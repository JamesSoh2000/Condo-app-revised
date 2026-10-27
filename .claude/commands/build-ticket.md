---
description: Autonomous loop — frame, build, review (fresh), explain (implementer) and merge one ticket, with no human step
argument-hint: <ticket-id, e.g. P2-03>
---

Build ticket $ARGUMENTS end to end, autonomously, following `docs/AI_AGENT_PLAYBOOK.md` and `CLAUDE.md`.
Do not stop to ask me anything. The only reasons to stop early are the playbook's **stop rules**; then block
the ticket (below) and end.

You are the **implementer**. You never review your own work: step 5 runs in fresh subagents that get file
paths and the ticket ID, never this conversation. You write and edit the explanation yourself (step 6), but
only after re-reading the code, never from memory of what you built.

1. **Preflight.** Read `docs/HUMAN_INBOX.md`; if `Run state: paused`, stop. Check that every dependency of
   $ARGUMENTS in `docs/tickets/README.md` is `done`. Create the worktree and branch
   (`scripts/ticket-preflight.sh $ARGUMENTS --create` does all three from `origin/main`: exit 10 paused, stop;
   11 a dependency not `done`, end the run naming it; 12 not in the index, block; 13 `done`, `review` or
   `blocked`, end the run and report it; 14 or 65, end the run and report the error) and work there. Set the ticket's
   status to `in progress`.
2. **Frame** as in `.claude/commands/frame-ticket.md`, reading the ticket from the new worktree, never the main
   checkout, whose `main` can be behind `origin/main` (P5-03c, P5-05). Commit the ticket file as the branch's first commit.
   If it needs a split, do the split, commit it, and continue with the first part.
3. **Plan, then implement** as in `.claude/commands/implement-ticket.md`, through `make check` green, the
   stack run for Tier 1–2 user-reachable behaviour, and a PR opened with the template filled in
   (`gh pr create`). Push and wait for CI (`git push`, then `scripts/pr-wait.sh <N> --sha "$(git rev-parse HEAD)"`
   with the Bash tool's `timeout: 600000`: exit 1, read the printed log file and fix the cause; exit 2, run it
   again; exit 3, the head moved, wait on the new head; exit 4, an error. Exits 2, 3 and 4 are never green).
   Before spawning the first reviewer, fill the PR's "Known failure cases" table (one row per changed control, field
   or wait point, each with its test or `n/a: why`; `expectFocusKept` and `act_blocked_on_lock` make the focus and
   lock-wait rows one-line tests), and keep adding rows for each fix's neighbours in step 4.
4. **Review** (step 5). Read the ticket's tier.
   - Spawn a fresh subagent with: "Run `.claude/commands/review-ticket.md` for $ARGUMENTS in worktree
     `<path>`. Round <N>." Tier 1: say it must include the security pass.
   - Tier 1 also: run the Codex review with the `codex-review` skill (use gpt-6-astra-high). If Codex isn't
     available, spawn a second fresh subagent that runs only the Tier 1 security pass.
   - For each finding: reproduce it with a failing test, then fix it; or dismiss it with a reason. Record
     both in the PR's "Independent review" section: the commit reviewed, and for each fix the concrete
     failure and the evidence (the failing-then-passing test). A fix that chose between approaches also
     gets a block in "Decisions and alternatives". Push, wait for CI. Wait as in step 3.
   - Before the next round, list each fix's neighbours in the PR's "Independent review" section (error
     paths, malformed input, the changed path's other options, other ways to reach the same state, and for
     state or concurrency fixes the cases in `CLAUDE.md` "Lessons learned"), each with its test or
     `n/a: why`.
   - Repeat with **new** subagents until every required reviewer says `VERDICT: MERGE`, at most 3 rounds.
     An open Critical/High after round 3 is stop rule 4.
5. **Explain** (step 6), last before the bookkeeping commit. Start only when the final review round said
   `MERGE`. Rebase onto `origin/main` first if `main` has moved, push, and wait for green CI,
   as in step 3, so the source
   revision the explanation records is the one that merges and it is normally written once. Run
   `.claude/commands/explain-ticket.md` for $ARGUMENTS yourself, in the worktree. Do its reality pass first: re-read the diff, the cited files and the
   tests' assertions from disk, and run the tests you will cite. If the pass shows the code contradicting the
   PR's plan or decisions by accident, treat it as a review finding: fix it test-first and run one more
   review round with a new fresh reviewer, then redo the pass and update the explanation. A deliberate
   deviation goes in the PR below the Plan. If a decision has no recorded rationale, add what you actually
   knew to the PR first (or write "Rationale not recorded"). A later commit that touches what the
   explanation describes (a CI fix, a rebase that conflicted in the ticket's files) means redoing the pass on
   the changed files, their callers and callees, and updating the claims that cite them before the merge gate.
   See the playbook's "Editing" for how to check (`--name-status`, also after a rebase) and what
   counts as bookkeeping; a bookkeeping-only change needs no new pass. Fetch the PR once for this step.
6. **Bookkeeping commit** on the branch: the ticket's status `done` in `docs/tickets/README.md`; autonomous
   lasting decisions added to the inbox's "Decisions to audit"; confirmed findings added to
   `docs/AGENT_MISTAKES_LOG.md`; follow-ups that need action added to their ticket, the index or the inbox.
   Rebase onto `origin/main`, push, wait for CI. Wait as in step 3.
7. **Merge gate.** Tick every box in the PR's "Merge gate" from real evidence. If one fails, fix it or block.
   Then `scripts/pr-wait.sh <N> --sha <the sha the boxes were ticked against>` and `scripts/pr-state.sh <N>`
   (`behind_by` 0 and `merge_state` `CLEAN`; `UNKNOWN` is asked again; a PR with conflicts gets no checks, so
   on a `pr-wait.sh` timeout read `merge_state`), then
   `gh pr merge <N> --squash --delete-branch --match-head-commit <that sha>`, and remove the worktree. If `gh`
   refuses because the head moved, re-tick the boxes the new commits change.
8. **Improve.** If a mistake pattern now appears twice in the log, note it as the first follow-up for the
   next ticket (fitness test or `CLAUDE.md` lesson). If this was the last ticket of its phase, run
   `/milestone-recap <phase>` (the automated phase gate).
9. Print the handoff block, with the merge commit (`merge_commit` from `scripts/pr-state.sh <N>`), and post it on
   the PR.

**To block** (any step): stop work on the branch and leave it pushed. Open a bookkeeping PR from
`origin/main` that sets $ARGUMENTS to `blocked` in the index and adds an inbox item (what's needed, the
options with your recommendation, what is blocked behind it), merge it once CI is green, and print the
handoff block with `Status: blocked`.
