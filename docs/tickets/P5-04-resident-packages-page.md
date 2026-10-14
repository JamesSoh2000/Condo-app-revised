# P5-04 — Resident packages page

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-02a, P3-05 |
| Replaces old | M7-T04, M7-T05 (resident badge part) |
| Status | todo |

## Goal

Residents see their waiting packages, with photos and history, and a nav badge. Package notifications deep
link to the package. The new page replaces the Base44 `Packages` page.

## Why

This is the resident half of journey 4. It is the most-used resident screen, so it should be fast and clear.

## Scope

- In (`features/packages/pages/MyPackagesPage.tsx`, route `/packages`, role resident):
  - **"Waiting for you":** cards with the photo (`PrivateImage`), carrier, description, "Arrived <time>"
    (building timezone), and "Pick up at the front desk".
  - **"History":** picked-up and returned packages, paginated (load more).
  - **Empty states** for both.
  - **Deep link:** `/packages/:id` opens the package detail (a dialog or a page). A package that is not
    visible shows the generic not-found state.
  - **Nav badge** from `packages_summary.waiting`, polled with the notification summary cadence (30 s,
    visible tab only).
  - The notification `link` for `package.arrived` is `/packages/{id}`. P5-02a sets it.
  - Remove legacy `Packages.jsx` from the routes and lower the ratchet.
- Out:
  - delegate pickup authorization by residents (pilot option)

## Interfaces

Consumes `packages_list`, `packages_get` and `packages_summary`.

## Acceptance criteria

1. **Given** `resident1` with 2 waiting packages and 3 picked up, **then** the page shows 2 cards and 3
   history rows, and the badge shows 2.
2. **Given** security logs a new package, **when** the tab is visible, **then** within 30 s the badge shows 3,
   and the bell shows a notification that deep-links to the package.
3. **Given** `/packages/<id of another resident's package>`, **then** the not-found state shows.
4. **Given** a timestamp of 23:30 UTC and a building in `America/Toronto`, **then** the local building time is
   displayed.
5. **Given** mobile width, **then** the cards are readable, and images have alt text.

## Test plan

- Vitest for the components (mock data, timezone formatting).
- E2E in P5-05.
- Manual on the local stack.

## Likely files

`frontend/src/features/packages/pages/MyPackagesPage.tsx`, `frontend/src/features/packages/components/*`,
`frontend/src/lib/time.ts` (building-timezone formatting helper), `frontend/src/app/routes.tsx`,
`frontend/src/pages/Packages.jsx` (removed), `frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. Which server rule decides what this page shows? (Name the function.)
2. How does the badge stay fresh without WebSockets, and what is the worst-case delay?
3. How is a UTC timestamp rendered in the building's timezone?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
