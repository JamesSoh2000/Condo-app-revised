# P5-03d — Package pickup and return dialogs

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-03b |
| Replaces old | M7-T03 (hand-out part) |
| Status | todo |

Split from the original P5-03 (Security packages page) while framing P5-03a. The page and the "Waiting"
list are [P5-03b](./P5-03b-package-desk-page-and-waiting-list.md).

## Goal

Front-desk staff hand packages out, or send them back, from the "Waiting" list.

## Why

Two desks can reach for the same package; the second must learn it's gone, not see an error.

## Scope

- In (on the "Waiting" list's rows):
  - **Pickup dialog:** choose an occupant, or type a name, then confirm. A 409 shows "Already picked up (by a
    colleague)" and refreshes.
  - **Return action** with a required reason.
  - **Invalidation:** after pickup or return, invalidate the package list and summary keys.
  - Layout works at tablet (768 px) and phone (375 px) widths.
- Out:
  - showing who collected a package or the return reason (not in `PackageOut`; see the P5-02b carry)

## Interfaces

Consumes `units_occupants`, `packages_pickup`, `packages_return`.

## Acceptance criteria

1. **Given** two staff pick up the same package, **then** the second sees the friendly 409 message, and the
   list refreshes. (Original P5-03 criterion 3.)

## Test plan

- Vitest for the dialogs' validation and refusals (mock the client).
- Manual on the local stack with devtools device mode.
- E2E in P5-05.

## Likely files

`frontend/src/features/packages/{api.ts,components/PickupDialog.tsx,components/ReturnDialog.tsx}`.

## Carried from P5-02b

From PR #115: `POST …/packages/{id}/pickup` takes exactly one of `picked_up_by_membership_id` (the recipient
or an active current occupant of the unit, else 422 `invalid_pickup_member`) and `picked_up_by_name`
(1–120 characters); `POST …/{id}/return` takes `reason` (1–300). Both answer 409 `invalid_transition` when
the package is no longer `received` (another desk got there first): refresh the list, don't retry.
`PackageOut` doesn't return who collected a package or the return reason; if the page shows them, add them
to `PackageOut` here (staff-only fields need care: residents read `PackageOut` too).

## Carried from P5-03c

- The P3-05 fitness test (every component under `src/app` or `src/features` that reads
  `useBuilding({ passive: true })` also calls `useBuildingDenied()`) is still open; P5-03b and P5-03c did not pick
  it up. As worded it fails on `app/AccountMenu.tsx::BuildingChoices`, so it needs either that component changed
  or an exemption with a reason.
- A dialog that submits while a `FileUpload` is inside it passes `disabled` while the request is out (PR #118 R1
  F1); `onStatusChange` tells the form an upload is still running.
- The `CLAUDE.md` lesson on 375 px widths applies to the dialogs: measure with the longest names and reasons the
  API allows (120-character pickup name, 300-character return reason).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: from P5-03 while framing P5-03a (see P5-03a's Frame notes for the sizing).
