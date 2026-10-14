# AI Agent Workflow

This is the working process for two developers using agentic AI coding on the condo management app.

The goal is to let both developers move in parallel without producing tangled branches, duplicate abstractions, or half-migrated Base44 behavior.

## Standard Context Pack

Attach this to every AI coding session:

1. The exact ticket text.
2. `docs/AI_PROJECT_CONTEXT.md`.
3. Any relevant domain doc or code file named by the ticket.
4. The relevant milestone section from `docs/MILESTONES_AND_TICKETS.md` if the ticket is broad.

Do not attach the entire repo unless the AI tool needs it. Smaller, sharper context usually produces better code.

## Recommended Team Model

### Phase 1: Foundation

Run mostly sequentially on shared contracts:

- Repo structure.
- Backend local setup.
- Database/Alembic setup.
- Auth and building membership model.
- Feature entitlement model.
- Frontend API client.
- Frontend auth shell.

Only one developer should own a shared foundation file at a time.

Shared files that should be edited carefully:

- `backend/app/config.py` or future `backend/app/core/config.py`.
- `backend/app/database.py` or future `backend/app/core/database.py`.
- Auth dependencies and route guards.
- Alembic migration heads.
- Frontend API client.
- Frontend layout/auth/route protection.
- Package lock files.

### Phase 2: Vertical Slices

After auth, tenant scoping, and the API client exist, split work by vertical feature slice:

- Packages.
- Maintenance.
- Moves and inspections.
- Reports.
- Notices/calendar.
- Amenities.
- Visitor access.
- Financials/council oversight.

A vertical slice includes schema, migrations, API, frontend wiring, notifications, permissions, tests, and manual verification for that feature.

### Phase 3: Hardening

Switch back to coordinated work:

- Security review.
- Tenant isolation tests.
- E2E tests.
- Staging deploy.
- UAT fixes.
- Production launch checklist.

## Branch And Ticket Naming

Use short branch names that include the ticket ID:

```text
dev-a/m3-t04-resident-approval
dev-b/m7-t03-resident-packages
dev-a/m11-t01-amenity-foundation
```

Every PR title should start with the ticket ID:

```text
M7-T01 Package schema and backend API
```

## Ticket Shape For AI Coding

Every AI-ready ticket should include:

```markdown
## Goal
One sentence describing the outcome.

## Context
Relevant docs, existing files, domain terms, and links.

## Scope
What the agent should change.

## Out Of Scope
What the agent should not touch.

## Dependencies
Tickets or contracts that must already exist.

## Acceptance Criteria
Specific behavior that must work.

## Tests / Verification
Commands, manual flows, and expected results.

## Likely Files
Optional list of files or folders to inspect first.
```

## Starter Prompt Template

Paste this into the AI IDE with the ticket:

```text
You are working in the condo management app repo.

Attached:
- docs/AI_PROJECT_CONTEXT.md
- Ticket: <ticket id and title>
- Relevant files/docs: <list>

Use the project vocabulary from docs/AI_PROJECT_CONTEXT.md. In particular:
- Use "Council Member" and role slug `council`.
- Treat old `board` references as legacy compatibility only.
- Security means building security/concierge staff, not cybersecurity.
- MVP notifications use database records plus API refetch/polling; do not add WebSockets unless this is a live chat ticket.
- Never trust `building_id` from client input.

Task:
<paste ticket>

Please inspect the existing code first, then implement the smallest complete change that satisfies the acceptance criteria. Add migrations/tests/docs as needed. Before finishing, summarize files changed, tests run, and any follow-up questions.
```

## How Two Devs Should Parallelize

Use a simple ownership rule:

- One developer owns backend contract work for a feature.
- One developer owns frontend wiring for the same feature only after the API shape is stable.
- If both developers work in the same feature, agree on the API contract first in a small PR.

Good parallel examples:

- Dev A builds package backend while Dev B builds frontend API client/auth shell.
- Dev A builds maintenance backend while Dev B migrates package frontend after package API is merged.
- Dev A sets up S3 file backend while Dev B updates upload components against a mocked/presigned contract.

Risky parallel examples:

- Both developers editing `Layout.jsx`.
- Both developers editing auth dependencies.
- Both developers generating Alembic migrations from different model states.
- One developer changing API response shape while another migrates frontend pages against the old shape.

## Contract-First Rule

When a ticket crosses frontend and backend:

1. Define endpoint paths, request shape, response shape, status codes, and permission rules.
2. Add or update Pydantic schemas.
3. Add frontend API module methods.
4. Then wire UI.

For bigger features, land a small contract PR before large UI/backend implementation.

## AI Session Workflow

### Before The Agent Codes

The developer should ask the agent to:

- Read the ticket.
- Read `docs/AI_PROJECT_CONTEXT.md`.
- Search the repo for relevant files.
- State the intended change plan.
- Identify risky shared files.

### During Coding

Keep the agent constrained:

- One ticket per session.
- No unrelated refactors.
- No broad renames unless the ticket is a rename/migration ticket.
- No new dependency without explaining why.
- No generated migration left unreviewed.

### After Coding

The agent must report:

- Files changed.
- Migrations added.
- Env vars added.
- Tests run.
- Manual verification steps.
- Known gaps.
- Follow-up tickets.

## PR Checklist

Every PR should answer:

- What ticket does this close?
- What changed?
- What tests were run?
- Any migrations?
- Any new env vars?
- Any feature flag/paywall behavior?
- Any role/permission changes?
- Any tenant isolation risks?
- Any frontend route or API contract changes?
- Any legacy `board` compatibility left behind?

## AI Review Prompt

Use a separate AI review pass before human review:

```text
Review this PR as a senior engineer for bugs, security issues, tenant isolation mistakes, missing role/feature guards, migration risks, and missing tests.

Project rules:
- Use `council`, not new `board` terminology.
- Never trust `building_id` from client input.
- Feature flags are backend security controls.
- Files live in S3, not PostgreSQL.
- MVP notifications do not use WebSockets.

List findings by severity with file/line references. If no issues, say so and list residual risks.
```

## Conflict Avoidance Rules

- Pull latest before starting a ticket.
- Do not keep long-running branches for shared files.
- Avoid editing package lock files unless dependencies actually changed.
- Avoid touching generated Base44 files unless the ticket migrates that area.
- If two branches both add migrations, rebase and regenerate/check migration order before merge.
- Keep compatibility aliases during role rename work if existing data or frontend code still references legacy `board`.

## Handoff Format

When handing a ticket to the other developer:

```markdown
## Handoff
Ticket:
Branch:
Status:
Changed files:
Commands run:
What works:
What still needs review:
Open questions:
```

## Recommended First AI-Ready Tickets

Start with tickets that create shared clarity:

1. M0-T03 Base44 usage matrix.
2. M0-T04 naming and role vocabulary.
3. M0-T07 legacy board-to-council migration plan.
4. M2-T05 API response shape standards.
5. M3-T03 auth dependencies and role guards.
6. M4-T01 frontend API client.

After those, vertical feature tickets become much safer for AI agents.
