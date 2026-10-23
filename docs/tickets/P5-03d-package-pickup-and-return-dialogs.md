# P5-03d — Package pickup and return dialogs

| Field | Value |
|---|---|
| Phase / lane | P5 / B |
| Risk tier | 2 |
| Depends on | P5-03b |
| Replaces old | M7-T03 (hand-out part) |
| Status | done |

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
   list refreshes. (Original P5-03 criterion 3.) Sharpened: a 409 `invalid_transition` (or a 404
   `package_not_found`) from either dialog closes it and shows, above the list, "Already picked up or returned by
   a colleague." (focused); every packages query is cancelled and asked again; the dialog never retries.
2. **Pickup dialog.** Each waiting row has "Hand out" for that row's package. The dialog names the unit and
   offers, as one radio group: the package's named recipient (if any), the unit's current occupants
   (`units_occupants`, without repeating the recipient), and "Someone else" with a name field. Confirm sends
   exactly one of `picked_up_by_membership_id` and `picked_up_by_name` (trimmed). Nothing chosen, a blank name, a
   control character, or more than 120 code points is refused in the dialog with a message and sends nothing.
   The occupants' loading and failure (with Try again) are shown; "Someone else" works without them.
3. **Return dialog.** Each waiting row has "Return". The reason is required: blank, a control character, or
   more than 300 code points is refused in the dialog and sends nothing; the trimmed reason is sent.
4. **Refusals that keep the dialog open:** 422 `invalid_pickup_member` removes that person from the choices,
   asks for the occupants again, and says "That person can't collect this package now. Choose someone else or
   type a name."; a 422 on the name or reason shows under its field; a 429 shows the rate-limit message; any
   other failure says "Could not … Try again." and keeps what was typed.
5. **Success** closes the dialog, shows "Unit X's package was handed to NAME." / "Unit X's package was marked
   returned." (focused, since the row leaves), and refreshes the packages queries.
6. **Invalidation:** after pickup or return, however it ends (success, refusal, network error: a lost answer may
   have been applied), every query under `['b', buildingId, 'packages']` (the waiting list, and the summary
   when a page reads it) is cancelled and then invalidated.
7. **One request per confirmation:** a second click in the same tick sends nothing; Cancel, Escape and the
   buttons are disabled while it is out; Escape or Cancel returns focus to the row's button.
8. **The dialog keeps the package it was opened with:** a list refresh that drops the row leaves the dialog as it
   was; the server's answer (criterion 1) then says what happened. Switching building unmounts it (the page is
   keyed by building); a `building_not_found` marks the building denied (mutation keyed by building).
9. **Layout:** at 768 px and 375 px in Chromium, with a 120-character unbroken name, a 300-character unbroken
   reason and the longest unit/recipient names, neither dialog nor the row's buttons overflow the viewport
   horizontally; controls are at least 44 px tall.

Tenant table (`docs/ENGINEERING_PRACTICES.md` §7): the endpoints are P5-02b's and already carry rows 1–10
(`backend/tests/packages/test_transitions.py`, `test_concurrency.py`). This ticket adds no endpoint; rows 8 and 10 are the UI's
criterion 1, row 3/6 the building-denied path in criterion 8.

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

- Criteria added or sharpened: criterion 1 sharpened (which codes, the exact message, focus, cancel then
  invalidate, no retry; the message covers a return too, since a 409 doesn't say which transition won).
  Added 2–9 from the scope bullets and the cases the ticket missed: the named recipient who has moved out but may
  still collect (P5-02b's `_check_pickup_member`), 422 `invalid_pickup_member`, Unicode length (code points, as
  Pydantic counts), invalidation after a failure, double submit, a refresh dropping the row under an open dialog,
  building switch, and the 375 px lesson with the API's longest values.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Reuse the residents `Modal` (focus trap, Escape) rather than the legacy `components/ui/dialog.jsx` (CLAUDE.md
    rule 12: new code TypeScript, don't extend legacy). Basis: convention (P4-08b–e dialogs).
  - One 409 message for both dialogs, "Already picked up or returned by a colleague.": the 409 body doesn't say
    the current status, and reading it from `detail` text would parse a human string. Basis: autonomous.
  - No preselected choice in the pickup dialog: handing a package to the wrong person is worse than one more
    click. Basis: autonomous.
  - Who collected and the return reason stay out of `PackageOut` (ticket "Out"); no API change.
- Sizing: ~380 non-test lines (pickup dialog ~180, return dialog ~100, list rows and host ~60, api ~25, a
  `maxLength` prop on the residents `ReasonField`), measured against `DecisionDialog.tsx` (154) and
  `TransferDialog.tsx` (116). Under ~400: no split.
- Split: from P5-03 while framing P5-03a (see P5-03a's Frame notes for the sizing).
