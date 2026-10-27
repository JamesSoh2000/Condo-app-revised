---
description: Steps 2–4 — write the plan, then implement one ticket test-first with evidence (no approval stop)
argument-hint: <ticket-id, e.g. P2-03>
---

Implement ticket $ARGUMENTS following CLAUDE.md. Don't wait for approval; the plan is written down so the
reviewer can check the code against it, and the explanation is later compared against it.

**Plan (step 2):**
1. Read `docs/tickets/$ARGUMENTS-*.md` (including the Frame notes), its linked ADRs, and the current code.
   The code is the truth; the docs are targets.
2. Write the plan into the PR description's "Plan" section: files to change, interfaces (endpoints, schemas,
   tables), the migration, each acceptance criterion mapped to a test, risks. Put every decision in
   "Decisions and alternatives" with its basis (ticket / ADR / convention / default / autonomous). A
   consequential one gets a block: problem or constraint, chosen, alternatives considered and why they
   lost, tradeoffs and accepted limitations, basis and evidence (playbook "Recording a decision"). Lasting
   autonomous decisions: write the ADR now (`Deciders: agent (autonomous) in $ARGUMENTS`).
3. If the estimate is over ~400 non-test lines, go back and split the ticket instead.

**Implement (step 3):**
1. Work in the ticket's worktree on branch `<ticket-id in lowercase>-<slug>`, for example
   `p2-03-tenant-context`.
2. Tests first: write the failing tests for the acceptance criteria and show them failing.
3. Implement the smallest change that makes them pass. Small commits, Conventional Commit messages ending
   with `[$ARGUMENTS]`.
4. If the API changed: `make gen-api`. If models changed: `make revision`, then read and fix the migration.
5. Never loosen a protected gate (playbook "Protected gates"). If that seems the only way to green, it is a
   stop rule.
6. When a decision comes up while coding (a different approach than planned, an experiment, a test result
   that changed the design), add it to "Decisions and alternatives" then, with its evidence.

**Verify (step 4):**
1. Run `make check`. Fix everything at its cause.
2. Tier 1–2 with user-reachable behaviour: run the journey on `make up` or `make prodlike` and paste the
   transcript (curl sequence or Playwright output) into the PR's evidence table.
3. Rebase onto the latest `main` (`git fetch && git rebase origin/main`) and run `make check` again.
4. Fill in the rest of `.github/pull_request_template.md`
   with real evidence. Write "Decisions and alternatives" for a reader who wasn't in this conversation: the
   the explanation takes the "why" only from there, not from your memory. Put accepted risks and follow-ups under "Follow-ups and
   accepted risks".
5. Open or update the PR and wait for CI. Wait with `scripts/pr-wait.sh <N> --sha "$(git rev-parse HEAD)"`
   (exit 0 is the only green). An unrelated failure gets two retries, then its own fix PR, or a
   block if it is external.
6. Before the first review, fill the PR's "Known failure cases" table in "Independent review": one row per changed
   control, field or wait point, with the CLAUDE.md lesson that applies and its test (`expectFocusKept` in
   `frontend/src/test/focus.ts` and `e2e/helpers/focus.ts`, `act_blocked_on_lock` in
   `backend/tests/helpers/lock_wait.py`) or `n/a: why`.
