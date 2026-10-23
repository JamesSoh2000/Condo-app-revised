# P5-03b — Package desk page and waiting list

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-03a, P3-06 |
| Replaces old | M7-T03 (page and list part) |
| Status | todo |

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
   (Original P5-03 criterion 5.)

Framing adds the list's criteria (search, filter, empty and failed states, age in the building timezone,
widths) and the tenant rows.

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

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: from P5-03 while framing P5-03a (see P5-03a's Frame notes for the sizing).
