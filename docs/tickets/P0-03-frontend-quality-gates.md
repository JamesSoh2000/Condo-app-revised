# P0-03 — Frontend quality gates (split)

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 3 |
| Depends on | P0-01 |
| Status | split into [P0-03a](./P0-03a-frontend-lint-and-type-gates.md), [P0-03b](./P0-03b-same-origin-proxy-and-route-scope.md), [P0-03c](./P0-03c-frontend-whitespace-and-pre-commit.md) |

Split while framing (2026-10-14). "P0-03" in other tickets' "Depends on" means all three parts; the
[ticket index](./README.md) lists which part each dependent actually needs.

| Part | Scope | Acceptance criteria (original numbers) |
|---|---|---|
| [P0-03a](./P0-03a-frontend-lint-and-type-gates.md) | lint fix, blocking lint in CI, `tsconfig.json` + `typecheck`, the Base44 ratchet, `no-restricted-imports` | 1, 4, 5 |
| [P0-03b](./P0-03b-same-origin-proxy-and-route-scope.md) | Vite `/api` proxy, demo route allowlist, Base44 runtime-call investigation (incl. `VisualEditAgent.jsx`) | 2, 3 |
| [P0-03c](./P0-03c-frontend-whitespace-and-pre-commit.md) | extend the pre-commit whitespace/EOF hooks to `frontend/` and normalise the files they flag | (scope item added in P0-02, no criterion) |

## Why split

- Measured while framing: extending the pre-commit hooks to `frontend/` rewrites 99 files (≈860 changed
  lines, whitespace only). Together with the lint fix (68 removed imports), the gates and the routing
  changes, one PR would be far over the ~400 non-test line limit and hard to review.
- The gates (03a) are mechanical config; the proxy and the route scope (03b) change behaviour a user can
  reach; the whitespace normalisation (03c) is purely mechanical and is checked with `git diff -w`. Each
  gets the review it needs.
- No criterion was dropped or loosened: AC1, AC4 and AC5 are in 03a; AC2 and AC3 in 03b.

## Original ticket (for reference)


| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 3 |
| Depends on | P0-01 (the loop commands and `CLAUDE.md` come from it) |
| Replaces old | M1-T03 follow-up, M4-T06 (tracker), M0-T02 (hide deferred routes) |
| Status | todo |

## Goal

The frontend has blocking lint and type checks, calls the API same-origin through the Vite proxy, measures
Base44 usage with a ratchet, and exposes only the demo-scope routes.

## Why

The migration needs guardrails, or it never finishes ([ADR-0011](../adr/0011-frontend-strangler-typescript.md)).
The same-origin proxy removes CORS and makes local development behave like production
([ADR-0003](../adr/0003-same-origin-server-side-sessions.md)).

## Scope

- In:
  - **Lint:** `npm run lint:fix` (removes the 68 unused imports), then fix any remaining errors by hand. Remove
    `continue-on-error` from the CI lint step.
  - **`tsconfig.json`:** `allowJs: true`, `checkJs: false`, `strict: true`, `noEmit: true`, `jsx: react-jsx`,
    `paths: {"@/*": ["./src/*"]}`, `include: ["src"]`.
    - `typecheck` script: `tsc --noEmit -p tsconfig.json`, added to CI.
    - Keep `jsconfig.json` only if editors need it; otherwise delete it.
  - **Vite dev proxy:** `server.proxy['/api'] = { target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000', changeOrigin: false }`.
  - **Route scope:**
    - `src/app/routeScope.ts` exports `DEMO_PAGES`, an allowlist of `pages.config.js` keys from
      [PRODUCT_SCOPE.md](../PRODUCT_SCOPE.md#base44-page--scope-map).
    - `App.jsx` registers only allowlisted pages, and `Layout.jsx` navigation shows only allowlisted items.
    - Check whether the Base44 plugin regenerates `pages.config.js`. If it does, filter in `App.jsx`, not in
      the generated file.
  - **Ratchet:** `scripts/base44-count.sh` counts `base44\.` and `@base44/` references under `frontend/src`.
    `frontend/base44-baseline.txt` stores the number. CI fails if the count is higher than the baseline, and
    prints a reminder to lower the baseline when it is lower.
  - **ESLint:** `no-restricted-imports` for `@base44/*` and `@/api/base44Client` in `src/features/**` and
    `src/app/**`.
  - **Investigate** `src/lib/VisualEditAgent.jsx`, `NavigationTracker.jsx` and the Base44 vite plugin for
    runtime network calls. Disable them in production builds if they phone home, and record the findings in
    the PR. Also check `VisualEditAgent.jsx`'s `postMessage(..., '*')` calls and its `message` handler, whose
    `event.origin` check is commented out: any page that frames the app can drive edit mode and read page
    text (found in the review of PR #3, which started tracking `src/lib/`).
  - Extend the pre-commit formatting hooks (`.pre-commit-config.yaml`, scoped to `backend/` in P0-02) to
    `frontend/`, fixing the whitespace/EOF findings they report.
- Out:
  - migrating any page
  - removing dependencies (done per slice)
  - the API client (P1-07)

## Interfaces

`VITE_API_PROXY_TARGET` (dev only). The allowlist in `src/app/routeScope.ts`.

## Acceptance criteria

1. **Given** `main`, **when** CI runs, **then** `eslint`, `tsc --noEmit`, the ratchet and `vite build` run, all
   blocking, and pass.
2. **Given** the backend running on :8000 and `npm run dev`, **when** the browser runs
   `fetch('/api/health')`, **then** it returns `{"status":"ok"}` with no CORS preflight.
3. **Given** a hidden page (for example `/Financials`), **when** navigated to directly, **then** the 404 page
   renders, and the page is absent from the navigation.
4. **Given** a new `base44.entities.X` reference, **when** CI runs, **then** the ratchet step fails.
5. **Given** `import { base44 } from '@/api/base44Client'` inside `src/features/x.ts`, **when** linting,
   **then** eslint errors.

## Test plan

- CI run on the PR.
- Manual: browser network tab for the proxy check, and the hidden route check.
- `bash scripts/base44-count.sh` locally before and after adding a dummy reference.

## Likely files

`frontend/package.json`, `frontend/tsconfig.json`, `frontend/vite.config.js`, `frontend/eslint.config.js`,
`frontend/src/App.jsx`, `frontend/src/Layout.jsx`, `frontend/src/app/routeScope.ts`,
`scripts/base44-count.sh`, `frontend/base44-baseline.txt`, `.github/workflows/<ci>.yml`.

## Must explain (learning checkpoint)

1. How does the Vite proxy make the browser think the API is same-origin, and why does that remove CORS?
2. What is a ratchet in CI, and why is it better than "fix everything first"?
3. Why hide out-of-scope routes instead of deleting the pages?

## Frame notes (original; see the parts)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
