# P2-01b — Sessions, login and logout

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-01a, P1-02, P1-05 |
| Replaces old | M3-T02 (redesigned per ADR-0003) |
| Status | done |

Split from [P2-01](./P2-01-sessions-login-logout-csrf.md) (see there why). CSRF, password hashing, the
password policy and seed passwords are [P2-01a](./P2-01a-csrf-and-password-hashing.md). Re-frame this part
before starting: its criteria are the original ticket's, moved here unchanged. Re-framed 2026-10-16 (Frame
notes below; AC1–AC6 sharpened, AC7–AC11 added).

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

The original six, sharpened (the original wording is kept in the parent ticket), then the added ones.

1. **Given** the seeded `resident1` (`make seed`, dev) and `DevPassword!2026`, **when** `POST /api/auth/login`
   (also with the email in another letter case, `Resident1@Example.TEST`), **then** 204 with an empty body and
   one `Set-Cookie: session=<token>` with `HttpOnly`, `SameSite=lax`, `Path=/`, `Max-Age` = 30 days, no
   `Domain` and no `Secure`. **Given** the staging settings, **then** the cookie is `__Host-session` with
   `Secure`; settings for staging/prod refuse `SESSION_COOKIE_SECURE=false` or a name without `__Host-`, and
   any environment refuses a `__Host-` name without `Secure`.
2. **Given** a successful login, **then** the new `sessions` row's `token_hash` is `sha256(token)` hex, no
   `sessions` column holds the token (`row::text`), no log record emitted during the login holds it, and the
   database refuses a `token_hash` that isn't 64 lowercase hex characters (check constraint).
3. **Given** a wrong password, an unknown email, a user whose `password_hash` is NULL, a user whose hash can't
   be parsed, or an inactive user with the right password, **then** each answers 401 `invalid_credentials`,
   the bodies are byte-identical when sent with the same `X-Request-ID`, no cookie is set and no session row
   is written. Each path runs exactly one password verification, against the user's hash or `DUMMY_HASH`
   (unknown, NULL, unparsable).
4. **Given** a logged-in client, **when** it logs out, **then** 204, the session's `revoked_at` is set, the
   response deletes the cookie (`Max-Age=0`, same name, `Path` and flags), and the old cookie on a
   protected route gives 401 `not_authenticated`. Logout without a cookie, with an unknown cookie, or twice,
   is also 204.
5. **Given** a session and a frozen clock, **when** the clock passes `expires_at`, or passes
   `idle_expires_at`, **then** a protected route gives 401 `not_authenticated`; one second before either, 200.
   A revoked session, a deactivated user, a garbage cookie and no cookie also give 401 `not_authenticated`.
6. **Given** a session last seen at `T`, **when** requests arrive at `T+1 min`, `T+5 min` and `T+6 min`,
   **then** `last_seen_at` stays `T` after the first, becomes `T+5 min` after the second (and
   `idle_expires_at` moves to `T+5 min` + the idle window), and stays `T+5 min` after the third: at most one
   write per 5 minutes. (Sharpened: the original "1 minute apart → updated once; six minutes → twice" counted
   from an unstated start.)
7. **Given** a user with an active membership holding a staff role (`security`, `property_management`,
   `council`), **then** login sets `idle_expires_at` = now + 12 h; a resident-only user, or one whose staff role
   is on a pending or suspended membership, gets now + 7 days; `expires_at` is now + 30 days for both. The
   refresh in AC6 recomputes the window from the current memberships. (Added.)
8. **Given** a login body with a missing or extra field, an empty email, or a password over 128 characters,
   **then** 422 (`validation_error`) and no password is verified. (Added.)
9. **Given** a user whose hash was made with weaker argon2 parameters, **when** they log in, **then** 204 and
   the stored hash is replaced by one that verifies and doesn't need a rehash. `needs_rehash` is True for a
   hash whose salt or digest isn't canonical base64 (Carried from P2-01a). (Added.)
10. **Given** `POST /api/auth/login` or `/logout` without `X-Requested-With`, **then** 403 `csrf_failed`, no
    session row written or revoked. (Added: the 10-case table's case 2 for these routes is "no session",
    covered by AC4/AC5.)
11. **Given** the test helper `login_as(db, client, user)`, **then** the client is authenticated as that user
    on the next request, with no password involved (the world's users have none). (Added.)

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

- Criteria added or sharpened: AC1–AC6 sharpened (exact cookie attributes and `Max-Age`; case-insensitive
  email; the settings guards for `__Host-`/`Secure`; the token-hash check constraint; NULL and unparsable
  hashes in the 401 set, one verification per path; the logout cookie deletion and idempotency; the
  revoked/deactivated/garbage cases; AC6's timeline made exact). AC7–AC11 added (staff idle window, 422s,
  rehash on login, CSRF on the auth routes, `login_as`).
- Criteria loosened: none.
- Decisions taken:
  - **Email lookup** (Carried from P1-02): `func.lower(User.email) == func.lower(:email)`, both sides lowered
    by Postgres, so the lookup uses the same function as `uq_users_lower_email` and Python's `lower()` never
    takes part. Login writes no email, so the length-after-lowering and non-ASCII rejection items stay with
    P4-02/P4-05 (the first schemas that write users), as does `email-validator`: the login body's `email` is a
    plain string (1–320 characters); a malformed one is just an unknown email (401). Basis: autonomous.
  - **Unparsable hashes cost a full verification:** a new `is_valid_hash()` (argon2 PHC string with canonical
    base64 salt and digest) decides whether login verifies against the user's hash or `DUMMY_HASH`;
    `needs_rehash` uses it too (the P2-01a carry). Basis: P2-01a review follow-up.
  - **Idle window recomputed on refresh** (at most every 5 minutes) from current memberships, not frozen at
    login: a role change applies within one refresh, consistent with ADR-0003's "permissions are never
    stale". Costs one indexed query per refresh. Basis: autonomous.
  - **Persistent cookie** with `Max-Age` = the absolute lifetime (30 days), so a resident's 7-day idle window
    survives a browser restart; the server-side expiry is what counts. Alternative: a browser-session cookie
    (logs residents out on every browser restart, contradicting the 7-day idle design). Basis: autonomous.
  - **Cookie settings:** `session_cookie_name`/`session_cookie_secure` default per environment
    (`session`/false in dev and test, `__Host-session`/true in staging and prod) and can be overridden.
    Basis: ticket + ADR-0003.
  - **`sessions.user_id` ON DELETE CASCADE:** a session is a credential, not history; deleting a user must
    not be blocked by, or leave, its sessions. Users are deactivated, not deleted (P1-02), so this is only a
    backstop. Basis: autonomous.
  - **Touching the session commits** in `service.touch_session`, a use-case of its own (CLAUDE.md rule 5),
    called by `get_current_session` before the endpoint runs. Basis: rule 5.
  - **argon2 off the event loop** (`anyio.to_thread.run_sync`) for verify and rehash (Carried from P2-01a).
  - **`login_as`**, not `as_user`: P2-03 owns the `as_user` client helper (its ticket) and builds it on
    `login_as`. The `tests/README.md` TODO for case 2 is updated here. Basis: P2-03 ticket.
  - The P1-07 carry (a wrong-password 401 fires the frontend's event) needs nothing here; P2-06 handles it.
- Split: second part of P2-01 (see the parent ticket).
