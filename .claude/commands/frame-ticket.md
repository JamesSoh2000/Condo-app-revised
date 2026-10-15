---
description: Step 1 — sharpen a ticket's acceptance criteria autonomously before any code is written
argument-hint: <ticket-id, e.g. P2-03>
---

Frame ticket $ARGUMENTS. Do NOT write or change code in this step. Do not ask me; decide with the playbook's
decision rules, or block on a stop rule (`docs/AI_AGENT_PLAYBOOK.md`).

1. Read `docs/tickets/$ARGUMENTS-*.md`, the ADRs it links, `CLAUDE.md`, `docs/PRODUCT_SCOPE.md`, and the
   current code it touches.
2. Find and fix, in the ticket file:
   - acceptance criteria that are ambiguous or untestable: rewrite them precisely
   - missing rows of the 10-case tenant table (`docs/ENGINEERING_PRACTICES.md` §7) that apply: add them
   - at least one case the ticket missed: add it
   - contradictions between the ticket, the ADRs and the current code: the code is the truth for what
     exists, the ADRs for what to build. A contradiction with an accepted ADR or the scope is a stop rule.
   - open decisions: resolve each with the decision rules and note its basis
3. Never delete or loosen a criterion silently. If one is wrong, change it, give the reason in the Frame
   notes, and add a line to the inbox's "Decisions to audit".
4. Estimate the non-test lines. Over ~400: split into `$ARGUMENTSa` / `$ARGUMENTSb`, dividing the criteria,
   and add the rows to `docs/tickets/README.md`.
5. Fill in the ticket's "Frame notes (filled by the agent in step 1)". Commit the ticket file alone as
   `docs(tickets): frame $ARGUMENTS [$ARGUMENTS]`, so the reviewer can diff it.
