# P6-04a — Maintenance hooks and the resident's request list

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03b |
| Replaces old | M8-T02 (list part) |
| Status | todo |

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

1. **Given** `a_resident1` with three requests in different statuses, **when** they open the page, **then** three
   cards show in the API's order, each with its status as text (not colour alone), category, location and
   submit time; with 26 requests, "Load more" fetches the next page without repeating or skipping a card.
2. **Times.** `2026-03-15T23:30:00Z` in an `America/Toronto` building shows as Mar 15, 2026, 7:30 PM in the
   building's locale, not the device's zone (as P5-04 criterion 4).
3. **Access (tenant rows 1, 2, 4).** A resident opens the page; a signed-out user goes to login with the way back;
   security, property management and council-only members get `/403` without asking the maintenance API; a
   building with `maintenance` off gives `/403` and its nav has no item. A council + resident member opens it.
4. **Tenant row 3, UI side.** The page asks only the selected building's `/api/buildings/{id}/maintenance-requests`
   URLs, and a `building_not_found` marks the building denied (`app/buildingDenial.ts`; a passive reader also
   reads `useBuildingDenied()`, `src/test/buildingDenial.test.ts`).
5. **Switching building.** With the page open in A, choosing building B shows only B's requests: nothing of A's
   shows while B's load (the page is keyed by building).
6. **States.** Loading, empty, a failed first page (with "Try again") and a failed "Load more" (the cards stay,
   with a message and a retry) each render; a 429 says to wait, as the other lists do.
7. **Legacy path.** `/Maintenance` reaches the new page (`app/routes.tsx::LegacyRedirect`, query and hash kept),
   or is answered by the route itself if framing picks a path that differs only in case (`sameLegacyPath`).
8. **375 px in Chromium** with the API's longest values (P6-03a's `description` and common-area lengths, a word
   without spaces), nothing is wider than the viewport.

## Test plan

- `frontend/src/features/maintenance/myMaintenance.test.tsx` (`renderApp`, `stubApi`): criteria 1–7
- `src/test/queryFreshness.test.ts` and `buildingDenial.test.ts` pass with the new hooks and page (no change to
  them)
- Chromium check at 375 px (criterion 8), output in the PR
- `make check DB_PORT=55432`; the page on `make up` with requests filed through the API, transcript in the PR

## Likely files

`frontend/src/features/maintenance/{api.ts,statusLabel.ts,MyMaintenanceList.tsx}`,
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
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
