# ADR-0003: Server-side sessions in a same-origin cookie (no JWT access/refresh tokens)

- Status: Accepted
- Date: 2026-10-13
- Supersedes: the session design in the old M3-T02 / PRODUCT_CONTRACTS §Sessions

## Context

The old design used:
- short-lived JWT access tokens kept in memory
- rotating refresh tokens in an HttpOnly cookie, organised in families with replay detection
- refresh coordination across tabs
- per-tab membership-bound access tokens
- a separate CSRF scheme

Each piece answers a real problem in **cross-origin** or **stateless** setups.

The adopted deployment ([ADR-0008](./0008-single-ec2-compose-caddy.md)) serves the SPA and `/api` from the
**same origin**, with one API process and PostgreSQL on every request anyway. We also need instant revocation:
a role change or a suspended membership must apply on the next request.

## Decision

- **Login** verifies the password (argon2id) and creates a `sessions` row with
  `token_hash = sha256(random_32_bytes)`. The raw token goes only into the cookie.
- **Cookie:** `__Host-session=<token>; Secure; HttpOnly; Path=/; SameSite=Lax` in staging and production.
  It is a plain `session` cookie without `Secure` on local http. The cookie name comes from settings.
- **Every request** resolves the cookie to `session → user` with one indexed query. Authorization always reads
  current memberships and roles from the database.
- **Expiry:**
  - 30 days absolute
  - idle 7 days for residents, 12 hours for staff
  - activity refreshes `last_seen_at` at most every 5 minutes
- **Logout** revokes the current session. **Logout-all**, **password reset** and **account deactivation**
  revoke all of the user's sessions.
- **CSRF:** a middleware rejects unsafe methods unless the `Origin` is trusted (or `Sec-Fetch-Site:
  same-origin`) **and** the `X-Requested-With: fetch` header is present.
- **Building context is not in the session.** It is in the URL path ([ADR-0004](./0004-path-scoped-tenancy.md)).

## Consequences

- **Simpler:**
  - no token refresh logic in the frontend
  - no cross-tab coordination
  - no signing keys to rotate
  - revocation is a row update
- **More secure by default:** the browser never exposes the token to JavaScript, and permissions are never
  stale.
- **Cost:** one DB lookup per request, which is trivial at this scale. Add an in-process cache with a TTL of a
  few seconds only if measured as a problem.
- **A future native mobile app** can use the same session token in an `Authorization` header via a separate
  login endpoint, or a token flow can be added then.
- **Staff MFA** at pilot adds `mfa_verified_at` to the session (see [07](../PILOT_READINESS.md)).

## Alternatives considered

- **JWT access + refresh tokens:** stateless verification doesn't matter with one process and a DB hit per
  request anyway. It brings revocation complexity, token-theft blast radius, and frontend refresh races.
- **`localStorage` bearer tokens:** readable by any XSS. Rejected.
- **Third-party auth (Auth0, Cognito, Clerk):** good for production. It hides the concepts this project
  exists to teach and adds per-user cost. Revisit if the pilot needs SSO.

## Revisit when

We add a native mobile app or third-party API clients, SSO becomes a requirement, or the API runs across
multiple origins.
