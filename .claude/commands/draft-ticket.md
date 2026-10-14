---
description: Rolling wave — turn a backlog stub (e.g. P6-01) into a full ticket file, ready for framing
argument-hint: <ticket-id, e.g. P6-01>
---

Draft the full ticket for $ARGUMENTS. Do NOT write or change code in this session.

1. Read the stub for $ARGUMENTS in `docs/tickets/P6-P7-backlog.md`, `docs/templates/TICKET.md`,
   `docs/SLICE_RECIPE.md`, `CLAUDE.md`, the ADRs the stub touches, and the reference-slice tickets
   (`docs/tickets/P5-*.md`) as worked examples.
2. Read the current code the ticket will touch, including what earlier slices already provide (`notify`,
   `record_audit`, `claim_file`, `visible_*` helpers, the 10-case test helpers). Reuse them; don't re-specify them.
3. Write `docs/tickets/$ARGUMENTS-<slug>.md` from the template:
   - explicit interfaces (method, path, auth, request/response schema, error codes; tables and constraints)
   - Given/When/Then acceptance criteria, including the 10-case table rows that apply
   - a test plan mapping each criterion to a test, with commands
   - likely files, risk tier, dependencies, and 3–5 "Must explain" questions
4. For every "Decide while framing" item in the stub, state the stub's default in the ticket and list it under
   "Open decisions" for `/frame-ticket`. Do not decide anything the stub doesn't.
5. Estimate the non-test lines. If over ~400, draft it as two tickets (`$ARGUMENTSa`, `$ARGUMENTSb`) instead.
6. Add or update the row in `docs/tickets/README.md`, and replace the stub's body with a link to the new file.
7. Show me the new file and the index diff. I edit and accept it before anyone frames it.
