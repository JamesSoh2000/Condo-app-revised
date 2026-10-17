# Explanation — P2-05 Rate limiting

> **PR:** #61 · **Source revision:** `d26af9f`. This is the pre-merge PR head this explanation was written from and checked against.
> **Reviewed:** the final review round (1) reviewed this commit.
> **Merge commit:** not known when this was written; after the merge, `gh pr view 61 --json mergeCommit` gives it.
>
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it before merge. This describes the PR's changes at the source revision. It does not describe commits after it (bookkeeping) or the squash merge, and a rebase after it gives the same changes new SHAs. It is a snapshot: before the merge it is edited to match the PR head; once merged, later changes get a new explanation and this one is not updated. Lasting decisions live in ADRs.
>
> **Reality check:** at `d26af9f` I re-read from disk:
> - `git diff origin/main...HEAD`
> - every file in the table in §4 in full: `backend/app/rate_limits/{models,service}.py`, `backend/app/core/config.py::RatePolicy`, `backend/app/auth/service.py::login`, `backend/app/auth/router.py::login`
> - the migration `f2a180ecdeb7`
> - the assertions of every test named in §5
> - the PR #61 description, with review round 1
>
> Ran `uv run pytest tests/test_rate_limit.py tests/auth tests/test_world.py tests/test_architecture.py` against a test database of its own (`condo_p205_test`): 183 passed. Compiled the upsert for Postgres to show its SQL (§3). `make check` at `6d8a389` (code identical to `d26af9f`, which only adds docs): 814 passed (PR). The prod-like transcript in §3 was run by this session at `6d8a389`.
>
> Differences from the plan: none (§2).
>
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)). Form: full. Tier: 1. Walkthrough variant: A (a login request).

## 1. What was built and why

`POST /api/auth/login` can now refuse an attempt with **429 `rate_limited`** and a `Retry-After` header. Two limits apply: **30 attempts per 10 minutes per client IP**, then **8 per 15 minutes per email**. Before this ticket nothing bounded online password guessing, or the argon2 work a login flood causes (ticket, "Carried from P2-01b").

The counts live in a new Postgres table, `rate_limits`, one row per key and fixed time window. They survive restarts without adding Redis (CLAUDE.md rule 13).

The two decisions that matter most:
- **The counter commits on a session of its own, immediately.** A failed login's count must stay even if the request's transaction rolls back.
- **The check runs before anything else in `login`.** A limited attempt does no user lookup and no argon2 verification, so the 429 is the same whether the email has an account.

## 2. Decisions

### D1. The limiter is a feature package, `app/rate_limits/`, not a module in `app/core/`

- **Problem or constraint:** `hit()` has to commit its own transaction. The commit fitness test (`backend/tests/test_architecture.py::COMMIT_ALLOWED`) allows commits only in `**/service.py` and in the process entry points.
- **Chosen:** `backend/app/rate_limits/models.py` and `backend/app/rate_limits/service.py`. `hit()` is a small use-case that commits exactly once.
- **Alternatives rejected:** a `rate_limit` module in `app/core/`, as the ticket and ARCHITECTURE §3 named it. That needs the file added to `COMMIT_ALLOWED`, which loosens a protected gate (playbook stop rule 3).
- **Tradeoffs and accepted limitations:** none recorded. ARCHITECTURE §3 now lists `rate_limits/`.
- **Basis:** protected gate; package-by-feature convention. Autonomous.
- **Source:** recorded (ticket Frame notes; PR D1).

### D2. The limiter is a FastAPI dependency that holds its own session factory

- **Problem or constraint:** the counts must commit apart from the request (criterion 3), on separate connections in production. But tests run every request on savepoints of one connection that is rolled back at the end. Also, the app's `AsyncSessionLocal` points at the dev database, not the test one.
- **Chosen:** `RateLimiter(sessions)`. In production, `backend/app/rate_limits/service.py::get_rate_limiter` returns `RateLimiter(AsyncSessionLocal)`. The router injects it and passes it to `service.login`. In tests, `backend/tests/conftest.py::limiter_on` gives the limiter savepoints of the test's connection, set in the `client` and `app_client` fixtures next to the `get_db_session` override. Criteria 3 and 4 use the `committing` fixture instead: a limiter on the real test engine whose rows really commit, deleted afterwards.
- **Alternatives rejected:**
  - Module functions `hit(key, limit, window)` that open `AsyncSessionLocal` themselves, as the ticket sketched. Every login test would then write to the dev database, or need a monkeypatch the fixtures don't use elsewhere.
  - Counting on the request's session. A failed login would lose its count whenever the request rolls back.
- **Tradeoffs and accepted limitations:** `hit` and `enforce` are methods, not module functions. The default test limiter shares the request's connection, so on its own it doesn't prove the separation. `test_production_limiter_opens_sessions_of_its_own_not_the_requests` pins the production factory, and the two `committing` tests prove the behaviour.
- **Basis:** the existing `get_db_session` override pattern. Autonomous.
- **Source:** recorded (PR D2).

### D3. Every attempt counts, IP first, before the lookup

- **Problem or constraint:** criterion 1 (the 9th attempt is 429 even with the right password). The P2-01b carry also asks to bound argon2 work and to keep the limited answer from revealing whether the email exists.
- **Chosen:** `backend/app/auth/service.py::login` first enforces the IP key, then the email key, and only then queries `users` and runs argon2. Successful attempts count too. An attempt refused by the IP limit raises before the email is counted.
- **Alternatives rejected:** count only failures, after verifying. That needs a check-then-count pair, still runs argon2 on every attempt, and the time to answer would differ between found and not-found emails.
- **Tradeoffs and accepted limitations:**
  - A user who logs in successfully 9 times in 15 minutes is refused.
  - Anyone can lock one account's login for up to 15 minutes with 8 attempts, from any IPs. That is the cost of any per-account limit (accepted; §7).
- **Basis:** ticket criterion 1; P2-01b carry. Autonomous for "successes count".
- **Source:** recorded (PR D3; review round 1 L2).

### D4. The email key hashes the email as Postgres lowers it

- **Problem or constraint:** login finds users with Postgres `lower(email)` (P2-01b D1). Python's `str.lower()` disagrees outside ASCII. `'İnfo@example.org'.lower()` gives `i` plus a combining dot (U+0307), while Postgres (`en_US.utf8`) gives `info@example.org`. A key built from Python's lowering would give one account one counter per spelling, multiplying the attempts an attacker gets.
- **Chosen:** `backend/app/rate_limits/service.py::email_key` runs `SELECT lower(:email)` on a limiter session, then builds `login:email:<sha256 hex>` in Python.
- **Alternatives rejected:**
  - `str.lower()` or `casefold()`: both still differ from Postgres.
  - Computing the key inside the upsert's SQL: `hit()` would take an SQL expression instead of a string key.
- **Tradeoffs and accepted limitations:**
  - One extra short round trip, so three limiter transactions per attempt.
  - The hash is unsalted. Someone with database access can confirm a guessed email against a key; the address itself is never stored.
- **Basis:** criterion 6 (framed); P2-01b D1. Autonomous.
- **Source:** recorded (PR D4, Frame notes).

### D5. IPv6 clients are keyed by their /64

- **Problem or constraint:** one IPv6 subscriber usually holds a whole /64. Keyed per address, an attacker could rotate through 2^64 IP buckets.
- **Chosen:** `backend/app/rate_limits/service.py::ip_key` keys:
  - IPv6 by its /64 network
  - an IPv4-mapped address (`::ffff:a.b.c.d`) as the IPv4 address
  - a missing or non-IP peer as `unknown`, one shared bucket
- **Alternatives rejected:** per-address keys (the bypass above); /48 (would group unrelated users at some providers).
- **Tradeoffs and accepted limitations:** users behind one NAT or one /64 share a bucket.
- **Basis:** framed criterion 9 (the case the ticket missed). Autonomous.
- **Source:** recorded (PR D5).

### D6. Default policies for the endpoints that come later

- **Problem or constraint:** the ticket sets login's numbers and says the reset, signup and join policies are defined here, without numbers.
- **Chosen:** reset 30/10 min per IP and 8/15 min per email; signup 10/hour per IP; join lookup 20/10 min per IP. Each one is a `RatePolicy` setting.
- **Alternatives rejected:** leaving them to P4-04 and P4-05 (the ticket says to define them here).
- **Tradeoffs and accepted limitations:** the numbers are judgement. They fit the dependents' own criteria: P4-04 criterion 6 (the 9th reset request for one email in 15 minutes is 429) and P4-05 criterion 8 (30 rapid join lookups give 429).
- **Basis:** autonomous, from those criteria.
- **Source:** recorded (PR D6).

### D7. Fixed windows aligned to the epoch, at most a day long

- **Problem or constraint:** the ticket asks for a fixed window aligned to its length, and a cleanup of rows older than a day.
- **Chosen:** `backend/app/rate_limits/service.py::window_start` computes `EPOCH + (now − EPOCH) // window × window`, with `now` from `app.core.clock.now()`, so tests can freeze it. `Retry-After` is the whole seconds left in the window, rounded up, at least 1. `backend/app/core/config.py::RatePolicy` refuses a window over 86,400 seconds, so the one-day cleanup can't delete a live window.
- **Alternatives rejected:** a sliding window or a token bucket. Both need more state or more rows per key, for little gain here (ARCHITECTURE §6).
- **Tradeoffs and accepted limitations:**
  - Across a window boundary, a client can make up to twice the limit in a short time.
  - All window arithmetic uses the app's clock; the database clock is never compared with it.
- **Basis:** ticket.
- **Source:** recorded (PR D7).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `enforce(key, policy)` takes a `RatePolicy` | `enforce(key, limit, window)` | every caller has a policy from settings | autonomous | PR |
| `RateDecision` also carries `count` | only `allowed` and `retry_after` | the concurrency test checks the returned counts are exactly 1..10 | autonomous | PR |
| The counter keeps counting past the limit | stop at `limit + 1` | one statement either way; the count shows the size of an attack | autonomous | PR |
| No audit event for a refused attempt | `auth.login_rate_limited` | not in the ticket; the 429 shows in the request log | autonomous | PR |
| Index `ix_rate_limits_window_start` | no index | the cleanup deletes by age across all keys | autonomous | PR |
| No change to `compose.prodlike.yml` or the Dockerfile | add proxy flags | P1-08 already runs gunicorn with `--forwarded-allow-ips "$FORWARDED_ALLOW_IPS"` (Caddy's address) | code is the truth | PR, Frame notes |
| Policies are read from `settings` at request time | bind them at import | tests and operators can change them | autonomous | PR |

**Framing changes:** criteria 1 and 3–7 were sharpened:
- 1: the problem+json body, no session or cookie, the same answer for known and unknown emails, no lookup or argon2 when refused
- 3: proven on separate connections, including a request that fails after the limiter ran
- 4: the returned counts, and how many calls a limit allows
- 5: epoch alignment and how `Retry-After` is rounded
- 6: Postgres lowering
- 7: a test through `ProxyHeadersMiddleware`, plus a run on the prod-like stack

Added: 8 (the IP limit), 9 (IPv6 /64), 10 (cleanup and the one-day bound), 11 (policies and overrides), 12 (OpenAPI), 13 (the tenant table rows that apply). Nothing was loosened.

**Plan versus final code:** I compared the PR's Plan with the code at `d26af9f`: same files, interfaces and migration. The single review round changed no code. None.

## 3. How it is implemented

### Overview

- `backend/app/rate_limits/models.py::RateLimit`: one row per `(key, window_start)`, holding `count`.
- `backend/app/rate_limits/service.py::RateLimiter`: `hit` (count one attempt, commit), `enforce` (`hit`, then raise `RateLimited` over the limit), `email_key` (the Postgres-lowered, hashed email key).
- `backend/app/rate_limits/service.py::ip_key`: the IP key from the server-resolved client address.
- `backend/app/core/config.py::RatePolicy` and the six `rate_limit_*` settings.
- `backend/app/auth/service.py::login`: the two `enforce` calls at the top.
- The existing `backend/app/core/errors.py::RateLimited`, which turns into 429 problem+json with `Retry-After` (it existed before this ticket).

### Walkthrough (variant A): the 9th login attempt for one email

1. **HTTP:** `POST /api/auth/login` with `{"email": "Resident1@Example.TEST", "password": "…"}`. The CSRF middleware passes it (Origin and `X-Requested-With: fetch`). FastAPI resolves `backend/app/auth/router.py::login`, with `db` from `get_db_session` and `limiter` from `get_rate_limiter`. Neither opens a database connection yet.
2. **Client address:** in production, gunicorn's `UvicornWorker` runs uvicorn's proxy-headers middleware with `--forwarded-allow-ips` set to `FORWARDED_ALLOW_IPS` (Caddy's address). Only when the TCP peer is that address does it replace `request.client` with the address from `X-Forwarded-For`. The router's `_client_ip` reads `request.client.host`, never the header.
3. **IP limit:** `login` calls `limiter.enforce(ip_key("login", ip), settings.rate_limit_login_ip)`. `hit` opens a session, runs one upsert and commits:

   ```sql
   INSERT INTO rate_limits (key, window_start, count) VALUES ($1, $2, 1)
   ON CONFLICT (key, window_start) DO UPDATE SET count = (rate_limits.count + 1)
   RETURNING rate_limits.count
   ```

   (Compiled from the SQLAlchemy statement for the Postgres dialect; the `1`s are bound parameters there.) The row lock that `ON CONFLICT DO UPDATE` takes makes concurrent hits queue up on that row, so no count is lost. The count is 9, at most 30, so it is allowed.
4. **Email key:** `limiter.email_key("login", email)` runs `SELECT lower($1)` on another short session and hashes the result with SHA-256.
5. **Email limit:** `enforce` on that key. The upsert returns 9, over the limit of 8, so `RateLimited(retry_after)` is raised. `retry_after` is the seconds to the end of the 15-minute window, rounded up.
6. **Response:** the `DomainError` handler in `backend/app/core/errors.py` returns 429 `application/problem+json` with `code: rate_limited`, `retry_after`, and the `Retry-After` header. `db` was never used, so no user was looked up, argon2 never ran, no session row exists and no cookie is set.

On the prod-like stack at `6d8a389` (PR transcript, run by this session; `Retry-After` is 78 because the window was 13 minutes old):

```
attempt 1..8: 401
attempt 9 (correct password, spelled Resident1@Example.TEST):
HTTP/1.1 429 Too Many Requests
Retry-After: 78
{"type":"/problems/rate-limited","title":"Too Many Requests","status":429,"code":"rate_limited","detail":"Too many attempts. Try again later.","retry_after":78,"request_id":"d60c22ba-…"}
same IP, another email, right password: 204
forged X-Forwarded-For: 198.51.100.1 through Caddy: 401
rate_limits: login:ip:10.213.208.1 … count 11; login:email:ecbae81f… count 9; two other email keys count 1
```

`10.213.208.1` is the host, where curl ran, as Caddy saw it. The forged address appears nowhere, and neither does Caddy's own `10.213.208.10`.

### Data model changes

`rate_limits`:
- `key` varchar(200) and `window_start` timestamptz, together the primary key `pk_rate_limits`. The primary key is what `ON CONFLICT (key, window_start)` targets: without it the upsert couldn't merge concurrent hits into one row.
- `count` integer, not null.
- `ix_rate_limits_window_start`, for the cleanup's delete by age across all keys.

No foreign keys: keys are hashed emails and IP strings, not references.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/rate_limits/service.py` | new: `RateLimiter`, `get_rate_limiter`, `window_start`, `ip_key`, `delete_expired_rate_limits` | +122 |
| `backend/app/rate_limits/models.py` | new: `RateLimit` | +21 |
| `backend/migrations/versions/f2a180ecdeb7_rate_limits.py` | new table and index | +37 |
| `backend/app/core/config.py` | `RatePolicy`, six settings | +29/−1 |
| `backend/app/auth/service.py` | `login` takes the limiter; two `enforce` calls | +14/−1 |
| `backend/app/auth/router.py` | inject the limiter; document 429 | +12/−3 |
| `backend/app/models/registry.py` | register the model | +1 |
| `backend/.env.example` | the `RATE_LIMIT_*` variables | +8 |
| `frontend/src/api/schema.d.ts` | regenerated (429 on login) | +11/−1 |
| `docs/ARCHITECTURE.md` | §3, §5, §6 | +16/−2 |
| `backend/tests/test_rate_limit.py` | new | +464 |
| `backend/tests/conftest.py` | `limiter_on` and the overrides | +16 |
| `backend/tests/test_world.py` | `rate_limits: 0` expected | +2 |

**Key excerpts**

`backend/app/rate_limits/service.py::RateLimiter`

```python
    async def hit(self, key: str, limit: int, window: timedelta) -> RateDecision:
        now = clock.now()
        start = window_start(now, window)
        upsert = (
            insert(RateLimit)
            .values(key=key, window_start=start, count=1)
            .on_conflict_do_update(
                index_elements=[RateLimit.key, RateLimit.window_start],
                set_={"count": RateLimit.count + 1},
            )
            .returning(RateLimit.count)
        )
        async with self._sessions() as session:
            count = (await session.execute(upsert)).scalar_one()
            await session.commit()
        retry_after = max(1, math.ceil((start + window - now).total_seconds()))
        return RateDecision(allowed=count <= limit, retry_after=retry_after, count=count)
```

- One statement both creates the window's row and increments it, and returns the new count. The session is the limiter's own and commits before returning.
- Why: D2 (its own session) and criterion 4 (atomic).
- Without `await session.commit()`, closing the session rolls the count back: mutation M1 made 6 tests fail, among them both `committing` tests and the concurrency test. Replacing the upsert with read-then-write (M3) made the concurrency test fail.

`backend/app/auth/service.py::login` (the new top of the function)

```python
    await limiter.enforce(ip_key("login", ip), settings.rate_limit_login_ip)
    await limiter.enforce(await limiter.email_key("login", email), settings.rate_limit_login_email)
    # lower() on both sides in Postgres: the same function as uq_users_lower_email (P1-02).
    found = (
        await db.execute(
    # ...
```

- Both limits run before the first use of `db`.
- Why: D3. There is also a harness reason: in tests the limiter's savepoints sit on the request's connection, so they must not open inside the request's own savepoint.
- Without the second line, the email limit is gone: mutation M5 made 8 tests fail.

`backend/app/rate_limits/service.py::ip_key`

```python
    try:
        address = ipaddress.ip_address(ip or "")
    except ValueError:
        return f"{scope}:ip:unknown"
    if isinstance(address, ipaddress.IPv6Address):
        if address.ipv4_mapped is not None:
            return f"{scope}:ip:{address.ipv4_mapped}"
        return f"{scope}:ip:{ipaddress.IPv6Network((address, 64), strict=False)}"
    return f"{scope}:ip:{address}"
```

- Normalizes the address, then groups IPv6 by /64 (D5).
- Keying IPv6 per address (M4) made the two /64 cases fail.

`backend/app/rate_limits/service.py::email_key`

```python
        async with self._sessions() as session:
            lowered = await session.scalar(select(func.lower(email)))
        assert lowered is not None  # noqa: S101 (lower() of a non-null string)
        return f"{scope}:email:{hashlib.sha256(lowered.encode()).hexdigest()}"
```

- D4. With `email.lower()` instead (M2), `test_email_key_uses_postgres_lower_so_unicode_spellings_share_a_counter` failed.

`backend/tests/test_rate_limit.py::test_counter_survives_a_request_whose_own_transaction_rolls_back`

```python
    @router.post("/limited-then-fails")
    async def limited_then_fails(
        session: AsyncSession = Depends(get_db_session),  # noqa: B008
    ) -> None:
        session.add(RateLimit(key="test:request-write", window_start=datetime.now(UTC), count=1))
        await session.flush()
        await committing.enforce("test:rollback", RatePolicy(limit=5, window_seconds=60))
        raise RuntimeError("the request fails after the limiter ran")
    # ...
    assert response.status_code == 500
    # The request's own write was rolled back, and the counter was not.
    assert "test:request-write" not in await _counts(db)
    assert await _committed_count(engine, "test:rollback") == 1
```

- The hardest criterion (3). The request writes a row, the limiter counts, and the request fails. The request's row is gone; the count is visible from a third connection (`_committed_count`), so it was really committed.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| The right password after 8 failures gets in | 429, no session, no cookie | `test_ninth_login_for_one_email_in_15_minutes_is_429_even_with_the_right_password` |
| The 429 reveals whether the email exists | same status, code, `retry_after`, header and body members | `test_limited_login_answers_the_same_for_a_known_and_an_unknown_email` |
| A refused attempt still runs argon2 or the lookup | `enforce` raises first | `test_limited_login_runs_no_lookup_and_no_argon2` (no `FROM users` statement; `verify_password` not called) |
| The email limit blocks other emails from that IP | separate keys | `test_another_email_from_the_same_ip_is_not_blocked_by_the_email_limit` |
| A failed login's count is lost | committed on the limiter's own connection | `test_failed_login_counter_is_committed_on_the_limiters_own_connection` |
| A request that rolls back takes the count with it | the limiter's session is separate | `test_counter_survives_a_request_whose_own_transaction_rolls_back` |
| Concurrent hits lose counts | one atomic upsert | `test_ten_concurrent_hits_on_one_key_count_exactly_ten` (10 connections, counts 1..10, 7 allowed) |
| Wrong window boundaries | epoch-aligned | `test_windows_are_aligned_to_their_length_since_the_epoch` |
| Still refused after the window ends, or let in early | 429 with `Retry-After: 1` one second before the end, 204 at the end | `test_login_is_allowed_again_when_the_window_passes` |
| `Retry-After` of 0 or a fraction | rounded up, at least 1 | `test_retry_after_rounds_up_to_whole_seconds` |
| A raw email stored; case variants get separate counters | hashed key of the lowered email | `test_no_key_holds_a_raw_email_address` |
| Unicode spellings get separate counters | Postgres `lower()` | `test_email_key_uses_postgres_lower_so_unicode_spellings_share_a_counter` |
| A forged `X-Forwarded-For` picks the bucket | only the trusted proxy's header is used | `test_forged_x_forwarded_for_from_an_untrusted_peer_is_ignored`, `test_x_forwarded_for_from_the_trusted_proxy_names_the_client` |
| The IP limit is not enforced | 31st attempt 429; no email row for it | `test_thirty_first_login_from_one_ip_in_10_minutes_is_429` |
| IPv6 rotation inside a /64; mapped IPv4; no peer | /64, unmapped, `unknown` | `test_ip_key_groups_ipv6_by_64_and_unmaps_ipv4` (6 cases) |
| The cleanup deletes live windows, or commits | deletes only older than a day; never commits | `test_cleanup_deletes_windows_older_than_a_day_and_never_commits` |
| A zero limit or a window over a day | refused by settings | `test_settings_refuse_a_policy_with_no_limit_or_a_window_over_a_day` |
| Overrides ignored | JSON env var; read per request | `test_a_policy_is_overridden_by_a_json_environment_variable`, `test_login_uses_the_policy_in_settings_at_request_time` |
| Production limiter shares the request's session | `get_rate_limiter` uses `AsyncSessionLocal` | `test_production_limiter_opens_sessions_of_its_own_not_the_requests` |
| A rate-limit row survives into another test | rolled back with the test | `backend/tests/test_world.py::test_two_worlds_in_a_row_have_the_same_row_counts` (expects `rate_limits: 0`) |
| A database error in the limiter | the login fails with 500; nothing proceeds (fails closed) | No test (round 1 reviewer read it in the code) |

Acceptance criteria → tests:
1. the first three rows above
2. `test_another_email_from_the_same_ip_is_not_blocked_by_the_email_limit`
3. the two `committing` tests
4. `test_ten_concurrent_hits_on_one_key_count_exactly_ten`
5. the three window tests
6. the two key tests
7. the two proxy tests, plus the prod-like transcript (§3)
8. `test_thirty_first_login_from_one_ip_in_10_minutes_is_429`
9. `test_ip_key_groups_ipv6_by_64_and_unmaps_ipv4`
10. the cleanup and policy-bound tests
11. `test_default_policies` and the two override tests
12. `test_login_documents_429_as_problem`; `schema.d.ts` regenerated
13. `test_login_succeeds_under_the_limits`, every existing login test, and criterion 4

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Fresh Claude (Sonnet 5.5, high effort, with the security pass) | `d26af9f` | MERGE | L1: a `FORWARDED_ALLOW_IPS` that misses the real proxy puts every client in one IP bucket · L2: targeted lockout; successes count; e2e suites will hit the limits · L3: cleanup not scheduled · L4: `committing` tests can fail after a hard kill leaves rows | none fixed: L1–L3 accepted, L4 deferred to P2-07 (§7) |
| 1 | Codex (`gpt-6.1-sol`, high effort, security pass) | `d26af9f` | MERGE | none | — |

No finding changed the code or the design. The Claude reviewer also ran a mutation of its own: swapping the IP and email `enforce` order made `test_thirty_first_login_from_one_ip_in_10_minutes_is_429` fail. It ran a migration up/down/up round trip with `alembic check` on a scratch database, and confirmed that uvicorn 0.48's `UvicornWorker` passes gunicorn's `forwarded_allow_ips` on.

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **Staging behind host Caddy.** The keys there should be the real client IP, not `127.0.0.1`. Only the prod-like stack was run (§3). D-06 checks staging (its checklist).
- **The limiter's failure mode** (a database error gives a 500) was read in the code, not tested.
- **The proxy behaviour in tests** wraps the app in uvicorn's `ProxyHeadersMiddleware` directly. That gunicorn installs the same middleware from `--forwarded-allow-ips` rests on the round 1 reviewer's reading of uvicorn 0.48, and on the prod-like transcript.
- **A concurrent login flood** of more than 30 requests on real connections was not run. Concurrency is proven on `hit` (criterion 4).

Accepted risks:
- **Targeted lockout:** 8 attempts lock one email's login for up to 15 minutes, from any IPs (D3). Tracked only here and in PR #61's follow-ups.
- **A misconfigured proxy setting** (review L1) makes every client share the proxy's bucket, so one attacker could lock out logins for everyone. D-06 checks staging; a startup or log warning is a follow-up, tracked only here and in the PR.
- **Distributed load:** the per-IP limit doesn't bound argon2 work from many IPs. Edge protection is out of scope (ticket "Out").
- **Fixed-window bursts:** up to 2× the limit across a boundary (D7).

Follow-ups:
- **Cleanup scheduling:** P3-01 (the `rate_limits.cleanup` job, in its ticket; a TODO in `delete_expired_rate_limits`).
- **e2e environment** (review L2): P4-09 must raise the `RATE_LIMIT_*` login limits (added to its ticket in the bookkeeping commit).
- **Test fixture robustness** (review L4): P2-07 (added to its ticket in the bookkeeping commit).
- **Applying the policies:** P4-04 (reset) and P4-05 (signup, join) apply the policies defined here (noted in their tickets in the bookkeeping commit). P4-02 defines its own invitation-lookup policy.
- **No audit event for refused attempts:** tracked only here.

## 8. How to change this safely

- **To rate-limit a new endpoint:**
  1. Add a `RatePolicy` setting in `backend/app/core/config.py` (window at most a day).
  2. Inject `get_rate_limiter` in the router.
  3. Call `limiter.enforce(...)` in the use-case **before** its first use of `db`, and before any work an attacker shouldn't be able to trigger.
  4. Use `ip_key(scope, ip)` with `request.client.host`; use `email_key` for an email.
  5. Document 429 with `problem_responses(..., 429)` and run `make gen-api`.
- **Tests:** endpoint tests through `client` get the savepoint limiter automatically. Anything that must prove a real commit uses the `committing` pattern from `backend/tests/test_rate_limit.py`.
- **If you change the key format or the lowering,** `test_no_key_holds_a_raw_email_address` and the Unicode test tell you. **If you change the window maths,** the three window tests do. **If you change the upsert,** the concurrency test does.

## 9. Must explain, then quiz

**1. Why must the counter be committed in a separate transaction from the login attempt?** A guessing attack is made of failed attempts, and a failed request is the kind that rolls back. Today `login` happens to commit its failed-login audit row, but any request that raises without committing (the `get_db_session` session is closed, which rolls back) would discard a count written in its own transaction. The attacker would then never be counted. `backend/app/rate_limits/service.py::RateLimiter.hit` commits on its own session before `login` touches `db`. `test_counter_survives_a_request_whose_own_transaction_rolls_back` shows it with a request that fails after counting.

**2. Fixed window vs sliding window vs token bucket: the weakness of a fixed window, and why it is acceptable here.**
- A fixed window resets all at once. A client can spend the whole limit at the end of one window and again at the start of the next: up to 2× the limit in a short time.
- A sliding window (or log) smooths this, but needs more rows or per-attempt timestamps. A token bucket needs a stored refill state per key, updated on every request.
- For password guessing the 2× burst is still 16 attempts per email in about 15 minutes, which doesn't make online guessing practical. A fixed window is one upsert on one row (ticket; D7).

**3. Why hash the email in the key?** The table is a log of who was attempted. Raw addresses there would be personal data kept for no purpose, readable by anyone with database access or a backup (CLAUDE.md rule 10). A SHA-256 of the Postgres-lowered email still gives each account exactly one counter (`backend/app/rate_limits/service.py::email_key`). It is unsalted, so a guessed address can be confirmed against a key; it is minimisation, not secrecy.

**4. Why can't we trust `X-Forwarded-For` from anyone?** It is just a request header, and any client can write any address in it. If the limiter read it, an attacker would send a new fake address with every request and never fill a bucket, or fill someone else's. Only the reverse proxy we run (Caddy) writes it truthfully, so gunicorn/uvicorn honour it only when the TCP peer is `FORWARDED_ALLOW_IPS`. The app reads only `request.client.host` (`backend/app/rate_limits/service.py::ip_key`). Proven by `test_forged_x_forwarded_for_from_an_untrusted_peer_is_ignored` and the prod-like transcript.

**Quiz**

1. A login request is refused by the IP limit. Which rows of `rate_limits` changed, and why not the other one?
2. Why does `email_key` ask Postgres to lower the email instead of calling `str.lower()`? Give an input where they differ.
3. What would break if `login` called `limiter.enforce` *after* the user lookup instead of before? Name both the security effect and the test-harness effect.
4. What would break if we removed the primary key `pk_rate_limits`?
5. How would you extend this to limit `POST /api/auth/password-reset` per IP and per email (P4-04), keeping the "same answer for unknown emails" property?

<details><summary>Answers</summary>

1. Only the IP key's row: its count went up and passed 30, so `enforce` raised before `email_key` and the second `enforce` ran (`test_thirty_first_login_from_one_ip_in_10_minutes_is_429` asserts there is no row for the 31st email).
2. Login finds users with Postgres `lower()`, so the key has to group exactly the spellings that reach one account. `İnfo@example.org`: Python gives `i` plus a combining dot, Postgres (`en_US.utf8`) gives `info@example.org`. With Python's lowering one account would get one counter per spelling.
3. Security: a refused attempt would still run the user lookup (and argon2, if the check came after it), so the limit would no longer bound that work, and the time to a 429 could differ between known and unknown emails. Harness: the limiter's savepoints would open inside the request's savepoint on the shared test connection, so the request's rollback could undo the counts and the counting tests would fail.
4. `ON CONFLICT (key, window_start)` needs a unique index to target; the upsert would fail, so every login would 500. Even with a plain insert, concurrent hits would create duplicate rows instead of one count.
5. Add nothing to config (the `rate_limit_reset_ip` and `rate_limit_reset_email` policies exist). In the reset use-case, before any lookup: `await limiter.enforce(ip_key("reset", ip), settings.rate_limit_reset_ip)`, then `await limiter.enforce(await limiter.email_key("reset", email), settings.rate_limit_reset_email)`. Use the `reset` scope so login and reset counts stay apart. Answer allowed requests the same way whether the email exists, document 429, and add tests like criterion 1's for both an existing and an unknown email.

</details>
