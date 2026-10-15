# Explanation — <ticket-id> <title>

> Code as merged in PR #<N> (<date>), built and merged autonomously
> ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it before merge. The branch was
> rebased onto the latest `main` before the squash merge, so the merged tree equals the PR head. The PR's
> commits stay reachable at `refs/pull/<N>/head`.
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: full (Tier 1–2, ≤ 400 lines including code) / short (Tier 3, ≤ 60 lines). Walkthrough variant: A / B / C.

## How to reference code

- **In prose**, use symbol references, not bare line numbers: `path::anchor`, for example
  `backend/app/packages/service.py::pickup_package` or
  `frontend/src/features/packages/api.ts::usePickupPackage`. The anchor is literal text that appears in the
  file: a function, class, component or hook name for code; a key or block header for config
  (`.github/workflows/ci.yml::deploy:`).
- **Code excerpts** are fenced blocks with the language set, each preceded by a line naming its
  `path::anchor`. Copy the code exactly as merged; cut with `# ...` rather than rewrite.
- If exact lines matter, add a GitHub permalink at the PR head commit (`…/blob/<pr-head-sha>/path#L10-L20`).
- `scripts/check-explanation-refs.py` verifies every `path::anchor` in prose (it skips fenced code).

## 1. What was built and why (≤ 3 lines)

## 2. Decisions

Every non-obvious choice: from the PR's "Decisions and alternatives", the ticket's Frame notes, ADRs written
in this ticket, and any you find in the code. Mark the ones the agent made **without a written rule** with
"autonomous" in the Basis column: those are also in [HUMAN_INBOX](../HUMAN_INBOX.md).

| Decision | Alternative rejected | Why | Basis (ticket / ADR-NNNN / default / autonomous) |
|---|---|---|---|

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

**Key excerpts.** The 3–6 pieces that carry the ticket: the core service function or component, the
migration, the guard or constraint, and one test that proves the hardest criterion. At most ~150 lines of
code in total. For each:

`backend/app/<x>/service.py::<use_case>`

```python
# the merged code, trimmed with "# ..." where it is routine
```

- What it does, in 2–4 lines.
- Why it is written this way (link to §2 where a decision drives it).
- What would break if a key line were removed.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|

Acceptance criteria → tests: one line per criterion, naming its test or evidence.

## 6. Review log

| Round | Reviewer | Verdict | Findings (severity: one line) | Outcome (fixed in commit / dismissed: why) |
|---|---|---|---|---|

## 7. Not verified

What no test, check or reviewer proved: behaviour only real infrastructure shows, unfixed Medium/Low findings,
residual risks the reviewers listed, manual checks not run. "None" only if that is literally true.

## 8. How to change this safely

"If you need to add X, touch these places, and these tests will tell you if you broke Y."

## 9. Must explain, then quiz

Answer each of the ticket's "Must explain" questions in 3–6 lines, with `path::anchor` references.

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

## Short form (Tier 3 tickets only, ≤ 60 lines)

Use this instead of sections 1–9 for docs, config, copy, styling and tooling tickets.

1. **What changed and why** (≤ 3 lines)
2. **Decisions**: one line each, with the basis; "None" is valid
3. **Files changed**: one line each, using `path` or `path::anchor`
4. **The code**: the one excerpt that matters, if any (≤ 20 lines)
5. **How to verify it**: the command or check, and what success looks like
6. **Review**: verdict and anything fixed or dismissed
7. **How to change it safely**: one or two lines
