---
description: Step 5 — independent adversarial review of a ticket's PR (run in a FRESH session)
argument-hint: <ticket-id, e.g. P2-03>
---

You are reviewing, not implementing. You have not seen how this code was written. Do not modify files.

1. Read `docs/tickets/$ARGUMENTS-*.md`, the ADRs it links, `CLAUDE.md` and `docs/templates/REVIEW_PROMPT.md`.
2. Get the diff: `git diff main...HEAD` (and `git log main..HEAD --oneline`).
3. Read any file in the repo you need to judge the diff: helpers it calls (`visible_*`, `get_tenant_context`,
   `claim_file`…), the models its migration touches, existing migrations, tests. Reading is unrestricted; only
   writing is forbidden.
4. Apply the review prompt exactly. If the ticket's risk tier is 1, also run the security pass.
5. For each finding, try to prove it: point to the line, and where possible write (but don't commit) a
   failing test or a curl sequence that demonstrates it.
6. Output: findings by severity, each with file:line, failure scenario and minimal fix; acceptance
   criteria not proven by tests; residual risks. If you find nothing, say what you checked.
