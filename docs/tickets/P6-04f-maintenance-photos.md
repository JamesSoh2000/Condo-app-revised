# P6-04f — Photos on the maintenance submit form

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-04b, P3-06 |
| Replaces old | M8-T02 (photo part) |
| Status | todo |

Split from [P6-04b](./P6-04b-maintenance-submit-and-cancel.md) while it was being built: the whole of P6-04b measured
~750 non-test lines. Its criterion 1's photos, criterion 3, criterion 4's file errors and criterion 9's file name are
this ticket's.

## Carried from P6-04b (first follow-up; do while framing)

- **P6-04b review round 3 F1 (Medium, unfixed there):** in `SubmitRequestForm.tsx`, if `/me` drops the occupancy
  (the form shows the common-area field), the resident types a common area, and `/me` then gives a *different* unit
  while the form is open, the stored `chosenLocation` is still `unit`: the radios return with "My unit" chosen, the
  field and its focus go, and a submit files for the new unit. Fix suggested by the reviewer: make `common_area` the
  stored choice when the occupancy goes, and keep focus on the field. Test it test-first with the round 1 F3 tests in
  `submit.test.tsx` as neighbours (PR #155 "Independent review", round 3).

## Draft to start from

An unreviewed implementation written during P6-04b is on the local branch `p6-04-photos-cancel-draft` (commit
`71e043c`): `frontend/src/features/maintenance/PhotoList.tsx`, its use in `SubmitRequestForm.tsx` (the `photos` state,
the submit disabled while one uploads, the file error codes), and the "photos (criterion 3)" tests in
`frontend/src/features/maintenance/submit.test.tsx` with `FakeXHR` and `uploadsApi` in `frontend/src/test/maintenance.ts`
(green there). Re-frame against `main`, which by then has P6-04b's form; the draft is a starting point, not reviewed
code.

## Goal

A resident adds up to five photos to a maintenance request (`docs/PRODUCT_SCOPE.md` journey 6: "A resident submits a
request with a photo").

## Scope

- In: 0 to `MAX_PHOTOS` (5) photos on P6-04b's form, each through `features/files/FileUpload.tsx` with purpose
  `maintenance_photo` (one row per photo; `FileUpload` takes one file), sent as `photo_file_ids` in row order.
- Out: showing the photos on the request view (P6-04c).

## Acceptance criteria

1. **Given** `a_resident1`, **when** they fill the form with two photos and submit, **then** one request is sent with
   the photos' file ids in row order.
2. **Given** a photo still uploading, **then** submit is disabled and a text tied to it by `aria-describedby` says
   why; a failed upload can be retried (`FileUpload`'s Retry) or removed (focus then goes to "Add a photo") without
   losing the other fields or photos; a submit with a failed row, or a row with no file chosen, is refused with a
   message on the photos.
3. "Add a photo" adds a row and focuses its button; at 5 photos it is disabled and says why.
4. **Given** `invalid_file`, `file_not_found` or `upload_incomplete` from the create, **then** a message on the photos
   says to remove and add the photo again, it takes focus, and the fields and photos stay.
5. **Switching building** with photos added or uploading cancels their uploads (`useUpload`) and sends nothing to
   either building.
6. **375 px in Chromium** with a 255-character photo file name, five photo rows and the longest description, the form
   stays inside the viewport.

## Test plan

- `frontend/src/features/maintenance/submit.test.tsx` (photo cases) or `photos.test.tsx`: criteria 1–5
- Chromium at 375 px (criterion 6), output in the PR
- `make check DB_PORT=55432`; on the stack, submit with a photo, transcript in the PR

Estimate: ~160 non-test lines (photo list ~125, form wiring ~35), measured from the draft.

## Must explain (learning checkpoint)

1. Why does each photo row have its own `FileUpload`, and what happens to a row's upload when it is removed?
2. What stops a request from being sent with a photo that never finished uploading?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis):
- Split:
