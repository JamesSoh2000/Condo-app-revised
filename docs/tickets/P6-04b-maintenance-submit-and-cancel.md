# P6-04b — Maintenance submit form and the emergency text

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04a, P6-03b, P6-03e |
| Replaces old | M8-T02 (submit part) |
| Status | in progress |

Split from the P6-04 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-04a](./P6-04a-resident-maintenance-list.md), before [P6-04c](./P6-04c-maintenance-request-view.md), which reuses
its emergency copy.

## Carried from P6-04a (first follow-up; do while framing)

- A failed first page's "Try again" must keep focus (P6-04a review round 1 F1): the form's and the list's retries
  here follow `MyMaintenanceList`'s `retry`. Also fix `features/packages/MyPackageList.tsx`'s "Try again", which has
  the same drop, with the same tests (`frontend/src/features/maintenance/myMaintenance.test.tsx` "review round 1"),
  or split it out if it doesn't fit.

**Split while building (2026-10-29):** photos moved to [P6-04f](./P6-04f-maintenance-photos.md) and cancel to
[P6-04e](./P6-04e-maintenance-cancel-ui.md); see the Frame notes' "Split". The text below keeps the original
criteria, each moved part marked.

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

1. **Given** `a_resident1` (tenant in 101), **when** they fill the form for their unit ~~with two photos~~ (photos:
   P6-04f criterion 1) and submit, **then** one request is sent ~~with the photos' file ids in order~~, the new request shows at the top of
   the list, and focus moves to the outcome message (the submit button that disabled itself would drop it to
   `<body>`; the CLAUDE.md lesson).
2. **Given** a double press, or Enter then a press, **then** exactly one `maintenance_create` is sent; with
   `Idempotency-Key`, a retry after a network failure sends the same key and body.
3. *(Moved to P6-04f criteria 2–3.)* **Given** a photo still uploading, **then** submit is disabled and says why; a failed upload can be removed or
   retried without losing the other fields.
4. **Given** each documented error (422 per field, the unit not occupied, `invalid_file` and `file_not_found` (moved to
   P6-04f criterion 4), 429, a
   500, a network failure), **then** a message says what to do, the alert takes focus, and the typed values and
   photos remain.
5. **Given** a resident with no current occupancy (P6-03b criterion 2), **then** the unit choice is absent and
   only a common-area request can be filed (or the form says why none can, as P6-03b decides).
6. **Emergency.** **Given** `emergency` chosen, **then** the fixed text shows before submit, and after the 201 the
   text with the response's `emergency_phone`; with no phone set for the building (`null`), the text says to call
   the emergency services and building staff directly; nothing on screen says the building was notified.
7. *(Moved to P6-04e criteria 1–5.)* **Cancel.** **Given** a `submitted` request of the caller, **when** they confirm cancel, **then** one request is
   sent and it shows as cancelled; a 409 (a manager started it meanwhile) shows the message, keeps the dialog open
   and refreshes the list; Cancel and Escape return focus to the opener; a request the caller may not cancel has no
   button.
8. **Switching building** with the form ~~or dialog~~ (dialog: P6-04e criterion 6) open closes it, and nothing typed in A is submitted to B.
9. **375 px in Chromium** with the longest description ~~, a 255-character photo file name~~ (P6-04f criterion 6) and
   the longest common-area detail, the form and the emergency text ~~and the dialog~~ (P6-04e criterion 7) stay inside
   the viewport.
10. The legacy `Maintenance.jsx` is deleted and the ratchet lowered.

## Test plan

- `frontend/src/features/maintenance/submit.test.tsx`: criteria 1–8
- ~~`frontend/src/features/maintenance/cancel.test.tsx`: criterion 7~~ (P6-04e)
- Chromium check at 375 px and focus after submit (criteria 1, 9), output in the PR
- `make check DB_PORT=55432`; on the stack, submit a unit and an emergency request, transcript in the PR (photo and
  cancel runs: P6-04f, P6-04e)

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
  - **1** sharpened: the form is a panel opened by a "New request" button above the list; after the 201 the panel
    closes, an outcome message ("Your request was submitted.") takes focus, and the list is refreshed (cancel, then
    invalidate `maintenanceKey`, as `useLogPackage`). Closing the panel without submitting ("Close") returns focus
    to "New request".
  - **2** sharpened: the guard is a ref taken before anything else (as `usePackageSubmit`), so a second press in the
    same tick sends nothing. P6-03b takes `Idempotency-Key` (8–80 visible ASCII): one `crypto.randomUUID()` per
    opened form, reused by every retry of it. Added: a 201 with `Idempotent-Replayed: true` is a success like any
    201; a 409 `idempotency_key_reused` (the key's first attempt landed with other details) says so, points at the
    list, refreshes it, and gives the form a new key while keeping what was typed.
  - **3** sharpened: "says why" is a visible text tied to the submit by `aria-describedby`. A failed upload's row
    keeps `FileUpload`'s Retry and gets a Remove button; pressing submit with a failed or empty-chosen row is refused
    with a message on the photos ("Retry it or remove it"). Added: at most 5 photos (`MAX_PHOTOS`): "Add a photo"
    is disabled at 5 and says so; photo ids are sent in row order, only `ready` rows.
  - **4** sharpened: the documented create errors are 422 `validation_error` (placed on `description` /
    `common_area` / `category` when `serverFieldErrors` can, else a form message), 422 `unit_not_occupied`, 404
    `unit_not_found`, 409 `unit_inactive`, 409 `occupancy_changed` (each: a message on the location, and `/me` asked
    again), 422/409 `invalid_file`, `file_not_found`, `upload_incomplete` (a message on the photos), 429 (with its
    wait), a 500 and a network failure (a form message saying the details are kept). Added client checks that
    mirror `MaintenanceRequestCreate`: a description is required after the strip, at most 2,000 code points, and
    holds no control character except tab and line breaks; a common area is required, at most 120 code points, no
    control character.
  - **5** sharpened: with no `occupancy` on `/me`'s membership for this building, the unit choice is absent and the
    form says "You have no unit on file in this building, so you can report a common-area problem only." P6-03b
    lets such a resident file a common-area request, so the form is still offered.
  - **6** unchanged in substance; the fixed text is in `EmergencyNotice.tsx` and the test asserts that no text on
    screen contains "notified", "alerted" or "sent to" next to the emergency copy.
  - **7** sharpened: the button shows on a card only when `status` is `submitted` and `requester_membership_id` is
    the caller's membership in this building (a co-occupant's submitted request and the caller's own `in_progress`
    one have none). Confirm on 200: the card shows "Cancelled" from the response at once (the cached item is
    replaced), the list is refreshed, a status says "Request cancelled.", and focus goes to the card (the button
    that opened the dialog is gone). Added: 404 `maintenance_request_not_found` and 403 `not_requester` end like the
    409 (message, list refreshed); after any of them the dialog keeps only "Close", and closing it returns focus to
    the opener if it is still there, else to the card. 429 and other failures keep the dialog with a message.
  - **8** sharpened: the page is keyed by building (P6-04a); the test opens the form, types, switches building and
    checks that the form is closed in B and that no `maintenance_create` reaches either building.
  - Added (carried from P6-04a): `MyPackageList`'s "Try again" keeps focus as `MyMaintenanceList`'s now does; the
    retry logic moves into a shared `features/lists/useFocusedRetry.ts` that both lists use, with the P6-04a tests
    kept and the same tests added for the packages list.
- Tenant table (`docs/ENGINEERING_PRACTICES.md` §7): this ticket adds no endpoint; the server rows are P6-03b's. The
  rows that apply to the browser: building switch (criterion 8), another member's record (criterion 7's no-button
  case), and a membership with no occupancy (criterion 5).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis):
  - **Panel, not dialog** (open decision; autonomous, convention): an inline panel as `LogPackageForm`, opened by
    "New request". A dialog would trap focus around a long form with five file controls and scroll inside a 375 px
    viewport; the panel uses the page's own scroll. The cancel confirmation is a dialog (`Modal`), as the ticket says.
  - **Emergency phone after the 201 only** (open decision; stub default): no API change. Before submit the fixed
    text says to call the emergency services or building staff now.
  - **Category labels** (open decision): P6-04a's `CATEGORY_LABEL`, in its order, in a `<select>` (8 options; radio
    chips would wrap into a tall block at 375 px).
  - **No draft across reload** (open decision; stated default).
  - **Unit pre-selected** when the resident has one (autonomous): most requests are for the unit; the common-area
    radio is one press away.
  - **Review route** (James, in-session 2026-10-29): the review rounds run as a fresh Codex `gpt-6.1-sol` session at
    high effort through the `codex-review` skill, instead of a fresh Claude reviewer; no Claude reviewer is spawned.
- Split (2026-10-29, while building; the framing estimate of ~420 was wrong): the full implementation measured ~750
  added non-test lines (form 288, photo list 124, cancel dialog 107, page 103, hooks 55, shared retry 34, list 49).
  Without cancel it was still ~560, so both moved: cancel to [P6-04e](./P6-04e-maintenance-cancel-ui.md) (criterion
  7, criterion 8's dialog, criterion 9's dialog) and photos to [P6-04f](./P6-04f-maintenance-photos.md) (criterion 1's
  photos, 3, criterion 4's file errors, criterion 9's file name). P6-04b keeps the form, the emergency copy, the
  carried retry fix and the legacy delete (426 added non-test lines, ~24 of them moved from `MyMaintenanceList`). The
  draft of both parts is kept on the local branch `p6-04-photos-cancel-draft` (`71e043c`), unreviewed. No criterion
  is loosened: each moved one is in its new ticket in full. P3-06 leaves P6-04b's dependencies (no upload here).
