---
description: Phase gate (automated) — run the exit gate, write the recap; James's sections stay optional
argument-hint: <phase, e.g. P2>
---

Run the phase gate for $ARGUMENTS and write `docs/recaps/$ARGUMENTS.md` from
`docs/templates/MILESTONE_RECAP.md`. Don't ask me anything.

1. Confirm every ticket in phase $ARGUMENTS is `done` in `docs/tickets/README.md`. If any is `blocked`, the
   gate waits: say so, note it in the inbox item, and stop.
2. Run each item of the phase's exit gate in `docs/ROADMAP.md` on the stack and in CI, and record pass/fail
   with evidence in §0.
3. Collect the merged PRs (`git log --oneline --grep "\[$ARGUMENTS-"`) and the explanations. Fill in: §1 demo
   script (exact steps on the prod-like stack, or on staging after milestone D), §2 architecture delta (a
   mermaid diagram), §3 decisions (ADRs and the inbox's "Decisions to audit" for this phase), §4 agent
   performance (review rounds from the PRs, `docs/AGENT_MISTAKES_LOG.md`), §5 open risks (unfixed findings,
   "Not verified" sections, follow-ups), §6 reading order.
4. Leave §7 and §8 for James, with prompts. Propose the 3 interview questions in §9 without answers.
5. List the "Must explain" questions from the phase's tickets that no explanation answers.
6. Gate red: add fix tickets (`$ARGUMENTS-fix-01`…) to the index; they are built before the next phase
   starts. Gate green: the next phase may start.
7. Commit the recap (and any fix-ticket rows) as a Tier 3 docs PR through the normal loop.
