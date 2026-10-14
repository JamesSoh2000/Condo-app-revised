# P2-05 — Rate limiting

| Field | Value |
|---|---|
| Phase / lane | P2 / B (moved from A: off the critical path) |
| Risk tier | 1 |
| Depends on | P2-01 |
| Replaces old | M3-T11 |
| Status | todo |

## Goal

Login, and later the password-reset, signup and join-code endpoints, are rate-limited per IP and per
account. Counters live in PostgreSQL, so they survive restarts.

## Why

This prevents online password guessing and enumeration. The old plan rightly required limits that survive
process restarts. Postgres meets that without Redis.

## Scope

- In:
  - **`rate_limits` table:** `key` String(200), `window_start` timestamptz, `count` int,
    PK `(key, window_start)`.
  - **`app/core/rate_limit.py`:**
    - **`async hit(key: str, limit: int, window: timedelta) -> RateDecision(allowed, retry_after)`:**
      - an atomic `INSERT … ON CONFLICT (key, window_start) DO UPDATE SET count = rate_limits.count + 1
        RETURNING count`, using a fixed window aligned to `window`
      - **runs in its own short transaction on a separate session** and commits immediately, so the count
        persists even when the request's main transaction rolls back (for example a failed login)
    - **`enforce(...)`** raises `RateLimited(retry_after)`, which becomes 429 `rate_limited` with a
      `Retry-After` header.
  - **Policies** (constants, tunable via settings):
    - login: per IP 30 per 10 min; per normalized email 8 per 15 min
    - The reset, signup and join policies are defined here and applied by P4-04 and P4-05.
  - **Client IP:**
    - uvicorn/gunicorn `--proxy-headers --forwarded-allow-ips=127.0.0.1`, so `request.client.host` is the
      real client behind Caddy (the prod-like stack locally, staging later; D-06 checks it there)
    - locally it is the direct peer
    - document why `X-Forwarded-For` from untrusted peers is ignored
  - **Cleanup:** a function `delete_expired_rate_limits(db, older_than=1 day)`, scheduled by the P3-01
    scheduler (leave a TODO link).
  - **Key format:** `login:ip:<ip>`, `login:email:<sha256(lower(email))>`, so raw emails are never stored.
- Out:
  - per-endpoint generic decorators for every route (YAGNI)
  - global DDoS protection (that belongs at the edge, not in the app)

## Interfaces

`hit()` and `enforce()`. Error code `rate_limited` with the `Retry-After` header.

## Acceptance criteria

1. **Given** 8 failed logins for one email within 15 min, **when** a 9th attempt is made, **then** 429 with
   `Retry-After` > 0, even with the correct password.
2. **Given** another email from the same IP, **then** it is not blocked by the email limit.
3. **Given** a failed login, **then** the counter row was incremented despite the request transaction rolling
   back.
4. **Given** 10 concurrent `hit()` calls for one key, **then** the final count is exactly 10.
5. **Given** the window passes (frozen clock), **then** requests are allowed again.
6. **Given** the table after login attempts, **then** no key contains a raw email address.
7. **Given** a request with a forged `X-Forwarded-For` from a non-trusted peer, **then** the limiter uses the
   peer IP.

## Test plan

- `tests/test_rate_limit.py`, using separate sessions for the concurrency test.
- Commands: `make test`; manual: a curl loop against local login.

## Likely files

`backend/app/core/rate_limit.py`, `backend/app/auth/service.py`, `backend/app/core/config.py`,
`backend/migrations/versions/<new>.py`, `compose.prodlike.yml` (proxy flags),
`backend/tests/test_rate_limit.py`.

## Must explain (learning checkpoint)

1. Why must the counter be committed in a separate transaction from the login attempt?
2. Fixed window vs sliding window vs token bucket: what is the weakness of a fixed window, and why is it
   acceptable here?
3. Why hash the email in the key?
4. Why can't we trust `X-Forwarded-For` from anyone?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
