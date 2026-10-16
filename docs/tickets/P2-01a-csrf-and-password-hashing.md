# P2-01a — CSRF protection and password hashing

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P1-02, P1-04, P1-06 |
| Replaces old | M3-T01 (redesigned per ADR-0003) |
| Status | done |

Split from [P2-01](./P2-01-sessions-login-logout-csrf.md) (see there why). Sessions, login and logout are
[P2-01b](./P2-01b-sessions-login-logout.md).

## Goal

Every state-changing request to the API passes a CSRF check before any handler runs, and the backend can hash
and verify passwords with argon2id and enforce a password policy; seeded demo users get a password.

## Why

CSRF goes in before the first unsafe endpoint that uses a cookie (P2-01b's login and logout), so no such
endpoint ever exists without it. Hashing and the policy are the building blocks of login (P2-01b), password
reset (P4-04) and invitation accept (P4-02). [ADR-0003](../adr/0003-same-origin-server-side-sessions.md)
fixes the design: argon2id passwords, sha256 session tokens, and an `Origin` + `X-Requested-With` CSRF check.

## Scope

- In:
  - **CSRF middleware** (`app/core/csrf.py`), a pure ASGI middleware added inside `RequestLoggingMiddleware`
    (so a rejection is logged with its request id):
    - It checks every request whose method is not `GET`, `HEAD` or `OPTIONS`, on every path.
    - A checked request passes only if it carries exactly one `X-Requested-With` header whose value is
      exactly `fetch`, **and** either exactly one `Origin` header whose value is in `settings.trusted_origins`
      (exact string match), or no `Origin` header and `Sec-Fetch-Site: same-origin`.
    - Otherwise it returns `problem_response(...)` (403, code `csrf_failed`), never raises: a `DomainError`
      raised in a middleware becomes a 500 (Carried from P1-04). The handler does not run and the request
      body is not read.
  - **Test clients** (`client` and `app_client` in `tests/conftest.py`) send `X-Requested-With: fetch` and
    `Origin: <settings.trusted_origins[0]>` by default; a test overrides or removes them per request.
  - **`app/core/security.py`** (dependency `argon2-cffi`):
    - `hash_password(password) -> str` (argon2id, the library's default parameters),
      `verify_password(password, hash) -> bool` (False for a mismatch **or** a hash it can't parse, never an
      exception), `needs_rehash(hash) -> bool`
    - `generate_token() -> str` = `secrets.token_urlsafe(32)`; `hash_token(token) -> str` = sha256 hex
    - a module-level `DUMMY_HASH` (an argon2id hash with the current parameters), so the unknown-email path
      of login (P2-01b) costs the same as a wrong password
  - **Password policy** (`check_password_policy(password)` in `app/core/security.py`): length 12–128
    characters; rejects the 1,000 most common passwords **that meet the length rule**, compared
    case-insensitively (embedded list `app/core/common_passwords.txt`); no composition rules. A rejection
    is a `WeakPasswordError` (a `ValueError`) with a reason: `too_short`, `too_long` or `too_common`.
  - **Seed (P1-06):** seeded users get a password. `APP_ENV=dev` and `test`: `DevPassword!2026`, documented
    in the README. `APP_ENV=staging`: the `SEED_PASSWORD` setting (a secret); the seed refuses to run if it
    is unset, fails the policy, or equals the dev password. Production: the seed already refuses to run.
    Re-running the seed doesn't rewrite a hash that already verifies with the current parameters.
  - **Carried from P1-04:**
    - `code`, `title`, `detail` and `extra` are keyword-only on the `DomainError` subclasses
      (`RateLimited` keeps `retry_after` first), and `DomainError.__init__` raises `ValueError` unless
      `code` is snake_case (`^[a-z][a-z0-9]*(_[a-z0-9]+)*$`).
    - `TRUSTED_ORIGINS` rejects an explicit default port (`https://host:443`, `http://host:80`).
- Out:
  - sessions, login, logout, session dependencies and `as_user` (P2-01b)
  - rate limiting (P2-05), audit (P2-04), password reset (P4-04), MFA (pilot)

## Interfaces

- No endpoint. Every unsafe request now needs the CSRF headers; the typed client already sends
  `X-Requested-With: fetch` (P1-07), and browsers send `Origin`.
- Rejection: 403 `application/problem+json`, `code: "csrf_failed"`, `title: "Forbidden"`, with `request_id`.
- Settings: `SEED_PASSWORD` (optional secret; required by `seed` in staging only).
- `app/core/security.py`: the functions above. Dependency: `argon2-cffi`.

## Acceptance criteria

1. **Given** a `POST` (and, parametrised, `PUT`, `PATCH`, `DELETE` and a non-standard method) to a test
   route, **when** it lacks `X-Requested-With`, or has `X-Requested-With: XMLHttpRequest`, or has two
   `X-Requested-With` headers, **then** 403 with media type `application/problem+json`, `code`
   `csrf_failed`, the body's `request_id` equal to the `X-Request-ID` header, and the route's handler did
   not run. (Sharpened from AC7: every method but `GET`/`HEAD`/`OPTIONS`, every path, the exact value.)
2. **Given** the header is right, **when** `Origin` is `https://evil.example`, `null`, a trusted origin with a
   trailing slash, in upper case or with another port, or two `Origin` headers, **then** the same 403 and the
   handler did not run.
3. **Given** the header is right and there is no `Origin`, **when** `Sec-Fetch-Site` is absent, `same-site`,
   `cross-site` or `none`, **then** 403; **when** it is `same-origin`, **then** the handler runs.
4. **Given** a trusted `Origin` and `X-Requested-With: fetch`, **then** the handler runs (2xx), including a
   path outside `/api` (the check covers every path). **Given** `GET`, `HEAD` or `OPTIONS` with neither
   header, **then** the request is unaffected.
5. **Given** a rejected request, **then** the response is the 403 problem, not a 500 (the P1-04 residual),
   and the request log line records it with status 403.
6. **Given** `hash_password(p)`, **then** it starts with `$argon2id$`, `verify_password(p, h)` is True,
   a wrong password gives False, and a malformed or non-argon2 hash (`"not-a-hash"`, a bcrypt string) gives
   False without raising. `needs_rehash` is True for a hash made with weaker parameters and False for a
   fresh one; `DUMMY_HASH` is an argon2id hash that doesn't need a rehash. (Sharpened from AC8.)
7. **Given** `generate_token()`, **then** two calls differ and each is at least 43 URL-safe characters;
   `hash_token(t)` is the 64-character lowercase hex sha256 of `t`.
8. **Given** the password policy, **then** 11 characters are rejected (`too_short`), 12 and 128 accepted,
   129 rejected (`too_long`), a list entry in any letter case rejected (`too_common`), and
   `DevPassword!2026` accepted. The list has 1,000 unique lowercase entries, each 12–128 characters.
9. **Given** `seed` with `app_env="dev"`, **then** `resident1`'s hash starts with `$argon2id$` and verifies
   `DevPassword!2026`; a second run leaves every `password_hash` unchanged. **Given** `app_env="staging"`,
   **when** `SEED_PASSWORD` is unset, fails the policy, or equals the dev password, **then** `seed` refuses
   (`SeedRefusedError`) before writing anything; **when** it is a valid password, **then** users verify it.
10. **Given** `NotFound("Package not found")` (positional), **then** `TypeError`; **given**
    `Conflict(code="Not Snake")` or `DomainError(code="bad-code", …)`, **then** `ValueError`;
    `RateLimited(retry_after=30)` and `Conflict(code="x_conflict")` still work.
11. **Given** `TRUSTED_ORIGINS` containing `https://app.example:443` or `http://localhost:80`, **then**
    loading the settings fails; `http://localhost:8080` is accepted. (Missed case added.)

## Test plan

- `tests/test_csrf.py` (AC1–AC5, with a test-only router through `app_client`), `tests/test_security.py`
  (AC6–AC8), `tests/test_cli_seed.py` (AC9), `tests/test_errors.py` (AC10), `tests/test_config.py` (AC11).
- Commands: `make test`, `make check`. Manual: on the dev stack, `curl -X POST /api/health` without and with
  the headers (no unsafe endpoint exists yet, so a 403 vs 405 shows the check runs first).

## Likely files

`backend/app/core/{csrf,security,errors,config}.py`, `backend/app/core/common_passwords.txt`,
`backend/app/main.py`, `backend/app/seed.py`, `backend/app/cli.py`, `backend/pyproject.toml`, `backend/uv.lock`,
`backend/.env.example`, `README.md`, `backend/tests/conftest.py`, `backend/tests/test_{csrf,security}.py`.

## Must explain (learning checkpoint)

1. Why argon2id for passwords but plain sha256 for session tokens?
2. What does `DUMMY_HASH` prevent?
3. Walk through a CSRF attack from `evil.example` against an unsafe endpoint (P2-01b's
   `POST /api/auth/logout`), and show each defense that stops it.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - AC1–AC5 sharpen the original AC7: the check covers every method except `GET`/`HEAD`/`OPTIONS` (not only
    the four listed), every path (not only `/api/`), the exact header value `fetch`, duplicate headers,
    `Origin: null`, near-miss origins, and the `Sec-Fetch-Site` fallback values. AC5 is the P1-04 residual
    (middleware errors become 500s).
  - AC6 sharpens AC8: verification of a malformed or foreign hash returns False instead of raising, and
    `DUMMY_HASH`/`needs_rehash` are tested.
  - AC7–AC11 are new: tokens, the policy, seed passwords, and the two P1-04 carries.
  - Missed case: an explicit default port in `TRUSTED_ORIGINS` (AC11), and duplicate CSRF headers (AC1, AC2).
- Criteria loosened: none.
- Decisions taken:
  - **The common-password list.** The ticket asked for "the 1,000 most common passwords". In the usual
    top-1,000 list (SecLists `xato-net-10-million-passwords-1000.txt`) no entry has 12 or more characters,
    so with the 12-character minimum that check could never fire. Chosen: the 1,000 most frequent entries of
    12–128 printable-ASCII characters from the same source's top-1,000,000 list, lower-cased and
    de-duplicated, compared case-insensitively. Stricter than the literal reading. Alternative: the literal
    top-1,000 (rejected: vacuous). Basis: autonomous; source pinned to SecLists commit
    `21537beae7465102a3ebbedea6a7852a0cbcb3c4` (MIT licence).
  - **Staging seed password (Carried from P1-06).** Chosen: staging seed users get `SEED_PASSWORD`, a secret
    set in the staging environment, never the public dev password. Alternatives: keep `DevPassword!2026` in
    staging (rejected: anyone who reads the repo could log in as the demo manager on a reachable host);
    no password in staging (rejected: D-06 must log in on staging to check the `__Host-` cookie). Basis:
    autonomous (the ticket left it open); lasting, so it goes to the inbox and D-02/D-06 need the secret.
  - **CSRF on every path and every non-safe method.** The app serves only `/api`, so this rejects nothing
    legitimate, and a route mounted elsewhere later is never left unchecked. Basis: autonomous (stricter
    than the ticket).
  - **Test clients send `Origin` too**, not only `X-Requested-With` as the ticket said: without an `Origin`
    or `Sec-Fetch-Site`, the middleware rejects the request. Basis: follows from the ticket's own rule.
  - **`argon2-cffi`**, not `pwdlib`: `pwdlib[argon2]` wraps it, and `argon2-cffi` alone has
    `check_needs_rehash`. Its default parameters (RFC 9106 low-memory profile) are used. Basis: autonomous.
  - Login email normalisation (Carried from P1-02) moves to P2-01b with the login endpoint.
- Split: this is the first part of P2-01; see the parent ticket.
