# P2-06b — Building context, membership guards and navigation

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 1 |
| Depends on | P2-06a |
| Replaces old | M4-T05, M3-T10 (frontend part) |
| Status | todo |

Split from [P2-06](./P2-06-frontend-auth-shell.md) (see there why). Login, logout, `/me`, `RequireAuth`, the
new shell and the placeholders are [P2-06a](./P2-06a-frontend-auth-core.md).

## Goal

Inside the P2-06a shell, the user works in one building per tab, sees only screens their membership, roles
and the building's features allow, and navigates with a menu built from route metadata.

## Why

Correct cache scoping here prevents a whole class of cross-building data-leak bugs in the UI
([02 §13](../ARCHITECTURE.md#13-frontend-architecture-adr-0011)).

## Scope

- In:
  - **`src/app/BuildingProvider.tsx`:**
    - the selected building ID is stored in `sessionStorage` (per tab)
    - default: the only active membership, or a picker when there are several
    - switching removes `['b', oldId]` queries
    - every building hook reads the ID from here
  - **Guards** (`src/app/guards.tsx`, next to P2-06a's `RequireAuth`):
    - `RequireActiveMembership`, which renders `NoMembershipScreen` (enter join link or code), `PendingScreen`
      (status from `/me`), `DeniedScreen` (with reason after P4-05) or `SuspendedScreen`
    - `RequireRole roles=[…]`
    - `RequireFeature feature=…` (from `GET /api/buildings/{id}`)
  - **403 page** (route `/403`).
  - **Navigation:** built from route metadata (role, feature, scope allowlist from P0-03), replacing the
    Base44 nav logic in `Layout.jsx` (delete `Layout.jsx` once nothing imports it), with the header menu that
    holds P2-06a's "Log out". Council "view as resident/management" is a **presentation toggle only**,
    stored per tab, and it never changes API calls or permissions.
  - **Seed:** a multi-building user (active in Maple and Birch) for AC4, if none exists by then.
- Out:
  - invitation, reset and join screens (P4-07, P4-08)
  - notification bell (P3-05)

## Interfaces

Consumes `GET /api/auth/me` (through P2-06a's `useMe`) and `GET /api/buildings/{id}`. Routes: `/403`.

## Acceptance criteria

1. **Given** seeded `resident1`, **when** logging in, **then** the nav shows only resident demo items
   (original AC1, second half; the landing is P2-06a's AC1).
2. **Given** `pending@example.test`, **when** logging in, **then** the pending screen is shown, and the
   network log shows **no** `/api/buildings/...` calls at all (original AC3).
3. **Given** the multi-building seeded user, **when** tab 1 selects Maple and tab 2 selects Birch, **then**
   each tab keeps its own selection after reload, and data never mixes (original AC4).
4. **Given** `npm run lint` and the ratchet, **then** the files this part adds contain no `base44` reference,
   and the baseline is lowered again if `Layout.jsx` goes (original AC7, continued).

Sharpen these and add the tenant-table rows and a missed case when framing.

## Test plan

- Vitest + Testing Library for the guards (mock the client) and building switching (cache removal).
- Stack run on `make up` with the seeded users (dev and prod-like); transcript in the PR.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`.

## Likely files

`frontend/src/app/{BuildingProvider,guards,routes}.tsx`, `frontend/src/app/nav*.ts(x)`,
`frontend/src/features/membership/**`, `frontend/src/Layout.jsx` (deleted), `backend/app/seed.py`,
`frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. Why is the selected building stored in `sessionStorage` rather than `localStorage` or on the server?
2. Show how a slow response from building A could appear in building B's view without building-scoped query
   keys, and how the keys prevent it.
3. Why does council "view as" never change API permissions?

## Notes from the P2-06a frame (2026-10-17)

- No seeded user has memberships in two buildings today (`backend/app/seed.py::MEMBERS`): AC3 needs one.
- P2-06a removed `LanguageProvider` from the shell (it calls Base44 on mount). The nav labels are English
  until a slice brings i18n back without Base44.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
