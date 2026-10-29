# P6-04a — Maintenance hooks and the resident's request list

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03b |
| Replaces old | M8-T02 (list part) |
| Status | done |

Drafted from the P6-04 stub in [P6-P7-backlog.md](./P6-P7-backlog.md) and split four ways, as the notices
frontend was (P6-02a → d). Measured against the components of its kind (`MyPackageList.tsx` 146,
`MyPackagesPage.tsx` 83, `LogPackageForm.tsx` 292, `PackageDetailDialog.tsx` 108, `ManagerNoticeList.tsx` 148 +
`ManagerNoticesPage.tsx` 129, `NoticeActionDialog.tsx` 108, `features/notices/api.ts` 203), the stub is about
1,500 non-test lines. This ticket is the hooks and the resident's list;
[P6-04b](./P6-04b-maintenance-submit-and-cancel.md) the submit form with photos and cancel;
[P6-04c](./P6-04c-maintenance-request-view.md) one request with its timeline and comments;
[P6-04d](./P6-04d-manager-maintenance-list-and-actions.md) the manager's list, filters and transition dialog.

## Goal

A resident of a building with `maintenance` on opens "Maintenance requests" and sees the requests the API lets
them see, newest first, each with its status, category, location and submit time, paged with "Load more".

## Why

The first migrated maintenance screen, and the hooks every later P6-04 ticket uses. P6-03b's API is merged by
then but nothing reads it. The list is the resident's half of journey 6 ("the resident sees the status changes",
`docs/PRODUCT_SCOPE.md`). ADR-0011 (strangler), ADR-0012 (polling), `docs/SLICE_RECIPE.md` step 9.

## Scope

- In (`frontend/src/features/maintenance/`):
  - `api.ts`: `maintenanceKey(buildingId, …)` under `['b', buildingId, 'maintenance', …]`
    (`features/packages/api.ts::packagesKey`); an infinite query over `maintenance_list` (cursor pages,
    optional `status`), `staleTime: 0` where the list can remount while data changes elsewhere (the
    `queryFreshness` fitness test). Mutation hooks come with the tickets that use them.
  - **resident page** at the path framing picks (see "Open decisions"; P6-03c's notifications link to
    `/maintenance/<id>`), `PAGE_ACCESS.Maintenance` (`roles: ['resident']`, `feature: 'maintenance'`) gains its
    `path`; its route under `RequirePageAccess`, keyed by building, matching `<path>/:requestId?` so P6-04c's
    view mounts on the same page (as `MyPackagesPage`, P5-04 D2). Until P6-04c, `<path>/<id>` shows the list.
  - **list**: one card per request with the status as text, the category, the unit label or the common-area
    detail, "Submitted <time>" in the building's timezone (`features/packages/time.ts::buildingTime`), the
    description's first line truncated, and the photo count; 25 a page; loading, empty ("You haven't submitted
    any requests"), failed and failed-"Load more" states (`features/lists/useLoadMore.ts`)
  - the status labels as one map (`statusLabel.ts`), reused by P6-04c and P6-04d
- Out: the submit form and cancel (P6-04b); one request, its timeline and comments (P6-04c); the manager's page
  (P6-04d); the dashboard card (P6-05b); deleting the legacy `Maintenance.jsx` (P6-04b, once a resident can
  submit); E2E (P6-07b)

## Interfaces

Consumes `maintenance_list` (`GET /api/buildings/{b}/maintenance-requests?status=&cursor=&limit=`) returning
`Page[MaintenanceRequestOut]` as P6-03b settles it. No API change. If P6-03b's framing changed a field this
ticket names (the common-area detail, the order key), this ticket follows the merged schema
(`frontend/src/api/schema.d.ts`), not this text.

## Acceptance criteria

1. **Given** `a_resident1` with three requests in different statuses, **when** they open `/maintenance`, **then**
   three cards show in the API's order (no re-sorting in the browser), each with its status as text (not colour
   alone, from `labels.ts`), its category as a label (not the raw enum value), its location ("Unit A-101" from
   `unit_tower`/`unit_label`, or the `common_area` text) and "Submitted <time>"; the description's first line only,
   cut to 120 characters with "…" when longer; and "1 photo" / "N photos" when it has any. With 26 requests the
   first request asks `limit=25` and no cursor, "Load more" sends the page's `next_cursor`, and the 26 cards show
   once each, in order; after the last page the button is gone.
2. **Times.** `2026-03-15T23:30:00Z` in an `America/Toronto` building shows as Mar 15, 2026, 7:30 PM in the
   building's locale, not the device's zone (as P5-04 criterion 4).
3. **Access (tenant rows 1, 2, 4).** A resident opens the page; a signed-out user goes to login with the way back
   (`/login?next=…`, also from `/maintenance/<id>`); security, property management and council-only members get
   `/403` without any request to `…/maintenance-requests`; a building with `maintenance` off gives a resident `/403`,
   without that request, and its nav has no "Maintenance requests" item. A council + resident member opens it. The
   nav item links to `/maintenance`.
4. **Tenant row 3, UI side.** The page asks only the selected building's `/api/buildings/{id}/maintenance-requests`
   URLs, and a `building_not_found` on that list marks the building denied (the "no longer have access" screen,
   `app/buildingDenial.ts`; a passive reader also reads `useBuildingDenied()`, `src/test/buildingDenial.test.ts`).
5. **Switching building.** With the page open in A, choosing building B shows only B's requests: nothing of A's
   shows while B's load (the page is keyed by building).
6. **States.** Loading ("Loading requests…" as a status), empty ("You haven't submitted any requests."), a failed
   first page (an alert with "Try again", which asks again and then shows the cards) and a failed "Load more" (the
   cards stay, with an alert and the "Load more" button to retry) each render; a 429 on either says to wait
   (`rateLimitMessage`, with the `Retry-After` time), as the other lists do. "Load more" moves focus as
   `useLoadMore` does (to the first new card; to the button again on failure; to the heading after an empty page).
7. **Legacy path.** `/Maintenance` is answered by the `/maintenance` route itself (the paths differ only in case,
   `sameLegacyPath`), query and hash kept, and the URL stays `/Maintenance`.
8. **375 px in Chromium** with the API's longest values (a 2,000-character `description` and a 120-character
   `common_area`, each a single word without spaces, and the longest category and status labels), nothing is wider
   than the viewport; the measurement is shown to fail once with `overflow-wrap` turned off.
9. **(Added in framing) The browser does not filter.** Every request the API returns shows, including one a
   co-occupant filed for the unit (`requester_membership_id` not the caller's; `visible_maintenance` lets the
   resident see it): the list never compares `requester_membership_id` or `status` with anything. The request asks
   no `status` (the resident sees every status, as `MyPackagesPage` shows waiting and history).
10. **(Added in framing) `/maintenance/<id>` until P6-04c.** The notification link P6-03c sends
    (`/maintenance/<request id>`, `app/maintenance/service.py`) and any other `/maintenance/<anything>` show the
    same list, on the same mounted page: going from `/maintenance/<id>` to `/maintenance` (Back) asks for the list
    no second time.
11. **(Added in framing) Coming back asks again.** Leaving the page and returning (another page, then the nav
    item) asks for the list again (`staleTime: 0`, the `queryFreshness` fitness test), so a status a manager
    changed meanwhile shows.

## Test plan

- `frontend/src/features/maintenance/myMaintenance.test.tsx` (`renderApp`, `stubApi`): criteria 1–7, 9–11
- the shell tests that used `/Maintenance` as "an unmigrated resident page" (`app/building.test.tsx`,
  `app/shell.test.tsx`, `app/nav.test.tsx`) move to another unmigrated page, as P5-04 moved them off `/Packages`,
  keeping each assertion
- `src/test/queryFreshness.test.ts` and `buildingDenial.test.ts` pass with the new hooks and page (no change to
  them)
- Chromium check at 375 px (criterion 8), output in the PR
- `make check DB_PORT=55432`; the page on `make up` with requests filed through the API, transcript in the PR

## Likely files

`frontend/src/features/maintenance/{api.ts,labels.ts,MyMaintenanceList.tsx}`,
`frontend/src/features/maintenance/pages/MyMaintenancePage.tsx`, `frontend/src/app/{pages.ts,routes.tsx}`.
Copy from `features/packages/{api.ts,MyPackageList.tsx,pages/MyPackagesPage.tsx}` and `features/lists/useLoadMore.ts`.

Estimate: ~300 non-test lines (hooks ~60, page ~60, list ~140, status labels ~20, routes and pages ~20).

## Must explain (learning checkpoint)

1. Which server function decides which requests the list shows, and why does the browser not filter again?
2. Why is the page keyed by building, and what would show for a moment without it?
3. Why does the route take `:requestId?` now, before P6-04c needs it?

## Open decisions (resolve while framing)

From the stub: none (the stub names the pages, not their rules).

Left open by the stub:
- **The path.** `/maintenance` (as `/packages`; it differs from `/Maintenance` only in case, so the route answers
  the legacy path itself) is the default, and it must match the link P6-03c's notifications use.
- **The label.** Today "Maintenance requests"; keep it, or "My requests" to tell it apart from the staff page.
- Whether the list offers a status filter for residents (the API takes `status`), or shows all with the status on
  each card (default: all, as `MyPackagesPage` shows waiting and history).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - 1: what each card shows is now exact (labels not enum values, "Unit A-101" or the common-area text, first line
    cut at 120 characters, the photo count wording), and the paging is exact (`limit=25`, the cursor, 26 cards once
    each, the button gone after the last page).
  - 3: the login redirect also from `/maintenance/<id>`; "without asking the maintenance API" made checkable (no
    request to `…/maintenance-requests`); the feature-off case also sends no request; the nav item's link.
  - 4: the denial shows as the "no longer have access" screen.
  - 6: the exact copy, what "Try again" and the failed "Load more" retry do, the 429 text, and where focus goes.
  - 7: the path differs only in case, so the route itself answers it and the URL stays (decision 1).
  - 8: the exact longest values from P6-03a's schema (description 2,000, common area 120), and a failing probe.
  - Added 9 (the missed case): a co-occupant's request shows, and the browser never filters; added 10 (the
    notification link and `/maintenance/<id>` before P6-04c); added 11 (coming back asks again).
  - Test plan: the shell tests that used `/Maintenance` as an unmigrated page move to another one (as in P5-04).
  - `statusLabel.ts` becomes `labels.ts`: the cards also need category labels, and P6-04b's form and P6-04d's
    filters reuse both maps; one file of labels, not two.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis):
  1. **Path `/maintenance`** (the ticket's default). Basis: default, and P6-03c's notifications already link to
     `/maintenance/<id>` (`backend/app/maintenance/service.py`). Alternative `/my/maintenance` lost: the
     notification links would 404 and need a backend change. It differs from `/Maintenance` only in case, so the
     route answers the legacy path (`sameLegacyPath`), as `/packages` does.
  2. **Label "Maintenance requests"** kept for the nav item and the page heading (default: keep what exists). The
     staff page is "Maintenance", so the two still differ. "My requests" lost: it doesn't say what kind.
  3. **No status filter for residents** (the ticket's default, as `MyPackagesPage` shows everything): each card
     carries its status. The hook still takes an optional `status` for P6-04d.
  4. **Tenant rows.** UI side only (no API change): rows 1, 2, 4 in criterion 3, row 3 in criterion 4; row 5 is
     the server's (`visible_maintenance`, proven by P6-03b) and criterion 9 proves the browser adds no filter of
     its own; rows 6–10 don't apply (a read; P6-03b covers pending members).
  5. **A card has no link yet.** P6-04c adds the view and its link; until then `/maintenance/<id>` shows the list
     (criterion 10). Basis: ticket scope.
- Split: none. Estimate ~250 non-test lines (hooks ~40, labels ~30, list ~130, page ~40, pages/routes ~10).

## Follow-ups (from PR #153)

- `features/packages/MyPackageList.tsx`'s "Try again" drops focus to `<body>` the way P6-04a review round 1 F1 found
  here (a failed first page refetches as `pending`, so the button goes): fix it as `MyMaintenanceList`'s `retry` does,
  with the same tests. Carried to [P6-04b](./P6-04b-maintenance-submit-and-cancel.md) as its first follow-up.
- No test isolates `MyMaintenancePage`'s `key={buildingId}` (PR #153 mutation M2): P6-04c, which adds per-request
  state to the page, should add one (a state that must not survive a switch).
