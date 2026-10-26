# P6-05b — Role landing pages

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-05a, P6-04d, P5-04, P6-02a, P4-08b |
| Replaces old | M9-T01 (pages part) |
| Status | todo |

Split from the P6-05 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-05a](./P6-05a-dashboard-summary-api.md).

## Goal

Every active member lands, at `/`, on their role's page: cards for the domains their roles and the building's
features allow, each with the counts from `GET /dashboard` and a link to the slice's page. The legacy `Dashboard`
and `Home` pages are gone.

## Why

Journey 8 in the UI. Today `/` is `app/screens.tsx::HomePlaceholder` ("coming soon"), and every slice's page is
reachable only from the nav. The cards must agree with the nav (the same `PAGE_ACCESS` rows decide both) and with
the badges (the same server counts), so the page adds no permission rule of its own.

## Scope

- In (`frontend/src/features/dashboard/`):
  - `api.ts`: `useDashboard(buildingId)` over `dashboard_get`, key `['b', buildingId, 'dashboard']`, polled at the
    30 s visible-tab cadence (ADR-0012, as `useNoticeSummary`), `staleTime: 0`
  - **landing page** at `/` (replacing `HomePlaceholder`): the building's name, then one card per section that is
    non-null **and** whose page `PAGE_ACCESS` lets the caller open (`navPages`), so a card never links to `/403`:
    - resident: "My packages" (waiting), "Notices" (unread, urgent unread), "Maintenance requests" (open by status)
    - security: "Package log" (waiting), "Notices", "Maintenance" (open, read only)
    - property management: "Pending requests" (onboarding pending, linking to `/manage/residents`), "Package log",
      "Manage notices" / "Notices", "Manage maintenance" (open by status)
    - council: "Notices", and maintenance as P6-05a decided
    - a multi-role member gets the union, each card once
  - **council view-as** (carried from P2-06c, below): the landing page may use `useBuildingContext().viewAs`, applied
    only when `useCanViewAs(building)` is true, to choose the council member's cards; it never reaches the API, a
    guard or a query key
  - loading, failed (with retry) and "no cards" states; a card's count says "None waiting" for 0, never a blank
  - delete `src/pages/Dashboard.jsx` and `src/pages/Home.jsx`; `/Dashboard` and `/Home` redirect to `/`
    (`LegacyRedirect`); `PAGE_ACCESS.Dashboard`'s nav label points at `/` (or the item goes, as framing decides);
    lower the ratchet
  - mutations that change a count (package pickup, notice read, onboarding decision, maintenance actions and
    submit) also invalidate the dashboard key, so returning to `/` shows the new count
- Out: deferred domains' cards (no amenities, moves, visitors, reports, financials); charts; editing anything from
  a card

## Interfaces

Consumes `dashboard_get` (P6-05a). No API change.

## Acceptance criteria

1. **Per role.** **Given** each Maple persona (`resident1`, `security`, `manager`, `council`, `multi` in Maple),
   **then** `/` shows exactly the cards listed above for their roles, with the counts the API returned, each card's
   link equal to the nav item's path; no card is shown for a null section, a disabled feature or a page the caller's
   roles can't open.
2. **Agreement.** **Given** a count, **then** the card's number equals the nav badge for the same domain once both
   have loaded (both are the server's counts); after a mutation in the tab (a notice read, a pickup), returning to
   `/` shows the new count without a reload.
3. **Features.** **Given** `maintenance` off, **then** no maintenance card shows and nothing asks for one; **given**
   every feature off, the "no cards" state shows.
4. **View-as (P2-06c carry).** **Given** a council + resident member, **when** they pick "resident" view, **then** the
   page shows the resident's cards; no request differs between the views (the test compares the requests sent);
   a member without `useCanViewAs` sees their roles' cards whatever is stored in `viewAs`.
5. **Tenant rows 2, 3, 6.** Signed out goes to login; `/` asks only the selected building's dashboard; a
   `building_not_found` marks the building denied; switching building shows only B's cards (keyed by building); a
   pending member sees the pending screen, not the page.
6. **States.** Loading, failed with "Try again", and a 429 each render; a failed poll after a success keeps the last
   counts with a quiet message, not an empty page.
7. **Legacy.** `Dashboard.jsx` and `Home.jsx` are deleted, `/Dashboard` and `/Home` reach `/` with query and hash,
   and the ratchet is lowered.
8. **375 px in Chromium** with the longest building name and five-digit counts, the cards stay inside the viewport,
   and each card's accessible name includes its count ("Notices, 3 unread, 1 urgent").

## Test plan

- `frontend/src/features/dashboard/dashboard.test.tsx` (`renderApp`, `stubApi`): criteria 1–7
- `src/test/queryFreshness.test.ts`, `buildingDenial.test.ts` and `nav.test.tsx` pass with the new page
- Chromium check at 375 px (criterion 8), output in the PR
- `make check DB_PORT=55432`; on `make up`, `/` as each seeded persona, transcript in the PR

## Likely files

`frontend/src/features/dashboard/{api.ts,DashboardPage.tsx,DashboardCard.tsx,cards.ts}`,
`frontend/src/app/{routes.tsx,pages.ts,screens.tsx,routeScope.ts}`, the domain `api.ts` files (invalidate the
dashboard key), `frontend/src/pages/{Dashboard,Home}.jsx` (deleted), `frontend/base44-baseline.txt`.

Estimate: ~300 non-test lines (page ~110, card ~50, the card table from `PAGE_ACCESS` ~60, hooks ~30, invalidation
in four `api.ts` ~20, routes and legacy redirects ~30).

## Must explain (learning checkpoint)

1. Which code decides whether a card shows, and why can't a card and the nav disagree?
2. What does council view-as change on this page, and why must it never reach the API?
3. How does the card's count stay equal to the badge?

## Carried from P2-06c

Council "view as" (`useBuildingContext().viewAs`, applied only when `useCanViewAs(building)` is true) changes only
the nav today. The landing page may use it to pick the council member's cards; it must never reach the API or a
guard (PR #65 D3). Criterion 4 tests it.

## Open decisions (resolve while framing)

Left open by the stub:
- **`/` or `/dashboard`** for the landing page (default `/`, the index route the guards already send members to)
- the nav's "Dashboard" item: kept (pointing at `/`) or removed in favour of the header's building name
- whether a card shows recent items (the last three packages, the urgent notice title) or counts only (default:
  counts only, the stub's "cards linking to the slices")

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
