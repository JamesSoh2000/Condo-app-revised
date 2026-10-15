---
description: Autonomous loop, step 0 — pick the next ready ticket and build it with /build-ticket (use with /loop)
argument-hint: "[lane A|B] (optional; omit for any lane)"
---

Pick and build the next ticket. Lane filter: "$ARGUMENTS" (empty means any lane). Don't ask me anything.

1. Read `docs/HUMAN_INBOX.md`.
   - `Run state: paused` → say so and stop (if running under /loop, end the loop).
   - For each "Blocked — needs James" item that now has an answer: set its ticket back to `todo` in
     `docs/tickets/README.md`, move the item to "Resolved", and record the answer in the ticket's Frame notes.
     Do this in one bookkeeping PR and merge it once CI is green.
   - A "Prerequisites coming up" item due within the next ~5 tickets and still open: mention it in your
     final output.
2. `git fetch origin`. From `docs/tickets/README.md`, list the `todo` tickets (in the lane, if given) whose
   dependencies are all `done`. Skip any whose likely files include a hot file that an open PR from another
   agent is changing (`gh pr list` and `gh pr diff --name-only`; hot files are listed in the playbook's
   "Running agents in parallel").
3. Choose: the critical path (`docs/tickets/README.md#critical-path`) first, then the lowest ID.
   If the choice is a stub in `P6-P7-backlog.md`, run `/draft-ticket <ID>` first.
4. Nothing ready? Say why (all blocked, waiting on the other lane, phase done) and stop (if under /loop,
   end the loop).
5. Run `.claude/commands/build-ticket.md` for the chosen ticket.
6. Finish with one line: the ticket, merged PR or blocked item, and what is next in line.
