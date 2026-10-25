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
| [P2-03](./P2-03-tenant-context-guards-fitness.md) | Tenant context, guards and fitness tests | A | 1 | P2-02, P1-05 | done | — |
| [P2-04](./P2-04-audit-events.md) | Audit events | A | 1 | P2-03 | done | — |
| [P2-05](./P2-05-rate-limiting.md) | Rate limiting | B | 1 | P2-01b | done | — |
| [P2-06a](./P2-06a-frontend-auth-core.md) | Frontend auth core: login, logout, session guard, new shell (split from [P2-06](./P2-06-frontend-auth-shell.md)) | B | 1 | P2-02, P1-07 | done | — |
| [P2-06b](./P2-06b-building-context-guards-nav.md) | Building context and membership guards (navigation split to P2-06c) | B | 1 | P2-06a | done | — |
| [P2-06c](./P2-06c-navigation-and-header-menu.md) | Navigation, header menu and council "view as" (split from P2-06b) | B | 1 | P2-06b | done | — |
| [P2-07](./P2-07-test-infrastructure-hardening.md) | Test infrastructure hardening (P1-05 and P2-03 follow-ups) | B | 3 | P2-03 | done | — |
| [P2-gate-01](./P2-gate-01-login-rate-limit-gate.md) | Reconcile the login rate-limit exit gate (James's decision) | B | 3 | P2-05, P2-07 | done | — |
| [P3-01a](./P3-01a-job-queue-and-worker.md) | Job queue and worker (split from [P3-01](./P3-01-job-queue-and-worker.md)) | B | 1 | P1-04, P0-05 | done | — |
| [P3-01b](./P3-01b-scheduler-cleanup-and-cli.md) | Scheduler, cleanup jobs and jobs CLI (split from P3-01) | B | 1 | P3-01a, P2-05, P2-01b | done | — |
| [P3-02](./P3-02-transactional-email.md) | Transactional email | B | 2 | P3-01a | done | — |
| [P3-03](./P3-03-notifications-api.md) | In-app notifications API | A | 2 | P3-01a, P2-03 | done | — |
| [P3-04a](./P3-04a-file-registry-and-uploads.md) | File registry and direct uploads (split from [P3-04](./P3-04-private-file-uploads.md)) | A | 1 | P2-03, P0-04a | done | — |
| [P3-04b](./P3-04b-file-downloads-and-claim.md) | File downloads and `claim_file` (split from P3-04) | A | 1 | P3-04a | done | — |
| [P3-04c](./P3-04c-file-cleanup-job.md) | File cleanup job (split from P3-04) | A | 1 | P3-04b, P3-01b | done | — |
| [P3-05](./P3-05-frontend-notification-center.md) | Frontend notification center with polling | B | 2 | P3-03, P2-06c | done | — |
| [P3-06](./P3-06-frontend-upload-component.md) | Frontend upload component | B | 2 | P3-04b, P2-06b | done | — |
| [P4-01a](./P4-01a-units-api.md) | Units API and unit options (split from [P4-01](./P4-01-units-api.md)) | A | 2 | P2-03, P2-04 | done | — |
| [P4-01b](./P4-01b-units-csv-import.md) | Units CSV import (split from P4-01) | A | 2 | P4-01a | done | — |
| [P4-02a](./P4-02a-invitations-management.md) | Invitations: table and manager endpoints (split from [P4-02](./P4-02-staff-invitations.md)) | A | 1 | P3-02, P2-04, P2-03, P2-05 | done | — |
| [P4-02b](./P4-02b-invitation-accept.md) | Invitation lookup and accept (split from P4-02) | A | 1 | P4-02a | done | — |
| [P4-03](./P4-03-bootstrap-building-command.md) | Bootstrap-building operator command | A | 1 | P4-02b, P4-01b, P1-06 | done | — |
| [P4-04](./P4-04-password-reset.md) | Password reset | B | 1 | P3-02, P2-05, P2-04 | done | — |
| [P4-05a](./P4-05a-resident-signup-and-join.md) | Resident signup and join request (split from [P4-05](./P4-05-resident-join-onboarding-approval.md)) | A | 1 | P4-01a, P3-03, P2-04, P2-05 | done | — |
| [P4-05b](./P4-05b-onboarding-decisions.md) | Onboarding decisions: list, approve, deny (split from P4-05) | A | 1 | P4-05a | done | — |
| [P4-06a](./P4-06a-members-roles-suspension.md) | Members: list, roles, suspend, reactivate (split from [P4-06](./P4-06-membership-administration.md)) | A | 1 | P2-04, P4-05b | done | — |
| [P4-06b](./P4-06b-move-out-and-transfer.md) | Members: move-out and transfer (split from P4-06) | A | 1 | P4-06a | done | — |
| [P4-07a](./P4-07a-password-reset-screens.md) | Password reset screens and password field (split from [P4-07](./P4-07-frontend-account-screens.md)) | B | 2 | P4-04, P2-06c | done | — |
| [P4-07b](./P4-07b-frontend-accept-invite.md) | Accept-invitation screen (split from P4-07) | B | 2 | P4-07a, P4-02b, P2-06c | done | — |
| [P4-08a](./P4-08a-join-flow-and-status-screens.md) | Join flow and pending/denied screens (split from [P4-08](./P4-08-frontend-onboarding-approval-screens.md)) | B | 2 | P4-05b, P2-06c, P4-07b | done | — |
| [P4-08b](./P4-08b-manager-pending-requests.md) | Manager pending requests (split from P4-08; badge split to P4-08d) | B | 2 | P4-08a, P4-05b, P2-06c | done | — |
| [P4-08d](./P4-08d-pending-badge-and-onboarding-follow-ups.md) | Pending-requests nav badge and onboarding follow-ups (split from P4-08b) | B | 2 | P4-08b | done | — |
| [P4-08f](./P4-08f-account-menu-and-notifications-follow-ups.md) | Account menu and notifications panel follow-ups (from P4-08d) | B | 2 | P4-08d | done | — |
| [P4-08h](./P4-08h-header-panels-at-phone-width.md) | Header panels at phone width (from P4-08f) | B | 2 | P4-08f | done | — |
| [P4-08c](./P4-08c-members-administration.md) | Members list, suspend, reactivate, move out (split from P4-08; roles and transfer split to P4-08e) | B | 2 | P4-08b, P4-06b | done | — |
| [P4-08e](./P4-08e-member-roles-and-transfer.md) | Member roles editor and unit transfer (split from P4-08c) | B | 2 | P4-08c | done | — |
| [P4-08g](./P4-08g-staff-invitations-screen.md) | Staff invitations screen (from P4-09; resend, revoke and residents split to P4-08i) | B | 2 | P4-02a, P4-08b, P4-09 | done | — |
| [P4-08i](./P4-08i-invitation-resend-revoke-and-residents.md) | Invitation resend, revoke and pre-approved residents (split from P4-08g) | B | 2 | P4-08g | done | — |
| [P4-09](./P4-09-playwright-harness-onboarding-e2e.md) | Playwright harness and onboarding E2E | B | 2 | P4-07b, P4-08c, P4-03, P1-08 | done | — |
| [P5-01](./P5-01-package-schema-state-machine.md) | Package schema and state machine | A | 1 | P1-03, P3-04b | done | — |
| [P5-02a](./P5-02a-package-create-and-read.md) | Package create and read | A | 1 | P5-01, P3-03, P2-04, P4-01a | done | — |
| [P5-02b](./P5-02b-package-pickup-and-return.md) | Package pickup and return | A | 1 | P5-02a | done | — |
| [P5-03a](./P5-03a-package-desk-read-fields.md) | Package desk read fields (split from P5-03) | A | 1 | P5-02a, P5-02b | done | — |
| [P5-03b](./P5-03b-package-desk-page-and-waiting-list.md) | Package desk page and waiting list (split from P5-03) | B | 2 | P5-03a, P3-06 | done | — |
| [P5-03c](./P5-03c-log-package-panel.md) | Log package panel (split from P5-03) | B | 2 | P5-03b | done | — |
| [P5-03d](./P5-03d-package-pickup-and-return-dialogs.md) | Package pickup and return dialogs (split from P5-03) | B | 2 | P5-03b | done | — |
| [P5-04](./P5-04-resident-packages-page.md) | Resident packages page | B | 2 | P5-02a, P3-05 | done | — |
| [P5-05](./P5-05-packages-e2e-and-slice-gate.md) | Packages E2E and reference-slice gate | B | 1 | P5-03c, P5-03d, P5-04, P4-09, P1-08 | done | — |
| [P6-01a](./P6-01a-notice-schema-and-visibility.md) | Notice schema, state machine and visibility (split from P6-01) | B | 2 | P3-04b, P2-03 | done | — |
| [P6-01b](./P6-01b-notice-authoring-api.md) | Notice authoring API (split from P6-01) | B | 2 | P6-01a, P2-04, P3-04b | done | — |
| [P6-01c](./P6-01c-notice-reads-and-fan-out.md) | Notice reads, unread summary and publish fan-out (split from P6-01) | B | 2 | P6-01b, P3-03, P3-02 | done | — |
| [P6-02a](./P6-02a-notices-feed-and-detail.md) | Notices feed (split from P6-02) | B | 2 | P6-01c, P5-05 | done | — |
| [P6-02b](./P6-02b-urgent-banner-and-attachments.md) | One notice, urgent banner and attachments (split from P6-02) | B | 2 | P6-02a, P3-06 | done | — |
| [P6-02c](./P6-02c-manager-notice-list-and-actions.md) | Manager notice list, publish and archive (split from P6-02) | B | 2 | P6-02a, P6-01b | done | — |
| [P6-02d](./P6-02d-notice-editor.md) | Notice editor with preview and publish (split from P6-02) | B | 2 | P6-02c, P3-06 | done | — |
| [P6-02e](./P6-02e-list-focus-fixes.md) | List focus fixes: "Load more" and the feed card (split from P6-02d) | B | 2 | P6-02c | done | — |
| [P6-02f](./P6-02f-notice-expiry-and-attachment.md) | Notice editor: expiry and attachment (split from P6-02d) | B | 2 | P6-02d, P3-06 | todo | — |

### Milestone D — deployment (after week 8)

| ID | Title | Lane | Tier | Depends on | Status | Learned |
|---|---|---|---|---|---|---|
| [D-01](./D-01-terraform-base.md) | Terraform base infrastructure | B | 1 | P0-04a, P0-04b | todo | — |
| [D-02](./D-02-host-bootstrap-caddy-compose.md) | Host bootstrap, Caddy and staging compose | B | 1 | D-01, P1-08, P3-01a | todo | — |
| [D-03](./D-03-cicd-deploy-staging.md) | CI/CD: build, push and deploy to staging | B | 1 | D-02, P1-08 | todo | — |
| [D-04](./D-04-logs-errors-uptime.md) | Logs, error tracking and uptime | A | 2 | D-03 | todo | — |
| [D-05](./D-05-nightly-backups-to-s3.md) | Nightly backups to S3 and the staging restore test | A | 1 | D-02, P7-01, D-04 | todo | — |
| [D-06](./D-06-staging-verification-gate.md) | Staging verification gate | both | 1 | D-03, D-04, D-05, P5-05, P6-07 | todo | — |

## Critical path

```text
P0-02 → P0-05 → P1-01 → P1-02 → P1-03 → P1-05 → P2-03 → P2-04 → P4-01a → P4-05a → P4-05b → P4-06a → P4-06b → P4-08a → P4-08b → P4-08c → P4-09 → P5-05
                         P1-02 → P2-01a → P2-01b → P2-02 ↗         P3-01a → P3-03 ↗
                                  P2-02 → P2-06a → P2-06b → P2-06c ───────────────────────↗ (P4-08a)
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
