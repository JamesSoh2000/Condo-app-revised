---
description: Step 6 — write the ticket's explanation (decisions, how it works, the code) for James (run FRESH)
argument-hint: <ticket-id, e.g. P2-03>
---

Run this in a **fresh session** that has not seen the implementation conversation, so the explanation
describes the code that exists, not what the implementer intended. No human reviewed this code; James reads
this explanation instead of the PR, so it must be accurate and honest about gaps.

Write `docs/explanations/$ARGUMENTS-<slug>.md` using `docs/templates/EXPLANATION.md` (read its "How to write
this" section first), and commit it to the PR branch as `docs(explanations): explain $ARGUMENTS [$ARGUMENTS]`.

Inputs to read first:
- the ticket `docs/tickets/$ARGUMENTS-*.md`: its risk tier decides the form; its Frame notes and "Must
  explain" questions feed §2 and §9
- the ADRs it links, and any ADR the PR adds (`git diff --name-only origin/main...HEAD -- docs/adr`)
- the PR description and discussion: `gh pr view --json number,title,body,comments,reviews,headRefOid`.
  The plan, "Decisions and alternatives", "Independent review" (every round, with the commit each round
  reviewed) and "Follow-ups"
- the diff `git diff origin/main...HEAD`, and any file it touches or calls (read-only)

Rules:
- **Header.** Record the PR number, the source revision (`git rev-parse HEAD` before your commit, labelled
  pre-merge), and whether the final review round reviewed that commit. Don't write a merge SHA; it doesn't
  exist yet. Confirm the branch is rebased onto the latest `main`: if
  `git merge-base --is-ancestor origin/main HEAD` fails, stop and say so.
- **Length is guidance.** Full form for Tier 1–2, aiming at about 400 lines including code; short form by
  default for Tier 3, with full-form sections added when the change's complexity needs them. Go longer only
  for a consequential decision, important behaviour, a failure scenario or a "Must explain" question. No
  padding, repetition, whole files or generic tutorials. Long: keep one file and use `<details>` for deeper
  material.
- **Attribute every "why".** Label rationale as recorded (cite the ticket, ADR, PR decision or review
  round), established by code and tests (cite `path::symbol` or the test), or "Inferred:". If the motivation
  isn't recorded, say "Rationale not recorded". Never invent an alternative, experiment, decision, test run
  or verification result.
- **Decisions (§2):** a block for each consequential decision (problem or constraint, chosen approach,
  alternatives rejected and why, tradeoffs and accepted limitations, basis, source); one table row for
  smaller ones; nothing for routine syntax. Mark the autonomous ones. Add what an interviewer would ask
  about.
- **How it is implemented (§3):** pick the walkthrough variant that fits: **A** API request, **B** UI
  interaction, **C** process/pipeline. If none fits, say so and skip it. Never invent a request the ticket
  didn't add. Variant A: include the actual SQL for anything non-obvious (enable echo or read the logs).
- **The code (§4):** the files-changed table, then the excerpts that carry the ticket (usually 3–6, around
  150 lines of code: guidance, not a cap), copied exactly as at the source revision (trim with `# ...`),
  each headed by its `path::anchor`, with what it does, why, and what breaks without it. Add an immutable
  permalink at the source revision where exact lines matter.
- **Edge cases (§5):** name the test that proves each one. If no test exists, say so plainly; that is a
  finding.
- **Review log (§6)** from the PR: for each finding that changed the code or design, the concrete failure
  that motivated it and the evidence for the fix. **Not verified (§7):** be specific and don't soften it;
  list accepted risks and open follow-ups with where each is tracked.
- **Report to the implementer at the top of your output** (as findings, not papered over): the code
  contradicting the PR's plan or decisions; a consequential decision with no recorded rationale (it belongs
  in the PR's "Decisions and alternatives"); an accepted risk or follow-up tracked nowhere in the repo.
- Answer each "Must explain" question, then write 5 quiz questions that test understanding: at least one
  "what breaks if we remove X?" and one "how would you extend this to Y?". Answers in a collapsed
  `<details>` block.
- In prose, reference code as `path::anchor`, never bare line numbers. Use plain language; define each term
  the first time you use it.
- Finish by running `python3 scripts/check-explanation-refs.py` and fixing any reference it reports.

**Explaining a ticket that has already merged** (a new explanation after later changes, or an answer about
old code): find the merge commit (`gh pr view <N> --json mergeCommit`, or
`git log origin/main --grep "(#<N>)"`), and say which revision you describe. Keep the original
implementation separate from later changes (`git log <merge-sha>..origin/main -- <paths>`). Never edit an
older explanation; it is a snapshot.
