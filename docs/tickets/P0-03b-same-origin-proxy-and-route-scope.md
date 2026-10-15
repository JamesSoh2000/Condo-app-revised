# P0-03b — Same-origin dev proxy and demo route scope

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 2 |
| Depends on | P0-03a (same files: `App.jsx`, `Layout.jsx`, lint config) |
| Replaces old | M0-T02 (hide deferred routes) |
| Status | todo |

Split from [P0-03](./P0-03-frontend-quality-gates.md) (see there why).

## Goal

The frontend calls the API same-origin through the Vite proxy, and exposes only the demo-scope routes.

## Why

The same-origin proxy removes CORS and makes local development behave like production
([ADR-0003](../adr/0003-same-origin-server-side-sessions.md)). Hidden routes keep the migration focused
([ADR-0011](../adr/0011-frontend-strangler-typescript.md)).

## Scope

- In:
  - **Vite dev proxy:** `server.proxy['/api'] = { target: process.env.VITE_API_PROXY_TARGET ?? 'http://localhost:8000', changeOrigin: false }`.
  - **Route scope:**
    - `src/app/routeScope.ts` exports `DEMO_PAGES`, an allowlist of `pages.config.js` keys from
      [PRODUCT_SCOPE.md](../PRODUCT_SCOPE.md#base44-page--scope-map).
    - `App.jsx` registers only allowlisted pages, and `Layout.jsx` navigation shows only allowlisted items.
    - Check whether the Base44 plugin regenerates `pages.config.js`. If it does, filter in `App.jsx`, not in
      the generated file.
  - **Investigate** `src/lib/VisualEditAgent.jsx`, `NavigationTracker.jsx` and the Base44 vite plugin for
    runtime network calls. Disable them in production builds if they phone home, and record the findings in
    the PR. Also check `VisualEditAgent.jsx`'s `postMessage(..., '*')` calls and its `message` handler, whose
    `event.origin` check is commented out: any page that frames the app can drive edit mode and read page
    text (found in the review of PR #3, which started tracking `src/lib/`).
- Out: migrating any page; removing dependencies (done per slice); the API client (P1-07).

## Interfaces

`VITE_API_PROXY_TARGET` (dev only). The allowlist in `src/app/routeScope.ts`.

## Acceptance criteria

2. **Given** the backend running on :8000 and `npm run dev`, **when** the browser runs
   `fetch('/api/health')`, **then** it returns `{"status":"ok"}` with no CORS preflight. *(was P0-03 AC2)*
3. **Given** a hidden page (for example `/Financials`), **when** navigated to directly, **then** the 404 page
   renders, and the page is absent from the navigation. *(was P0-03 AC3)*

(The agent framing P0-03b sharpens these.)

## Likely files

`frontend/vite.config.js`, `frontend/src/App.jsx`, `frontend/src/Layout.jsx`, `frontend/src/app/routeScope.ts`,
`frontend/src/lib/VisualEditAgent.jsx`, `frontend/src/lib/NavigationTracker.jsx`.

## Must explain (learning checkpoint)

1. How does the Vite proxy make the browser think the API is same-origin, and why does that remove CORS?
2. Why hide out-of-scope routes instead of deleting the pages?
3. What can a page that frames the app do through an unchecked `postMessage` handler?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: part b of [P0-03](./P0-03-frontend-quality-gates.md).
