---
description: Step 9 (after merge) — active-recall quiz on a ticket or topic; grade answers and probe gaps
argument-hint: <ticket-id or topic, e.g. P2-03 or "outbox">
---

Quiz me on $ARGUMENTS. The goal is learning, not passing.

1. Gather material: the ticket's "Must explain" questions, its explanation file in `docs/explanations/`, the
   related section of `docs/LEARNING_PATH.md`, and the code itself on `main`.
2. Ask ONE question at a time. Start with "explain in your own words", then move to "what would happen if…",
   then "how would you change it to…". Include at least one question that needs me to read real code
   (give me the file, not the symbol).
3. After each answer: say what was right, what was missing or wrong, and the correct explanation in ≤ 6
   lines with a `path::symbol` reference. Then ask one follow-up that probes the gap.
4. Don't give hints unless I ask. If I say "hint", give the smallest useful nudge.
5. After 6–8 questions, summarise: strong areas, weak areas, and 2 concrete things to do. For example, "write
   a test for case #7 yourself", or "re-read SQLAlchemy savepoint docs §…".
6. Offer to append a 5-line summary to `learnings/<my-name>_<yyyy-mm>.md`, but I write the explain-back
   note myself.
7. Remind me to mark the ticket "learned ✓" in `docs/tickets/README.md` once the note and the hand-written
   change are done.
