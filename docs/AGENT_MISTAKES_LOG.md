# Agent Mistakes Log

Record every mistake an agent made that a reviewer, a test or a human caught. When a pattern appears **twice**,
turn it into a fitness test (preferred) or a `CLAUDE.md` rule, and link it here. Over time this file becomes
the most project-specific guidance you have.

| Date | Ticket | What the agent did | Caught by | Root cause (missing context? ambiguous ticket? model habit?) | Prevention added |
|---|---|---|---|---|---|
| 2026-__-__ | P_-__ | e.g. queried packages by id without the building_id filter | independent review | the ticket didn't restate the rule; no test for case #5 | fitness test `test_package_queries_scoped` + CLAUDE.md rule 3 wording |

## Promoted to rules / tests

| Pattern | Promoted to | Date |
|---|---|---|
