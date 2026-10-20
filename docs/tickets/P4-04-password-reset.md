# P4-04 — Password reset

| Field | Value |
|---|---|
| Phase / lane | P4 / B (moved from A: off the critical path; pairs with P4-07) |
| Risk tier | 1 |
| Depends on | P3-02, P2-05, P2-04 |
| Replaces old | M3-T06 (reset part), M3-T13 (reset delivery) |
| Status | done |

## Goal

Users who forget their password can reset it through an emailed, single-use, short-lived link, without the
system revealing whether an account exists. A reset logs out all sessions.

## Why

This completes demo journey 7, and it is one of the most commonly attacked flows in any web app
([OWASP Forgot Password Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Forgot_Password_Cheat_Sheet.html)).

## Scope

- In:
  - **`password_reset_tokens` table:** `user_id`, `token_hash` unique, `expires_at` (1 hour), `used_at`,
    `created_at`.
  - **`POST /api/auth/password-reset/request`** `{email}` (allowlisted):
    - **always 202**, with the same body: "If an account exists, we sent an email"
    - rate-limited per IP and per hashed email (P2-05 policies)
    - if an active user exists, the request invalidates their earlier unused tokens, creates a new one, and
      queues the `password_reset` email with the link `${APP_BASE_URL}/reset-password/{token}`
      (`sensitive_keys` scrub the link after sending)
    - audit `auth.password_reset_requested` (with user_id only if it exists)
  - **`POST /api/auth/password-reset/confirm`** `{token, new_password}` (allowlisted):
    - validates that the token is unused and unexpired, and the password policy (P2-01)
    - sets the argon2id hash and marks the token used
    - calls **`revoke_all_sessions`** (P2-02)
    - audit `auth.password_reset_completed`
    - 204
    - an invalid, expired or used token gives 400 `reset_token_invalid`
  - **Email template `password_reset`.**
  - **Timing:** avoid early returns that make "unknown email" measurably faster. Always do the rate-limit
    check, plus a constant amount of token-generation work.
- Out:
  - email verification on signup (pilot checklist)
  - MFA reset (pilot)

## Interfaces

`auth_password_reset_request`, `auth_password_reset_confirm`.

## Acceptance criteria

1. **Given** an unknown email and a known email, **then** the responses are byte-identical 202, and only the
   known email produces a job.
2. **Given** a known email, **then** the DB stores only the token hash, and after the worker sends the email
   the job payload no longer contains the link.
3. **Given** confirm with a valid token, **then** the password changes, the user's other sessions get 401, and
   login with the new password works.
4. **Given** the same token again, a token past 1 hour, or an older token after a newer request, **then** 400
   `reset_token_invalid`.
5. **Given** a weak password (`password123`), **then** 422, and the token remains usable.
6. **Given** 9 requests for one email in 15 minutes, **then** 429. The body for allowed requests stays
   generic.
7. **Given** an inactive user's email, **then** 202 and no email.

## Test plan

- `tests/auth/test_password_reset.py`, using the world fixture and a frozen clock.
- Commands: `make test`.

## Likely files

`backend/app/auth/{models,service,router,schemas}.py`, `backend/app/email/templates/en/password_reset.*`,
`backend/app/auth/allowlist.py`, `backend/migrations/versions/<new>.py`,
`backend/tests/auth/test_password_reset.py`.

## Must explain (learning checkpoint)

1. Why is the response identical for unknown emails? What attack does that prevent?
2. Why does a reset revoke all sessions?
3. Why is the token valid for 1 hour, while invitations last 7 days?
4. Why scrub the link from the job payload after sending?

## Carried from P2-01b (do while framing)

- Password fields must not be stripped: `InputModel` strips strings, so declare them
  `Annotated[str, StringConstraints(strip_whitespace=False, max_length=PASSWORD_MAX_LENGTH)]` as
  `app/auth/schemas.py::LoginIn` does (PR #57 D5), and call `check_password_policy`, mapping
  `WeakPasswordError.reason` to a 422 without echoing the password.
- Revoke all the user's sessions on reset (`UPDATE sessions SET revoked_at = now WHERE user_id = … AND
  revoked_at IS NULL`, index `ix_sessions_user_id_live`); `resolve_session` needs no change.

## Carried from P2-03 (do while framing)

- Add this ticket's routes that work without a session to `backend/app/auth/allowlist.py::AUTH_ALLOWLIST`
  as `(method, path)` pairs; the fitness test `test_every_api_route_requires_a_session_unless_allowlisted`
  fails otherwise, and the allowlist holds only routes that exist (PR #59 D1).
- Routes: password-reset request and confirm.

## Carried from P2-04 (do while framing)

- `revoke_all_sessions` records no audit event (PR #60 D4). The reset use-case records its own action (for
  example `auth.password_reset`, with `{"sessions_revoked": n}`) with `record_audit`, before its single commit.

## Carried from P2-05 (do while framing)

- The policies exist: `settings.rate_limit_reset_ip` (30/10 min) and `settings.rate_limit_reset_email`
  (8/15 min). Inject `get_rate_limiter`, and in the use-case, **before any lookup**:
  `await limiter.enforce(ip_key("reset", ip), settings.rate_limit_reset_ip)` then
  `await limiter.enforce(await limiter.email_key("reset", email), settings.rate_limit_reset_email)`. Use the
  `reset` scope so reset and login counts stay apart; document 429 (`problem_responses(..., 429)`). See
  `docs/explanations/P2-05-rate-limiting.md` §8.

## Carried from P4-03 (do while framing; first follow-up)

- Pattern "a secret leaks through a second output path" appeared twice (P4-02b: the CSRF middleware's log
  line kept the invitation token the request log redacted; P4-03: a database error's message printed the
  email job's `/invite/<token>` though logs and tracebacks were covered). The reset token has the same
  paths. Promote it in this PR: a `CLAUDE.md` lesson, or better a test that fails a request, a job insert
  and a commit while holding a token and asserts the token reaches no log line and no error output.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - **1** "Byte-identical" means: status 202, the same body bytes, and the same headers apart from
    `X-Request-ID`. Checked for an unknown email, a known active one, the known one in other case, a
    malformed address (`not-an-email`) and an inactive user (7). Only the known active email produces a
    job: exactly one `email.send`, to the stored address, with the `password_reset` template.
  - **2** The row's `token_hash` is sha256 hex (check constraint, as `sessions`); no column, response or
    audit row holds the token; after `Worker.run_once` sends it, the job payload has no `context` and no
    token, and the sent email's text and HTML parts hold the same `${APP_BASE_URL}/reset-password/<token>`.
  - **3** Confirm → 204; the token gets `used_at`; every session of the user that existed (two of them,
    one being the caller's own cookie) answers 401 on `/api/auth/me`; another user's session still works;
    login with the old password is 401 and with the new one 204; audit `auth.password_reset_completed`
    with `{"sessions_revoked": n}`.
  - **4** Also invalid, with the same 400 `reset_token_invalid` body and no password change: a token at
    exactly 1 hour (`expires_at <= now`), an unknown well-formed token, a malformed one, and a token whose
    user was deactivated after the request.
  - **5** 422 names `new_password` with the policy's reason code (`password_too_common` for
    `password123`… which is 11 characters, so `password_too_short`; both are tested), never echoes the
    password; the same token then succeeds with a strong password.
  - **6** The 9th request for one email in 15 minutes is 429 with `Retry-After`, whether or not the email
    has an account (the count runs before the lookup); 8 allowed ones had the identical 202 body. The 31st
    request from one IP in 10 minutes is 429 too.
- Cases the ticket missed (added):
  - **8 Concurrency.** Two confirms of one token: one 204, one 400. Two requests for one email at once:
    one live token (the user row is locked first). A confirm that waits on a lock and passes the hour
    meanwhile is refused (expiry is final; CLAUDE.md lesson). A login whose argon2 check started before a
    reset committed cannot start a session after it: login re-reads the hash under the user lock.
  - **9 Secrets through a second output path** (the P4-03 carry). A request that fails at the token
    insert, the job insert, the audit insert or the commit answers the generic 500, and no log line,
    traceback or response holds the token or the link. Fix at the source: the engine hides SQL parameters
    from error messages.
  - **10** Confirm is rate-limited per IP (scope `reset_confirm`, `settings.rate_limit_reset_ip`): 429.
  - **11** Input shape: a missing or non-string email, one over 320 characters, with NUL or a lone
    surrogate is 422 before any lookup (it can't depend on an account). Passwords aren't stripped.
  - **12** A confirm needs no session and leaves none; it doesn't log the caller in.
- Tenant table (docs/ENGINEERING_PRACTICES.md §7): n/a for rows 1-7, these are not building routes
  (`/api/auth/...`, allowlisted). Row 8 (invalid transition) is criterion 4, row 9 (retry) the reused
  token, row 10 (concurrency) criterion 8.
- Criteria loosened (with reason; also listed in the inbox): none. "Always 202" stays for every
  well-formed request; a 422 for a body that is not a string email of at most 320 storable characters
  (11) depends on the input only, never on an account.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - D1 Earlier unused tokens are **revoked** (`revoked_at`, a column the ticket's list lacks), not deleted
    or marked used: `used_at` keeps meaning "a password was set with it" (autonomous).
  - D2 The request locks the user row (`FOR NO KEY UPDATE`) before revoking and inserting, and the confirm
    locks it before claiming the token: one lock order (user, then tokens, then sessions) and one live
    token per user; a partial unique index backs it (autonomous).
  - D3 Confirm checks the policy first, reads the token, ends the read, hashes with argon2, then claims
    the token with a fresh clock in the conditional UPDATE (as `accept_invitation`; CLAUDE.md lesson).
  - D4 `hide_parameters=True` on the app's engine and the tests' (one factory), for criterion 9: lasting,
    so an ADR and a line in the inbox (autonomous).
  - D5 The email's locale is the user's when supported, else `en` (as invitations use the building's).
- Split: none. Estimate ~350 non-test lines (model and migration ~80, service ~160, router and schemas
  ~60, templates ~20, engine and login ~20).

## Follow-ups (from PR #90)

- No cleanup job for `password_reset_tokens`: used, revoked and expired rows stay. Add one like
  `sessions.cleanup` (daily, delete rows ended more than 30 days ago) when the next auth or jobs ticket runs.
- Response timing is not constant: a known active account's request does three more statements. Accepted
  (the ticket asks only for the rate-limit check and the token work on both paths).
- The `/reset-password/:token` page is P4-07's (carried there).
