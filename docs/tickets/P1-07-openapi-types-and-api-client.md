# P1-07 — OpenAPI → TypeScript types and API client

| Field | Value |
|---|---|
| Phase / lane | P1 / B |
| Risk tier | 2 |
| Depends on | P1-04, P0-03 |
| Replaces old | M4-T01, M4-T03, M4-T04 (conventions part) |
| Status | in progress |

## Goal

The frontend has a typed API client generated from the backend's OpenAPI. CI fails when the types are stale,
errors become a typed `ApiError`, and React Query conventions are established.

## Why

Contract drift between frontend and backend is a top source of bugs when two lanes work in parallel. With
generated types, a backend change that breaks the UI fails `tsc` instead of failing in production
([ADR-0011](../adr/0011-frontend-strangler-typescript.md)).

## Scope

- In:
  - **Backend:** `python -m app.export_openapi` writes the OpenAPI JSON to stdout without starting a server.
  - **Frontend** devDependencies `openapi-typescript`, and dependency `openapi-fetch`.
  - **Generation:** `npm run gen:api` runs `openapi-typescript ../openapi.json -o src/api/schema.d.ts`.
    `make gen-api` runs the export, then the generation.
  - **CI:** export, generate, then `git diff --exit-code frontend/src/api/schema.d.ts`.
  - **`src/api/client.ts`:**
    - `createClient<paths>({ baseUrl: "" })` (paths already include `/api`)
    - middleware adds `X-Requested-With: fetch` to every request
    - problem+json responses become `ApiError {status, code, title, detail, errors, requestId}`
    - a 401 emits an `auth:unauthenticated` event (consumed in P2-06)
    - helpers `unwrap()` and `api.get/post` wrappers that throw `ApiError`
  - **`src/app/queryClient.ts`** (replaces `src/lib/query-client.js`):
    - `staleTime: 30_000`, `refetchOnWindowFocus: true`
    - retry: at most 2 attempts, only for network errors and 5xx (never 4xx)
  - Query-key convention documented in `src/api/README.md`: `['me']`, `['b', buildingId, domain, params]`.
  - A sample hook `useVersion()` (`GET /api/version`), shown in the footer in dev builds, to prove the wiring.
  - Vitest + Testing Library setup (`npm run test`).
- Out:
  - auth screens (P2-06)
  - domain hooks (their own slices)

## Interfaces

`src/api/schema.d.ts` (generated; never edit), `src/api/client.ts`, `src/api/errors.ts`,
`src/app/queryClient.ts`. Make target `gen-api`.

## Acceptance criteria

1. **Given** the backend code, **when** `make gen-api` runs, **then** `schema.d.ts` contains the
   `/api/version` path. Running it again produces no diff.
   *Sharpened:* `python -m app.export_openapi` prints exactly `create_app().openapi()` as JSON and works with
   no database or server running (pytest, in a subprocess); `/api/version` has a typed response schema
   (`VersionOut`), so `useVersion()` reads `git_sha` without casts.
2. **Given** a backend change adding a field without regenerating, **when** CI runs, **then** the frontend job
   fails on the diff check.
   *Sharpened:* proven by a deliberate mutation (a field added to `VersionOut`, not regenerated): the CI
   step's commands exit non-zero, output pasted in the PR.
3. **Given** a 409 problem+json response, **when** a call goes through the client, **then** an `ApiError` is
   thrown with `code` and `requestId` set (Vitest with mocked fetch).
   *Sharpened:* `status`, `code`, `title`, `detail`, `errors` and `requestId` (from the body's `request_id`)
   all set; also for a 422 with `errors[]`.
4. **Given** any request, **then** the `X-Requested-With: fetch` header is present (Vitest).
   *Sharpened:* on GET and POST, through both the raw client and the `api.get/post` wrappers.
5. **Given** a 404 response, **then** the query client does not retry. A 503 retries at most twice.
   *Sharpened:* "at most 2 attempts" in Scope means at most 2 **retries** (3 requests), as this criterion
   says. Through a real `QueryClient` with the app's options: a 404 makes 1 request; a 503 makes 3; a
   network error (`fetch` rejects with `TypeError`) makes 3; 400, 401, 403, 409 and 422 make 1.
6. **Given** `npm run dev` with the backend up, **then** the footer shows the backend version.
   *Sharpened:* a Testing Library test renders the footer from a mocked `/api/version`; on the stack,
   `GET /api/version` through the Vite proxy returns the backend's body (transcript in the PR).

Added while framing:

7. **Given** a 401 response, **then** one `auth:unauthenticated` event is emitted (and `ApiError` 401
   thrown); other statuses emit nothing (Vitest).
8. **Given** an error response that is not problem+json (a proxy's HTML 502), **then** the client still
   throws an `ApiError` with that `status`, `code: "http_error"`, and `requestId` from the `X-Request-ID`
   response header when present, otherwise `null` (Vitest).
9. **Given** a production build (`npm run build`), **then** the version footer is not rendered: it is gated on
   `import.meta.env.DEV` (Vitest renders nothing with `DEV` false).
10. `src/lib/query-client.js` is removed and `App.jsx` uses `src/app/queryClient.ts`; the query client's
    defaults are `staleTime: 30_000`, `refetchOnWindowFocus: true` (Vitest). `npm run test` runs in CI.

Tenant table (`ENGINEERING_PRACTICES.md` §7): no rows apply; this ticket adds no building-scoped endpoint.

## Test plan

- `src/api/client.test.ts`, `src/app/queryClient.test.ts`
- Commands: `make gen-api`, `npm run test`, `npm run typecheck`

## Likely files

`backend/app/export_openapi.py`, `frontend/package.json`, `frontend/src/api/{client,errors}.ts`,
`frontend/src/api/schema.d.ts`, `frontend/src/app/queryClient.ts`, `frontend/src/api/README.md`,
`frontend/vitest.config.ts`, `Makefile`, `.github/workflows/<ci>.yml`.

## Must explain (learning checkpoint)

1. Walk through what happens when a backend developer renames a response field: which check fails, and where?
2. Why should the client never retry 4xx responses?
3. Why include `buildingId` in query keys? What bug happens without it?

## Carried from P1-04

Every error is documented as the `Problem` schema under `application/problem+json` (422s included; there
is no `HTTPValidationError`). Paged responses appear as `Page_<Item>_`. Operation ids are
`<tag>_<function name>` (`health_ready`).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC1 (export is pure, `VersionOut`), AC2 (mutation proof), AC3 (all fields,
  422), AC4 (GET/POST, both paths), AC5 (retry counts per status and network error), AC6 (component test +
  proxy transcript); added AC7 (401 event), AC8 (non-problem errors), AC9 (no footer in production), AC10
  (old query client removed, defaults, tests in CI).
- Criteria loosened (with reason; also listed in the inbox): none. AC6's "footer shows the version" is
  checked by a component test plus the proxy transcript, not a browser screenshot (no browser in the agent
  environment); this is recorded under "not verified" rather than counted as loosening.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - "At most 2 attempts" read as at most 2 retries, per AC5 (ticket).
  - `openapi.json` is written to the repo root (the ticket's `../openapi.json`) and gitignored; only
    `schema.d.ts` is committed and drift-checked (ticket).
  - The drift check runs in the frontend CI job, which gains Python and uv to run the export (ticket AC2).
  - `/api/version` gets a `VersionOut` response model so the generated type is a typed object rather than
    `Record<string, string>` (autonomous, ticket-local).
  - The 401 event goes through an `EventTarget` exported by `src/api/client.ts`, not `window` (autonomous;
    P2-06 consumes it; listed in the inbox).
  - Non-problem error bodies map to `code: "http_error"` (autonomous; listed in the inbox).
  - Vitest 4 (not 5, which needs Vite ≥ 6.4; the lock has 6.3.6), jsdom only for component tests (autonomous).
  - The version footer is a new `src/app/DevVersionFooter.tsx` rendered from `App.jsx`; legacy
    `Layout.jsx` is not extended (CLAUDE.md layout rule).
  - The Base44 import fence is extended to `src/api/**/*.{ts,tsx}` (stricter gate; autonomous).
- Split: none. Estimate ~350 non-test lines (generated `schema.d.ts` excluded).
