---
description: Step 5 — independent adversarial review of a ticket's PR; its verdict decides the merge (run FRESH)
argument-hint: <ticket-id, e.g. P2-03> [round N]
---

You are reviewing, not implementing. You have not seen how this code was written. Do not modify tracked
files. No human reviews this PR after you (ADR-0014): your verdict decides whether it merges.

1. Read `docs/tickets/$ARGUMENTS-*.md` (the ticket ID is the first word), the ADRs it links, `CLAUDE.md`,
   `docs/templates/REVIEW_PROMPT.md`, and the PR description (`gh pr view --json number,body`, once): its plan,
   decisions and, from round 2, the earlier findings and answers.
2. Get the diff: `git diff --stat main...HEAD` and `git log main..HEAD --oneline` first, then the patch of
   **every** changed path, one at a time (`git diff main...HEAD -- <path>`; one command when the diff is
   small). The stat orders your reading and never replaces it: config, CI and migrations are read like code.
   Name any path you read only as a stat (lockfiles, generated types) in the verdict. Diff the ticket file
   separately to check the framing.
3. Read any file in the repo you need to judge the diff: helpers it calls (`visible_*`, `get_tenant_context`,
   `claim_file`…), the models its migration touches, existing migrations, tests. Reading is unrestricted;
   only writing tracked files is forbidden.
4. Apply the review prompt exactly. Tier 1: also run the security pass. Round 2 or later: add the re-review
   block and review the whole diff again.
5. For each finding, try to prove it: point to the line, and where possible write a failing test or a curl
   sequence that demonstrates it (in a scratch file or `codex_proofs/`, not committed).
6. Output: findings by severity, each with file:line, failure scenario and minimal fix; acceptance criteria
   not proven by tests; residual risks; and the last line `VERDICT: MERGE` or `VERDICT: BLOCK`. If you find
   nothing, say what you checked.
