---
description: Steps 2–3 — plan, get approval, then implement one ticket test-first with evidence
argument-hint: <ticket-id, e.g. P2-03>
---

Implement ticket $ARGUMENTS following CLAUDE.md.

**Phase A — plan (stop and wait for approval):**
1. Read `docs/tickets/$ARGUMENTS-*.md` (including the Frame notes), its linked ADRs, and the current code.
   The code is the truth; the docs are targets.
2. Propose: files to change, interfaces (endpoints, schemas, tables), the migration, a test list mapped to
   each acceptance criterion, risks, and any ADR candidates.
3. Estimate the non-test lines changed. If it is over ~400, propose a split instead of a plan.
4. Compare your plan with my design prediction in the Frame notes and point out the differences.
5. Stop. Wait for my approval or changes.

**Phase B — implement (after approval):**
1. Make sure you're in a dedicated worktree on branch `<ticket-id in lowercase>-<slug>`, for example
   `p2-03-tenant-context`.
2. Tests first: write the failing tests for the acceptance criteria and show them failing.
3. Implement the smallest change that makes them pass. Small commits, Conventional Commit messages ending
   with `[$ARGUMENTS]`.
4. If the API changed: `make gen-api`. If models changed: `make revision`, then read and fix the migration.
5. Run `make check`. Fix everything. Never disable a check.
6. Rebase onto the latest `main` (`git fetch && git rebase origin/main`) and run `make check` again. The
   explanation relies on the merged tree being identical to the PR head.
7. Fill in `.github/pull_request_template.md` with real evidence (test names and command output). Write the
   "Decisions and alternatives" section carefully: the explainer runs in a fresh session and gets the "why"
   only from there.
8. End with the handoff block from docs/AI_AGENT_PLAYBOOK.md. List ADR candidates and follow-ups;
   don't implement them.
