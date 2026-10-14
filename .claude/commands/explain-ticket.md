---
description: Step 7 — write a short, code-anchored explanation of a ticket's PR (run in a FRESH session)
argument-hint: <ticket-id, e.g. P2-03>
---

Run this in a **fresh session** that has not seen the implementation conversation, so the explanation
describes the code that exists, not what the implementer intended.

Write `docs/explanations/$ARGUMENTS-<slug>.md` using `docs/templates/EXPLANATION.md`.

Inputs to read first:
- the ticket `docs/tickets/$ARGUMENTS-*.md` (its risk tier decides the form)
- the PR description: `gh pr view --json number,title,body` (the "why" and the rejected alternatives live here)
- the diff `git diff main...HEAD`, and any file it touches or calls (read-only)

Rules:
- Header: record the PR number (`gh pr view --json number`), not a commit SHA. Confirm the branch is rebased
  onto the latest `main`; if `git merge-base --is-ancestor origin/main HEAD` fails, stop and say so.
- **Tier 3:** use the short form (≤ 40 lines). **Tier 1–2:** full form (≤ 250 lines).
- Reference code as `path::anchor` (a function, class, component, hook, or literal config key that appears in
  the file). No bare line numbers. Add a permalink at the PR head commit only where exact lines matter.
- Pick the walkthrough variant that fits: **A** API request, **B** UI interaction, **C** process/pipeline.
  If none fits, say so and skip §2. Never invent a request the ticket didn't add.
- Variant A: include the actual SQL for anything non-obvious (enable echo or read the logs).
- In "Decisions and alternatives", start from the PR description, then add what a reviewer would ask about in
  an interview.
- In "Edge cases", name the test that proves each one. If no test exists, say so plainly; that is a finding.
- Write 5 quiz questions that test understanding, not recall of names: at least one "what breaks if we
  remove X?" and one "how would you extend this to Y?". Put the answers in a collapsed `<details>` block.
- Use plain language. Define each term the first time you use it.
- Finish by running `python scripts/check-explanation-refs.py` and fixing any reference it reports.
