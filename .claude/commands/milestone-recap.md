---
description: Milestone gate — draft the phase recap from merged tickets; humans write the learning sections
argument-hint: <phase, e.g. P2>
---

Draft `docs/recaps/$ARGUMENTS.md` from `docs/templates/MILESTONE_RECAP.md`.

1. Collect the tickets in phase $ARGUMENTS from `docs/tickets/README.md`, their merged PRs
   (`git log --oneline --grep "\[$ARGUMENTS-"`) and their explanations.
2. Fill in: §1 demo script (exact steps on the prod-like stack, or on staging after milestone D), §2
   architecture delta (a mermaid diagram of what
   was added), §5 agent performance (from `docs/AGENT_MISTAKES_LOG.md`), §6 open risks and debt (from PR
   follow-ups and TODOs in the code).
3. Leave §3 "What we learned", §4 cross-teach, §7 the STAR story and §8 interview answers EMPTY with prompts.
   The developers must write these in their own words.
4. Propose 3 interview questions for §8 based on the phase's hardest parts.
5. List which "Must explain" questions from the phase's tickets have no matching explanation or test.
6. List every ticket in the phase that is `done` but not yet "learned ✓" in the ticket index. The phase gate
   does not pass until this list is empty.
