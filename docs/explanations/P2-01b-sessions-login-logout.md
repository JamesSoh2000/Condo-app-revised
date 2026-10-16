# Explanation — P2-01b Sessions, login and logout

> **PR:** #57 · **Source revision:** `45427db`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 57 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> contains `origin/main`.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `45427db` the diff (`git diff origin/main...HEAD`),
> `backend/app/auth/service.py`, `backend/app/auth/deps.py`, `backend/app/auth/router.py`,
> `backend/app/auth/schemas.py`, `backend/app/core/security.py`, the session settings in
> `backend/app/core/config.py`, `backend/tests/helpers/auth.py` and `backend/tests/test_app_imports.py`, and
> the test names of `backend/tests/auth/`. Ran `make test DB_PORT=55432`: **614 passed**; the cited files
> (`tests/auth`, `test_security.py`, `test_config.py`, `test_app_imports.py`, `test_world.py`): **218 passed**.
> The SQL in §3 was captured by running login, a resolve, a refresh and logout against a scratch database at
> this revision (SQLAlchemy echo). Mutation results are quoted from the PR (run at `c8d99a1`, `489c051`,
> `45427db`), not re-run for this text. Differences from the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A (one real request, `POST /api/auth/login`, then what the cookie
> does on the next request).

## 1. What was built and why

P2-01 was split during framing; P2-01a (PR #56) added CSRF protection and password hashing. This half adds
what those protect:

- a **`sessions` table** that stores the sha256 of a random token, never the token;
- **`POST /api/auth/login`**: 204 with an HttpOnly cookie, or one identical 401 `invalid_credentials` for
  every kind of failure;
- **`POST /api/auth/logout`**: revokes the session and deletes the cookie, always 204;
- **`get_current_session` / `get_current_user`**: the dependencies every later endpoint (P2-02 onwards) uses to
  turn the cookie into a user, with 401 `not_authenticated`;
- **expiry** per [ADR-0003](../adr/0003-same-origin-server-side-sessions.md): 30 days absolute, idle 7 days
  for residents and 12 hours for staff, activity recorded at most every 5 minutes;
- **settings** that give staging and production a `__Host-session` cookie with `Secure`, and refuse to start
  otherwise;
- **test support**: `backend/app/core/clock.py::now` and the `frozen_clock` fixture, and `login_as` for logging in a
  world user who has no password.

The two properties that matter most: a database leak doesn't hand out usable sessions (only hashes are
stored), and login doesn't reveal, by its answer or its timing, which emails have accounts (D2).

## 2. Decisions

### D1. Email lookup lowers both sides in Postgres

- **Problem or constraint:** P1-02 lower-cases `User.email` in Python on ORM writes, while uniqueness is the
  index `uq_users_lower_email` on Postgres `lower(email)`. Python's and Postgres' `lower()` disagree on some
  characters (carried from P1-02).
- **Chosen:** `func.lower(User.email) == func.lower(email)` in `backend/app/auth/service.py::login`. Only
  Postgres lowers, with the same function as the index. The login `email` is a plain string of 1–320
  characters, so a malformed address is just an unknown one (401).
- **Alternatives rejected:** lowering the input in Python (the mismatch the carry warns about); `EmailStr`
  (a 422 for a malformed address is a second, distinguishable answer, and login writes no email).
- **Tradeoffs and accepted limitations:** the carry's write-side items (non-ASCII, length after lowering,
  `email-validator`) stay with P4-02/P4-05, the first endpoints that write emails.
- **Basis:** autonomous (framing). **Source:** recorded (ticket Frame notes; PR D1).

### D2. One password verification on every login path

- **Problem or constraint:** AC3 wants identical 401s for an unknown email, a wrong password, a NULL hash, an
  unparsable hash and an inactive user. If any of those paths skipped argon2 it would answer measurably
  faster and reveal the account (P2-01a's `DUMMY_HASH` exists for this).
- **Chosen:** `login` uses the stored hash only if `backend/app/core/security.py::is_valid_hash` accepts it,
  else `DUMMY_HASH`; it verifies exactly once, in a worker thread; it checks `is_active` only *after*
  verifying; and every failure raises the same `InvalidCredentials` with the same detail text.
- **Alternatives rejected:** returning early for an unknown email or a NULL hash (a timing oracle); checking
  `is_active` first (inactive accounts would answer faster).
- **Tradeoffs and accepted limitations:** a real hash made with *weaker* parameters verifies faster than
  `DUMMY_HASH` until its owner's next login upgrades it (round 3 L1, accepted). Equal timing is structural
  (one verification per path), not a guarantee; the round 3 reviewer measured medians of 34.0–34.6 ms across
  the paths on one machine.
- **Basis:** ticket AC3 plus the P2-01a carry. **Source:** recorded (PR D2; review rounds 1–2 for
  `is_valid_hash`).

`is_valid_hash` needed three review rounds across two PRs: argon2-cffi parses strings libargon2 refuses (a
7-byte salt, `t=0`, `t=03`, `t=+3`, `t=2^32`), and each such hash failed in microseconds instead of costing
a verification. The final version stops listing bad inputs: it rebuilds the canonical string from the parsed
parameters, requires an exact match, then bounds every parameter (§4).

### D3. The idle window is recomputed at each refresh

- **Problem or constraint:** the ticket sets the window at login. ADR-0003 says authorization always reads
  current roles.
- **Chosen:** `backend/app/auth/service.py::idle_window` returns 12 h if the user holds a staff role on an
  **active** membership, else 7 days. Login and every refresh (at most every 5 minutes) call it.
- **Alternatives rejected:** keep the login-time window (stale for up to 7 days after a role change); store
  the window length on the row (an unlisted column, and still stale).
- **Tradeoffs and accepted limitations:** one indexed `EXISTS` query per refresh. A resident promoted to
  staff keeps the 7-day deadline until their next request (round 2 L2, accepted).
- **Basis:** autonomous. **Source:** recorded (ticket Frame notes; PR D3).

### D4. A persistent cookie, `Max-Age` = 30 days

- **Problem or constraint:** neither the ticket nor ADR-0003 says whether the cookie outlives the browser.
- **Chosen:** `Max-Age` is the absolute lifetime. Validity is decided on the server (`expires_at`,
  `idle_expires_at`, `revoked_at`); the cookie's age only bounds how long the browser keeps it.
- **Alternatives rejected:** a browser-session cookie (a resident would be logged out at every browser
  restart, which defeats a 7-day idle window).
- **Tradeoffs and accepted limitations:** the cookie of a session that died early stays in the browser until
  it is sent (then 401) or logout deletes it.
- **Basis:** autonomous. **Source:** recorded (PR D4).

### D5. Login keeps password whitespace

- **Problem or constraint:** `InputModel` strips every string (`str_strip_whitespace=True`); a plain
  `password: str` turned `"  pw  "` into `"pw"` (checked with a pydantic probe while planning).
- **Chosen:** `backend/app/auth/schemas.py::LoginIn` declares the password with
  `StringConstraints(strip_whitespace=False, min_length=1, max_length=128)`. The cap is the policy's maximum,
  so no password that could have been set is refused, and argon2 never sees a huge input.
- **Alternatives rejected:** stripping (a password that starts or ends with a space could never log in).
- **Tradeoffs and accepted limitations:** P4-02 and P4-04, which set passwords, need the same annotation
  (follow-up).
- **Basis:** experiment. **Source:** recorded (PR D5).

### D6. Cookie settings follow the environment, with guards

- **Problem or constraint:** `session` in dev/test, `__Host-session` with `Secure` in staging/prod. Browsers
  silently drop a `__Host-` cookie without `Secure`.
- **Chosen:** `backend/app/core/config.py::_session_cookie_defaults` (a `mode="before"` validator) fills the
  name and `Secure` from `APP_ENV` unless they are set; `validate_production_settings` refuses staging/prod
  without `Secure` and `__Host-`; every environment refuses `__Host-` without `Secure`.
- **Alternatives rejected:** fixed defaults plus per-environment env files (a missing value would silently
  give staging an insecure cookie).
- **Basis:** ticket and ADR-0003. **Source:** recorded (PR D6).

### D7. One PR at 462 non-test lines

- **Problem or constraint:** the limit is about 400, and this is already half of a split.
- **Chosen:** keep login, logout and the dependency together; each one's tests need the others.
- **Tradeoffs and accepted limitations:** the count includes the migration (66 lines), `.env.example`, docs
  and docstrings.
- **Basis:** autonomous. **Source:** recorded (PR D7).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `sessions.user_id` `ON DELETE CASCADE` | RESTRICT (the memberships convention) | a session is a credential, not history; users are deactivated, not deleted | autonomous | PR table |
| CHECK `token_hash ~ '^[0-9a-f]{64}$'` | none | the database refuses a raw token stored by mistake (AC2) | autonomous | PR table |
| `touch_session` is its own committing use-case | update inside the endpoint's transaction | CLAUDE.md rule 5; the refresh must persist even if the endpoint fails | rule 5 | PR table |
| Refresh and rehash `UPDATE`s are conditional on the value read | unconditional | concurrent requests write once; a password changed meanwhile wins | autonomous; review rounds 1–2 | PR table, review section |
| Login releases its connection (`rollback`) before argon2 | keep the read's transaction open | a burst of bad logins held all 15 pooled connections | review round 2 M1 | PR review section |
| Timestamps from `clock.now()` (DB default kept as a backstop) | DB `now()` | a frozen clock in tests must match what is stored | ticket test plan | PR table |
| `login_as(db, client, user)`, not `as_user` | build `as_user` here | P2-03's ticket owns `as_user` | P2-03 ticket | PR table |
| A second login doesn't revoke a live cookie | revoke on re-login | several devices are normal; P2-02 lists and revokes sessions | autonomous | PR table |
| Client IP is the proxy-resolved `request.client.host`, kept only if it parses as an IP | `X-Forwarded-For` | the server already resolves trusted proxies (P1-08) | existing convention | PR table |
| NUL rejected in the login email (422), stripped from the stored User-Agent | none | Postgres text can't hold NUL; both were 500s | review rounds 1–2 | PR review section |

**Framing changes:** AC1–AC6 sharpened (exact cookie attributes and `Max-Age`; case-insensitive email; the
settings guards; the token-hash constraint; NULL and unparsable hashes in the 401 set with one verification
each; logout idempotency; revoked, deactivated, garbage and missing cookies; AC6 as an exact T+1/T+5/T+6
timeline). AC7–AC11 added (staff idle window, 422s, rehash on login, CSRF on the auth routes, `login_as`).
Nothing loosened.

**Plan versus final code:** the Plan's files and interfaces match, with one deviation found by running the
stack: `backend/app/main.py` also imports `app.models.registry` (`623bb88`; without it login answered 500 in a
real server). Review rounds added: `is_valid_hash`'s canonical form and bounds, the NUL handling, the
`rollback()` before argon2, the conditional rehash, and positivity checks on the session settings.

## 3. How it is implemented

### Overview

- `backend/app/auth/router.py` parses the request and sets or deletes the cookie; it knows nothing about
  hashes or expiry.
- `backend/app/auth/service.py` holds the lifecycle: `login`, `start_session`, `idle_window`,
  `resolve_session`, `touch_session`, `logout`. `login`, `touch_session` and `logout` commit once each.
- `backend/app/auth/deps.py::get_current_session` is what other routers depend on: cookie → `resolve_session`
  → `touch_session` → `CurrentSession(session, user)`.
- `backend/app/core/clock.py::now` is the only clock the auth code reads, so tests can freeze it.

### Walkthrough (variant A): logging in, then using the cookie

1. **HTTP.** `POST /api/auth/login` with `Origin: http://localhost:5173`, `X-Requested-With: fetch` and
   `{"email":"Resident1@example.test","password":"DevPassword!2026"}`. `RequestLoggingMiddleware` assigns a
   request id; `CSRFMiddleware` (P2-01a) sees a trusted `Origin` and the header and passes it on.
2. **Validation.** FastAPI builds `LoginIn`: `email` 1–320 characters with no NUL; `password` 1–128
   characters, not stripped. Anything else is 422 before any database or argon2 work (AC8).
3. **Lookup, then release.** `service.login` runs one query and ends its transaction at once:

   ```sql
   SELECT users.id, users.password_hash, users.is_active FROM users
   WHERE lower(users.email) = lower($1::VARCHAR)
   ROLLBACK
   ```
4. **One verification.** `is_valid_hash` decides between the stored hash and `DUMMY_HASH`;
   `to_thread.run_sync(verify_password, ...)` runs argon2 (64 MiB; the round 3 reviewer measured 401s at about 34 ms) in AnyIO's thread pool
   while the event loop serves other requests. Any failure raises `InvalidCredentials` → 401.
5. **Rehash (only for weaker parameters).** `UPDATE users SET password_hash=$new WHERE id=$id AND
   password_hash=$verified`. Not run in this request: the seeded hash is current.
6. **Session.** `start_session` makes a token (`secrets.token_urlsafe(32)`, 43 characters), computes the idle
   window and inserts the hash, in a new short transaction:

   ```sql
   BEGIN
   SELECT EXISTS (SELECT * FROM building_memberships, membership_roles
     WHERE building_memberships.user_id = $1 AND building_memberships.status = $2
       AND membership_roles.membership_id = building_memberships.id
       AND membership_roles.role IN ($3, $4, $5))
   INSERT INTO sessions (id, user_id, token_hash, created_at, last_seen_at, expires_at, idle_expires_at,
     revoked_at, user_agent, ip) VALUES (...)
   COMMIT
   ```
7. **Response.** The router sets the cookie; the token goes nowhere else (not logged, not stored):

   ```
   HTTP/1.1 204 No Content
   set-cookie: session=<token>; HttpOnly; Max-Age=2592000; Path=/; SameSite=lax
   ```
8. **The next request.** A route depending on `get_current_user` reads the cookie, hashes it and runs one
   query that checks everything at once:

   ```sql
   SELECT sessions.*, users.* FROM sessions JOIN users ON users.id = sessions.user_id
   WHERE sessions.token_hash = $1 AND sessions.revoked_at IS NULL
     AND sessions.expires_at > $2 AND sessions.idle_expires_at > $3 AND users.is_active
   ```

   If `last_seen_at` is 5 minutes old or more, `touch_session` runs the `EXISTS` query again and
   `UPDATE sessions SET last_seen_at=$1, idle_expires_at=$2 WHERE sessions.id=$3 AND
   sessions.last_seen_at=$4`, then commits. Otherwise it writes nothing.
9. **Logout.** `UPDATE sessions SET revoked_at=$1 WHERE token_hash=$2 AND revoked_at IS NULL`, commit, and a
   `Set-Cookie` with the same name, `Path` and flags and `Max-Age=0`.

There is no protected endpoint yet (`/me` is P2-02), so step 8 was run in tests and in the SQL capture, not
through HTTP on the stack.

### Data model changes

Migration `backend/migrations/versions/e28660ad6da3_sessions.py` (expand only) creates `sessions`
(`backend/app/auth/models.py::AuthSession`): `id` (uuid7), `user_id` → `users` `ON DELETE CASCADE`,
`token_hash` varchar(64) unique with the sha256-hex check, `created_at`, `last_seen_at`, `expires_at`,
`idle_expires_at`, `revoked_at`, `user_agent` varchar(300), `ip` inet, and the partial index
`ix_sessions_user_id_live ON (user_id) WHERE revoked_at IS NULL` (for P2-02's "revoke all"). The resolve
query uses the unique index on `token_hash`. The PR ran upgrade → `alembic check` → downgrade → upgrade on a
scratch database.

## 4. The code

**Files changed** (from `git diff --stat origin/main...HEAD`)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/auth/service.py` | new: the session lifecycle | +169 |
| `backend/app/auth/router.py`, `deps.py`, `schemas.py`, `models.py` | new | +62, +41, +25, +40 |
| `backend/app/core/security.py` | `is_valid_hash`; `needs_rehash` built on it | +50 −17 |
| `backend/app/core/config.py` | session settings and guards | +29 −2 |
| `backend/app/core/clock.py` | new: `now()` | +11 |
| `backend/app/main.py`, `backend/app/models/registry.py` | router; registry import | +6, +1 |
| `backend/migrations/versions/e28660ad6da3_sessions.py` | new table | +66 |
| `backend/.env.example`, `docs/ARCHITECTURE.md` | settings; §6 | +8, +7 −5 |
| `frontend/src/api/schema.d.ts` | regenerated | +105 |
| `backend/tests/*` | `tests/auth/` new; config, security, world, app-imports tests; `frozen_clock`, `login_as` | +1099 −2 |

`backend/app/auth/service.py::login`

```python
    found = (
        await db.execute(
            select(User.id, User.password_hash, User.is_active).where(
                func.lower(User.email) == func.lower(email)
            )
        )
    ).one_or_none()
    # End the read before argon2 runs, so the pooled connection isn't held for the slow part: a
    # burst of logins would otherwise hold every connection (review round 2).
    await db.rollback()
    stored = found.password_hash if found is not None else None
    usable = stored if stored is not None and is_valid_hash(stored) else None
    # argon2 is CPU-bound and memory-hard: run it off the event loop.
    matches = await to_thread.run_sync(verify_password, password, usable or DUMMY_HASH)
    if found is None or usable is None or not matches or not found.is_active:
        raise InvalidCredentials(detail="The email or password is incorrect.")
    if needs_rehash(usable):
        upgraded = await to_thread.run_sync(hash_password, password)
        # Only over the hash that was verified: a password changed meanwhile wins.
        await db.execute(
            update(User)
            .where(User.id == found.id, User.password_hash == usable)
            .values(password_hash=upgraded)
        )
    token = await start_session(db, found.id, user_agent=user_agent, ip=ip)
    await db.commit()
    return token
```

- The single `if` after the verification is what makes the paths indistinguishable: all five failures reach
  it having done the same work. Skip `DUMMY_HASH` for the unknown/NULL paths and
  `test_every_credential_failure_is_the_same_401_and_writes_nothing` fails (mutation M1); let inactive users
  through and it fails too (M2).
- `usable is None` keeps the user's *own* password from matching `DUMMY_HASH` (whose password is random, so it
  never would; the check makes it explicit).
- Without the `rollback()`, the read's transaction stays open on a pooled connection for the whole argon2
  run; `test_login_holds_no_transaction_while_verifying` fails.
- Drop `User.password_hash == usable` from the rehash and
  `test_rehash_does_not_overwrite_a_password_changed_meanwhile` fails.

`backend/app/core/security.py::is_valid_hash`

```python
    try:
        params = extract_parameters(password_hash)
    except InvalidHashError, UnicodeEncodeError:
        return False
    *_, salt, digest = password_hash.split("$")
    canonical = (
        f"$argon2{params.type.name.lower()}$v={params.version}"
        f"$m={params.memory_cost},t={params.time_cost},p={params.parallelism}${salt}${digest}"
    )
    # ...
    within_bounds = (
        params.version in {16, 19}
        and 8 <= params.salt_len <= 64
        and 4 <= params.hash_len <= 64
        and 1 <= params.time_cost <= 16
        and 1 <= params.parallelism <= 16
        and 8 * params.parallelism <= params.memory_cost <= 1024 * 1024
    )
    return (
        password_hash == canonical
        and within_bounds
        and _is_canonical_b64(salt)
        and _is_canonical_b64(digest)
    )
```

- Rebuilding the string closes the whole class of "parses but isn't what argon2 writes" (`t=03`, `t=+3`,
  reordered or extra fields); comparing it to the input is one check instead of a growing list.
- Lower bounds are libargon2's minimums; upper bounds are this app's, far above what `hash_password` writes
  (t=3, m=64 MiB, p=4).
- Removing the canonical comparison fails 4 cases of
  `test_non_canonical_or_out_of_bounds_parameters_verify_as_dummy`; removing the upper bounds fails 1.

`backend/app/auth/service.py::resolve_session` and `touch_session`

```python
async def resolve_session(db: AsyncSession, token: str) -> CurrentSession | None:
    """The live session the token names, with its active user; None otherwise. One query."""
    now = clock.now()
    row = (
        await db.execute(
            select(AuthSession, User)
            .join(User, User.id == AuthSession.user_id)
            .where(
                AuthSession.token_hash == hash_token(token),
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > now,
                AuthSession.idle_expires_at > now,
                User.is_active,
            )
        )
    ).one_or_none()
    return None if row is None else CurrentSession(*row)


async def touch_session(db: AsyncSession, session: AuthSession) -> None:
    """Record activity, at most once per `REFRESH_EVERY`; the idle window follows current roles."""
    now = clock.now()
    if now - session.last_seen_at < REFRESH_EVERY:
        return
    idle = await idle_window(db, session.user_id)
    # Conditional on the value read: of two concurrent requests, only one writes.
    await db.execute(
        update(AuthSession)
        .where(AuthSession.id == session.id, AuthSession.last_seen_at == session.last_seen_at)
        .values(last_seen_at=now, idle_expires_at=now + idle)
    )
    await db.commit()
```

- `> now` makes a deadline exclusive: at exactly `expires_at` the session is dead
  (`test_session_is_rejected_from_either_deadline_on`, −1 s/0/+1 s; `>=` is mutation M6).
- The `User.is_active` filter makes deactivation take effect on the next request, without touching sessions
  (`test_deactivated_user_is_rejected_on_the_next_request`; M7).
- `< REFRESH_EVERY` means a request at exactly T+5 min writes; T+1 and T+6 don't
  (`test_last_seen_at_is_written_at_most_every_5_minutes`; refreshing every time is M8).

`backend/app/auth/deps.py::get_current_session`

```python
    token = request.cookies.get(settings.session_cookie_name)
    current = await service.resolve_session(db, token) if token else None
    if current is None:
        raise NotAuthenticated(detail="Log in to continue.")
    await service.touch_session(db, current.session)
    return current
```

- Every reason (no cookie, garbage, revoked, expired, idle, inactive user) is the same 401: the caller
  learns only "log in". Its docstring warns that the refresh commits, so it must come before any dependency
  that adds work to the request's session.

`backend/app/auth/router.py::_set_session_cookie`

```python
def _set_session_cookie(response: Response, value: str, *, max_age: int) -> None:
    # No Domain: the cookie stays on the exact host (and the __Host- prefix requires that).
    response.set_cookie(
        settings.session_cookie_name,
        value,
        max_age=max_age,
        path="/",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="lax",
    )
```

- Login and logout share it, so the deleting cookie always has the same name, `Path` and flags as the one it
  replaces; a browser treats a cookie with another `Path` as a different cookie and would keep the old one.
- Dropping `httponly=True` fails 3 tests (M13).

`backend/tests/helpers/auth.py::login_as`

```python
    token = await start_session(db, user.id, user_agent="tests", ip=None)
    client.cookies.set(settings.session_cookie_name, token)
    return token
```

- It goes through the real `start_session`, so a test session has the same columns and windows as a real
  one; the world's users have no password, so `login` can't be used for them.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Unknown email, wrong password, NULL hash, unparsable hash, inactive user | same 401 body, no cookie, no row, exactly one verification | `test_every_credential_failure_is_the_same_401_and_writes_nothing` |
| A hash argon2-cffi parses but libargon2 refuses or doesn't write (`t=0`, short salt, `t=03`, `t=2^32`) | verified as `DUMMY_HASH` | `test_unusable_argon2_hash_is_verified_as_dummy`, `test_non_canonical_or_out_of_bounds_parameters_verify_as_dummy` |
| Email in another case | logs in | `test_seeded_resident_logs_in_and_gets_an_httponly_lax_cookie[Resident1@Example.TEST]` |
| NUL in the email / password / User-Agent | 422 / ordinary 401 / stored without it | `test_email_with_a_nul_character_is_422_not_500`, `test_password_with_a_nul_character_is_an_ordinary_failure`, `test_user_agent_with_nul_is_stored_without_it` |
| Password with leading or trailing spaces | kept | `test_password_whitespace_is_kept` |
| Token stored or logged | only its sha256; the DB refuses anything else | `test_db_stores_only_the_token_hash_and_logs_never_hold_the_token`, `test_database_refuses_a_token_hash_that_isnt_sha256_hex` |
| Login holding a DB connection during argon2 | released first | `test_login_holds_no_transaction_while_verifying` |
| Rehash racing a password change | the change wins | `test_rehash_does_not_overwrite_a_password_changed_meanwhile` |
| Two concurrent refreshes | one write | `test_refresh_does_not_overwrite_a_newer_write` |
| Staff role on a pending or suspended membership | resident window | `test_idle_window_is_staff_length_only_for_an_active_staff_role` |
| Role changed after login | window follows at the next refresh | `test_refresh_recomputes_the_idle_window_from_current_roles` |
| Logout twice, without a cookie, with an unknown cookie | 204; first revocation kept | `test_logout_without_a_valid_session_is_still_204`, `test_logging_out_twice_with_the_same_cookie_keeps_the_first_revocation` |
| App started without the test suite's imports | every mapper configures | `test_importing_the_app_alone_configures_every_mapper` |
| Staging configured with an insecure cookie | settings refuse to load | `test_staging_refuses_an_insecure_session_cookie`, `test_host_prefixed_cookie_needs_secure_in_every_env` |

Acceptance criteria → tests:
1. `test_seeded_resident_logs_in_and_gets_an_httponly_lax_cookie`, `test_cookie_is_host_prefixed_and_secure_with_staging_settings`, `test_session_cookie_defaults_follow_the_environment`, `test_staging_refuses_an_insecure_session_cookie`, `test_host_prefixed_cookie_needs_secure_in_every_env`
2. `test_db_stores_only_the_token_hash_and_logs_never_hold_the_token`, `test_database_refuses_a_token_hash_that_isnt_sha256_hex`
3. `test_every_credential_failure_is_the_same_401_and_writes_nothing`
4. `test_logout_revokes_the_session_and_deletes_the_cookie`, `test_cookie_reused_after_logout_is_rejected`, `test_logout_without_a_valid_session_is_still_204`
5. `test_session_is_rejected_from_either_deadline_on`, `test_resident_session_dies_after_7_idle_days_and_staff_after_12_hours`, `test_session_dies_at_30_days_however_active`, `test_revoked_session_is_rejected`, `test_deactivated_user_is_rejected_on_the_next_request`, `test_missing_or_unknown_cookie_is_rejected`
6. `test_last_seen_at_is_written_at_most_every_5_minutes`
7. `test_idle_window_is_staff_length_only_for_an_active_staff_role`, `test_user_without_memberships_gets_the_resident_window`, `test_refresh_recomputes_the_idle_window_from_current_roles`
8. `test_malformed_login_body_is_422_and_verifies_nothing`
9. `test_login_upgrades_a_hash_made_with_weaker_parameters`, `test_login_keeps_a_current_hash`, `test_non_canonical_base64_is_not_a_valid_hash_and_needs_replacing`
10. `test_auth_routes_need_the_csrf_header`
11. `test_login_as_authenticates_a_world_user_without_a_password`, `test_current_session_carries_the_session_and_its_user`

Mutation probes (from the PR, 16 in all) each failed at least one test; the one partial result is M15
(turning off the staging cookie guard is still caught for "not Secure" by the any-environment `__Host-` rule,
and caught by one test for "no `__Host-`").

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6-astra` (medium) | `623bb88` | MERGE | Medium: unusable argon2 parameters skip `DUMMY_HASH`; Low: NUL email → 500 | fixed in `489c051` |
| 1 | Claude (Sonnet 5.5, high), security pass | `623bb88` | MERGE | M1: NUL email (same); L2: rehash can overwrite a concurrent password change; L3: stale loaded session; test gaps | M1 fixed, tests added in `489c051`; L2 fixed in round 2; L3 dismissed (doesn't reproduce; pinned by `test_refresh_updates_the_loaded_session_too`) |
| 2 | Codex `gpt-6-astra` (medium) | `489c051` | MERGE | Medium: non-canonical or huge parameters still skip `DUMMY_HASH`; Low: NUL User-Agent → 500 | fixed in `45427db` |
| 2 | Claude (Sonnet 5.5, high), security pass | `489c051` | **BLOCK** | H1: CI backend job red (ruff I001); M1: connection held across argon2; L1–L5 | H1, M1, L1, L4, L5 fixed in `45427db`; L2 accepted (D3); L3 follow-up (purge) |
| 3 | Codex `gpt-6-astra` (medium) | `45427db` | MERGE | none | — |
| 3 | Claude (Sonnet 5.5, high), security pass | `45427db` | MERGE | L1: weak-parameter hash verifies faster (accepted, D2); L2: login flood before P2-05 (follow-up) | — |

Fixes and the failures behind them:
- **Round 1 Codex Medium.** Input: a stored hash with a 7-byte salt, `t=0`, `p=0` or `v=99`. Outcome:
  `is_valid_hash` accepted it, the verification failed in microseconds, and the account answered faster than
  an unknown email. Evidence: 13 of 16 new cases red before, green after.
- **Round 2 Codex Medium.** The round 1 fix covered only the reported values; `t=03`, `t=+3`,
  `t=4294967296` passed. Fixed by the canonical comparison plus bounds (§4); 6 cases red before, green after.
- **NUL in email (round 1) and User-Agent (round 2).** asyncpg: `invalid byte sequence for encoding "UTF8":
  0x00` → 500 with a traceback. Now 422 and stripped respectively.
- **Round 2 Claude M1.** The reviewer measured 120 concurrent bad logins holding all 15 pooled connections
  "idle in transaction" and a logout slowing from 12 ms to 4.8 s. After the `rollback()` fix, round 3
  measured a logout during a 60-login burst at 30 ms.
- **Round 2 Claude H1.** CI's backend job had failed on both earlier heads; the PR had reported it green from
  a truncated output, and the local `ruff check` passed only because of a stale cache. Corrected in the PR
  body; evidence since then uses the full `gh pr checks` listing and `ruff check --no-cache`.

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **Cookie → user over HTTP on the stack.** No protected endpoint exists until P2-02; the dependency ran in
  tests only.
- **The `__Host-session` cookie over HTTPS** in a real browser: D-06 on staging.
- **Timing equality** between the 401 paths is structural, with one reviewer's measurement on one machine,
  not a statistical test.

Accepted risks:
- A real hash with weaker parameters verifies faster than `DUMMY_HASH` until its owner logs in again (D2).
- A resident promoted to staff keeps the 7-day idle deadline until their next request (D3).
- An expired session's cookie stays in the browser until sent or deleted (D4).

Follow-ups (to be added to their tickets in this PR's bookkeeping commit):
- **P2-05:** rate-limit login. Until then nothing bounds password guessing, or memory in a flood (up to 40
  concurrent argon2 runs in AnyIO's thread pool, 64 MiB each).
- **P3-01:** purge expired and revoked sessions; consider a per-user cap.
- **P4-02 / P4-04:** `strip_whitespace=False` on password fields and `check_password_policy`.
- **P4-02 / P4-05:** the P1-02 email-write items.
- **P2-02:** session listing, logout-all (`ix_sessions_user_id_live`); **P2-04:** `auth.*` audit events.

## 8. How to change this safely

- **Protect an endpoint:** depend on `get_current_user` (or `get_current_session`), and list it **before**
  dependencies that add to the request's session, because the refresh commits.
- **Revoke sessions** (logout-all, password reset, deactivation): set `revoked_at` with a conditional
  `UPDATE … WHERE user_id = … AND revoked_at IS NULL`; `resolve_session` needs no change. Deactivating a user
  already blocks their sessions through `User.is_active`.
- **Change a lifetime:** the `SESSION_*` settings; new values apply at login and at the next refresh. Tests
  use `frozen_clock`, never `datetime.now()`.
- **Change argon2 parameters:** existing hashes are upgraded at their owner's next login; keep
  `is_valid_hash`'s upper bounds above the new values or every login fails as `DUMMY_HASH`.
- **Add a model** in a new module: register it in `backend/app/models/registry.py`;
  `test_importing_the_app_alone_configures_every_mapper` catches a missing one.

## 9. Must explain, then quiz

**1. Why `SameSite=Lax` rather than `Strict`?** `Strict` withholds the cookie on *every* request that starts
on another site, including a top-level navigation: a resident clicking a link in a notification email would
land on the app without their cookie. `Lax` sends it on top-level `GET` navigations and withholds it on
cross-site `POST`s, subresources and `fetch` calls, which are what CSRF uses. ADR-0003 names `Lax` without
recording why. Inferred: `Strict` would add little here, because CSRF is already stopped by the middleware
(`X-Requested-With` plus a trusted `Origin`; P2-01a), while it would make cross-site links behave as logged
out for any page or download that the server answers on that first navigation. With this SPA the first
navigation only loads static HTML and the API calls that follow are same-origin, so the practical difference
today is small; `Lax` keeps future server-answered links (for example a file download linked from an email) working.

**2. Why write `last_seen_at` at most every 5 minutes?** Every authenticated request reads the session; if
every one also wrote it, each page load (often several API calls at once) would become several row updates,
WAL writes and row locks on the same row, for information that only has to be accurate to the idle window
(7 days or 12 hours). Five minutes caps it at one write per user per 5 minutes. The cost is precision: the
idle deadline can be up to 5 minutes earlier than "idle window after the last request", which is negligible
against 12 hours. The conditional `UPDATE` (`WHERE last_seen_at = <value read>`) makes concurrent requests
that cross the boundary write once (`test_refresh_does_not_overwrite_a_newer_write`).

**3. How does a request's cookie become a user, and which query does it run?**
`get_current_session` reads the cookie named `settings.session_cookie_name`, and `resolve_session` hashes it
with sha256 and runs one `SELECT … FROM sessions JOIN users` on `token_hash` (unique index) that also checks
not revoked, both deadlines in the future (by `clock.now()`) and `users.is_active` (§3 step 8). No row → 401
`not_authenticated`. A row → `touch_session` maybe refreshes (at most every 5 minutes: an `EXISTS` on
memberships and a conditional `UPDATE`, then commit) → `CurrentSession(session, user)`;
`get_current_user` returns the user. Roles are not loaded here; authorization reads them per request (P2-03).

Quiz:
1. Why does `login` call `db.rollback()` before verifying the password, not after?
2. A user's stored hash is `$argon2id$v=19$m=65536,t=03,p=4$…`. What happens when they log in with the right
   password, and why?
3. Why does `resolve_session` filter on `users.is_active` instead of deactivation revoking sessions?
4. Logout sets the cookie with `max_age=0` through the same helper as login. What would go wrong if it used
   `path="/api"`?
5. Why is the token stored as sha256 and not argon2, when passwords use argon2?

<details><summary>Answers</summary>

1. The `SELECT` opens a transaction that holds a pooled connection until it ends. argon2 takes tens of
   milliseconds per call and runs in a thread; ending the transaction first means a burst of bad logins doesn't hold every
   connection (round 2 M1; `test_login_holds_no_transaction_while_verifying`).
2. 401. `t=03` isn't the canonical form argon2 writes, so `is_valid_hash` is False and login verifies against
   `DUMMY_HASH`, which the password doesn't match. That is deliberate: argon2-cffi would parse it, but whether
   libargon2 accepts it is not something login should depend on. Such a hash can't come from
   `hash_password`; only a hand-edited row produces one.
3. It takes effect on the very next request with no second write to forget, and it also covers sessions that
   were created by any path. P2-02's logout-all and P4-04's password reset still revoke, because those keep
   the user active.
4. The browser would treat it as a different cookie (cookies are keyed by name, domain and path), so the
   original `Path=/` cookie would stay. The server-side revocation would still make it useless, but the
   browser would keep sending it.
5. The token is 32 random bytes: it can't be guessed, so the stored value only needs to be useless after a
   leak, and a fast hash does that. argon2 would cost tens of milliseconds and 64 MiB on every authenticated request.

</details>
