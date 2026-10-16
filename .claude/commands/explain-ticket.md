---
description: Step 6 — write or update the ticket's explanation (decisions, how it works, the code) for James (run by the implementer, after re-reading the code)
argument-hint: <ticket-id, e.g. P2-03>
---

The implementer (the parent session that built the ticket) runs this, and runs it again to update the
explanation whenever later commits touch what it describes (ADR-0017). No human reviewed this code; James
reads this explanation instead of the PR, so it must be accurate and honest about gaps.

You built this code, so you will remember what you meant to write. The explanation must describe what is in
the code now, after the review rounds. Do the **reality pass** (`docs/AI_AGENT_PLAYBOOK.md#the-reality-pass`)
before the first sentence and before every edit:
1. **Re-read, don't recall.** From disk at the source revision: the diff, every file and symbol you will cite
   (the whole function, not a search hit), the assertions of the tests you will cite, the final migration, the
   PR's current description and review comments. Run the tests you will cite. Your memory of the conversation
   is a hypothesis to check, not a source.
2. **Keep three kinds of statement apart:** implemented behaviour (§3–§5, from files and tests re-read now),
   design rationale (§2, recorded or inferred), limitations (§5 gaps and §7). A rationale never stands in for
   proof of behaviour.
3. **Compare the final code with the PR's Plan, the ticket criteria and each recorded decision.** Describe the
   final state; an approach a review round replaced goes only in the review log.
4. **Audit the finished text:** open each cited symbol; for each "test T proves X", open T and confirm it
   asserts X. Record what you re-read and ran in the header's Reality check line.

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
  pre-merge), whether the final review round reviewed that commit, and the Reality check line. Don't write a
  merge SHA; it doesn't exist yet. When you are **updating** an existing explanation, set the source revision
  to the new head and add an `Updated (pre-merge)` line naming the commits you read and what changed. Confirm the branch is rebased onto the latest `main`: if
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
- **Handle these as findings, not papered over:**
  - The code contradicts the PR's plan or a decision. A deliberate deviation: note it in the PR below the Plan
    with the reason, and list it in §2 "Plan versus final code". A defect: fix it test-first and run a review
    round before you write it up.
  - A consequential decision has no recorded rationale. Add to the PR's "Decisions and alternatives" only what
    you actually knew when you decided; if you don't know, write "Rationale not recorded". Remembered intent
    is not a source until it is in the PR.
  - An accepted risk or follow-up is tracked nowhere in the repo: add it to the PR's follow-ups (it reaches
    its ticket, the index or the inbox in the bookkeeping commit).
- Answer each "Must explain" question, then write 5 quiz questions that test understanding: at least one
  "what breaks if we remove X?" and one "how would you extend this to Y?". Answers in a collapsed
  `<details>` block.
- In prose, reference code as `path::anchor`, never bare line numbers. Use plain language; define each term
  the first time you use it.
- Finish by running `python3 scripts/check-explanation-refs.py` and fixing any reference it reports. It only
  proves the anchors exist; the audit in step 4 above proves the claims.

**Explaining a ticket that has already merged** (a new explanation after later changes, or an answer about
old code; any session may do this, and the reality pass applies the same way): find the merge commit (`gh pr view <N> --json mergeCommit`, or
`git log origin/main --grep "(#<N>)"`), and say which revision you describe. Keep the original
implementation separate from later changes (`git log <merge-sha>..origin/main -- <paths>`). Never edit an
older explanation; it is a snapshot.
