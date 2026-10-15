# Explanation — <ticket-id> <title>

> **PR:** #<N> · **Source revision:** `<sha>`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (<R>) reviewed this commit / reviewed `<sha>`.
> **Merge commit:** not known when written; after the merge, `gh pr view <N> --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: full / short. Tier: 1 / 2 / 3. Walkthrough variant: A / B / C / none.

## How to write this (for the explainer; don't copy this section)

### Length and shape

- Start with §1: a brief overview the reader can take in before the details.
- **Full form** (Tier 1–2): about 400 lines including code is an editing guideline, not a limit.
  **Short form** is the default for Tier 3 (about 60 lines); when a Tier 3 change is complex enough, add the
  full-form sections it needs.
- Spend extra length only where it explains a consequential decision, important behaviour, a failure
  scenario or a "Must explain" question. Don't pad, don't restate a point, don't paste whole files, and
  don't write tutorials on general tools (link their docs).
- If it grows long, keep one file. Use the numbered sections, and put deeper material (full SQL, a long
  excerpt, a second walkthrough) in `<details><summary>Deeper: …</summary>` blocks so the main path still
  reads in order.

### Where each claim comes from

| Kind | What it is | How to write it |
|---|---|---|
| **Recorded** | Rationale written down before this explanation: the ticket and its Frame notes, an ADR, the PR's "Decisions and alternatives", the review log or review comments | State it and cite the source ("PR decision D2", "ADR-0005", "review round 2, High 1") |
| **Code and tests** | Behaviour you established from the code, or from tests you ran | Cite `path::symbol` or the test name; say whether you ran it |
| **Inferred** | Your own reading of *why*, which no record states | Prefix it with "Inferred:" |

If the original motivation is not recorded and the code doesn't establish it, write "Rationale not
recorded." **Never invent** an alternative, experiment, decision, test run or verification result. A
consequential decision without recorded rationale is also reported to the implementer (`/explain-ticket`).

### Revisions and links

- The **source revision** is `git rev-parse HEAD` before your own commit. Check in the PR's "Independent
  review" section that the final review round reviewed that commit; if it didn't, name the one it did.
- Never write a merge SHA before the merge exists, and don't try to put your own commit's SHA in the file.
- Describe the PR's changes (`git diff origin/main...HEAD`). Don't present the branch's whole tree as "what
  merged".
- Where exact lines matter, add an immutable permalink next to the `path::symbol`:
  `https://github.com/<owner>/<repo>/blob/<source-sha>/<path>#L10-L20`. A later explanation or answer, written
  after the merge, links the merge commit instead.

### How to reference code

- **In prose**, use symbol references, not bare line numbers: `path::anchor`, for example
  `backend/app/packages/service.py::pickup_package` or
  `frontend/src/features/packages/api.ts::usePickupPackage`. The anchor is literal text that appears in the
  file: a function, class, component or hook name for code; a key or block header for config
  (`.github/workflows/ci.yml::deploy:`).
- **Code excerpts** are fenced blocks with the language set, each preceded by a line naming its
  `path::anchor`. Copy the code exactly as it is at the source revision; cut with `# ...` rather than
  rewrite.
- `scripts/check-explanation-refs.py` verifies every `path::anchor` in prose (it skips fenced code).

## 1. What was built and why

A brief overview, 3–6 lines: what changed, why, and the one or two decisions that matter most.

## 2. Decisions

Every **consequential** decision: one a later reader would ask "why this way?" about. That covers
behaviour, data shape, security, an interface, a gate, a tradeoff, and anything a reviewer questioned.
Sources: the PR's "Decisions and alternatives", the ticket's Frame notes, ADRs written or applied in this
ticket, the review log, and any you find in the code (those are inferred unless a record backs them).
Routine choices (syntax, naming that follows the convention) need no entry. Decisions the agent made
**without a written rule** have Basis "autonomous": those are also in [HUMAN_INBOX](../HUMAN_INBOX.md).

### D1. <the decision, in one line>

- **Problem or constraint:**
- **Chosen:**
- **Alternatives rejected:** <alternative>: why it lost. "None recorded" if the records name none.
- **Tradeoffs and accepted limitations:**
- **Basis:** ticket / ADR-NNNN / existing convention (`path::symbol`) / experiment / test result / review
  finding (round N) / autonomous
- **Source:** recorded (where) / inferred

Smaller decisions, one row each:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|

**Framing changes:** criteria the agent added, sharpened or (with reason) loosened in step 1. "None" is valid.

## 3. How it is implemented

### Overview

The moving parts in 3–6 bullets, or a small mermaid diagram if more than three components interact.

### Walkthrough

Pick the **one** variant that matches what the ticket built. Never invent an HTTP request the ticket did not
add: a made-up walkthrough is worse than none.

**Variant A — API request (backend endpoint tickets).** Follow one real request through the code:

1. HTTP: `POST /api/buildings/{b}/…` → `app/<x>/router.py::<handler>`
2. Dependencies: session → tenant context (`app/tenancy/deps.py::get_tenant_context`)
3. Service: `app/<x>/service.py::<use_case>`. Business rule, query, transaction
4. Database: the SQL that actually runs (paste it from logs if it's non-obvious)
5. Side effects: audit / notification / job rows written in the same transaction
6. Response: `app/<x>/schemas.py::<XOut>` and status codes

**Variant B — UI interaction (frontend tickets).** Follow one real user action through the code:

1. The user action: which page, which control (`src/features/<x>/pages/<Page>.tsx::<Component>`)
2. Form and validation: zod schema, what is checked client-side and what only the server checks
3. Hook: the React Query query or mutation (`src/features/<x>/api.ts::<useHook>`) and its query key
4. API call: the typed client call and the endpoint (operation id)
5. Response handling: success, problem+json errors shown next to fields, 401/403/404 behaviour
6. Cache: which keys are invalidated or updated, and why the view re-renders correctly
7. States: loading, empty, error, and what a mobile-width user sees

**Variant C — Process or pipeline (infra, CI, tooling, worker, schema/migration tickets).** Follow one
concrete run from trigger to result:

1. Trigger: what starts it (`git push`, a job row becoming due, `alembic upgrade head`, an INSERT hitting a
   constraint)
2. Each stage in order: what runs, where it is defined (`path::anchor`), what it reads and produces
3. State or artifact at the end: image tag, job status, table/constraint
4. Where it fails and what you would see: the log line, CI step, error code or constraint name
5. How to re-run or recover it safely

### Data model changes

Tables and columns added, with constraints and *why each constraint exists* (what bug it prevents).
"None" if nothing changed.

## 4. The code

The code this ticket wrote, so you can read it here instead of in the PR.

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|

**Key excerpts.** The pieces that carry the ticket: usually 3–6 (the core service function or component,
the migration, the guard or constraint, and one test that proves the hardest criterion), around 150 lines
of code in total. Both numbers are guidance: add an excerpt when a consequential decision or failure
scenario needs the reader to see the code; never paste a whole file when a trimmed excerpt makes the point.
For each:

`backend/app/<x>/service.py::<use_case>`

```python
# the code at the source revision, trimmed with "# ..." where it is routine
```

- What it does, in 2–4 lines.
- Why it is written this way (link to the §2 decision that drives it).
- What would break if a key line were removed.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|

Acceptance criteria → tests: one line per criterion, naming its test or evidence.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome (fixed in commit / dismissed: why) |
|---|---|---|---|---|---|

For each finding that changed the code or the design: the concrete failure that motivated it (inputs →
wrong outcome), the evidence for the final approach (the test that failed and now passes, a proof run), and
the §2 decision it produced, if any.

## 7. Not verified, accepted risks and follow-ups

What no test, check or reviewer proved: behaviour only real infrastructure shows, unfixed Medium/Low findings,
residual risks the reviewers listed, manual checks not run. "None" only if that is literally true.

Then the risks the PR accepted and the follow-ups it left open, each with where it is tracked (a ticket's
file, an index row, the inbox, an ADR), or "tracked only here".

## 8. How to change this safely

"If you need to add X, touch these places, and these tests will tell you if you broke Y."

## 9. Must explain, then quiz

Answer each of the ticket's "Must explain" questions, with `path::anchor` references. A few lines each is
usual; take more when the question needs it.

Then five quiz questions that test understanding, not recall of names:

1. …
2. …
3. …
4. … (one "what would break if we removed …?" question)
5. … (one "how would you extend this to …?" question)

<details><summary>Answers</summary>

1. …

</details>

---

## Short form (default for Tier 3 tickets, about 60 lines)

Use this instead of sections 1–9 for docs, config, copy, styling and tooling tickets. Keep the header, and
the rules in "How to write this". When the change is complex enough (a non-obvious pipeline, a decision with
real alternatives), add the full-form sections it needs, such as the walkthrough or the edge-case table.

1. **What changed and why**: a brief overview, 3–6 lines
2. **Decisions**: one line each, with basis and source; "None" is valid. A consequential decision gets the
   §2 block instead
3. **Files changed**: one line each, using `path` or `path::anchor`
4. **The code**: the excerpt that matters, if any (usually ≤ 20 lines)
5. **How to verify it**: the command or check, and what success looks like
6. **Review**: verdict, and anything fixed (with the failure that motivated it) or dismissed
7. **Not verified, accepted risks and follow-ups**: and where each is tracked; "None" only if literally true
8. **How to change it safely**: one or two lines
