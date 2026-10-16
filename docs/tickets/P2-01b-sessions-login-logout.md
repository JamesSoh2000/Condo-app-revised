# P2-01b — Sessions, login and logout

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-01a, P1-02, P1-05 |
| Replaces old | M3-T02 (redesigned per ADR-0003) |
| Status | todo |

Split from [P2-01](./P2-01-sessions-login-logout-csrf.md) (see there why). CSRF, password hashing, the
password policy and seed passwords are [P2-01a](./P2-01a-csrf-and-password-hashing.md). Re-frame this part
before starting: its criteria are the original ticket's, moved here unchanged.

## Goal

Users log in with email and password and receive an HttpOnly session cookie backed by a hashed server-side
session. They can log out.

## Why

This is the foundation of every authorization check. The design is deliberately simpler than the old JWT
plan ([ADR-0003](../adr/0003-same-origin-server-side-sessions.md)).

## Scope

- In:
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
      - The unknown-email and null-password paths verify against `DUMMY_HASH` (P2-01a).
      - The idle window is staff-length if the user has any active membership with a staff role.
      - Rehashes the password if `needs_rehash`.
    - `POST /api/auth/logout`: revokes the current session if present, clears the cookie, returns 204
      (idempotent).
  - **Dependencies** (`app/auth/deps.py`):
    - `get_current_session`: reads the cookie, hashes it, loads a not-revoked, not-expired session joined to
      an active user.
    - It refreshes `last_seen_at` and `idle_expires_at` **at most once per 5 minutes**.
    - `get_current_user` builds on it. Failure gives 401 `not_authenticated`.
  - **Test helpers** (`tests/helpers/auth.py`):
    - `login_as(client, user)`: creates a session row directly and sets the cookie on the client
- Out:
  - CSRF, hashing, the password policy, seed passwords (P2-01a)
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

## Test plan

- `tests/auth/test_login.py`, `tests/auth/test_sessions.py`, covering each criterion.
- Use a clock helper (`app/core/clock.py` `now()`) so tests can freeze time.
- Commands: `make test`. Manual: log in on the prod-like stack (`make prodlike`) with curl and inspect
  `Set-Cookie`. The `__Host-`/`Secure` cookie over HTTPS is checked on staging in D-06.

## Likely files

`backend/app/core/clock.py`, `backend/app/auth/{models,router,deps,service,schemas}.py`,
`backend/app/main.py`, `backend/app/core/config.py`, `backend/app/models/registry.py`, `backend/.env.example`,
`backend/migrations/versions/<new>.py`, `backend/tests/auth/*`, `backend/tests/helpers/auth.py`,
`frontend/src/api/schema.d.ts` (regenerated).

## Must explain (learning checkpoint)

1. Why `SameSite=Lax` rather than `Strict` here?
2. Why limit `last_seen_at` updates to once every 5 minutes?
3. How does a request's cookie become a user, and which query does it run?

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

## Carried from P1-05 (do while framing)

- The test world's users (`tests/world.py`) all have `password_hash` NULL. `as_user` should create the
  session directly (or set a password), and login must treat a NULL hash as "cannot log in" (also a P1-02
  residual risk). Wire `as_user` into the TODO in `backend/tests/README.md` ("The 10 cases with the world").

## Carried from P1-07 (do while framing)

- Every request from the typed client (`src/api/client.ts`) carries `X-Requested-With: fetch` (PR #52); the
  legacy Base44 calls don't. The CSRF check may rely on the header for the SPA's own calls.
- A wrong-password 401 also fires the frontend's `auth:unauthenticated` event (P2-06 handles it; see its
  "Carried from P1-07").

## Carried from P2-01a (do while framing)

From the P2-01a reviews (PR #56; `docs/explanations/P2-01a-csrf-and-password-hashing.md` §7):
- Verify the submitted password against `DUMMY_HASH` when the user is unknown, has a NULL hash **or** a hash
  `verify_password` can't parse (it returns False at once for one, which is faster than a real verify;
  review round 2 L2).
- Cap the password length in the login schema (`max_length`) before it reaches argon2 (round 1 L5, round 2 L3).
- Run `verify_password`/`hash_password` off the event loop (`anyio.to_thread.run_sync`): argon2 is CPU-bound.
- `needs_rehash` doesn't decode the salt and digest: a non-canonical last base64 character returns False
  (round 3 Low). Login calls it only after a successful verify, so it is safe there; make it decode
  canonically (decode, re-encode, compare) and test that case.
- Every unsafe request needs `X-Requested-With: fetch` and a trusted `Origin`; curl transcripts must send
  both (`docs/ARCHITECTURE.md` §6).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: second part of P2-01 (see the parent ticket).
