# Architecture Decision Records

An ADR records **one** decision: its context, what we chose, what we gave up, and when to revisit it.
ADRs are short (one screen), numbered, and never deleted. When a decision changes, write a new ADR that
supersedes the old one and set the old one's status to `Superseded by NNNN`.

**Who writes them:** agents write them when a ticket makes a lasting decision
([decision rules](../AI_AGENT_PLAYBOOK.md#decision-rules)), with `Deciders: agent (autonomous) in <ticket>`, and
list them in [HUMAN_INBOX.md](../HUMAN_INBOX.md) for James to audit. James writes them for decisions he makes
himself. Reading them is a core learning activity, because they state the trade-offs.

| # | Decision | Status |
|---|---|---|
| [0001](./0001-record-architecture-decisions.md) | Record architecture decisions as ADRs; defaults now, revisit at pilot | Accepted |
| [0002](./0002-modular-monolith.md) | Modular monolith: FastAPI + PostgreSQL, package-by-feature | Accepted |
| [0003](./0003-same-origin-server-side-sessions.md) | Server-side sessions in a same-origin cookie (no JWT) | Accepted |
| [0004](./0004-path-scoped-tenancy.md) | Path-scoped tenancy with a server-validated TenantContext | Accepted |
| [0005](./0005-tenant-integrity-in-the-database.md) | Tenant integrity enforced by composite FKs; RLS deferred | Accepted |
| [0006](./0006-postgres-job-queue.md) | PostgreSQL job queue (outbox) for email and background work | Accepted |
| [0007](./0007-private-s3-presigned-uploads.md) | Private S3 with presigned POST uploads and a server-owned file registry | Accepted |
| [0008](./0008-single-ec2-compose-caddy.md) | Single EC2 host with Docker Compose and host Caddy, in ca-central-1 | Accepted (from the 2026-10-12 decision); timing amended by 0013 |
| [0009](./0009-backups-staged.md) | Staged backups: pg_dump for demo, PITR (or RDS) before pilot | Accepted; demo schedule amended by 0013 |
| [0010](./0010-unit-occupancy-relationship.md) | Dated unit occupancy with owner / tenant / household relationship | Accepted |
| [0011](./0011-frontend-strangler-typescript.md) | Strangler migration of the Base44 frontend to typed API + TypeScript | Accepted |
| [0012](./0012-polling-not-websockets.md) | Polling with React Query for freshness; no WebSockets/Redis in MVP | Accepted |
| [0013](./0013-local-first-deployment-milestone.md) | Build and test locally first; deployment is a separate milestone (D) | Accepted |
| [0014](./0014-autonomous-agent-workflow.md) | Agents build, review and merge tickets autonomously; humans audit asynchronously | Accepted |
| [0015](./0015-typescript-eslint-for-new-code.md) | Lint TypeScript with typescript-eslint's recommended rules (agent, P0-03a) | Accepted |
| [0016](./0016-occupancy-windows-and-writes.md) | Occupancy windows are half-open on the database clock; writes serialize per membership (agent, P1-03) | Accepted |

Template: [../templates/ADR.md](../templates/ADR.md).
