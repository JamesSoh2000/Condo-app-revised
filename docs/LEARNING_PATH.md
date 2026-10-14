# 06 — Learning Path

The project is the curriculum. Each phase lists:
- **Concepts** that phase exercises.
- **Must explain:** questions you should answer aloud without notes before the phase gate. The `/quiz-me`
  command draws from these.
- **Read:** short, primary sources only. Official docs beat blog posts.
- **Interview story:** the STAR story the phase gives you.

## P0 — Guardrails and workflow

**Concepts:**
- trunk-based development
- CI as a quality gate
- linters vs formatters vs type checkers
- lockfiles and reproducible builds
- test databases and transactional test isolation

**Must explain:**
1. Why trunk-based development with short branches beats long-lived `develop`/`staging` branches for a
   two-person team.
2. What `ruff`, `ruff format` and `mypy` each catch that the others don't.
3. Why tests run against real PostgreSQL instead of SQLite or mocks *in this project specifically*.
4. How a SAVEPOINT lets a test call code that commits while the test still rolls everything back.
5. What `alembic check` detects, and why it belongs in CI.

**Read:**
- SQLAlchemy docs: "Joining a Session into an External Transaction"
- Alembic: "Auto Generating Migrations" (what autogenerate cannot detect)
- trunkbaseddevelopment.com (short-lived branches)

**Interview story:** "We inherited an AI-exported frontend with 68 lint errors and no type checking. I set up
a ratchet so quality could only improve…"

## P1 — Data modeling and the local walking skeleton

**Concepts:**
- relational modeling
- multi-tenancy strategies: shared schema vs schema-per-tenant vs database-per-tenant
- composite foreign keys
- partial unique indexes
- `NULLS NOT DISTINCT`
- uuid7 vs uuid4 vs serial
- keyset vs offset pagination
- RFC 9457 problem details
- immutable artifacts and dev/prod parity

**Must explain:**
1. The three common multi-tenancy designs, and why we chose a shared schema with `building_id`.
2. How a composite FK `(building_id, unit_id) → units(building_id, id)` makes a cross-building reference
   impossible, and what an app-level check alone would miss.
3. Why `unit_occupancies` has `started_at`/`ended_at` instead of a `unit_id` column on the membership, and which
   privacy bug that prevents.
4. Why the unique constraint on units needs `NULLS NOT DISTINCT` when `tower` is null.
5. Why uuid7 primary keys index better than uuid4, and how they enable keyset pagination.
6. Why offset pagination gets slow and inconsistent on large, changing tables.
7. What happens, step by step, between `git push` and the `prodlike` CI job passing. Why do we test the
   built image and SPA behind Caddy, and not only the dev server?
8. What the prod-like stack still does not prove about a real server, and where we check it (D-06).

**Read:**
- PostgreSQL docs: Constraints (§5.5), Indexes on Expressions / Partial Indexes (§11.7–11.8)
- RFC 9457
- The Twelve-Factor App: "Dev/prod parity" and "Build, release, run"

**Interview story:** "I designed the multi-tenant schema so that the database itself rejects cross-building
references…"

## P2 — Authentication, sessions and authorization

**Concepts:**
- password hashing (argon2id, salts, work factors)
- session tokens vs JWTs
- cookie attributes (`HttpOnly`, `Secure`, `SameSite`, `__Host-` prefix)
- CSRF and its defenses
- authentication vs authorization
- RBAC plus resource-level checks
- 403 vs 404 for multi-tenant data
- rate limiting algorithms
- audit logging
- architectural fitness functions

**Must explain:**
1. Why passwords are hashed with argon2id and not SHA-256, and what the "work factor" buys.
2. Why we store `sha256(session_token)` and not the token itself, and why a fast hash is fine *here* but not
   for passwords.
3. **Server-side sessions vs JWT:** the trade-offs, and why same-origin hosting made sessions the better
   choice for us. When would you choose JWTs?
4. What `HttpOnly`, `Secure`, `SameSite=Lax` and the `__Host-` prefix each protect against.
5. A CSRF attack step by step, and why "Origin check + required custom header" stops it.
6. Why a user from another building gets **404**, not 403.
7. How the route-scan fitness test prevents a future developer (or agent) from shipping an unguarded endpoint.
8. Fixed-window vs sliding-window vs token-bucket rate limiting; why ours lives in Postgres and not in memory.
9. What belongs in an audit event, and what must never go in one.

**Read:**
- OWASP Cheat Sheets: Password Storage, Session Management, CSRF Prevention, Authorization
- MDN: Set-Cookie (cookie prefixes, SameSite)
- FastAPI docs: Dependencies, and Dependencies in path operation decorators / routers

**Interview story:** "We replaced a planned JWT access/refresh-token design with server-side sessions. Here's
why that was simpler *and* more secure…"

## P3 — Asynchronous work, email, files

**Concepts:**
- the dual-write problem
- transactional outbox
- `SELECT … FOR UPDATE SKIP LOCKED`
- leases and visibility timeouts
- at-least-once delivery and idempotent consumers
- exponential backoff with jitter
- dead-letter handling
- presigned URLs
- S3 object versioning
- content sniffing / magic numbers
- polling vs WebSockets vs SSE

**Must explain:**
1. The dual-write problem: what goes wrong if we commit the package and *then* call SES in the request.
2. How the outbox makes "package created" and "email will be sent" atomic.
3. How `FOR UPDATE SKIP LOCKED` lets two workers pull from one table without double-processing.
4. What happens if a worker crashes after SMTP accepted the message but before marking the job done. Why we
   promise at-least-once, not exactly-once.
5. Why backoff needs jitter.
6. Why the browser uploads directly to S3, and what stops a user from uploading a 5 GB file or overwriting
   another user's object.
7. Why the `files` row stores the S3 `VersionId`.
8. Why polling every 30 s is the right MVP choice, and what would make you switch to SSE or WebSockets.

**Read:**
- PostgreSQL docs: `SELECT` locking clause (`SKIP LOCKED`)
- AWS Prescriptive Guidance: Transactional outbox pattern
- AWS S3 docs: presigned POST (POST policy conditions)
- TanStack Query docs: `refetchInterval`, `refetchIntervalInBackground`

**Interview story:** "Email delivery can never roll back or block a business action. I built a Postgres-backed
job queue with leases and retries…"

## P4 — Account lifecycle and workflows

**Concepts:**
- invitation and reset token design (single use, expiry, hashing)
- account enumeration
- state machines
- idempotent commands
- invariants (last-manager protection)
- E2E testing strategy
- test data management

**Must explain:**
1. How a password-reset token is generated, stored, delivered, validated and invalidated, and why the
   "forgot password" response is identical whether or not the email exists.
2. Why password reset revokes all sessions.
3. The membership state machine (pending → active → suspended/deactivated; pending → denied). Which
   transitions are legal and who may perform each.
4. How "you cannot remove the last active manager" is enforced so that two concurrent requests can't both
   succeed.
5. Why E2E tests read the invite email from Mailpit's API instead of reading the token from the database.

**Read:**
- OWASP Forgot Password Cheat Sheet
- Playwright docs: "Authentication" (storage state) and "Best Practices"

## P5 — The reference slice

**Concepts:**
- idempotency keys (request fingerprint)
- optimistic concurrency via conditional `UPDATE … RETURNING`
- race conditions and how to test them
- vertical slices
- writing a "recipe" so patterns spread

**Must explain:**
1. What happens when security double-clicks "Log package" on a flaky network, with and without an
   `Idempotency-Key`.
2. Why "same key, different body" is a 409.
3. Two staff click "Picked up" at the same moment: walk through both transactions, and show why exactly one
   succeeds.
4. Why `SELECT` then `UPDATE` has a race and `UPDATE … WHERE status='received' RETURNING` does not.
5. How a new resident in unit 1205 is prevented from seeing the previous tenant's packages.

**Read:**
- Stripe API docs: Idempotent requests (the de-facto industry reference)
- PostgreSQL docs: Transaction Isolation (Read Committed behaviour of `UPDATE`)

**Interview story:** "We proved our concurrency guarantees with tests that fire simultaneous requests…"

## P6–P7 — More slices, hardening, operations

**Concepts:**
- reuse through patterns, not frameworks
- public vs internal data on one entity
- backups vs restores (RPO/RTO)
- load testing and percentiles
- security headers and CSP
- threat modeling (STRIDE)
- accessibility basics

**Must explain:**
1. RPO vs RTO, and our numbers for demo vs pilot. Why "a backup you have never restored is not a backup".
2. What p95 latency means and why it matters more than the average.
3. What each security header does, and what our CSP allows.
4. The top three threats in our one-page threat model and their mitigations.

**Read:**
- k6 docs: thresholds
- MDN: Content-Security-Policy
- OWASP ASVS Level 1
- WebAIM: WCAG checklist

## Milestone D — Deployment to staging

**Concepts:**
- Infrastructure as Code and state
- OIDC federation (no long-lived keys)
- immutable artifacts promoted unchanged from CI to a server
- cloud-init and rebuildable hosts
- TLS and automatic certificates
- observability: logs, errors, uptime
- backups you have actually restored

**Must explain:**
1. What happens, step by step, between `git push` and the new version answering on staging.
2. Why GitHub OIDC is safer than storing AWS access keys in GitHub secrets, and what the `sub` claim
   restriction protects against.
3. Why the database lives on a separate EBS volume with `prevent_destroy`, and why cloud-init must never
   reformat it.
4. Why migrations run before the new containers start, and why they must stay compatible with the previous
   release.
5. Which staging-only check surprised you (D-06), and how you would catch it locally next time.

**Read:**
- AWS docs: "Configuring OpenID Connect in Amazon Web Services" (GitHub)
- Terraform tutorial: "Get Started – AWS"
- Caddy docs: Automatic HTTPS

**Interview story:** "We built and tested everything against a production-like local stack first, then
deployed to AWS in two weeks, because the artifacts had already been built and smoke-tested on every
merge…"

## Stretch — Amenity booking (if you get there)

**Concepts:**
- range types (`tstzrange`)
- exclusion constraints with `btree_gist`
- timezones and DST at boundaries

**Must explain:**
1. Why a "check availability, then insert" approach double-books under concurrency.
2. How `EXCLUDE USING gist (resource_id WITH =, during WITH &&)` makes overlap impossible.
3. What happens to a 01:30 booking on the night clocks go back.

## Turning the project into career evidence

**Resume bullets** (fill in real numbers at week 8):
- Built a multi-tenant condo-operations platform (FastAPI, PostgreSQL, React/TypeScript) with
  database-enforced tenant isolation (composite FKs) and automated fitness tests that guard every endpoint.
- Designed a PostgreSQL-backed job queue (transactional outbox, `SKIP LOCKED`, leases, backoff) that
  delivered email reliably without Redis or Celery.
- Implemented session-based auth with CSRF protection, rate limiting and audit logging; documented the
  trade-offs against JWT in ADRs.
- Shipped CI/CD from GitHub Actions to AWS after milestone D (Terraform, ECR, OIDC, SSM): every merge
  deployed in < N minutes;
  N Playwright E2E journeys; p95 < X ms at 100 virtual users.

**Portfolio artifacts:** README with an architecture diagram, an ADR folder, a recorded demo, and 2–3
explanations as writing samples.

**System-design practice:** at the end, each dev presents "design a building-management platform" in
45 minutes, using this project as the worked example. Include how it would change for 1,000 buildings:
connection pooling, read replicas, RLS, partitioning `notifications` and `audit_events`, a managed queue.
