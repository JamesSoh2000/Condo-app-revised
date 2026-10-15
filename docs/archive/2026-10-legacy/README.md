# Legacy docs (archived 2026-10-13)

**Superseded on 2026-10-13 by [docs/README.md](../../README.md); kept for history.**

Don't use these files as current guidance: their rules, ticket IDs (M0-T01 …) and workflow are replaced by the
plan in [`docs/`](../../README.md), adopted in [P0-01](../../tickets/P0-01-adopt-plan-into-repo.md). Links
inside these files are not maintained (`scripts/check-links.py` skips this folder).

| File | Was | Now |
|---|---|---|
| [AI_PROJECT_CONTEXT.md](./AI_PROJECT_CONTEXT.md) | Context to attach to AI sessions | [`CLAUDE.md`](../../../CLAUDE.md) |
| [AI_AGENT_WORKFLOW.md](./AI_AGENT_WORKFLOW.md) | Two-dev AI workflow | [AI_AGENT_PLAYBOOK.md](../../AI_AGENT_PLAYBOOK.md), [`.claude/commands/`](../../../.claude/README.md) |
| [MILESTONES_AND_TICKETS.md](./MILESTONES_AND_TICKETS.md) | Milestones M0–M16, ~170 tickets | [ROADMAP.md](../../ROADMAP.md), [tickets/](../../tickets/README.md) |
| [BACKEND_INFRA.md](./BACKEND_INFRA.md) | Target backend/infra guide | [ARCHITECTURE.md](../../ARCHITECTURE.md), [adr/](../../adr/README.md) |
| [backend_requirements.md](./backend_requirements.md) | Backend/product requirements | [PRODUCT_SCOPE.md](../../PRODUCT_SCOPE.md) |
| [backend/](./backend/README.md) | Backend notes (readiness) | [ARCHITECTURE.md](../../ARCHITECTURE.md) |

## Where the old milestones went

The milestones (M0–M16) are from [MILESTONES_AND_TICKETS.md](./MILESTONES_AND_TICKETS.md).

| Old milestone | Where it went |
|---|---|
| M0 Scope & policy (T01–T10) | Scope → [01](../../PRODUCT_SCOPE.md); vocabulary → P1-02 + [01](../../PRODUCT_SCOPE.md); council view → P2-03/P2-06 (presentation only); environments → [ADR-0008](../../adr/0008-single-ec2-compose-caddy.md) + D-01; workflow/board → [05](../../AI_AGENT_PLAYBOOK.md) + P0-01/P0-04; **T09/T10 policy and targets → adopted defaults in [01](../../PRODUCT_SCOPE.md#product-defaults-adopted-now-revisit-at-pilot), re-decided in [07](../../PILOT_READINESS.md)** |
| M1 Local foundation | Done; follow-ups in P0-02…P0-05 |
| M2 Database & tenancy | P1-01…P1-05; T08 RLS → deferred ([ADR-0005](../../adr/0005-tenant-integrity-in-the-database.md)); T09 → P1-04; T10 → [02 §8](../../ARCHITECTURE.md#8-api-conventions) + P1-01; T11 → P1-06; T12 → P1-03 |
| M3 Auth, onboarding, audit | P2-01…P2-05, P4-01…P4-06; **T14 staff MFA → pilot**; T13 → P3-02 + P4-02/P4-04 |
| M4 Frontend migration | P0-03, P1-07, P2-06, P4-07, P4-08; T09 Base44 exit → pilot §7 (ratchet tracks progress meanwhile) |
| M5 Notifications, files, delivery | P3-01…P3-06; T10 preferences UI and T12 provider feedback → pilot; SMS → pilot option |
| M6 Resident core, notices, dashboard | P6-01…P6-06; profile extensions (vehicles, contacts, documents) → pilot option |
| M7 Packages & parking | P5-01…P5-05; T07 retention → pilot; parking proof → pilot option |
| M8 Maintenance | P6-03, P6-04 |
| M9 Moves · M10 Reports & daily ops · M11 Amenities · M12 Visitors | Pilot options, detailed when selected ([03 §After week 8](../../ROADMAP.md#after-week-8-deployment-then-toward-the-pilot-months-36)); amenities may be the week-8 stretch |
| M13 Financials & council overview | Later (needs the owner model from ADR-0010) |
| M14 Infrastructure | P1-08 (local prod-like stack), milestone D: D-01…D-06 (staging, CI/CD, observability, nightly backups), P3-01 (worker), P7-01 (backup scripts); maintenance mode, rollback drill, PITR, production → pilot |
| M15 QA, security, UAT, launch | Continuous (tests, E2E, fitness tests) + P7-02/P7-03/P7-04; UAT/launch → pilot |
| M16 Post-MVP | Unchanged: later |

## Planning folders outside the repo

These live next to the repo, not in it. Decide as a team after reading the review:
- `Recent_Plan/docs/`, `Recent_Plan/entire_*.md`, `Past_folder/`, `Plan/*`: mark as superseded, or move under
  an `archive/` folder.
- `Plan/EC2-single-instance-deployment-plan.md`: still the detailed reference behind
  [ADR-0008](../../adr/0008-single-ec2-compose-caddy.md). Keep it.
- `Process/`: the pre-implementation per-ticket guides. Stop writing these, and use post-implementation
  explanations ([templates/EXPLANATION.md](../../templates/EXPLANATION.md)) instead. Keep the
  `initial database Structure/metropolis-data-schema.md` business schema; it informs the later financials
  epic.
- `Recent_Plan/learning_content/`, `Study_book/`: your personal study material. Continue using it alongside
  [LEARNING_PATH.md](../../LEARNING_PATH.md).
- `.agents/` and `.codex/` (top level, empty since 2026-05-31): delete them. Codex reads the repo's
  [`AGENTS.md`](../../../AGENTS.md), which points to `CLAUDE.md` instead of keeping a second rule set.
