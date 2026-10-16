# `src/api` — the typed API client (P1-07)

New and migrated code reaches the backend only through this folder (ADR-0011). The `*.js` files here are
the legacy Base44 client; the ESLint fence keeps them out of the TypeScript files.

| File | What it is |
|---|---|
| `schema.d.ts` | Generated from the backend's OpenAPI by `make gen-api`. Never edit it. CI regenerates it and fails on any diff |
| `client.ts` | `api.get/post` (throw `ApiError`), the raw openapi-fetch `client`, `unwrap()`, `onUnauthenticated()` |
| `errors.ts` | `ApiError {status, code, title, detail, errors, requestId}` and `toApiError()` |

## When the backend changes

Run `make gen-api` and commit `schema.d.ts` with the backend change. If a field or path the frontend uses
was renamed or removed, `npm run typecheck` now fails where it is used: fix those call sites in the same PR.

## Calling the API

```ts
import { api } from '@/api/client';

const version = await api.get('/api/version'); // typed from schema.d.ts
```

- Paths are the full OpenAPI paths, `/api` included; the base URL is the page's own origin (ADR-0003).
- Every request carries `X-Requested-With: fetch`.
- Failures throw `ApiError`. Branch on `error.code` (stable), never on `title` or `detail`. A response that
  isn't problem+json (a proxy's HTML 502) still throws `ApiError`, with `code: "http_error"`.
- A 401 also calls every `onUnauthenticated()` listener (P2-06 redirects to login).

## React Query conventions

The client is `src/app/queryClient.ts`: `staleTime` 30 s, refetch on window focus, and at most 2 retries,
only for network errors and 5xx (a 4xx gives the same answer next time).

Query keys:

| Data | Key |
|---|---|
| The signed-in user | `['me']` |
| Anything in a building | `['b', buildingId, domain, params]`, e.g. `['b', buildingId, 'packages', { status: 'waiting' }]` |
| Global, not user- or building-specific | `[name]`, e.g. `['version']` |

`buildingId` is in every building key so that switching buildings never shows one building's cached data
under another, and so `queryClient.removeQueries({ queryKey: ['b', oldId] })` drops a building's data in
one call. Hooks live with their domain (`src/features/<domain>/`), not here; `src/app/useVersion.ts` is the
sample.
