# P6-04b — Maintenance submit form with photos, and cancel

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04a, P6-03b, P6-03e, P3-06 |
| Replaces old | M8-T02 (submit part) |
| Status | todo |

Split from the P6-04 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-04a](./P6-04a-resident-maintenance-list.md), before [P6-04c](./P6-04c-maintenance-request-view.md), which reuses
its emergency copy.

## Carried from P6-04a (first follow-up; do while framing)

- A failed first page's "Try again" must keep focus (P6-04a review round 1 F1): the form's and the list's retries
  here follow `MyMaintenanceList`'s `retry`. Also fix `features/packages/MyPackageList.tsx`'s "Try again", which has
  the same drop, with the same tests (`frontend/src/features/maintenance/myMaintenance.test.tsx` "review round 1"),
  or split it out if it doesn't fit.

## Goal

A resident submits a maintenance request from the maintenance page (category, description, their unit or a
common area, photos), sees the building's emergency phone when the category is `emergency`, and cancels a
request that is still `submitted`. The legacy `Maintenance` page is gone.

## Why

Journey 6 starts here ("A resident submits a request with a photo", `docs/PRODUCT_SCOPE.md`). It is the first
resident form in the app that uploads several files and names a unit, and the emergency copy is a safety text:
the app must say to call, never imply that submitting alerted anyone (P6-03b criterion 7).

## Scope

- In (`frontend/src/features/maintenance/`):
  - **submit form** (a panel or dialog on the P6-04a page, as framing picks): location (`unit`, which is the
    resident's current unit from `/me`'s occupancy, or `common_area` with P6-03b's detail field), category (the
    generated `MaintenanceCategory` values with labels), description (P6-03a's `max_length`, counted as the server
    counts), and 0 to P6-03a's limit of photos, each through `features/files/FileUpload.tsx` with purpose
    `maintenance_photo` (one control per photo, or a list that adds one; `FileUpload` takes one file)
  - one `maintenance_create` per submit (a second press while it is out sends nothing), with the
    `Idempotency-Key` header if P6-03b takes it (one key per form fill, reused on retry); the submit stays
    disabled while a photo uploads
  - errors as messages on the form: 422 field errors (`features/auth/formErrors.ts`), the unit-not-occupied code,
    `invalid_file`, `file_not_found`, 429, any other failure; the form keeps what was typed and the photos
  - **emergency copy**: choosing `emergency` shows a fixed text before submit: the request does not alert anyone,
    call the emergency services or building staff now. After the 201, the same text with the building's
    `emergency_phone` from the response (P6-03b returns it only on an emergency request) stays on screen until
    dismissed. Showing the phone before submit needs a source P6-03b doesn't define (see "Open decisions")
  - **cancel**: a confirm dialog on a `submitted` request the caller may cancel (P6-03b's rule), one
    `maintenance_cancel` per confirm, 409 `invalid_transition` turned into a message ("It was already started or
    cancelled"), then the list refreshed (cancel, then invalidate the domain key `onSettled`)
  - delete `src/pages/Maintenance.jsx` and lower `frontend/base44-baseline.txt` to `scripts/base44-count.sh`
- Out: the request view and comments (P6-04c); manager actions (P6-04d); editing a request (no API)

## Interfaces

Consumes `maintenance_create` (`POST …/maintenance-requests`, body `MaintenanceRequestCreate`, 201
`MaintenanceRequestOut`), `maintenance_cancel` (`POST …/{id}/cancel`), `files_create`/`files_complete` through
`FileUpload`, and `/api/auth/me`'s occupancy for the unit. The field names, limits and error codes are P6-03a/b's
merged ones (`frontend/src/api/schema.d.ts`).

## Acceptance criteria

1. **Given** `a_resident1` (tenant in 101), **when** they fill the form for their unit with two photos and
   submit, **then** one request is sent with the photos' file ids in order, the new request shows at the top of
   the list, and focus moves to the outcome message (the submit button that disabled itself would drop it to
   `<body>`; the CLAUDE.md lesson).
2. **Given** a double press, or Enter then a press, **then** exactly one `maintenance_create` is sent; with
   `Idempotency-Key`, a retry after a network failure sends the same key and body.
3. **Given** a photo still uploading, **then** submit is disabled and says why; a failed upload can be removed or
   retried without losing the other fields.
4. **Given** each documented error (422 per field, the unit not occupied, `invalid_file`, `file_not_found`, 429, a
   500, a network failure), **then** a message says what to do, the alert takes focus, and the typed values and
   photos remain.
5. **Given** a resident with no current occupancy (P6-03b criterion 2), **then** the unit choice is absent and
   only a common-area request can be filed (or the form says why none can, as P6-03b decides).
6. **Emergency.** **Given** `emergency` chosen, **then** the fixed text shows before submit, and after the 201 the
   text with the response's `emergency_phone`; with no phone set for the building (`null`), the text says to call
   the emergency services and building staff directly; nothing on screen says the building was notified.
7. **Cancel.** **Given** a `submitted` request of the caller, **when** they confirm cancel, **then** one request is
   sent and it shows as cancelled; a 409 (a manager started it meanwhile) shows the message, keeps the dialog open
   and refreshes the list; Cancel and Escape return focus to the opener; a request the caller may not cancel has no
   button.
8. **Switching building** with the form or dialog open closes it, and nothing typed in A is submitted to B.
9. **375 px in Chromium** with the longest description, a 255-character photo file name and the longest
   common-area detail, the form, the emergency text and the dialog stay inside the viewport.
10. The legacy `Maintenance.jsx` is deleted and the ratchet lowered.

## Test plan

- `frontend/src/features/maintenance/submit.test.tsx`: criteria 1–8
- `frontend/src/features/maintenance/cancel.test.tsx`: criterion 7
- Chromium check at 375 px and focus after submit and cancel (criteria 1, 7, 9), output in the PR
- `make check DB_PORT=55432`; on `make up`, submit with a photo and cancel, transcript in the PR

## Likely files

`frontend/src/features/maintenance/{SubmitRequestForm.tsx,PhotoList.tsx,EmergencyNotice.tsx,CancelDialog.tsx,
api.ts,categoryLabel.ts}`, `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx`,
`frontend/src/pages/Maintenance.jsx` (deleted), `frontend/base44-baseline.txt`. Copy from
`features/packages/LogPackageForm.tsx`, `PackageDialog.tsx::usePackageSubmit`, `features/residents/Modal.tsx`.

Estimate: ~390 non-test lines (form ~200 against `LogPackageForm.tsx` 292 without its unit search, photo list
~60, emergency copy ~30, cancel dialog ~70 against `ReturnDialog.tsx` 63, hooks ~30). If the photo list needs its
own upload queue, move cancel to a ticket of its own (P6-04c is at its limit).

## Must explain (learning checkpoint)

1. Where does the unit a resident files for come from, and what does the server check again?
2. How does the form send exactly one request for a double press, and what makes a retry safe?
3. What does the emergency text promise, and why does it promise nothing more?

## Open decisions (resolve while framing)

From the stub ("Decide while framing", carried through P6-03b):
- **Emergency category behaviour.** Stub default: **show the building's emergency phone, and never rely on the
  app.** The exact copy is decided here (fixed text, no promise of an alert). Default: the phone after the 201 (the
  only place P6-03b returns it). Showing it **before** submit needs P6-03b (or a small API change here) to expose
  it on the building (`BuildingOut` or the feature's config); if framing takes that, it is in scope and costed.

Left open by the stub:
- the form as a panel on the page (as `LogPackageForm`) or a dialog
- the category labels (the values are P6-03a's)
- whether the form remembers an unsent draft across a reload (default: no)

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
