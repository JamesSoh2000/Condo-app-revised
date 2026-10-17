# Tickets

Detailed tickets cover **P0–P5** (weeks 1–6, up to the reference-slice gate). Weeks 7–8 are stubs in
[P6-P7-backlog.md](./P6-P7-backlog.md), to be detailed during week 5 (rolling wave). Weeks 1–8 run locally
and in CI only ([ADR-0013](../adr/0013-local-first-deployment-milestone.md)).

**Milestone D** (deployment to AWS staging, after week 8) has its own tickets, D-01…D-06. D-01…D-04 were
the first draft's P1-08…P1-11, so they are already detailed. Re-frame each one before starting, because the
code it builds on will have changed. Every ticket follows
[../templates/TICKET.md](../templates/TICKET.md) and is built, reviewed and merged by agents with the
autonomous loop in [../AI_AGENT_PLAYBOOK.md](../AI_AGENT_PLAYBOOK.md).

**How to use this index:**
- **Pick:** `/build-next` picks a `todo` ticket whose dependencies are all `done` (or whose interface
  contract is merged), critical path first (see
  [Definition of Ready](../ENGINEERING_PRACTICES.md#3-definition-of-ready-before-an-agent-starts)).
- **Status values:** `todo` → `in progress` → `review` → `done`, or `blocked` when the agent hits a
  [stop rule](../AI_AGENT_PLAYBOOK.md#stop-rules) (the reason is in [HUMAN_INBOX.md](../HUMAN_INBOX.md)).
  The agent sets `done` in the ticket's own PR, so it lands with the merge.
- **Lane** A = backend/platform; B = frontend/QA/ops. Lanes are two parallel agent tracks that avoid file
  conflicts; at most one agent per lane.
- **Tier** 1/2/3 sets the frame, review and explanation depth ([risk tiers](../AI_AGENT_PLAYBOOK.md#risk-tiers)).
- **Learned:** James's own tracker: `✓` after reading the explanation and doing any learning wanted
  (`/quiz-me`, a note, a hand-written change). Nothing waits on it.
- If a ticket turns out larger than one PR (≤ ~400 changed non-test lines), the agent splits it during
  framing (`P3-04a`, `P3-04b`) and adds the rows here, as was done for P5-02a/P5-02b.
- P6–P7 stubs become full tickets with `/draft-ticket <ID>`, through the same loop.

## Index

<!-- generated -->
| ID | Title | Lane | Tier | Depends on | Status | Learned |
|---|---|---|---|---|---|---|
| [P0-01](./P0-01-adopt-plan-into-repo.md) | Adopt the new plan into the repo | A | 3 | — | done | — |
| [P0-02](./P0-02-backend-quality-gates.md) | Backend quality gates | A | 3 | P0-01 | done | — |
| [P0-03a](./P0-03a-frontend-lint-and-type-gates.md) | Frontend lint and type gates (split from [P0-03](./P0-03-frontend-quality-gates.md)) | B | 3 | P0-01 | done | — |
| [P0-03b](./P0-03b-same-origin-proxy-and-route-scope.md) | Same-origin dev proxy and demo route scope | B | 2 | P0-03a | done | — |
| [P0-03c](./P0-03c-frontend-whitespace-and-pre-commit.md) | Frontend whitespace normalisation and pre-commit scope | B | 3 | P0-03a, P0-03b | done | — |
| [P0-04a](./P0-04a-local-stack-and-makefile.md) | Local stack and Makefile (split from [P0-04](./P0-04-repo-workflow-and-local-stack.md)) | B | 2 | P0-02, P0-03a, P0-03b | done | — |
| [P0-04b](./P0-04b-github-workflow.md) | GitHub workflow: branch protection, PR template, Dependabot, branches | B | 2 | P0-02, P0-03a, P0-03b | done | — |
| [P0-05](./P0-05-database-test-infrastructure.md) | Database test infrastructure | A | 2 | P0-02 | done | — |
| [P0-06](./P0-06-runtime-and-ci-upgrades.md) | Runtime and CI upgrades: Python 3.14, Postgres 18, SQLAlchemy 2.1, Actions v7 | A | 2 | P0-04a, P0-04b, P0-05 | done | — |
| [P0-07](./P0-07-venv-outside-bind-mount.md) | App venv outside the bind mount; Dependabot leaves uv alone | A | 3 | P0-06 | done | — |
| [P1-01](./P1-01-buildings-features-units-schema.md) | Buildings, features and units schema | A | 2 | P0-05 | done | — |
| [P1-02](./P1-02-users-memberships-roles-schema.md) | Users, memberships and roles schema | A | 1 | P1-01 | done | — |
| [P1-03](./P1-03-unit-occupancies-schema.md) | Unit occupancies schema | A | 1 | P1-02 | done | — |
| [P1-04](./P1-04-api-conventions.md) | API conventions: errors, pagination, schemas | B | 2 | P0-02 | done | — |
| [P1-05](./P1-05-test-world-and-isolation-helpers.md) | Test world fixtures and tenant-isolation helpers | A | 1 | P1-03, P0-05 | done | — |
| [P1-06](./P1-06-seed-and-cli.md) | Seed data and operator CLI skeleton | A | 3 | P1-03 | done | — |
| [P1-07](./P1-07-openapi-types-and-api-client.md) | OpenAPI → TypeScript types and API client | B | 2 | P1-04, P0-03a, P0-03b | done | — |
| [P1-08](./P1-08-production-like-local-stack.md) | Production-like local stack (local walking skeleton) | B | 2 | P0-04a, P0-02, P0-03a, P0-03b | done | — |
| [P2-01a](./P2-01a-csrf-and-password-hashing.md) | CSRF protection and password hashing (split from [P2-01](./P2-01-sessions-login-logout-csrf.md)) | A | 1 | P1-02, P1-04, P1-06 | done | — |
| [P2-01b](./P2-01b-sessions-login-logout.md) | Sessions, login and logout | A | 1 | P2-01a, P1-02, P1-05 | done | — |
| [P2-02](./P2-02-me-and-session-management.md) | Current-user API and session management | A | 1 | P2-01b | done | — |
| [P2-03](./P2-03-tenant-context-guards-fitness.md) | Tenant context, guards and fitness tests | A | 1 | P2-02, P1-05 | todo | — |
| [P2-04](./P2-04-audit-events.md) | Audit events | A | 1 | P2-03 | todo | — |
| [P2-05](./P2-05-rate-limiting.md) | Rate limiting | B | 1 | P2-01b | todo | — |
| [P2-06](./P2-06-frontend-auth-shell.md) | Frontend auth shell, guards and building picker | B | 1 | P2-02, P1-07 | todo | — |
| [P3-01](./P3-01-job-queue-and-worker.md) | Job queue and worker | B | 1 | P1-04, P0-05 | todo | — |
| [P3-02](./P3-02-transactional-email.md) | Transactional email | B | 2 | P3-01 | todo | — |
| [P3-03](./P3-03-notifications-api.md) | In-app notifications API | A | 2 | P3-01, P2-03 | todo | — |
| [P3-04](./P3-04-private-file-uploads.md) | Private file uploads | A | 1 | P2-03, P0-04a | todo | — |
| [P3-05](./P3-05-frontend-notification-center.md) | Frontend notification center with polling | B | 2 | P3-03, P2-06 | todo | — |
| [P3-06](./P3-06-frontend-upload-component.md) | Frontend upload component | B | 2 | P3-04, P2-06 | todo | — |
| [P4-01](./P4-01-units-api.md) | Units API | A | 2 | P2-03, P2-04 | todo | — |
| [P4-02](./P4-02-staff-invitations.md) | Staff invitations | A | 1 | P3-02, P2-04, P2-03, P2-05 | todo | — |
| [P4-03](./P4-03-bootstrap-building-command.md) | Bootstrap-building operator command | A | 1 | P4-02, P4-01, P1-06 | todo | — |
| [P4-04](./P4-04-password-reset.md) | Password reset | B | 1 | P3-02, P2-05, P2-04 | todo | — |
| [P4-05](./P4-05-resident-join-onboarding-approval.md) | Resident join, onboarding and approval | A | 1 | P4-01, P3-03, P2-04, P2-05 | todo | — |
| [P4-06](./P4-06-membership-administration.md) | Membership administration | A | 1 | P2-04, P4-05 | todo | — |
| [P4-07](./P4-07-frontend-account-screens.md) | Frontend account screens | B | 2 | P4-02, P4-04, P2-06 | todo | — |
| [P4-08](./P4-08-frontend-onboarding-approval-screens.md) | Frontend onboarding and approval screens | B | 2 | P4-05, P4-06, P2-06 | todo | — |
| [P4-09](./P4-09-playwright-harness-onboarding-e2e.md) | Playwright harness and onboarding E2E | B | 2 | P4-07, P4-08, P4-03, P1-08 | todo | — |
| [P5-01](./P5-01-package-schema-state-machine.md) | Package schema and state machine | A | 1 | P1-03, P3-04 | todo | — |
| [P5-02a](./P5-02a-package-create-and-read.md) | Package create and read | A | 1 | P5-01, P3-03, P2-04, P4-01 | todo | — |
| [P5-02b](./P5-02b-package-pickup-and-return.md) | Package pickup and return | A | 1 | P5-02a | todo | — |
| [P5-03](./P5-03-security-packages-page.md) | Security packages page | B | 2 | P5-02a, P5-02b, P3-06 | todo | — |
| [P5-04](./P5-04-resident-packages-page.md) | Resident packages page | B | 2 | P5-02a, P3-05 | todo | — |
| [P5-05](./P5-05-packages-e2e-and-slice-gate.md) | Packages E2E and reference-slice gate | B | 1 | P5-03, P5-04, P4-09, P1-08 | todo | — |

### Milestone D — deployment (after week 8)

| ID | Title | Lane | Tier | Depends on | Status | Learned |
|---|---|---|---|---|---|---|
| [D-01](./D-01-terraform-base.md) | Terraform base infrastructure | B | 1 | P0-04a, P0-04b | todo | — |
| [D-02](./D-02-host-bootstrap-caddy-compose.md) | Host bootstrap, Caddy and staging compose | B | 1 | D-01, P1-08, P3-01 | todo | — |
| [D-03](./D-03-cicd-deploy-staging.md) | CI/CD: build, push and deploy to staging | B | 1 | D-02, P1-08 | todo | — |
| [D-04](./D-04-logs-errors-uptime.md) | Logs, error tracking and uptime | A | 2 | D-03 | todo | — |
| [D-05](./D-05-nightly-backups-to-s3.md) | Nightly backups to S3 and the staging restore test | A | 1 | D-02, P7-01, D-04 | todo | — |
| [D-06](./D-06-staging-verification-gate.md) | Staging verification gate | both | 1 | D-03, D-04, D-05, P5-05, P6-07 | todo | — |

## Critical path

```text
P0-02 → P0-05 → P1-01 → P1-02 → P1-03 → P1-05 → P2-03 → P2-04 → P4-01 → P4-05 → P4-06 → P4-08 → P4-09 → P5-05
                         P1-02 → P2-01a → P2-01b → P2-02 ↗         P3-01 → P3-03 ↗
```

The data and identity chain (lane A) is the critical path. Its tickets must merge one after another, so the
calendar time between "PR ready" and "merged" matters more than total hours. With no human review on the
merge path ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)), that time is CI plus review rounds; a
blocked critical-path ticket is the costliest thing in the inbox. Tickets that are off this chain were moved to lane B: P2-05
(rate limiting), P3-02 (email, which builds on lane B's P3-01), P4-04 (password reset) and P1-04 (API
conventions). P1-04 should merge by the start of week 2, because P2-01 (lane A) and P1-07 need it. P2-05
and P3-02 feed P4-02 and P4-05 on lane A, so lane B merges them in week 3.

In weeks 1–2, lane B runs API conventions (P1-04), the frontend foundation (P0-03 → P1-07 → P2-06) and the
local walking skeleton (P1-08). It then starts the job queue (P3-01) a week earlier than the first draft.
No ticket before milestone D needs an AWS account, a domain or a server.

Milestone D's chain is D-01 → D-02 → D-03 → D-06. D-04 and D-05 can be coded locally while the chain is in
progress, but they are verified on staging. The human prerequisites (AWS account, domain, SES) start about a
week before D.

## Done before this plan (old IDs)

| Old ID | Title | State |
|---|---|---|
| M1-T01 | Backend skeleton | done |
| M1-T02 | Local Docker Compose | done (Redis removal and Mailpit/S3 additions in P0-04) |
| M1-T03 | Frontend local baseline | done |
| M1-T04 | Shared local development docs | done (rewritten quickstart in P0-04) |
| M1-T05 | Baseline CI | partially done (lint/format/types in P0-02, P0-03; DB tests in P0-05) |
| M2-T01 | SQLAlchemy async + Alembic | done |
| M2-T02 | Shared model conventions | done (`Base`, naming convention, uuid7 mixin, `database_enum`) |
| M2-T03 | Core tenant schema | in progress, continued as **P1-01** |
