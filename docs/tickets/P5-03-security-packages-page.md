# P5-03 — Security packages page

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-02a, P5-02b, P3-06 |
| Replaces old | M7-T03 |
| Status | todo |

## Goal

Front-desk staff log packages with a photo in under 30 seconds, see what is waiting, and hand packages out.
The new typed page replaces the Base44 `SecurityPackages`.

## Why

This is the front-desk half of journey 4. It is used all day on a tablet, so speed and resilience matter
more than anywhere else.

## Scope

- In (`features/packages/pages/SecurityPackagesPage.tsx`, route `/security/packages`, roles security and
  property_management):
  - **"Log package" panel:**
    - unit combobox (`units_list` search)
    - recipient select (`units_occupants`; "Anyone in unit" as the default)
    - carrier (a quick-pick of common carriers plus "Other"), description, last 4 of tracking (optional)
    - photo via `FileUpload` (`purpose=package_photo`, `capture="environment"`)
  - **Idempotency:** generate a UUID `Idempotency-Key` when the form opens and reuse it for retries of the
    *same* submission. Reset it after success. Show "Logged ✓" and keep the unit field focused for the next
    package.
  - **"Waiting" list:**
    - search by unit and filter by carrier, from `packages_list?status=received`
    - each row has the photo thumbnail (`PrivateImage`), the unit, the recipient and the age ("2 h ago",
      building timezone)
  - **Pickup dialog:** choose an occupant, or type a name, then confirm. A 409 shows "Already picked up (by a
    colleague)" and refreshes.
  - **Return action** with a required reason.
  - **Invalidation:** after create, pickup or return, invalidate the package list and summary keys.
  - Layout works at tablet (768 px) and phone (375 px) widths.
  - Remove legacy `SecurityPackages.jsx` from the routes (and delete it if unused), drop its Base44 email
    calls, and lower the ratchet.
- Out:
  - barcode scanning (a nice later enhancement)
  - bulk logging

## Interfaces

Consumes `units_list`, `units_occupants`, `packages_create`, `packages_list`, `packages_pickup`,
`packages_return`, plus the file components.

## Acceptance criteria

1. **Given** a security user on a tablet viewport, **then** they can log a package with a photo and see it
   appear in "Waiting" without a reload.
2. **Given** a network failure on submit followed by a retry, **then** exactly one package exists (same
   `Idempotency-Key`).
3. **Given** two staff pick up the same package, **then** the second sees the friendly 409 message, and the
   list refreshes.
4. **Given** keyboard only, **then** the full log-package flow completes. The focus order is logical.
5. **Given** the ratchet, **then** the Base44 count drops. No Base44 email or SMS calls remain for packages.

## Test plan

- Vitest for the form validation and idempotency-key lifecycle (mock the client).
- Manual on the local stack with devtools device mode (a real tablet on staging in D-06, if available).
- E2E in P5-05.

## Likely files

`frontend/src/features/packages/{api.ts,pages/SecurityPackagesPage.tsx,components/*}`,
`frontend/src/app/routes.tsx`, `frontend/src/pages/SecurityPackages.jsx` (removed),
`frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. When exactly is a new `Idempotency-Key` generated, and why not on every click?
2. Why invalidate queries instead of manually inserting the new package into the cache?
3. Why show times in the building's timezone rather than the device's?

## Carried from P3-06

- Use `FileUpload` with `purpose="package_photo"`. Send `onUploaded`'s `file_id` to the package endpoint, which
  claims it.
- Show the photo with `<PrivateImage fileId alt>`; it handles refresh, 404 and load errors.
- No route has mounted these components yet: this is their first real page. Run the upload on `make prodlike`
  too (CSP), as P3-06 did with a harness.
- First follow-up still open from P3-05 (`docs/AGENT_MISTAKES_LOG.md`, P3-05 step 8 note): the fitness test that
  every component reading `useBuilding({ passive: true })` also calls `useBuildingDenied()`. P3-06 did not pick
  it up.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
