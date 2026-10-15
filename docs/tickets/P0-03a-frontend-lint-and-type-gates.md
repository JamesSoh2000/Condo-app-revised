# P0-03a — Frontend lint and type gates

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 3 |
| Depends on | P0-01 |
| Replaces old | M1-T03 follow-up, M4-T06 (tracker) |
| Status | in progress |

Split from [P0-03](./P0-03-frontend-quality-gates.md) (see there why). The proxy and the route scope are in
[P0-03b](./P0-03b-same-origin-proxy-and-route-scope.md); the whitespace normalisation in
[P0-03c](./P0-03c-frontend-whitespace-and-pre-commit.md).

## Goal

The frontend has blocking lint and type checks, and Base44 usage is measured with a ratchet and fenced out
of the new TypeScript code ([ADR-0011](../adr/0011-frontend-strangler-typescript.md)).

## Scope

- In:
  - **Lint:** `npm run lint:fix` (removes the 68 unused imports), then fix any remaining errors by hand. Remove
    `continue-on-error` (and the "known baseline" summary step) from the CI lint step.
  - **`tsconfig.json`:** `allowJs: true`, `checkJs: false`, `strict: true`, `noEmit: true`, `jsx: react-jsx`,
    `paths: {"@/*": ["./src/*"]}`, `include: ["src"]`.
    - `typecheck` script: `tsc --noEmit -p tsconfig.json`, added to CI.
    - Keep `jsconfig.json` only if editors need it; otherwise delete it.
  - **Ratchet:** `scripts/base44-count.sh` counts `base44\.` and `@base44/` references under `frontend/src`.
    `frontend/base44-baseline.txt` stores the number. CI fails if the count is higher than the baseline, and
    prints a reminder to lower the baseline when it is lower.
  - **ESLint:** `no-restricted-imports` for `@base44/*` and `@/api/base44Client` in `src/features/**` and
    `src/app/**`.
- Out: the proxy, the route scope and the investigation (P0-03b); whitespace (P0-03c); migrating pages.

## Interfaces

npm scripts `lint`, `typecheck`; `scripts/base44-count.sh`; `frontend/base44-baseline.txt`.

## Acceptance criteria

1. **Given** the PR head, **when** CI runs, **then** `eslint`, `tsc --noEmit`, the ratchet and `vite build`
   run as separate, blocking steps (no `continue-on-error`) in the frontend job, and pass. *(was P0-03 AC1)*
4. **Given** a new `base44.entities.X` reference, **when** CI runs, **then** the ratchet step fails. Evidence:
   a demo commit on the PR branch, its failing run and log line, then the revert. *(was P0-03 AC4)*
5. **Given** `import { base44 } from '@/api/base44Client'` inside `src/features/x.ts`, **when** linting,
   **then** eslint errors. Evidence: an eslint run on a scratch file (transcript), and the rule applies to
   `.ts`/`.tsx` as well as `.js`/`.jsx`. *(was P0-03 AC5)*
6. *(added)* **Given** the count is **lower** than the baseline, **then** the ratchet passes and prints a
   reminder to lower `base44-baseline.txt` (transcript).
7. *(added)* **Given** a type error in a `.ts` file under `src/`, **when** `npm run typecheck` runs, **then**
   it fails (transcript), so `tsc` actually covers `src` and isn't vacuous.
8. *(added)* The lint fix is mechanical: every change from `lint:fix` only removes import specifiers or
   whole import lines (checked on the diff), and `npm run build` still succeeds.

## Test plan

- CI on the PR; demo commit for AC4.
- `bash scripts/base44-count.sh` before and after adding a dummy reference.
- Scratch files for AC5 and AC7 (not committed).

## Likely files

`frontend/package.json`, `frontend/tsconfig.json`, `frontend/jsconfig.json`, `frontend/eslint.config.js`,
`frontend/src/**` (lint fix), `scripts/base44-count.sh`, `frontend/base44-baseline.txt`,
`.github/workflows/ci.yml` (frontend job only).

## Must explain (learning checkpoint)

1. What is a ratchet in CI, and why is it better than "fix everything first"?
2. Why `checkJs: false` with `strict: true`: what does `tsc` check today, and what will it check as files move
   to TypeScript?
3. What does `no-restricted-imports` protect, and why only under `src/features` and `src/app`?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC1 (separate blocking steps, no `continue-on-error`), AC4/AC5 (evidence named;
  AC5 must cover `.ts`), added AC6 (the "lower than baseline" reminder had no criterion), AC7 (`tsc` is not
  vacuous), AC8 (the lint fix is mechanical).
- Criteria loosened (with reason; also listed in the inbox): none. AC2 and AC3 moved to P0-03b unchanged.
- Decisions taken (with basis: ticket / ADR / default / autonomous): split (playbook: over ~400 lines; see
  P0-03); others recorded in the PR.
- Split: this is part a of three.
