# Explanation — <ticket-id> <title>

> Code as merged in PR #<N> (<date>). The branch was rebased onto the latest `main` before the squash merge,
> so the merged tree equals the PR head. The PR's commits stay reachable at `refs/pull/<N>/head`.
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: full (Tier 1–2, ≤ 250 lines) / short (Tier 3, ≤ 40 lines). Walkthrough variant: A / B / C.

## How to reference code

Use **symbol references**, not bare line numbers, so references survive later edits and can be checked:

- `path::anchor`, for example `backend/app/packages/service.py::pickup_package` or
  `frontend/src/features/packages/api.ts::usePickupPackage`.
- The anchor is literal text that appears in the file: a function, class, component or hook name for code;
  a key or block header for config (`.github/workflows/ci.yml::deploy:`,
  `infra/main.tf::resource "aws_instance" "app"`).
- If exact lines matter, add a GitHub permalink at the PR head commit (`…/blob/<pr-head-sha>/path#L10-L20`).
- `scripts/check-explanation-refs.py` verifies every `path::anchor` in explanation files changed by the PR.

## 1. What was built and why (≤ 3 lines)

## 2. Walkthrough

Pick the **one** variant that matches what the ticket built. Never invent an HTTP request the ticket did not
add: a made-up walkthrough is worse than none.

### Variant A — API request (backend endpoint tickets)

Follow one real request through the code:

1. HTTP: `POST /api/buildings/{b}/…` → `app/<x>/router.py::<handler>`
2. Dependencies: session → tenant context (`app/tenancy/deps.py::get_tenant_context`)
3. Service: `app/<x>/service.py::<use_case>`. Business rule, query, transaction
4. Database: the SQL that actually runs (paste it from logs if it's non-obvious)
5. Side effects: audit / notification / job rows written in the same transaction
6. Response: `app/<x>/schemas.py::<XOut>` and status codes

### Variant B — UI interaction (frontend tickets)

Follow one real user action through the code:

1. The user action: which page, which control (`src/features/<x>/pages/<Page>.tsx::<Component>`)
2. Form and validation: zod schema, what is checked client-side and what only the server checks
3. Hook: the React Query query or mutation (`src/features/<x>/api.ts::<useHook>`) and its query key
4. API call: the typed client call and the endpoint (operation id)
5. Response handling: success, problem+json errors shown next to fields, 401/403/404 behaviour
6. Cache: which keys are invalidated or updated, and why the view re-renders correctly
7. States: loading, empty, error, and what a mobile-width user sees

### Variant C — Process or pipeline (infra, CI, tooling, worker, schema/migration tickets)

Follow one concrete run from trigger to result:

1. Trigger: what starts it (`git push`, `terraform apply`, a job row becoming due, `alembic upgrade head`,
   an INSERT hitting a constraint)
2. Each stage in order: what runs, where it is defined (`path::anchor`), what it reads and what it produces
3. State or artifact at the end: image tag, deployed SHA, AWS resource, job status, table/constraint
4. Where it fails and what you would see: the log line, CI step, error code or constraint name
5. How to re-run or recover it safely

## 3. Data model changes

Tables and columns added, with constraints and *why each constraint exists* (what bug it prevents).
Write "None" if nothing changed.

## 4. Key concepts used

Name each concept, explain it in 2–3 lines **in the context of this code**, and link it to
[LEARNING_PATH](../LEARNING_PATH.md).

## 5. Decisions and alternatives rejected

Take these from the PR description's "Decisions and alternatives" section, then add any you find in the code.

| Decision | Alternative | Why we didn't |
|---|---|---|

## 6. Edge cases and failure modes

| What could go wrong | What the code does | Test that proves it |
|---|---|---|

## 7. How to change this safely

"If you need to add X, touch these places, and these tests will tell you if you broke Y."

## 8. Quiz

1. …
2. …
3. …
4. … (one "what would break if we removed …?" question)
5. … (one "how would you extend this to …?" question)

<details><summary>Answers</summary>

1. …

</details>

---

## Short form (Tier 3 tickets only, ≤ 40 lines)

Use this instead of sections 1–8 for docs, config, copy, styling and tooling tickets.

1. **What changed and why** (≤ 3 lines)
2. **Files changed**: one line each, using `path` or `path::anchor`
3. **How to verify it**: the command or check, and what success looks like
4. **How to change it safely**: one or two lines
