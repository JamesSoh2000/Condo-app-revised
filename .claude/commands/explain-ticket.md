---
description: Step 6 — write the ticket's explanation (decisions, how it works, the code) for James (run FRESH)
argument-hint: <ticket-id, e.g. P2-03>
---

Run this in a **fresh session** that has not seen the implementation conversation, so the explanation
describes the code that exists, not what the implementer intended. No human reviewed this code; James reads
this explanation instead of the PR, so it must be accurate and honest about gaps.

Write `docs/explanations/$ARGUMENTS-<slug>.md` using `docs/templates/EXPLANATION.md`, and commit it to the
PR branch as `docs(explanations): explain $ARGUMENTS [$ARGUMENTS]`.

Inputs to read first:
- the ticket `docs/tickets/$ARGUMENTS-*.md` (its risk tier decides the form; its Frame notes and "Must
  explain" questions feed §2 and §9)
- the PR description: `gh pr view --json number,title,body` (the plan, the decisions and rejected
  alternatives, the review rounds)
- the diff `git diff main...HEAD`, and any file it touches or calls (read-only)

Rules:
- Header: record the PR number, not a commit SHA. Confirm the branch is rebased onto the latest `main`; if
  `git merge-base --is-ancestor origin/main HEAD` fails, stop and say so.
- **Tier 3:** short form (≤ 60 lines). **Tier 1–2:** full form (≤ 400 lines including code).
- **Decisions (§2):** every non-obvious choice with the rejected alternative and its basis; mark the
  autonomous ones. Add what an interviewer would ask about.
- **How it is implemented (§3):** pick the walkthrough variant that fits: **A** API request, **B** UI
  interaction, **C** process/pipeline. If none fits, say so and skip it. Never invent a request the ticket
  didn't add. Variant A: include the actual SQL for anything non-obvious (enable echo or read the logs).
- **The code (§4):** the files-changed table, then the 3–6 excerpts that carry the ticket, copied exactly as
  merged (trim with `# ...`), each headed by its `path::anchor`, with what it does, why, and what breaks
  without it. At most ~150 lines of code.
- **Edge cases (§5):** name the test that proves each one. If no test exists, say so plainly; that is a
  finding.
- **Review log (§6)** from the PR; **Not verified (§7):** be specific and don't soften it.
- **If the code contradicts the PR's plan or decisions,** do not paper over it: report the mismatch at the
  top of your output as a finding for the implementer.
- Answer each "Must explain" question, then write 5 quiz questions that test understanding: at least one
  "what breaks if we remove X?" and one "how would you extend this to Y?". Answers in a collapsed
  `<details>` block.
- In prose, reference code as `path::anchor`, never bare line numbers. Use plain language; define each term
  the first time you use it.
- Finish by running `python3 scripts/check-explanation-refs.py` and fixing any reference it reports.
