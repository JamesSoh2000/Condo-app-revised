# P6-04e — Maintenance cancel from the resident's list

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04b, P6-03e |
| Replaces old | M8-T02 (cancel part) |
| Status | todo |

Split from [P6-04b](./P6-04b-maintenance-submit-and-cancel.md) while it was being built: the whole of P6-04b measured
~750 non-test lines. Its criterion 7, criterion 8's dialog part and criterion 9's dialog part are this ticket's.

## Draft to start from

An unreviewed implementation written during P6-04b is on the local branch `p6-04-photos-cancel-draft` (commit
`71e043c`): `frontend/src/features/maintenance/CancelDialog.tsx`, `useCancelMaintenance` in `api.ts`, the card button in
`MyMaintenanceList.tsx`, the page's dialog owner, and `frontend/src/features/maintenance/cancel.test.tsx` with
`frontend/src/test/maintenance.ts`'s cancel route (17 tests, green there). Re-frame against `main`, which by then has
P6-04b's form; the draft is a starting point, not reviewed code.

## Goal

A resident cancels their own request while it is still `submitted`, from its card on `/maintenance`.

## Scope

- In: a confirm dialog (`features/residents/Modal.tsx`) on a `submitted` request the caller filed (P6-03b's rule:
  `requester_membership_id` is the caller's membership here), one `maintenance_cancel` per confirm, the card updated
  from the response and the list refreshed (cancel, then invalidate `maintenanceKey` `onSettled`).
- Out: cancelling from the request view (P6-04c reuses the dialog); manager actions (P6-04d).

## Acceptance criteria

1. **Given** a `submitted` request of the caller, **when** they confirm cancel, **then** one request is sent, the card
   shows "Cancelled" from the response at once, a status says "Request cancelled." and focus goes to the card (the
   button that opened the dialog is gone). A double press sends one request.
2. **Given** a 409 `invalid_transition` or 404 `maintenance_request_not_found` (a manager started it meanwhile),
   **then** the dialog says "It was already started or cancelled.", keeps only Close and refreshes the list; a 403
   `not_requester` says only the resident who filed it can cancel it. Close returns focus to the opener if it is
   still there, else to the card.
3. **Given** a 429, a 500 or a network failure, **then** the dialog says so (429 with its wait), the alert takes focus,
   and both buttons stay so it can be tried again.
4. "Keep request" and Escape close the dialog, return focus to the opener and send nothing; the dialog opens with
   focus on "Keep request".
5. A co-occupant's `submitted` request and the caller's own request in any other status have no button.
6. **Switching building** with the dialog open closes it and sends no cancel.
7. **375 px in Chromium** with the longest description (2,000 characters, one word) and the longest common area, the
   dialog stays inside the viewport.

## Test plan

- `frontend/src/features/maintenance/cancel.test.tsx`: criteria 1–6
- Chromium at 375 px and focus after confirm and Close (criteria 1, 2, 7), output in the PR
- `make check DB_PORT=55432`; on the stack, file a request and cancel it, transcript in the PR

Estimate: ~190 non-test lines (dialog ~105, hook ~30, card button ~15, page ~40), measured from the draft.

## Must explain (learning checkpoint)

1. Why does the card change to "Cancelled" before the list's refresh answers, and what makes that safe?
2. Where does focus go after each way the dialog closes, and why there?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis):
- Split:
