# Agent Mistakes Log

Record every implementer mistake that CI, an independent reviewer, the explainer or James caught (step 8 of the
[playbook](../AI_AGENT_PLAYBOOK.md)). When a pattern appears **twice**, the agent turns it into a fitness test
(preferred) or a `CLAUDE.md` rule in its next PR, and links it here. Over time this file becomes the most
project-specific guidance you have, and it shows how well the autonomous gates work.

| Date | Ticket | What the agent did | Caught by (CI / review round + reviewer / explainer / James after merge) | Root cause (missing context? ambiguous ticket? model habit?) | Prevention added |
|---|---|---|---|---|---|
| 2026-__-__ | P_-__ | e.g. queried packages by id without the building_id filter | review round 1 (Claude) | the ticket didn't restate the rule; no test for case #5 | fitness test `test_package_queries_scoped` + CLAUDE.md rule 3 wording |

## Promoted to rules / tests

| Pattern | Promoted to | Date |
|---|---|---|
