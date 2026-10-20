# Explanation — P4-04 Password reset

> **PR:** #90 · **Source revision:** `f22a3e8efb88063033ea30cc0f67da45dee4fb8a`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (1) reviewed this
> commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 90 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `f22a3e8` the diff (`git diff origin/main...HEAD`, every app path), the whole
> of `backend/app/auth/service.py::request_password_reset`, `::confirm_password_reset`, `::login` and
> `::_login_failed`, the router, schemas, model, migration `de8f8dbe23fb`, `backend/app/core/database.py::make_engine`,
> ADR-0019, the PR body, and the assertions of every test cited below; ran
> `uv run pytest -q tests/auth/test_password_reset.py tests/auth/test_password_reset_concurrency.py tests/test_world.py tests/invitations/test_accept.py tests/auth/test_login.py`:
> 183 passed. Differences from the plan: two small additions, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

Two public endpoints let a user who forgot their password set a new one. `POST /api/auth/password-reset/request`
always answers the same 202 and, only for an active account, emails a link holding a 43-character token that
lasts one hour and works once. `POST /api/auth/password-reset/confirm` takes the token and a new password,
sets it, and revokes every session of the account. Only the token's sha256 is stored, and the worker drops
the link from the job once the email is sent.

The two decisions that matter most: every write takes the **user row's lock first** (so two requests never
leave two live tokens, and a login racing a reset can't keep a session), and the engine now **hides SQL
parameters from error messages** (ADR-0019), which closes the "secret through a second output path" pattern
that P4-02b and P4-03 each hit once.

## 2. Decisions

### D1. Earlier tokens are revoked (a `revoked_at` column), not deleted or marked used

- **Problem or constraint:** a new request must invalidate the user's earlier unused tokens (ticket).
- **Chosen:** `password_reset_tokens.revoked_at`, set on the user's live tokens by each request, plus the
  partial unique index `uq_password_reset_tokens_user_id_live` (one token per user with `used_at` and
  `revoked_at` both NULL).
- **Alternatives rejected:** set `used_at` (then "used" no longer means "a password was set with it");
  delete the rows (loses when a token was issued and replaced, which an account-takeover investigation needs).
- **Tradeoffs and accepted limitations:** one column more than the ticket lists; rows accumulate, with no
  cleanup job yet (§7).
- **Basis:** autonomous. **Source:** recorded (PR #90 D1, ticket Frame notes D1).

### D2. One lock order: the user row, then tokens, then sessions

- **Problem or constraint:** two requests for one email must not leave two live tokens; a confirm and a
  request touch the same rows; login, session refresh and role changes already lock the user row
  (`backend/app/auth/service.py::lock_idle_deadlines`).
- **Chosen:** the request reads the user `FOR NO KEY UPDATE`; the confirm locks the user before claiming
  the token; login re-reads the hash under that same lock before it starts a session.
- **Alternatives rejected:** rely on the unique index alone (the second request would fail with a 500);
  confirm claims the token first (the opposite order to the request, so the two could deadlock).
- **Tradeoffs and accepted limitations:** requests for one account run one at a time (they are limited to 8
  per 15 minutes anyway).
- **Basis:** autonomous; the race tests in `backend/tests/auth/test_password_reset_concurrency.py`.
  **Source:** recorded (PR #90 D2, D8).

### D3. Confirm reads, ends the read, hashes, then claims with a fresh clock

- **Problem or constraint:** argon2 is slow (hundreds of milliseconds, 64 MiB) and must not hold a pooled
  connection; the token can expire or be used while it runs (CLAUDE.md lesson "don't write from a value read
  before a slow await", P4-02b).
- **Chosen:** as `backend/app/invitations/service.py::accept_invitation`: policy check, read the token (an
  unusable one is refused before any argon2), `rollback()`, hash off the event loop, then lock the user, read
  `clock.now()` again, and claim with a conditional `UPDATE … RETURNING`.
- **Alternatives rejected:** hash first (any random token would cost an argon2 run: a cheap way to load the
  server).
- **Tradeoffs and accepted limitations:** a weak password with an invalid token answers 422, not 400; both
  depend only on the input.
- **Basis:** CLAUDE.md lesson. **Source:** recorded (PR #90 D3).

### D4. SQL parameters are hidden from database error messages (ADR-0019)

- **Problem or constraint:** the P4-03 carry. A database error inside a request is logged by
  `RequestLoggingMiddleware` with `error_message=str(exc)` and the traceback, and SQLAlchemy writes the
  statement's `[parameters: …]` into both. The `email.send` job's INSERT carries the reset link.
- **Chosen:** `backend/app/core/database.py::make_engine` sets `hide_parameters=True`; the app engine and
  `backend/tests/conftest.py::engine` both use it, so request tests fail the way production does.
- **Alternatives rejected:** redact in the middleware (the traceback, the worker and the CLI would each need
  their own redaction, which is the pattern itself); drop `error_message` (the traceback still has it).
- **Tradeoffs and accepted limitations:** a database error's log line shows the SQL and the driver's
  message, not the values.
- **Basis:** P4-03 follow-up; the mutation probe in the PR (without it, the job-insert case of
  `test_failed_request_leaks_no_token` shows `"/reset-password/LeakCheck_x…"` in the log).
  **Source:** recorded (PR #90 D4, ADR-0019). Lasting, so it is an ADR and an inbox line.

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D5 Email locale: the user's when supported, else `en` | the building's | a reset has no building | autonomous | PR D5 |
| D6 Confirm is IP-limited (scope `reset_confirm`, `settings.rate_limit_reset_ip`) | no limit | every well-shaped call costs a read, and one with a live token an argon2 run | autonomous | PR D6 |
| D7 422 for an email that isn't a storable string of 1-320 characters | treat it as unknown (202) | Postgres fails on NUL and lone surrogates (CLAUDE.md lesson); the answer depends on the input only | CLAUDE.md lesson | PR D7 |
| D8 Login re-reads the hash under the user lock | leave login alone | a login checked against the old password could start a session after the reset revoked them all | criterion 8 | PR D8 |
| `token` accepted as any string ≤ 200, checked by shape in the service | `max_length=43` in the schema | a wrong-shaped token then gets the same 400 as an unknown one | as invitations | Inferred from `backend/app/auth/schemas.py::PasswordResetConfirmIn` comment |

**Framing changes:** criteria 1-7 sharpened (what "byte-identical" compares, the 1-hour boundary, the
policy reason codes, rate limits for unknown emails too), 8-12 added (races, the leak test, confirm rate
limit, input shape, no cookie on confirm). None loosened. See the ticket's Frame notes.

**Plan versus final code:** compared with the PR's Plan. Two additions it didn't list:
`PASSWORD_POLICY_MESSAGES` moved from `backend/app/invitations/service.py` to
`backend/app/core/security.py::PASSWORD_POLICY_MESSAGES`, so both 422 paths share it (the import the other way
would be circular: invitations import `app.auth.service`); and `backend/tests/test_world.py` gained the new
table in its exact row-count map. Otherwise the code matches the Plan.

## 3. How it is implemented

### Overview

- `backend/app/auth/router.py::password_reset_request` / `::password_reset_confirm`: thin routes on the
  `/api/auth` router, both in `backend/app/auth/allowlist.py::AUTH_ALLOWLIST` (no session) and both behind
  the CSRF middleware (unsafe methods).
- `backend/app/auth/service.py::request_password_reset` / `::confirm_password_reset`: the use-cases, one
  commit each.
- `password_reset_tokens` (`backend/app/auth/models.py::PasswordResetToken`).
- The `password_reset` email template (`backend/app/email/templates/en/password_reset.txt` and `.html`),
  queued through `queue_email` and sent by the worker's `email.send` handler, which drops `context` from the
  payload after a successful send.

### Walkthrough (variant A)

**Request.** `POST /api/auth/password-reset/request {"email": "Resident1@Example.test"}`

1. Schema: `PasswordResetRequestIn` strips the string (as every `InputModel`) and refuses empty, over 320,
   NUL or a lone surrogate with 422. Nothing has been looked up yet.
2. `request_password_reset` counts the attempt against `reset:ip:<ip>` (30 per 10 min) and
   `reset:email:<sha256 of lower(email)>` (8 per 15 min). Over either: 429 `rate_limited` with `Retry-After`,
   before any lookup, so an unknown email is limited the same way.
3. It always makes a token and its hash (the "constant token work" the ticket asks for).
4. `SELECT users.id, email, locale, is_active FROM users WHERE lower(email) = lower($1) FOR NO KEY UPDATE`.
5. Only for an active account: `UPDATE password_reset_tokens SET revoked_at = now WHERE user_id = … AND
   used_at IS NULL AND revoked_at IS NULL`, then `INSERT` the new hash with `expires_at = now + 1 h`, then
   `queue_email(to=<stored address>, template="password_reset", context={"link": "/reset-password/<token>"})`.
6. Always: audit `auth.password_reset_requested`, with `{"user_id": …}` when an account matched (active or
   not), then commit.
7. The route returns `service.RESET_REQUESTED`, one constant object: 202
   `{"detail": "If an account exists for this email, we sent a link to reset its password."}`.

**Confirm.** `POST /api/auth/password-reset/confirm {"token": "<43 chars>", "new_password": "…"}`

1. Schema: `token` any string ≤ 200; `new_password` 1-128 characters, not stripped.
2. `confirm_password_reset` counts against `reset_confirm:ip:<ip>` (30 per 10 min).
3. `check_password_policy`: a refusal is 422 `validation_error` with
   `errors: [{"loc": ["body", "new_password"], "msg": …, "type": "password_too_short" | …}]`, never echoing the
   password. The token is untouched.
4. Token shape (`_RESET_TOKEN`, 43 URL-safe base64 characters), else 400.
5. Read: the token's `user_id` where the hash matches, it is live (`used_at` and `revoked_at` NULL,
   `expires_at > now`) and the user is active. None: 400 `reset_token_invalid`.
6. `rollback()`, then argon2id in a thread.
7. `SELECT users.id … WHERE id = … AND is_active FOR NO KEY UPDATE`; `now = clock.now()` again;
   `UPDATE password_reset_tokens SET used_at = now WHERE token_hash = … AND <live at now> RETURNING id`.
   Either missing: 400, and the session's rollback undoes everything.
8. `UPDATE users SET password_hash = …`, `revoke_all_sessions` (every session with `revoked_at` NULL), audit
   `auth.password_reset_completed {"sessions_revoked": n}`, commit. 204, no cookie.

### Data model changes

`password_reset_tokens` (migration `de8f8dbe23fb`, a new table only):

| Column / constraint | Why |
|---|---|
| `user_id` FK users `ON DELETE CASCADE` | a token is a credential, not history (as `sessions`) |
| `token_hash` unique, `ck_password_reset_tokens_token_hash_is_sha256_hex` | only a sha256 hex string fits, so a raw token can't be stored by mistake |
| `expires_at`, `used_at`, `revoked_at`, `created_at` (server default) | the state is read from the timestamps |
| `uq_password_reset_tokens_user_id_live` unique on `user_id` WHERE `used_at IS NULL AND revoked_at IS NULL` | at most one live token per user; backs D2's lock. It counts expired tokens too, so the request revokes those as well |

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/auth/service.py` | the two use-cases; login's re-check under the lock | +190 −18 |
| `backend/app/auth/models.py` | `PasswordResetToken` | +30 |
| `backend/migrations/versions/de8f8dbe23fb_password_reset_tokens_p4_04.py` | the table and index | +69 |
| `backend/app/auth/router.py`, `schemas.py`, `allowlist.py` | routes, bodies, allowlist | +71 −3 |
| `backend/app/core/database.py` | `make_engine` with `hide_parameters` | +13 −1 |
| `backend/app/core/security.py`, `backend/app/invitations/service.py` | shared policy messages | +9, +2 −7 |
| `backend/app/audit/actions.py` | two actions | +3 |
| `backend/app/email/templates/en/password_reset.*` | subject, text, HTML | +15 |
| `backend/tests/auth/test_password_reset.py`, `test_password_reset_concurrency.py`, `conftest.py` | tests | +886 |
| `backend/tests/conftest.py`, `backend/tests/test_world.py` | the tests' engine via `make_engine`; the new table counted | +5 −2 |
| `docs/adr/0019-sql-parameters-hidden-from-errors.md` (+ index row), `frontend/src/api/schema.d.ts` | ADR; generated types | +43, +152 |

`backend/app/auth/service.py::request_password_reset`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/f22a3e8efb88063033ea30cc0f67da45dee4fb8a/backend/app/auth/service.py))

```python
    await limiter.enforce(ip_key("reset", ip), settings.rate_limit_reset_ip)
    await limiter.enforce(await limiter.email_key("reset", email), settings.rate_limit_reset_email)
    token = generate_token()
    token_hash = hash_token(token)
    # lower() on both sides in Postgres, as `login`.
    found = (
        await db.execute(
            select(User.id, User.email, User.locale, User.is_active)
            .where(func.lower(User.email) == func.lower(email))
            .with_for_update(key_share=True)
        )
    ).one_or_none()
    if found is not None and found.is_active:
        now = clock.now()
        # Expired ones too: the index counts every token neither used nor revoked.
        await db.execute(
            update(PasswordResetToken)
            .where(
                PasswordResetToken.user_id == found.id,
                PasswordResetToken.used_at.is_(None),
                PasswordResetToken.revoked_at.is_(None),
            )
            .values(revoked_at=now)
        )
        await db.execute(
            insert(PasswordResetToken).values(
                user_id=found.id, token_hash=token_hash, expires_at=now + PASSWORD_RESET_TTL
            )
        )
        await queue_email(
            db,
            # The stored address, not the one typed.
            to=found.email,
            template="password_reset",
            # ...
            context={"link": f"/reset-password/{token}"},
            locale=found.locale if found.locale in SUPPORTED_LOCALES else DEFAULT_LOCALE,
        )
    await record_audit(
        db,
        action=actions.AUTH_PASSWORD_RESET_REQUESTED,
        entity_type="user",
        metadata={"user_id": found.id} if found is not None else None,
    )
    await db.commit()
```

- The limits run first and the token is made on every path; the only branch is whether rows are written.
- `with_for_update(key_share=True)` is `FOR NO KEY UPDATE` (D2). Without it, two concurrent requests both
  revoke nothing new and both insert: the second fails on the unique index with a 500 (the mutation probe
  showed `test_racing_requests_leave_one_live_token` failing).
- The link lives in `context`, the payload key the `email.send` handler lists in `sensitive_keys`, so it is
  dropped after sending.

`backend/app/auth/service.py::confirm_password_reset` (the write half)

```python
    if user_id is None:
        raise _reset_invalid()
    await db.rollback()
    password_hash = await to_thread.run_sync(hash_password, new_password)

    active = await db.scalar(
        select(User.id).where(User.id == user_id, User.is_active).with_for_update(key_share=True)
    )
    now = clock.now()
    claimed = await db.scalar(
        update(PasswordResetToken)
        .where(PasswordResetToken.token_hash == token_hash, _reset_token_live(now))
        .values(used_at=now)
        .returning(PasswordResetToken.id)
    )
    if active is None or claimed is None:
        raise _reset_invalid()
    await db.execute(update(User).where(User.id == user_id).values(password_hash=password_hash))
    revoked = await revoke_all_sessions(db, user_id)
    await record_audit(
        db,
        action=actions.AUTH_PASSWORD_RESET_COMPLETED,
        entity_type="user",
        entity_id=user_id,
        actor_user_id=user_id,
        metadata={"sessions_revoked": revoked},
    )
    await db.commit()
```

- `now` is read after the lock, not before argon2 (D3). Moving it before the hash made
  `test_token_that_expires_while_the_confirm_waits_is_refused` fail (mutation probe).
- The conditional `UPDATE … RETURNING` is what decides between two confirms of one token: the second waits on
  the user lock, then matches nothing (`test_racing_confirms_of_one_token_have_one_winner`).
- Raising after writes is safe: the router commits nothing on an error and closing the session rolls back.

`backend/app/auth/service.py::login` (the re-check, D8)

```python
    matches = await to_thread.run_sync(verify_password, password, usable or DUMMY_HASH)
    if found is None or usable is None or not matches or not found.is_active:
        await _login_failed(db, found.id if found is not None else None)
    # The user's lock (taken again by the session's start), then the hash and status again: a
    # password reset may have committed while argon2 ran, and a session started from the old
    # password would outlive the reset that ended them all (P4-04 criterion 8).
    current = (
        await db.execute(
            select(User.password_hash, User.is_active)
            .where(User.id == found.id)
            .with_for_update(key_share=True)
        )
    ).one()
    if current.password_hash != usable or not current.is_active:
        await _login_failed(db, found.id)
```

- Without it, a login that verified the old password just before a reset committed would wait on the lock,
  then start a session the reset never saw (`test_login_checked_against_the_old_password_starts_no_session_after_a_reset`
  failed on that mutation). The other order (login first) is covered by
  `test_login_that_started_its_session_first_is_revoked_by_the_reset`.
- `_login_failed` is the old failure block moved into a helper (audit, commit, raise), unchanged.

`backend/app/core/database.py::make_engine`

```python
def make_engine(url: str, **options: Any) -> AsyncEngine:
    """An engine with the app's options; the tests build theirs with it too.

    `hide_parameters`: a database error's message and traceback never carry a statement's values,
    such as an emailed link in a job's payload, into a log line or stderr (ADR-0019).
    """
    return create_async_engine(url, hide_parameters=True, **options)
```

- The worker, the CLI, the request sessions and the rate limiter all use the engine this builds
  (`AsyncSessionLocal`), so every app output path is covered at once (D4).

`backend/tests/auth/test_password_reset.py::test_failed_request_leaks_no_token` (criterion 9, trimmed)

```python
@pytest.mark.parametrize("fail_at", ["token-insert", "job-insert", "audit-insert", "commit"])
async def test_failed_request_leaks_no_token(app_client, db, monkeypatch, caplog, capsys, fail_at):
    await _user(db)
    monkeypatch.setattr(service, "generate_token", lambda: SECRET)
    # ... a BEFORE INSERT trigger that raises on the chosen table, or a commit that raises
    async with app_client(raise_app_exceptions=False) as c:
        r = await c.post(REQUEST, json={"email": EMAIL})

    assert_problem(r, 500, "internal_error")
    formatter = JsonFormatter()
    logged = "\n".join(formatter.format(record) for record in caplog.records)
    assert "request_failed" in logged
    captured = capsys.readouterr()
    for output in (r.text, logged, captured.out, captured.err):
        assert SECRET not in output
        assert "/reset-password/" not in output
```

- It formats every captured record with the production `JsonFormatter` (message, `error_message`, traceback),
  so it checks what a log line would hold, not just the message text.
- Only the job-insert case can fail on parameters (the other statements carry no token), but all four
  points the P4-03 carry named are covered.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| The answer tells known from unknown emails | One constant body; headers equal but `X-Request-ID` | `test_request_answers_identically_whether_or_not_the_account_exists` |
| A raw token is stored | Only the sha256; check constraint | `test_only_the_hash_is_stored_and_the_sent_job_drops_the_link`, `test_stored_token_hash_must_be_sha256_hex` |
| The link stays in the job after sending | `context` dropped on success | `test_only_the_hash_is_stored_and_the_sent_job_drops_the_link` (runs the worker against a fake SMTP server) |
| A token used twice, at or past 1 h, replaced, unknown, malformed, empty | One 400 body, password unchanged | `test_reused_expired_replaced_or_unknown_tokens_are_invalid` (7 cases) |
| A newer token dies with the older one | Only the older is revoked | `test_newer_token_still_works_after_the_older_was_refused` |
| One user's request revokes another's token | Revokes by `user_id` | `test_new_request_revokes_only_that_users_live_tokens` |
| A deactivated user resets | 400, password unchanged, token unused | `test_token_of_a_deactivated_user_is_invalid` |
| An inactive user gets an email | 202, no row, no job | `test_inactive_user_gets_the_same_202_and_no_email` |
| A weak password burns the token | 422 first, token untouched | `test_weak_password_is_422_and_the_token_stays_usable` |
| Spaces trimmed from the new password | Not stripped | `test_new_password_is_not_stripped` |
| Sessions survive a reset | All revoked, including the caller's; others' untouched | `test_confirm_sets_the_password_and_revokes_every_session` |
| Flooding by email or IP | 429 after 8 per email (known or not) and 30 per IP | `test_ninth_request_for_one_email_is_rate_limited`, `test_requests_from_one_ip_are_rate_limited`, `test_confirm_is_rate_limited_per_ip` |
| Reset requests block logins | Separate `reset` scope | `test_reset_counts_are_apart_from_login_counts` |
| NUL / lone surrogate reach Postgres | 422 in the schema | `test_malformed_email_is_422_without_a_lookup`, `test_malformed_confirm_is_422` |
| CSRF bypass on the open routes | 403 `csrf_failed` | `test_reset_routes_need_no_session_and_still_need_csrf` |
| Races (two confirms, two requests, expiry while waiting, login vs reset both orders) | Locks + conditional UPDATE + fresh clock | the five tests in `backend/tests/auth/test_password_reset_concurrency.py` |
| A failing request logs the token | Parameters hidden | `test_failed_request_leaks_no_token` (4 cases), `test_app_engine_hides_sql_parameters` |
| Response timing differs for known emails | Not prevented: three more inserts | No test (§7) |

Acceptance criteria → tests: 1 `test_request_answers_identically_whether_or_not_the_account_exists`;
2 `test_only_the_hash_is_stored_and_the_sent_job_drops_the_link`; 3 `test_confirm_sets_the_password_and_revokes_every_session`;
4 `test_reused_expired_replaced_or_unknown_tokens_are_invalid`; 5 `test_weak_password_is_422_and_the_token_stays_usable`;
6 `test_ninth_request_for_one_email_is_rate_limited`; 7 `test_inactive_user_gets_the_same_202_and_no_email`;
8 `test_password_reset_concurrency.py`; 9 `test_failed_request_leaks_no_token`; 10 `test_confirm_is_rate_limited_per_ip`;
11 `test_malformed_email_is_422_without_a_lookup`; 12 within criterion 3's test (`set-cookie` absent). The
stack journey in the PR runs criteria 1-5 against `make up` with Mailpit.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` high, with the Tier 1 security pass | `f22a3e8` | MERGE | none | — |

James set the reviewers for this run in the session: one fresh Codex `gpt-6.1-sol` reviewer at high effort,
no Claude reviewer (the playbook's Tier 1 default is a Claude reviewer with the security pass plus Codex).
Codex ran the full suite and wrote three scratch proofs (constraint-error logging, migration upgrade and
downgrade with model drift, confirm rollback after an audit failure); the implementer re-ran them (3 passed)
and deleted them. No finding changed the code.

## 7. Not verified, accepted risks and follow-ups

- **Timing is not constant.** A known active account's request does three more statements (revoke, insert,
  job insert) than an unknown one, a few milliseconds that a patient attacker could measure. The ticket asks
  only for the rate-limit check and the token work on both paths, which the code does; nothing measures the
  difference. Accepted in the PR; tracked only here and in the PR.
- **No cleanup of old token rows.** Used, revoked and expired rows stay forever (D1). A follow-up for a
  cleanup job like `sessions.cleanup` goes to the inbox in the bookkeeping commit.
- **Only `en` templates.** A user with locale `fr` gets the English email (the `fr` folder has no templates
  yet for any email).
- **The frontend page** `/reset-password/<token>` doesn't exist yet: it is P4-07's. Until then no page handles the
  emailed link.
- **Real SMTP** was not used: the tests use a fake SMTP server and the journey used Mailpit.
- **ADR-0019 covers the app engine only.** Scratch-database tests (`create_async_engine`) and Alembic
  (`async_engine_from_config` in `backend/migrations/env.py`) build their own engines; they run no request
  code that logs.

## 8. How to change this safely

- Changing the token lifetime: `PASSWORD_RESET_TTL` in `backend/app/auth/service.py`; the email text says
  "1 hour" in both template parts; `test_token_expires_one_hour_after_the_request` and the at/past-one-hour
  cases will fail until updated.
- Adding a write that touches a user's tokens or sessions: take the user row first
  (`with_for_update(key_share=True)` or `lock_idle_deadlines`), or the race tests in
  `test_password_reset_concurrency.py` and the invitation ones can deadlock.
- Adding another emailed token (email verification): put the link in `context`, use `make_engine`'s engine,
  and copy `test_failed_request_leaks_no_token`'s shape for the new route.
- Changing the request's response: it must stay one constant for every allowed request; criterion 1's test
  compares bytes and headers.

## 9. Must explain, then quiz

**1. Why is the response identical for unknown emails? What attack does that prevent?** Account
enumeration: with different answers, anyone could test a list of addresses and learn which have accounts
here, then aim phishing or password guessing at them. `backend/app/auth/router.py::password_reset_request`
returns the one object `RESET_REQUESTED`, and the rate limits run before the lookup, so even a 429 depends
only on how often the address was tried, not on whether it exists.

**2. Why does a reset revoke all sessions?** A reset often follows a compromise: an attacker who stole the
password or a cookie may hold a live session. Changing the password alone wouldn't end it, since sessions are
checked by their own token (`resolve_session`), not the password. `confirm_password_reset` calls
`revoke_all_sessions` in the same transaction, and login's re-check (D8) stops a session from being started
from the old password in the gap.

**3. Why 1 hour for a reset token, while invitations last 7 days?** Recorded: the ticket fixes both. Inferred:
a reset link grants full control of an existing account, possibly one with history and building access, and
the user asked for it a moment ago, so a short window costs them nothing; an invitation offers access the
inviter chose, to someone who may not read email for days, and a manager can revoke it.

**4. Why scrub the link from the job payload after sending?** Succeeded jobs stay in the jobs table for 14 days
(`backend/app/jobs/service.py::SUCCEEDED_RETENTION`), where operators and backups can read them; a live link there is a working credential for the next hour. The
`email.send` handler lists `context` in `sensitive_keys`, and the worker removes it on success, as
`test_only_the_hash_is_stored_and_the_sent_job_drops_the_link` asserts. Combined with storing only the hash,
no table holds a usable token after the email leaves.

Quiz:

1. A user asks for two resets a minute apart and clicks the first email's link. What happens, and which
   statement makes it so?
2. Why does `confirm_password_reset` read the token before hashing the password, and again after?
3. What would break if `make_engine` dropped `hide_parameters=True`?
4. What would break if login stopped re-reading `password_hash` under the lock?
5. How would you extend this to email verification on signup?

<details><summary>Answers</summary>

1. 400 `reset_token_invalid`: the second request's `UPDATE password_reset_tokens SET revoked_at = now …` in
   `request_password_reset` revoked the first token, and the confirm's live condition requires
   `revoked_at IS NULL`.
2. Before: an unusable token is refused without an argon2 run (cheap refusals). After: the token may have
   been used, replaced or expired during the slow hash or while waiting on the user lock, so the claim
   re-checks it with a fresh clock in the writing statement.
3. A request that fails at the job insert would log the reset link in `error_message` and the traceback;
   `test_failed_request_leaks_no_token[job-insert]` fails (the mutation probe showed it).
4. A login that verified the old password just before a reset committed could start a session after the
   reset revoked all of them; `test_login_checked_against_the_old_password_starts_no_session_after_a_reset`
   fails.
5. A table like `password_reset_tokens` (hash only, expiry, `used_at`), a request use-case that locks the
   user and queues a template with the link in `context`, a confirm that claims the token conditionally and
   sets `users.email_verified_at`, allowlist entries, and a leak test of the same shape.

</details>
