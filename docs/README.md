# Condo Management App — Project Docs

Condo / building management app (FastAPI + PostgreSQL + React). AI agents build, review, explain and merge
every ticket autonomously; James (solo since 2026-10-13) sets direction, answers escalations and learns from
the explanations ([ADR-0014](./adr/0014-autonomous-agent-workflow.md)). Lanes A and B are two parallel agent
tracks.

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
| 4 | [ROADMAP.md](./ROADMAP.md) | Week-by-week plan for two agent tracks, phase gates | 10 min |
| 5 | [AI_AGENT_PLAYBOOK.md](./AI_AGENT_PLAYBOOK.md) | **The autonomous frame → build → review → explain → merge loop**, stop rules, what you still do | 15 min |
| 6 | [HUMAN_INBOX.md](./HUMAN_INBOX.md) | **The one page you check:** what's blocked on you, decisions made without you | 2 min, then weekly |
| 7 | [ENGINEERING_PRACTICES.md](./ENGINEERING_PRACTICES.md) | Git, PRs, Definition of Done, testing table, CI, security baseline, quality bars | 15 min |
| 8 | [LEARNING_PATH.md](./LEARNING_PATH.md) | What you must be able to explain per phase; interview stories | skim, then per phase |
| 9 | [PILOT_READINESS.md](./PILOT_READINESS.md) | What must be true before real residents (later) | skim |
| — | [adr/](./adr/README.md) | 14 short decision records | as referenced |
| — | [tickets/](./tickets/README.md) | 40 detailed tickets (P0–P5), 6 for milestone D (D-01…D-06), and stubs (P6–P7) | per ticket |
| — | [templates/](./templates/) | Ticket, ADR, PR, explanation, review prompt, recap, mistakes log | when writing one |
| — | [`CLAUDE.md`](../CLAUDE.md), [`.claude/commands/`](../.claude/README.md) | Agent context and the loop's slash commands | before your first ticket |
| — | [explanations/](./explanations/), [recaps/](./recaps/), [AGENT_MISTAKES_LOG.md](./AGENT_MISTAKES_LOG.md) | What the loop leaves behind: one explanation per ticket (decisions, how it works, the code), one recap per phase, the mistakes reviewers caught | as they grow |

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
- **One ticket = one branch = one PR, built and merged by agents.** The implementer frames and builds it; a
  fresh session reviews it (plus Codex on Tier 1) and must say `MERGE`; another fresh session writes the
  explanation; the agent merges when CI and the merge gate pass. It stops and writes to the
  [inbox](./HUMAN_INBOX.md) only on a [stop rule](./AI_AGENT_PLAYBOOK.md#stop-rules). Learning is yours, at
  your pace, and gates nothing.
- **Model owner vs tenant now** ([ADR-0010](./adr/0010-unit-occupancy-relationship.md)), and host in
  `ca-central-1` (likely Quebec pilot; [ADR-0008](./adr/0008-single-ec2-compose-caddy.md)).

## Getting started

**You, once (about 30 minutes):**
1. Clear the "Prerequisites coming up" items in [HUMAN_INBOX.md](./HUMAN_INBOX.md) that are needed now:
   authenticate `gh` (agents can't merge without it) and, ideally, the Codex CLI.
2. Merge **P0-01** (this docs adoption; it predates the loop).

**Then the agents.** In Claude Code, from the repo root:
- `/build-next` builds and merges the next ready ticket, then stops. Run it again, or
- `/loop /build-next` keeps going ticket after ticket until the inbox says `paused` or nothing is ready.
- For two lanes at once, run a second session with `/build-next B` (lane B only); each works in its own
  worktree.

The first tickets are P0-02 → P0-05 → P1-01 (lane A) and P0-03 → P0-04 → P1-04 (lane B). P0-04 switches
branch protection to required checks with no required approval, which autonomous merging needs. No AWS
account, domain or cloud setup is needed until milestone D.

## Next step

Don't run another plan review. Start the agents, and let real tickets show what else needs to change: the
agents record it in `AGENT_MISTAKES_LOG.md` and the recaps; you record it in the roadmap change log.
