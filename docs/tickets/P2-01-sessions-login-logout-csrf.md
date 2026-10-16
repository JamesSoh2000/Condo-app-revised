# P2-01 — Password hashing, sessions, login/logout and CSRF

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P1-02, P1-04 |
| Replaces old | M3-T01, M3-T02 (redesigned per ADR-0003) |
| Status | todo |

## Goal

Users log in with email and password and receive an HttpOnly session cookie backed by a hashed server-side
session. They can log out. State-changing requests are protected against CSRF.

## Why

This is the foundation of every authorization check. The design is deliberately simpler than the old JWT
plan ([ADR-0003](../adr/0003-same-origin-server-side-sessions.md)).

## Scope

- In:
  - **`app/core/security.py`:**
    - `hash_password` / `verify_password` / `needs_rehash` using argon2id (`pwdlib[argon2]` or
      `argon2-cffi`)
    - `generate_token()` = `secrets.token_urlsafe(32)`
    - `hash_token(t)` = sha256 hex
    - a module-level `DUMMY_HASH`, so the unknown-email path costs the same as a wrong password
  - **Password policy:** length 12–128, rejects the 1,000 most common passwords (embedded list), no
    composition rules.
  - **`sessions` table** (`app/auth/models.py`):
    - `user_id` FK
    - `token_hash` unique
    - `created_at`, `last_seen_at`
    - `expires_at` (absolute), `idle_expires_at`
    - `revoked_at`
    - `user_agent` String(300), `ip` INET
    - index `(user_id) WHERE revoked_at IS NULL`
  - **Settings:**
    - `session_cookie_name` (`session` in dev/test, `__Host-session` in staging/prod)
    - `session_cookie_secure`
    - `session_absolute_days=30`
    - `session_idle_resident_days=7`, `session_idle_staff_hours=12`
  - **Endpoints** (`app/auth/router.py`, allowlisted from auth):
    - `POST /api/auth/login` `{email, password}`: 204 plus `Set-Cookie`; or 401 `invalid_credentials`,
      identical for unknown email, wrong password, null password or inactive user; or 422.
      - The idle window is staff-length if the user has any active membership with a staff role.
      - Rehashes the password if `needs_rehash`.
    - `POST /api/auth/logout`: revokes the current session if present, clears the cookie, returns 204
      (idempotent).
  - **Dependencies** (`app/auth/deps.py`):
    - `get_current_session`: reads the cookie, hashes it, loads a not-revoked, not-expired session joined to
      an active user.
    - It refreshes `last_seen_at` and `idle_expires_at` **at most once per 5 minutes**.
    - `get_current_user` builds on it. Failure gives 401 `not_authenticated`.
  - **CSRF middleware** (`app/core/csrf.py`): for `POST/PUT/PATCH/DELETE` under `/api/`, require
    - `Origin` in `trusted_origins` (or `Origin` absent with `Sec-Fetch-Site: same-origin`), **and**
    - header `X-Requested-With: fetch`
    - otherwise 403 `csrf_failed`
  - **Seed (P1-06):** dev and staging users get the password `DevPassword!2026`, documented in the README.
    Never applied in prod.
  - **Test helpers** (`tests/helpers/auth.py`):
    - `login_as(client, user)`: creates a session row directly and sets the cookie on the client
    - a default `X-Requested-With: fetch` header on test clients
- Out:
  - `/me` (P2-02)
  - rate limiting (P2-05)
  - audit (P2-04 wires auth events)
  - password reset (P4-04)
  - MFA (pilot)

## Interfaces

Endpoints above. Cookie: `HttpOnly; SameSite=Lax; Path=/`, plus `Secure` when `session_cookie_secure`, and no
`Domain` attribute.

## Acceptance criteria

1. **Given** seeded `resident1` and the correct password, **when** logging in, **then** 204, and the cookie
   has HttpOnly, SameSite=Lax and Path=/ (and Secure in the staging config).
2. **Given** a successful login, **then** the DB stores `sha256(token)` only. The raw cookie value appears
   nowhere in the DB or logs.
3. **Given** a wrong password, an unknown email, or an inactive user, **then** the responses are
   byte-identical 401 bodies.
4. **Given** logout, **when** the old cookie is reused, **then** 401.
5. **Given** a session past `expires_at` or `idle_expires_at` (frozen clock), **then** 401.
6. **Given** two requests 1 minute apart, **then** `last_seen_at` is updated once. Six minutes apart, it is
   updated twice.
7. **Given** a POST without `X-Requested-With`, or with `Origin: https://evil.example`, **then** 403
   `csrf_failed`, and the handler does not run. GET requests are unaffected.
8. **Given** a stored hash, **then** it starts with `$argon2id$`.

## Test plan

- `tests/auth/test_login.py`, `tests/auth/test_sessions.py`, `tests/test_csrf.py`, covering each criterion.
- Use a clock helper (`app/core/clock.py` `now()`) so tests can freeze time.
- Commands: `make test`. Manual: log in on the prod-like stack (`make prodlike`) with curl and inspect
  `Set-Cookie`. The `__Host-`/`Secure` cookie over HTTPS is checked on staging in D-06.

## Likely files

`backend/app/core/{security,csrf,clock}.py`, `backend/app/auth/{models,router,deps,service,schemas}.py`,
`backend/app/main.py`, `backend/app/seed.py`, `backend/app/core/config.py`, `backend/.env.example`,
`backend/migrations/versions/<new>.py`, `backend/tests/auth/*`, `backend/tests/helpers/auth.py`.

## Must explain (learning checkpoint)

1. Why argon2id for passwords but plain sha256 for session tokens?
2. What does `DUMMY_HASH` prevent?
3. Walk through a CSRF attack from `evil.example` against `POST /api/auth/logout`, and show each defense that
   stops it.
4. Why `SameSite=Lax` rather than `Strict` here?
5. Why limit `last_seen_at` updates to once every 5 minutes?

## Carried from P1-02 (decide while framing)

From the P1-02 reviews (PR #44). `User` lower-cases `email` with Python's `str.lower()` on ORM writes; the
database enforces uniqueness on Postgres `lower(email)` (`uq_users_lower_email`). Login (and later P4-02,
P4-05) must:
- look users up with `func.lower(User.email) == <normalised input>`, never `User.email == …`: Core
  `insert()`/`update()` skip the model's lower-casing (L1);
- use one normalisation on write and on lookup, because Python and Postgres `lower()` disagree on some
  characters (`İ` → `i̇` in Python, `i` in Postgres under libc `en_US.utf8`; another collation provider would
  differ again), and send mail only to the stored address, never the typed one (the dotless-i takeover
  pattern) (L2, L5). Rejecting non-ASCII emails removes both problems;
- check the length after normalising: lower-casing can lengthen a string past `String(320)` (L4).

The database also accepts `''` and space-padded values for `email` and `full_name`, so the first request
schemas that write users must reject them. `email-validator` isn't a dependency yet; the first `EmailStr`
schema adds it.

## Carried from P1-04 (do while framing)

From the P1-04 reviews (PR #49; `docs/explanations/P1-04-api-conventions.md`):
- **The CSRF middleware must return `problem_response(...)` (403 `csrf_failed`), not raise `Forbidden`.**
  A `DomainError` raised in a middleware runs outside Starlette's `ExceptionMiddleware`, so it becomes a
  500 `internal_error` (round 3 residual). Test the rejection's status, code and media type.
- Make `code`, `title`, `detail` and `extra` keyword-only on the `DomainError` subclasses, and check
  `code` is snake_case in `DomainError.__init__` (`ValueError`, like the reserved-`extra` check):
  `NotFound("Package not found")` gives `code="Package not found"` today (round 3 M1).
- Reject explicit default ports in `TRUSTED_ORIGINS` (`https://host:443`, `http://host:80`): browsers omit
  them from `Origin`, so the CSRF comparison could never match (round 3 L1).
- The CSRF check compares `Origin` exactly against `settings.trusted_origins`, which are already validated
  as lowercase `scheme://host[:port]` (`app/core/config.py::_is_origin`).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
