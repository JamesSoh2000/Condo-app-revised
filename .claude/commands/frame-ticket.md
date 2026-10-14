---
description: Step 1 — help the human sharpen a ticket's acceptance criteria before any code is written
argument-hint: <ticket-id, e.g. P2-03>
---

We are framing ticket $ARGUMENTS. Do NOT write or change code in this session.

1. Read `docs/tickets/$ARGUMENTS-*.md`, the ADRs it links, `CLAUDE.md`, and the current code it touches.
2. Report, briefly:
   - acceptance criteria that are ambiguous or untestable (quote them and propose a precise rewrite)
   - missing cases from the 10-case tenant table (docs/ENGINEERING_PRACTICES.md §7) that apply here
   - contradictions between the ticket, the ADRs and the current code
   - decisions the ticket leaves open (these are ADR candidates)
   - whether the ticket fits in one PR of ≤ ~400 non-test lines; if not, propose a split (`P5-02a`,
     `P5-02b`), with the acceptance criteria divided between the parts
3. Ask me up to 5 questions whose answers change the implementation. Wait for my answers.
4. Then ask me for my **design prediction** (files, tables, request flow, hardest part) and record it,
   unedited, in the ticket's "Frame notes" section.
5. Update the ticket's acceptance criteria and test plan with the changes I approved. Show the diff.
