# P6-02f — Notice editor: expiry and attachment

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02d, P3-06 |
| Replaces old | M6-T04 (editor part) |
| Status | in progress |

Split from [P6-02d](./P6-02d-notice-editor.md) after implementing (its Frame notes, "Split again"): P6-02d measured 570
added non-test lines with these fields. The criteria below are P6-02d's, moved word for word, with P6-02d's framing.
The code was written and tested on P6-02d's branch, then reverted there: PR commits `383daa1` (per-type limits),
`8cba241` (building-time conversion), `620779a` (the editor with both fields), `0fcc09c` (legacy deletion). Start
from them.

## Goal

The editor gets an optional expiry, entered in building time, and one optional attachment (PDF or image) through
`FileUpload`. The legacy `NoticeAttachmentUpload` and the legacy Dashboard's Base44 notice form are deleted.

## Scope

- In: the expiry field and the attachment in `frontend/src/features/notices/NoticeEditor.tsx` (`null` clears either),
  `features/files/purposes.ts` per-type limits, the 422 `notice_expired` and `invalid_file` / `file_not_found`
  mapping, delete `src/components/NoticeAttachmentUpload.jsx` and the Dashboard notice form, lower the ratchet
- Out: several attachments; editing a published notice

## Acceptance criteria

- **2.** **Given** a draft, clearing the expiry or the attachment sends `null` for it (P6-02d criterion 2's second half).
- **4.** **Given** an expiry of 18:00 on a date in a building in `America/Toronto`, **then** the request carries that
  instant in Toronto time (DST included), not the device's zone; a past expiry shows the API's 422
  `notice_expired` on the field.
- **5.** **Given** an attachment, **then** it uploads through `FileUpload` with `purpose="notice_attachment"` and the
  request carries only its `file_id`; a wrong type or size is refused before upload with the purpose's message;
  saving before the upload is ready is prevented.
- **9.** **Given** 375 px in Chromium with a 255-character file name, **then** the upload and the expiry field stay inside
  the viewport (P6-02d criterion 9's file-name half).
- **10.** The legacy upload and the Dashboard's notice form are deleted and the ratchet is lowered.

## Framing carried from P6-02d

  - **4.** One `datetime-local` field, read and written in `building.timezone` (`useBuilding`), never the device's.
    Toronto 2026-07-15 18:00 is `2026-07-15T22:00:00.000Z` (EDT), 2026-12-15 18:00 is `2026-12-15T23:00:00.000Z`
    (EST); a time the DST change skips (2026-03-08 02:30) moves forward by the gap (03:30 EDT, `07:30Z`), a time it
    repeats (2026-11-01 01:30) is the earlier one (EDT, `05:30Z`), Temporal's `compatible`. Proven for two zones
    (Toronto and Tokyo), so one of them isn't the test machine's. An existing draft's expiry shows in building time.
    A 422 `notice_expired`, or a validation error on `expires_at` (`datetime_range`), shows on the expiry field.
  - **5.** The purpose's rule is the server's, per type: PDF up to 20 MB, JPEG, PNG, WebP or HEIC up to 10 MB (the
    P6-02b carry): an 11 MB PNG is refused, a 15 MB PDF accepted, before any request. Save is refused while the upload
    runs or after it failed. An existing attachment is shown with a Remove (sends `null`); a 422 `invalid_file` or
    404 `file_not_found` on save shows on the attachment field and asks for a new upload.
  - **D4 P6-02b carry**: `purposes.ts` gets per-type limits (`limits: Record<type, bytes>`), as the server's
    `PurposeRule.limits`, and `notice_attachment` is PDF or image. Basis: the carry, ADR-0007 "Limits".
  - **D6 DST**: Temporal's `compatible` resolution (criterion 4), the browser's and Temporal's default for a wall time.
    Basis: convention, autonomous.

## Carried from P6-02b (decide while framing)

- `frontend/src/features/files/purposes.ts::PURPOSE_RULES.notice_attachment` allows PDF only, but the server's
  registry (`backend/app/files/purposes.py::PURPOSES`) accepts PDF **or** images (JPEG, PNG, WebP, HEIC). Make the
  copy match before the editor's upload uses it (P6-02b review round 1 F1). The notice view already handles both:
  `NoticeOut.attachment_content_type`, JPEG/PNG/WebP shown inline, others downloaded.

## Follow-ups carried from P6-02d (PR #132)

- **First: promote a mistake pattern** (it appeared twice in P6-02d, `docs/AGENT_MISTAKES_LOG.md`): focusing an error's
  field when the element isn't rendered (a body error from Preview, review round 1 F1; `priority` in `FIELDS` with
  no element, the reality pass). Before adding the expiry and attachment fields, add a test that every entry of
  `NoticeEditor.tsx`'s `FIELDS` has an element with its id and an error slot, or a `CLAUDE.md` lesson.
- Adding a field: follow the explanation's §8 (`docs/explanations/P6-02d-notice-editor.md`).

## Test plan

- `frontend/src/features/notices/editor.test.tsx` (criteria 2, 4, 5, 10), `expiry.test.ts` (criterion 4),
  `features/files/files.test.tsx` (criterion 5); Chromium at 375 px; the journey on `make up`.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - **2** also: an upload that replaces a draft's attachment sends the new `file_id`; Remove on a finished upload of a
    new draft sends no `attachment_file_id`; sending back the saved attachment or expiry unchanged sends neither (only
    what differs, P6-02d criterion 2).
  - **4** also: an existing draft's expiry shows in building time (Toronto and Tokyo), and a `datetime_range` 422 on
    `expires_at` shows on the field (both from the carried framing, now testable lines of the criterion).
  - **5** also (missed case): after a 422 `invalid_file` / 404 `file_not_found` the refused `file_id` is dropped, so the
    next save doesn't send it again; a new upload is needed.
  - **11** (new, from the P6-02d follow-up): every entry of `NoticeEditor.tsx`'s `FIELDS` has a rendered element with id
    `${id}-<field>` that a server error on it focuses, and an error slot linked by `aria-describedby`. Written before the
    expiry and attachment are added, so it fails if either is listed without its element.
  - Tenant table (`ENGINEERING_PRACTICES.md` §7): no new endpoint; the client sends only a `file_id` and the server's
    P6-01 tests cover another building's file (404 `file_not_found`). Rows n/a here; criterion 5 covers the client half.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken:
  - **D1 start from P6-02d's reverted commits** (`383daa1`, `8cba241`, `620779a` editor part, `0fcc09c`), re-applied on
    today's editor, which P6-02d changed after them (priority errors, Preview on a body error). Basis: the ticket.
  - **D2 the follow-up as a test, not a lesson**: criterion 11. A test fails on the exact mistake; a lesson only asks to
    remember it. Basis: playbook "prefer a check over a rule", autonomous.
  - **D3 no time-zone library**: `expiry.ts` converts with `Intl.DateTimeFormat` (no dependency), Temporal's
    `compatible` as D6. Basis: CLAUDE.md "no dependency without a reason"; `Intl` is enough for one wall time.
- Split: none. Estimate ~210 added non-test lines (editor ~100, `purposes.ts` ~30, `expiry.ts` 60, page ~5, legacy
  deletion is removals only), under ~400.
