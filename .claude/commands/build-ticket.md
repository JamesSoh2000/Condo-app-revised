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
   (`git worktree add ../bw-<id> -b <id-lowercase>-<slug> origin/main`) and work there. Set the ticket's
   status to `in progress`.
2. **Frame** as in `.claude/commands/frame-ticket.md`. Commit the ticket file as the branch's first commit.
   If it needs a split, do the split, commit it, and continue with the first part.
3. **Plan, then implement** as in `.claude/commands/implement-ticket.md`, through `make check` green, the
   stack run for Tier 1–2 user-reachable behaviour, and a PR opened with the template filled in
   (`gh pr create`). Push and wait for CI (`gh pr checks --watch`).
4. **Review** (step 5). Read the ticket's tier.
   - Spawn a fresh subagent with: "Run `.claude/commands/review-ticket.md` for $ARGUMENTS in worktree
     `<path>`. Round <N>." Tier 1: say it must include the security pass.
   - Tier 1 also: run the Codex review with the `codex-review` skill (use gpt-6-astra-high). If Codex isn't
     available, spawn a second fresh subagent that runs only the Tier 1 security pass.
   - For each finding: reproduce it with a failing test, then fix it; or dismiss it with a reason. Record
     both in the PR's "Independent review" section: the commit reviewed, and for each fix the concrete
     failure and the evidence (the failing-then-passing test). A fix that chose between approaches also
     gets a block in "Decisions and alternatives". Push, wait for CI.
   - Repeat with **new** subagents until every required reviewer says `VERDICT: MERGE`, at most 3 rounds.
     An open Critical/High after round 3 is stop rule 4.
5. **Explain** (step 6). Rebase onto `origin/main` first if `main` has moved, so the source revision the
   explanation records is normally the one that merges. Run `.claude/commands/explain-ticket.md` for
   $ARGUMENTS yourself, in the worktree. Do its reality pass first: re-read the diff, the cited files and the
   tests' assertions from disk, and run the tests you will cite. If the pass shows the code contradicting the
   PR's plan or decisions by accident, treat it as a review finding: fix it test-first and run one more
   review round with a new fresh reviewer, then redo the pass and update the explanation. A deliberate
   deviation goes in the PR below the Plan. If a decision has no recorded rationale, add what you actually
   knew to the PR first (or write "Rationale not recorded"). **Any later commit** that touches what the
   explanation describes (a review round, a CI fix, a rebase that conflicted in the ticket's files) means
   redoing the pass on the changed files and updating the explanation before the merge gate.
6. **Bookkeeping commit** on the branch: the ticket's status `done` in `docs/tickets/README.md`; autonomous
   lasting decisions added to the inbox's "Decisions to audit"; confirmed findings added to
   `docs/AGENT_MISTAKES_LOG.md`; follow-ups that need action added to their ticket, the index or the inbox.
   Rebase onto `origin/main`, push, wait for CI.
7. **Merge gate.** Tick every box in the PR's "Merge gate" from real evidence. If one fails, fix it or block.
   Then `gh pr merge --squash --delete-branch`, and remove the worktree.
8. **Improve.** If a mistake pattern now appears twice in the log, note it as the first follow-up for the
   next ticket (fitness test or `CLAUDE.md` lesson). If this was the last ticket of its phase, run
   `/milestone-recap <phase>` (the automated phase gate).
9. Print the handoff block, with the merge commit (`gh pr view <N> --json mergeCommit`), and post it on
   the PR.

**To block** (any step): stop work on the branch and leave it pushed. Open a bookkeeping PR from
`origin/main` that sets $ARGUMENTS to `blocked` in the index and adds an inbox item (what's needed, the
options with your recommendation, what is blocked behind it), merge it once CI is green, and print the
handoff block with `Status: blocked`.
