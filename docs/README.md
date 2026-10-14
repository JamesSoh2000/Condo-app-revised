# Condo Management App — Project Docs

Condo / building management app (FastAPI + PostgreSQL + React), built by James and Khoi with AI agents
implementing tickets and humans framing, reviewing and learning.

**This folder is the single source of truth** for scope, architecture, decisions, tickets and process.
It was created on 2026-10-13 from a senior-engineer review ([REVIEW-2026-10.md](./REVIEW-2026-10.md)) and
adopted into the repo by [P0-01](./tickets/P0-01-adopt-plan-into-repo.md). The previous docs are kept for
history in [archive/2026-10-legacy/](./archive/2026-10-legacy/README.md), along with the old→new mapping.

## Reading order

| # | Document | Read it to learn | Time |
|---|---|---|---|
| 1 | [REVIEW-2026-10.md](./REVIEW-2026-10.md) | What is strong, what is blocking you, and why the plan changed | 15 min |
| 2 | [PRODUCT_SCOPE.md](./PRODUCT_SCOPE.md) | What the week-8 demo does, what waits for the pilot, the product defaults | 10 min |
| 3 | [ARCHITECTURE.md](./ARCHITECTURE.md) | How the system fits together (diagrams, data model, auth, tenancy, jobs, files, deploy) | 30 min |
| 4 | [ROADMAP.md](./ROADMAP.md) | Week-by-week plan for two developers, phase gates | 10 min |
| 5 | [AI_AGENT_PLAYBOOK.md](./AI_AGENT_PLAYBOOK.md) | **Your improved implement → review → explain → learn loop** | 15 min |
| 6 | [ENGINEERING_PRACTICES.md](./ENGINEERING_PRACTICES.md) | Git, PRs, Definition of Done, testing table, CI, security baseline, quality bars | 15 min |
| 7 | [LEARNING_PATH.md](./LEARNING_PATH.md) | What you must be able to explain per phase; interview stories | skim, then per phase |
| 8 | [PILOT_READINESS.md](./PILOT_READINESS.md) | What must be true before real residents (later) | skim |
| — | [adr/](./adr/README.md) | 13 short decision records | as referenced |
| — | [tickets/](./tickets/README.md) | 40 detailed tickets (P0–P5), 6 for milestone D (D-01…D-06), and stubs (P6–P7) | per ticket |
| — | [templates/](./templates/) | Ticket, ADR, PR, explanation, review prompt, recap, mistakes log | when writing one |
| — | [`CLAUDE.md`](../CLAUDE.md), [`.claude/commands/`](../.claude/README.md) | Agent context and the loop's slash commands | before your first ticket |
| — | [AGENT_MISTAKES_LOG.md](./AGENT_MISTAKES_LOG.md), [explanations/](./explanations/), [recaps/](./recaps/) | Living records the loop produces | as they grow |

## The plan in one minute

- **Keep the architecture.** Modular monolith; global users → building memberships → roles; tenant isolation
  enforced in the database; Postgres job queue instead of Redis; private S3; polling; one EC2 host with Caddy.
- **Simplify auth.** Server-side session cookie instead of JWT access/refresh token families. Building scope
  in the URL path, validated on every request
  ([ADR-0003](./adr/0003-same-origin-server-side-sessions.md), [ADR-0004](./adr/0004-path-scoped-tenancy.md)).
- **Three quality bars.** *Demo-ready* at week 8, run locally. *Deployed* after milestone D (staging on AWS).
  *Pilot-ready* (MFA, PITR backups, separate production, privacy/Law 25, UAT) before real residents.
- **Decide by default now.** Record defaults as ADRs, and revisit them when a pilot building signs. No more
  gates waiting on people who don't exist yet.
- **Local first** ([ADR-0013](./adr/0013-local-first-deployment-milestone.md)). Weeks 1–8 need no AWS
  account, domain or server. Everything runs with `make up`, and CI checks every PR from week 1.
- **Local walking skeleton in week 2.** Every PR builds the production image and SPA, and CI runs them behind
  Caddy and smoke-tests them (`make prodlike`, P1-08). **Deployment to AWS is milestone D** (about 2 weeks,
  after the week-8 demo). It ships those already-tested artifacts to an HTTPS staging URL.
- **Packages is the reference slice** (week 6). Notices, maintenance and dashboard follow its recipe
  (week 7). Hardening and the demo come in week 8.
- **One ticket = one agent session = one PR.** A fresh AI session reviews it, the other dev reviews it, and a
  fresh session explains it. After the merge, the dev who drove the agent learns actively (quiz, explain-back
  note, a hand-written change); every ticket must be "learned ✓" before its phase gate passes.
- **Model owner vs tenant now** ([ADR-0010](./adr/0010-unit-occupancy-relationship.md)), and host in
  `ca-central-1` (likely Quebec pilot; [ADR-0008](./adr/0008-single-ec2-compose-caddy.md)).

## Your first three days

| Day | James (lane A) | Khoi (lane B) | Together |
|---|---|---|---|
| 1 | Read REVIEW-2026-10 and PRODUCT_SCOPE … AI_AGENT_PLAYBOOK. **P0-01 first** (adopt docs, `CLAUDE.md`, commands; ~1 hour, no loop yet). Then frame and implement **P0-02** (backend gates) | Read REVIEW-2026-10 and PRODUCT_SCOPE … AI_AGENT_PLAYBOOK. Review P0-01. Then frame and implement **P0-03** (frontend gates) | 30 min: agree on the plan; note disagreements as ADR proposals |
| 2 | **P0-05** (DB tests) | **P0-04** (Makefile, compose, branch protection, delete stale branches) | Try the loop on one ticket each, end to end |
| 3 | **P1-01** (finish the old M2-T03 branch's work under the new ticket) | **P1-04** (API conventions) | Friday-style demo + retro (even on day 3) |

No AWS account, domain or cloud setup is needed in these days, or at all until milestone D. You need GitHub
(for CI and branch protection) and Docker on each laptop.

## Next step

Don't run another plan review. Start P0-01, and let real tickets show what else needs to
change: record it in the roadmap change log, the retro, or `AGENT_MISTAKES_LOG.md`.
