# P2-05 — Rate limiting

| Field | Value |
|---|---|
| Phase / lane | P2 / B (moved from A: off the critical path) |
| Risk tier | 1 |
| Depends on | P2-01b |
| Replaces old | M3-T11 |
| Status | done |

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
   - *Framed:* the 429 is problem+json `code: rate_limited` with `retry_after` equal to the header; no
     session row or cookie is created; and the limited answer is identical for an existing and an unknown
     email (same status, code and `Retry-After` for the same window position). A limited login runs no
     user lookup and no argon2.
2. **Given** another email from the same IP, **then** it is not blocked by the email limit.
3. **Given** a failed login, **then** the counter row was incremented despite the request transaction rolling
   back.
   - *Framed:* proven with the limiter on its own connection (as in production), read back from a third
     connection: (a) a failed login's counter is committed, and (b) for a request that runs `enforce` and
     then fails with an unhandled error, so its own session rolls back, the counter is still committed.
4. **Given** 10 concurrent `hit()` calls for one key, **then** the final count is exactly 10.
   - *Framed:* on 10 separate connections (`asyncio.gather`), and the returned counts are exactly
     `{1..10}`; with `limit=7`, exactly 7 calls are allowed.
5. **Given** the window passes (frozen clock), **then** requests are allowed again.
   - *Framed:* windows are fixed and aligned to the window length since the Unix epoch; `Retry-After` is
     the whole seconds (rounded up, at least 1) to the end of the current window; one second before the end
     is still limited, the window's end is allowed.
6. **Given** the table after login attempts, **then** no key contains a raw email address.
   - *Framed:* the email key is `login:email:<sha256 hex>` of the email lowered **by Postgres** (the same
     `lower()` that login's lookup uses), so the spellings that reach one account share one counter
     (`Resident1@Example.TEST`, and Unicode cases where Python's `str.lower()` and Postgres disagree, such
     as `İ`).
7. **Given** a request with a forged `X-Forwarded-For` from a non-trusted peer, **then** the limiter uses the
   peer IP.
   - *Framed:* tested through uvicorn's `ProxyHeadersMiddleware` (what gunicorn's `--forwarded-allow-ips`
     installs), not only the bare app: from an untrusted peer the key is the peer's IP; from the trusted
     proxy it is the forwarded client (so the test can fail). Also run on `make prodlike` behind Caddy.

Added while framing:

8. **Given** 30 login attempts from one IP within 10 minutes (each with a different email), **then** the
   31st is 429, and it does not increment any email counter.
9. **Given** IPv6 clients, **then** the IP key is the client's `/64` (one subscriber's usual allocation), and an
   IPv4-mapped IPv6 address keys as its IPv4 address.
10. **Given** `delete_expired_rate_limits(db)`, **then** rows whose window started more than 1 day ago are
    deleted and newer ones kept; it never commits. Settings refuse a policy whose window is longer than
    1 day (cleanup would delete a live window), or a limit or window ≤ 0.
11. **Given** settings, **then** each policy (login per IP and per email; reset per IP and per email; signup
    per IP; join lookup per IP) is a `RatePolicy` with the defaults below, overridable by environment
    variable (JSON).
12. **Given** the OpenAPI document, **then** `POST /api/auth/login` documents 429 with `Problem`, and
    `schema.d.ts` is regenerated.
13. Tenant table (ENGINEERING_PRACTICES §7): login is not a tenant endpoint, so rows 2–9 don't apply. Row 1:
    the existing login tests stay green with the limiter on. Row 10: criterion 4.

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

## Carried from P2-01b (do while framing)

- Until this ticket, nothing bounds password guessing on `POST /api/auth/login`, or the memory a login flood
  uses: up to 40 concurrent argon2 verifications (AnyIO's thread pool), 64 MiB each. Login no longer holds a
  database connection while verifying (PR #57 review round 2). Limit per IP and per target email, and keep
  the limited answer from revealing whether the email exists.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1, 3–7 sharpened (above, marked *Framed*); 8–13 added. 8 covers the IP
  limit, which the ticket set but no criterion tested. 9 (IPv6 /64) is the case the ticket missed: keyed per
  address, one IPv6 subscriber gets 2^64 IP buckets.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Module location** (autonomous): the limiter is `app/rate_limits/` (`models.py`, `service.py`), not
    `app/core/rate_limit.py`. `hit()` commits its own transaction, and the commit fitness test
    (`tests/test_architecture.py::COMMIT_ALLOWED`) only allows `**/service.py` and entry points; adding a
    core file to that list would loosen a protected gate. Package-by-feature is also the convention.
  - **The limiter is a FastAPI dependency** (autonomous): `get_rate_limiter()` returns a `RateLimiter`
    holding a session factory, so tests point it at their connection as they do `get_db_session`. `hit()`
    and `enforce()` are its methods with the ticket's arguments.
  - **What counts** (autonomous): every login attempt counts, checked before the user lookup and argon2,
    so a limited answer costs no hash and can't reveal whether the email exists. IP first; an IP-limited
    attempt does not count against the email.
  - **Default policies** (autonomous, from the dependents' criteria): login 30/10 min per IP and 8/15 min
    per email (ticket); reset 30/10 min per IP and 8/15 min per email (P4-04 criterion 6: the 9th in 15 min
    is 429); signup 10/hour per IP; join lookup 20/10 min per IP (P4-05 criterion 8: 30 rapid lookups give
    429). P4-02's invitation lookups get their own policy in P4-02.
  - **Client IP** (ticket, already done in P1-08): gunicorn `--forwarded-allow-ips` = Caddy's address
    (`FORWARDED_ALLOW_IPS`), so `request.client` is resolved by the server. Nothing to change in
    `compose.prodlike.yml`.
- Split: none. Estimate ~300 non-test lines.
