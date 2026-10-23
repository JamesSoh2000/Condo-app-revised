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
   history rows, and the badge shows 2. *(Sharpened:)* "Waiting for you" lists `status=received`, "History"
   lists `status=picked_up` and `returned` in one list, newest first, 25 a page with "Load more"; each history
   row says "Picked up <time>" or "Returned <time>". The nav item's accessible name is "My packages, 2 waiting";
   with none waiting, or after a failed refresh, it is plain "My packages".
2. **Given** security logs a new package, **when** the tab is visible, **then** within 30 s the badge shows 3,
   and the bell shows a notification that deep-links to the package. *(Sharpened:)* the summary is asked every
   30 s only while the tab is visible, again when it becomes visible, and on each mount of the nav item; opening
   the notification navigates to `/packages/<id>` and the detail dialog shows that package.
3. **Given** `/packages/<id of another resident's package>`, **then** the not-found state shows.
   *(Sharpened:)* the same "Package not found" dialog for another resident's package, another building's package
   and an id that doesn't exist (all 404 `package_not_found`), and for a path segment that isn't a UUID (not sent
   to the API). The page's lists still show behind it, and closing it goes to `/packages`.
4. **Given** a timestamp of 23:30 UTC and a building in `America/Toronto`, **then** the local building time is
   displayed. *(Sharpened:)* `2026-03-15T23:30:00Z` shows as 7:30 PM on Mar 15 (EDT), not the device's zone;
   the arrival, pickup and return times all use the building's timezone and locale.
5. **Given** mobile width, **then** the cards are readable, and images have alt text. *(Sharpened:)* at 375 px in
   Chromium, with a 50-character carrier and a 200-character description without spaces, nothing is wider than
   the viewport; each photo's alt is "Package photo: <carrier>"; a package without a photo shows a "No photo"
   box.

Added while framing:

6. **Detail.** Each card and history row has a "Details" link to `/packages/<id>`; the dialog shows the photo,
   carrier, description, unit, status and times from `packages_get`, closes with Close or Escape (to
   `/packages`), and Back/Forward between `/packages` and `/packages/<id>` opens and closes it without
   reloading the lists.
7. **Access (tenant rows 1, 2, 4).** A resident opens `/packages`; a signed-out user goes to the login page with
   the way back; security, property management and council alone get `/403`, and so does a resident whose
   building has `packages` off. None of them asks the packages API. The legacy `/Packages` path opens the page
   (it is the same path to the router, which matches case-insensitively), and its `.jsx` is deleted with the
   Base44 ratchet lowered.
8. **States.** Each list has its loading, empty ("No packages are waiting for you." / "No package history yet."),
   failed-with-Try-again and failed-"Load more" states; the detail dialog has loading and failed-with-retry
   states distinct from not-found.
9. **A case the ticket missed: the lists follow the badge.** When the polled waiting count changes while the page
   is open, both lists are asked again, so the cards don't stay at 2 while the badge says 3.
10. **API (tenant rows 1, 3, 5).** `GET …/packages?status=picked_up&status=returned` lists the visible packages
    in either status; a single `status` behaves as before; a resident gets only their own (`visible_packages`),
    another building's member gets 404.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1–5 sharpened (the lists' statuses and pagination, the badge's accessible name,
  the polling rules, which ids are "not found", the exact Toronto rendering, the 375 px longest-value check and
  the alt text); 6–10 added: the detail dialog and Back/Forward, access (tenant rows 1, 2, 4), the lists'
  states, one missed case (9, the lists follow the badge), and the API change history needs (10; tenant rows
  1, 3, 5). Rows 6–10 of the tenant table don't apply to these reads (no body, no transition) beyond what
  P5-02a already tests.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **History needs a multi-status filter.** `packages_list` takes one `status`; History is `picked_up` and
    `returned` together. `status` becomes a repeatable query parameter (additive: one value works as before).
    Rejected: listing everything and dropping `received` in the browser (pages of waiting packages would
    show as empty "Load more" pages), and two History lists (the ticket asks for one). Autonomous, reversible.
  - **Route.** `PAGE_ACCESS.Packages.path = '/packages'` and one route `/packages/:packageId?`, so the page stays
    mounted between the list and a package. React Router matches paths case-insensitively, so the legacy
    `/Packages` already reaches this route; it gets no `LegacyRedirect` (a redirect to its own path would loop),
    contrary to what the P5-03b explanation predicted. Autonomous.
  - **Detail is a dialog over the page** (the ticket allows a dialog or a page), reusing the residents `Modal`.
  - **Building time** reuses `WaitingList`'s `Intl.DateTimeFormat(building.locale, { timeZone })`; no
    `src/lib/time.ts` (that folder is legacy JS; convention).
  - **Badge** mirrors the notification summary (ADR-0012): `packages_summary` under the building's packages key,
    so the desk's mutations already invalidate it.
  - **Accepted limitation:** a member who is a resident *and* security or property management sees the whole
    building's packages here (`visible_packages` grants the union by design). Follow-up, not this ticket.
  - Not picked up: the P3-05 fitness-test follow-up carried to P5-03d; it is outside this page.
- Estimate: ~380 non-test lines (page and its two lists ~180, measured against `WaitingList.tsx` at 144 for a
  paged list with states; detail dialog ~80; hooks ~55; nav badge ~25; routes and pages ~15; backend ~10).
  The legacy `Packages.jsx` is deleted, not counted. No split.
- Split: none.
