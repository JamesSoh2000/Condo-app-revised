# P5-03b — Package desk page and waiting list

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-03a, P3-06 |
| Replaces old | M7-T03 (page and list part) |
| Status | in progress |

Split from the original P5-03 (Security packages page) while framing P5-03a. This part is the page, its
route and the "Waiting" list, and retires the legacy page. The "Log package" panel is
[P5-03c](./P5-03c-log-package-panel.md); pickup and return are
[P5-03d](./P5-03d-package-pickup-and-return-dialogs.md); the API fields are
[P5-03a](./P5-03a-package-desk-read-fields.md).

## Goal

Front-desk staff see what is waiting, at a glance, on a tablet. The new typed page replaces the Base44
`SecurityPackages`.

## Why

This is the front-desk half of journey 4. It is used all day on a tablet, so speed and resilience matter
more than anywhere else.

## Scope

- In (`features/packages/pages/SecurityPackagesPage.tsx`, route `/security/packages`, roles security and
  property_management):
  - **"Waiting" list:**
    - search by unit and filter by carrier, from `packages_list?status=received` (`unit_id` and `carrier`,
      P5-03a)
    - each row has the photo thumbnail (`PrivateImage`), the unit, the recipient and the age ("2 h ago",
      building timezone)
  - Layout works at tablet (768 px) and phone (375 px) widths.
  - Remove legacy `SecurityPackages.jsx` from the routes (and delete it if unused), drop its Base44 email
    calls, and lower the ratchet.
- Out:
  - logging (P5-03c), pickup and return (P5-03d)
  - barcode scanning (a nice later enhancement)
  - bulk logging

## Interfaces

Consumes `units_list`, `packages_list` (with `unit_tower`, `unit_label`, `recipient_name`, `?carrier=`),
plus `PrivateImage`.

## Acceptance criteria

1. **Given** the ratchet, **then** the Base44 count drops. No Base44 email or SMS calls remain for packages.
   (Original P5-03 criterion 5.) Sharpened: `src/pages/SecurityPackages.jsx` is deleted (nothing imports it),
   `frontend/base44-baseline.txt` is lowered to the new count in this PR, and no file under `frontend/src` that
   mentions packages calls `SendEmail` or `SendSMS` (evidence: `scripts/base44-count.sh` and the grep, pasted in
   the PR).
2. **Route and access (tenant rows 1, 2, 4).** `/security/packages` renders the page for a member with the
   `security` or `property_management` role in the selected building when it has the `packages` feature; a
   resident, or a building with `packages` off, gets `/403`; signed out goes to the login page and back. The
   nav's "Package log" links to `/security/packages`. The legacy `/SecurityPackages` path redirects there
   (replace, query kept), so a bookmark still works and still gets `/403` for a resident.
3. **Waiting list.** The page asks `GET /api/buildings/{id}/packages?status=received` and shows the packages in
   the order the API returns (newest first), one row each, with:
   - the photo thumbnail through `PrivateImage` (alt "Package photo for unit <unit>"), or a "No photo" box when
     `photo_file_id` is null;
   - the unit as `<tower>-<label>` (`unitName`), or the label alone without a tower;
   - the recipient's name, or "Anyone in the unit" when the package is addressed to the unit
     (`recipient_membership_id` null);
   - the carrier, and the description when there is one;
   - the age ("just now" under a minute, then "N min ago", "N h ago", "N d ago", whole units rounded down; a
     `received_at` in the future reads "just now") and the received date and time.
4. **Building time.** The received date and time are formatted in the building's `timezone` and `locale`, never
   the device's: a package received at 23:30 UTC in a `Asia/Tokyo` building shows the next calendar day. The age
   moves on while the page stays open (re-rendered at least once a minute) without a new request.
5. **Search by unit.** A "Unit number" search lists the building's active units starting with the typed text
   (`units_list?search=`, the residents `UnitPicker`); choosing one asks the list again with `unit_id=<id>`;
   "All units" clears it and typing a new search drops the choice (the list goes back to every unit).
   Control characters show "Search with visible characters only." and send nothing.
6. **Filter by carrier.** A "Carrier" select ("All carriers", then Amazon, Canada Post, DHL, FedEx, Purolator,
   UPS) sends `carrier=<value>`; it combines with the unit filter. Each filter combination starts from its
   first page (a cached earlier visit's pages are not all fetched again).
7. **States.** Loading shows "Loading packages…" (`role=status`). An empty answer shows "No packages are
   waiting." without filters and "No waiting packages match." with any. A failed first load shows an alert
   "Could not load the packages." with "Try again" (which asks again); a failed refresh keeps the rows and
   shows "Could not refresh the packages."; a 429 shows the shared rate-limit message. `next_cursor` shows a
   "Show more" button; a failed next page shows "Could not load more packages." and keeps the rows.
8. **Freshness (ADR-0012).** The list is asked again on every mount (the `queryFreshness` fitness test), on
   window focus and from a "Refresh" button; it does not poll. Its keys start `['b', buildingId, 'packages']`
   so P5-03c/d can invalidate them.
9. **Another building (tenant row 3).** A `404 building_not_found` on the list closes the building like any
   building request (the shared denial), and nothing of one building's list shows after switching to another
   (keys carry the building ID).
10. **Widths.** At 375 px and 768 px in Chromium the page has no horizontal scroll (`scrollWidth ≤
    clientWidth`), the filters stay usable and long names, descriptions and carriers wrap (evidence: a
    Playwright run on `make prodlike`, which also shows `PrivateImage` loading a seeded photo under the
    production CSP, or the seed's photo-less rows if the seed has no photo).
11. **Added case: an unreadable photo.** A photo the user may not see (the download URL answers 404) shows
    `PrivateImage`'s "Image unavailable" box in its row; the rest of the row and the list still render.

Tenant rows 5–10 are not this ticket's: the page writes nothing, and record visibility, related IDs and the
filters' tenancy are enforced and tested server-side (P5-02a, P5-03a).

## Test plan

- Vitest for the list's filters and states (mock the client).
- Manual on the local stack with devtools device mode (a real tablet on staging in D-06, if available).
- E2E in P5-05.

## Likely files

`frontend/src/features/packages/{api.ts,pages/SecurityPackagesPage.tsx,components/*}`,
`frontend/src/app/{routes.tsx,pages.ts,routeScope.ts}`, `frontend/src/pages/SecurityPackages.jsx` (removed),
`frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. Why show times in the building's timezone rather than the device's?

## Carried from P3-06

- Show the photo with `<PrivateImage fileId alt>`; it handles refresh, 404 and load errors.
- No route has mounted these components yet: this is their first real page. Run it on `make prodlike`
  too (CSP), as P3-06 did with a harness.
- First follow-up still open from P3-05 (`docs/AGENT_MISTAKES_LOG.md`, P3-05 step 8 note): the fitness test that
  every component reading `useBuilding({ passive: true })` also calls `useBuildingDenied()`. P3-06 did not pick
  it up.

## Carried from P5-03a

The list reads `unit_tower`, `unit_label` and `recipient_name` (null for a package addressed to the unit)
from `PackageOut`, and filters with `?unit_id=` and `?carrier=` (case-insensitive). See P5-03a's
explanation for what was and wasn't verified.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: criterion 1 sharpened (the file is deleted, the baseline lowered, a grep for
  package email/SMS); criteria 2–11 added from the framing instruction (search, filter, empty and failed
  states, age in the building timezone, widths, tenant rows 1–4) and one missed case (11, an unreadable photo).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - The page's path is `/security/packages` (ticket), set as `PAGE_ACCESS.SecurityPackages.path` like
    `Residents` (convention, P4-08b); the legacy `/SecurityPackages` redirects to it so old links work
    (autonomous, reversible).
  - Unit search reuses the residents `UnitPicker` (active units, prefix search) rather than a new combobox
    (simplest, matches existing code; autonomous). A package still waiting on a unit deactivated after it was
    logged is shown under "All units" only.
  - The carrier filter is a select of the six carriers the seed and the legacy desk use; a package logged with
    another carrier (P5-03c's "Other") shows under "All carriers" only (the API matches the whole carrier;
    a free-text filter would match nothing until fully typed). P5-03c can reuse the list for its quick-pick.
  - Freshness follows ADR-0012 (lists refetch on mount, focus and after mutations; no polling), plus a
    "Refresh" button for a tablet that stays in the foreground all day (autonomous).
  - Not picked up: the P3-05 fitness-test follow-up ("Carried from P3-06"). As worded it fails today on
    `app/AccountMenu.tsx::BuildingChoices`, outside this ticket, and this page renders only under
    `BuildingLoaded`, which already gates on the shared denial. Carried on to P5-03c.
- Estimate: ~330 non-test lines (page and list ~200, measured against `residents/Members.tsx` at 281 for a
  filtered, paged list with states; hooks and age/time helpers ~70; routes, pages and nav ~20; the legacy
  page's 971 lines are deleted, not counted). No split.
- Split: from P5-03 while framing P5-03a (see P5-03a's Frame notes for the sizing).
