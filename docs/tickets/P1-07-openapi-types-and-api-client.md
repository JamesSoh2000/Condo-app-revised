# P1-07 — OpenAPI → TypeScript types and API client

| Field | Value |
|---|---|
| Phase / lane | P1 / B |
| Risk tier | 2 |
| Depends on | P1-04, P0-03 |
| Replaces old | M4-T01, M4-T03, M4-T04 (conventions part) |
| Status | todo |

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
2. **Given** a backend change adding a field without regenerating, **when** CI runs, **then** the frontend job
   fails on the diff check.
3. **Given** a 409 problem+json response, **when** a call goes through the client, **then** an `ApiError` is
   thrown with `code` and `requestId` set (Vitest with mocked fetch).
4. **Given** any request, **then** the `X-Requested-With: fetch` header is present (Vitest).
5. **Given** a 404 response, **then** the query client does not retry. A 503 retries at most twice.
6. **Given** `npm run dev` with the backend up, **then** the footer shows the backend version.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
