# P4-04 — Password reset

| Field | Value |
|---|---|
| Phase / lane | P4 / B (moved from A: off the critical path; pairs with P4-07) |
| Risk tier | 1 |
| Depends on | P3-02, P2-05, P2-04 |
| Replaces old | M3-T06 (reset part), M3-T13 (reset delivery) |
| Status | todo |

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
