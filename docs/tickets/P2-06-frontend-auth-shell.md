# P2-06 — Frontend auth shell, guards and building picker

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 1 |
| Depends on | P2-02, P1-07 |
| Replaces old | M4-T02, M4-T05, M3-T10 (frontend part) |
| Status | todo |

## Goal

The app shell boots entirely from the new auth API (login, logout, `/me`, guards, per-tab building
selection, role-based navigation) with no Base44 auth calls left in the shell.

## Why

Every migrated page plugs into this shell. Correct cache scoping here prevents a whole class of
cross-building data-leak bugs in the UI ([02 §13](../ARCHITECTURE.md#13-frontend-architecture-adr-0011)).

## Scope

- In:
  - **`src/app/AuthProvider.tsx`:**
    - `useMe()` query `['me']`
    - listens for the `auth:unauthenticated` event, then `queryClient.clear()` and redirect to
      `/login?next=…`
  - **`src/features/auth/pages/LoginPage.tsx`:**
    - react-hook-form + zod
    - generic error message on 401, 429 message using `Retry-After`
    - accessible: labels, focus on the first error
  - **Logout** in the header menu calls the API, clears the query cache and navigates to `/login`.
  - **`src/app/BuildingProvider.tsx`:**
    - the selected building ID is stored in `sessionStorage` (per tab)
    - default: the only active membership, or a picker when there are several
    - switching removes `['b', oldId]` queries
    - every building hook reads the ID from here
  - **Guards** (`src/app/guards.tsx`):
    - `RequireAuth`
    - `RequireActiveMembership`, which renders `NoMembershipScreen` (enter join link or code), `PendingScreen`
      (status from `/me`), `DeniedScreen` (with reason after P4-05) or `SuspendedScreen`
    - `RequireRole roles=[…]`
    - `RequireFeature feature=…` (from `GET /api/buildings/{id}`)
  - **403 and 404 pages.**
  - **Navigation:** built from route metadata (role, feature, scope allowlist from P0-03), replacing the
    Base44 nav logic in `Layout.jsx`. Council "view as resident/management" is a **presentation toggle only**,
    stored per tab, and it never changes API calls or permissions.
  - **Legacy in-scope pages not yet migrated** (`Packages`, `SecurityPackages`, `Maintenance`, …) render a
    "Being migrated" placeholder, so the shell never calls Base44 auth. Their slices replace the placeholders.
  - Delete or retire `src/lib/AuthContext.jsx` usage in the shell, and lower the Base44 ratchet baseline.
- Out:
  - invitation, reset and join screens (P4-07, P4-08)
  - notification bell (P3-05)

## Interfaces

Consumes `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me` and
`GET /api/buildings/{id}`. Routes: `/login`, `/`, `/403`, `*`.

## Acceptance criteria

1. **Given** seeded `resident1`, **when** logging in, **then** they land on the resident home placeholder,
   and the nav shows only resident demo items.
2. **Given** a wrong password, **then** the generic error is shown and focus moves to the error summary.
3. **Given** `pending@example.test`, **when** logging in, **then** the pending screen is shown, and the
   network log shows **no** `/api/buildings/...` calls at all.
4. **Given** the multi-building seeded user, **when** tab 1 selects Maple and tab 2 selects Birch, **then**
   each tab keeps its own selection after reload, and data never mixes.
5. **Given** logout, **when** pressing browser Back, **then** no authenticated content renders, and the cache
   is empty.
6. **Given** a session revoked server-side (logout-all from another tab), **when** the next API call returns
   401, **then** the user is redirected to login.
7. **Given** `npm run lint` and the ratchet, **then** shell files contain no `base44` references, and the
   baseline is lowered in this PR.

## Test plan

- Vitest + Testing Library for the guards (mock the client), building switching (cache removal), and the 401
  handling.
- Manual run-through on the local stack (dev and prod-like) with the seeded users; record a short screen
  capture in the PR.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`.

## Likely files

`frontend/src/app/{AuthProvider,BuildingProvider,guards,routes}.tsx`, `frontend/src/features/auth/**`,
`frontend/src/App.jsx` (or `App.tsx`), `frontend/src/Layout.jsx`, `frontend/src/lib/AuthContext.jsx`,
`frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. Why is the selected building stored in `sessionStorage` rather than `localStorage` or on the server?
2. Show how a slow response from building A could appear in building B's view without building-scoped query
   keys, and how the keys prevent it.
3. Why are frontend guards "UX only"? Which server mechanism actually protects the data?
4. Why does council "view as" never change API permissions?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
