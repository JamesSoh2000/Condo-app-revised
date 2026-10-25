# P6-02d — Notice editor with preview and attachment

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02c, P3-06 |
| Replaces old | M6-T04 (editor part) |
| Status | done |

Split from the P6-02 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-02c](./P6-02c-manager-notice-list-and-actions.md).

## Goal

Property management writes and edits a draft notice (title, Markdown body, priority, expiry, one attachment),
previews it exactly as members will see it, and publishes it from the editor. The legacy
`NoticeAttachmentUpload` and the legacy Dashboard's Base44 notice form are gone.

*After the second split (Frame notes): this ticket is the editor with title, body, preview, priority, save and
publish; the expiry, the attachment and the legacy deletion are [P6-02f](./P6-02f-notice-expiry-and-attachment.md).*

## Why

The stub's manager editor ("rich text limited to Markdown, attachment upload, preview, publish") and P3-06's
carried item: replace the Base44 `UploadFile` with `FileUpload purpose="notice_attachment"` and the `file_id`
P6-01b claims (ADR-0007: no S3 keys from clients).

## Scope

- In (`frontend/src/features/notices/`):
  - **editor** for a new draft (`notices_create`) and an existing draft (`notices_update`, only the changed
    fields; `null` clears expiry or the attachment), opened from P6-02c's page
  - fields: title (≤ 200), body as Markdown text (≤ 10 000), priority (`normal` / `urgent`), optional expiry
    (a local date and time in the **building's** timezone, sent as an aware instant), optional attachment through
    `features/files/FileUpload.tsx` with `purpose="notice_attachment"` (PDF or image, the purpose's limits)
  - **preview** through P6-02a's `NoticeBody`, so preview and feed render the same way
  - **publish** from the editor (`notices_publish`), with P6-02c's error handling; what happens to unsaved
    changes is open decision 3
  - the API's 422 field errors shown on their fields (`features/auth/formErrors.ts`), 409 `notice_not_editable`
    as a message
  - delete `src/components/NoticeAttachmentUpload.jsx` and the notice form in the legacy `Dashboard.jsx` that
    uses it; lower the ratchet
- Out: rich-text (WYSIWYG) editing; several attachments; editing a published notice (the API refuses it)

## Interfaces

Consumes `notices_create` (201), `notices_update` (`NoticeUpdate`: only fields sent; 409
`notice_not_editable`), `notices_publish`, and the files API (`FileUpload`, purpose `notice_attachment`;
`attachment_file_id` must be `ready`, else 422 `invalid_file`).

## Acceptance criteria

1. **Given** the manager fills title, body, priority and no expiry, **when** they save, **then** one
   `notices_create` is sent and the draft appears in P6-02c's drafts list.
2. **Given** a draft, **when** the manager changes only the body, **then** `notices_update` sends only `body`;
   clearing the expiry or the attachment sends `null` for it. *(The `null` half moved unchanged to
   [P6-02f](./P6-02f-notice-expiry-and-attachment.md) criterion 2, with the fields; see Split.)*
3. **Given** the preview, **then** it renders the body with `NoticeBody` (no raw HTML, P6-02a criterion 3) and
   matches what the feed shows for the same text.
4. *(Moved unchanged to [P6-02f](./P6-02f-notice-expiry-and-attachment.md) criterion 4; see Split.)* **Given** an expiry of 18:00 on a date in a building in `America/Toronto`, **then** the request carries that
   instant in Toronto time (DST included), not the device's zone; a past expiry shows the API's 422
   `notice_expired` on the field.
5. *(Moved unchanged to [P6-02f](./P6-02f-notice-expiry-and-attachment.md) criterion 5; see Split.)* **Given** an attachment, **then** it uploads through `FileUpload` with `purpose="notice_attachment"` and the
   request carries only its `file_id`; a wrong type or size is refused before upload with the purpose's message;
   saving before the upload is ready is prevented.
6. **Given** a 201-character title, an 10 001-character body, or a body with a NUL character, **then** the form
   refuses it before sending, with the same limits as `app/notices/schemas.py`; the API's own 422 still maps to
   the field if sent.
7. **Given** another manager published the draft meanwhile, **when** this manager saves, **then** the 409
   `notice_not_editable` message shows and nothing is lost from the form.
8. **Access.** Only property management sees the editor's entry points; others get `/403` on its route if it has
   one.
9. **Given** 375 px in Chromium with a 255-character file name and the longest title, **then** the form,
   preview and upload stay inside the viewport. *(The file name and the upload moved to P6-02f criterion 9; here:
   the longest title and an unbroken 10 000-character body.)*
10. *(Moved unchanged to [P6-02f](./P6-02f-notice-expiry-and-attachment.md) criterion 10; see Split.)* The legacy upload and the Dashboard's notice form are deleted and the ratchet is lowered.

## Test plan

- `frontend/src/features/notices/editor.test.tsx`: criteria 1–8, 10
- Chromium check at 375 px (criterion 9); the journey on `make up` (write, preview, attach, publish, read as a
  resident), transcript in the PR; `make check`

## Likely files

`frontend/src/features/notices/{NoticeEditor.tsx,api.ts,ManagerNoticesPage.tsx}`,
`frontend/src/features/files/{FileUpload.tsx,purposes.ts}`, `frontend/src/features/auth/formErrors.ts`,
`frontend/src/pages/Dashboard.jsx`, `frontend/src/components/NoticeAttachmentUpload.jsx` (deleted),
`frontend/base44-baseline.txt`. Measure against `features/packages/LogPackageForm.tsx` (a form with a photo
upload, 292 lines).

## Must explain (learning checkpoint)

1. Why does the request carry a `file_id` and never a URL or key?
2. How is a building-local expiry turned into the instant the API stores?
3. Why does an update send only the changed fields, and what does `null` mean in it?

## Open decisions (resolve while framing)

1. **Markdown editing aids**: a plain textarea with preview (the stub's "rich text limited to Markdown"), or a
   toolbar; no WYSIWYG.
2. **Editor placement**: a dialog over P6-02c's page or its own route.
3. **Whether publish from the editor saves first** when there are unsaved changes, or refuses until saved.

## Carried from P6-02b (decide while framing; moved to P6-02f)

- `frontend/src/features/files/purposes.ts::PURPOSE_RULES.notice_attachment` allows PDF only, but the server's
  registry (`backend/app/files/purposes.py::PURPOSES`) accepts PDF **or** images (JPEG, PNG, WebP, HEIC). Make the
  copy match before the editor's upload uses it (P6-02b review round 1 F1). The notice view already handles both:
  `NoticeOut.attachment_content_type`, JPEG/PNG/WebP shown inline, others downloaded.

## Carried from P6-02c (decide while framing; moved to P6-02e)

- **"Load more" drops focus** (P6-02c review round 2 F1, Low): a "Load more" that fetches the last page removes
  itself, and keyboard focus falls to `<body>`. The same `hasNextPage && <button>` shape is in
  `frontend/src/features/notices/{ManagerNoticeList,NoticeList}.tsx`, `features/packages/{WaitingList,MyPackageList}.tsx`
  and the residents lists. Fix it once (focus the list's last new row or its heading), with a test per list.
- **The feed card has round 1 F1's shape** (P6-02c review round 1 F1, fixed only on the manager page): a refresh that
  removes the focused card in `NoticeList.tsx::Card` drops focus. `ManagerNoticeList.tsx::Row` shows the fix (track
  focus with `onFocus`/`onBlur`, hand it on when unmounting with focus).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened (the criteria above stay as written; these make them testable):
  - **1.** The create sends `title`, `body` (both stripped as the server strips), `priority`, and no `expires_at` or
    `attachment_file_id` key when there is none. On the 201 the drafts list is the one shown, asked again, and has the
    new draft; the editor stays open on the saved draft (so it can be published, D3).
  - **2.** "Changed" means different from the last saved version (the row's notice, or the latest 201/200), after the
    strip: `notices_update` sends exactly the changed fields, `null` for a cleared expiry or attachment. A form with no
    change sends nothing and says "No changes to save."
  - **3.** The preview shows the title, the Urgent label and `NoticeBody` of the **stripped** body, the text the
    server stores: an indented first line would be a code block in the preview of the unstripped text but not in the
    feed.
  - *(Moved to P6-02f.)* **4.** One `datetime-local` field, read and written in `building.timezone` (`useBuilding`), never the device's.
    Toronto 2026-07-15 18:00 is `2026-07-15T22:00:00.000Z` (EDT), 2026-12-15 18:00 is `2026-12-15T23:00:00.000Z`
    (EST); a time the DST change skips (2026-03-08 02:30) moves forward by the gap (03:30 EDT, `07:30Z`), a time it
    repeats (2026-11-01 01:30) is the earlier one (EDT, `05:30Z`), Temporal's `compatible`. Proven for two zones
    (Toronto and Tokyo), so one of them isn't the test machine's. An existing draft's expiry shows in building time.
    A 422 `notice_expired`, or a validation error on `expires_at` (`datetime_range`), shows on the expiry field.
  - *(Moved to P6-02f.)* **5.** The purpose's rule is the server's, per type: PDF up to 20 MB, JPEG, PNG, WebP or HEIC up to 10 MB (the
    P6-02b carry): an 11 MB PNG is refused, a 15 MB PDF accepted, before any request. Save is refused while the upload
    runs or after it failed. An existing attachment is shown with a Remove (sends `null`); a 422 `invalid_file` or
    404 `file_not_found` on save shows on the attachment field and asks for a new upload.
  - **6.** Lengths in code points (`formErrors.ts::codePoints`) after the strip of Python's `str.strip()` (its
    whitespace set, not JavaScript's `trim`, which also strips U+FEFF): title 1–200, body 1–10 000; no control
    character (`Cc`) in the title, none but tab, line feed and carriage return in the body, no lone surrogate in
    either (pydantic refuses those as `json_invalid`, which has no field). A blank title or body is refused too.
    The API's 422 `errors[]` on `title`, `body`, `priority`, `expires_at`, `attachment_file_id` map to their fields
    (`serverFieldErrors`); one that can't be placed shows a form message.
  - **7.** On the 409 every field keeps its value, the message says the notice is no longer a draft, and the editor
    doesn't offer Publish.
  - **8.** The entry points ("New notice", and "Edit" on draft rows only) are on `/manage/notices`, which only
    property management opens (P6-02c; others get `/403`). The editor has no route of its own (D2).
- Cases added (the ticket missed them):
  - **11. One request per press**: a double click on Save sends one request; Save and Publish are refused while a
    save is out.
  - **12. Unsaved work**: Escape doesn't close the editor while it has unsaved changes or a save is out (Cancel
    does, and discards them).
  - **13. Building switch** (tenant table row "another building"): switching building with the editor open removes
    it; nothing is sent, to either building.
  - **14. Publish from the editor** (D3): offered only on a saved draft with no unsaved change; it closes the editor
    and opens P6-02c's confirm dialog for that draft, with P6-02c's outcomes and messages.
- Tenant table (docs/ENGINEERING_PRACTICES.md §7): the endpoints are P6-01b's and tested there. In the UI: the role
  row is criterion 8, the other-building row is case 13; IDs in the body are only the `file_id` the upload returned.
- Criteria loosened: none.
- Decisions taken:
  - **D1 Markdown aids** (open decision 1): a plain textarea with a Write / Preview switch, no toolbar. Basis: the
    stub's "rich text limited to Markdown"; the simplest option, reversible. A toolbar is more code and no criterion
    asks for it.
  - **D2 Placement** (open decision 2): a dialog over P6-02c's page (`residents/Modal.tsx`, made wider for it).
    Alternative: its own route (`/manage/notices/<id>/edit`): it needs the draft loaded by id, a 404 and a "no longer
    a draft" page, and the Back/Forward cases of the CLAUDE.md lesson; the dialog gets the notice from its row, as
    P6-02c's action dialog does. Tradeoff: no link to an editor; a reload loses unsaved text (it would on a route too).
    Basis: existing pattern, autonomous.
  - **D3 Publish with unsaved changes** (open decision 3): refused until saved. Publish shows only on a saved draft
    without unsaved changes; otherwise a hint says to save first. Alternative: save then publish in one press: two
    requests whose partial outcomes (saved but not published, published from an older save) each need a message and
    tests. Basis: simplest, reversible, autonomous.
  - *(Moved to P6-02f.)* **D4 P6-02b carry**: `purposes.ts` gets per-type limits (`limits: Record<type, bytes>`), as the server's
    `PurposeRule.limits`, and `notice_attachment` is PDF or image. Basis: the carry, ADR-0007 "Limits".
  - **D5 P6-02c carries** ("Load more" focus in five lists, the feed card's focus): moved to the new
    [P6-02e](./P6-02e-list-focus-fixes.md), see Split. Basis: size; they touch other features' lists.
  - *(Moved to P6-02f.)* **D6 DST**: Temporal's `compatible` resolution (criterion 4), the browser's and Temporal's default for a wall time.
    Basis: convention, autonomous.
- Split: the estimate with the carries was ~490 non-test lines (editor ~280, the building-time conversion ~35, hooks
  ~35, page and row ~45, purposes ~20, Modal ~5, focus carries ~70). The two P6-02c focus carries go to
  [P6-02e](./P6-02e-list-focus-fixes.md); P6-02d keeps criteria 1–14 and the P6-02b carry, ~420 lines.
- **Split again after implementing** (2026-10-25): the whole ticket measured **570 added non-test lines**
  (`git diff --numstat`, tests and docs excluded; editor 378, building-time conversion 60, page 43, purposes 29,
  hooks 27, row 16, client 10, Modal 4, legacy 3), well over ~400. The expiry field and the attachment (criteria 4, 5,
  10, the `null` half of 2, the file-name half of 9, the P6-02b carry D4, decision D6) moved **unchanged** to
  [P6-02f](./P6-02f-notice-expiry-and-attachment.md), with the legacy deletion, since the Dashboard form it replaces
  has an attachment. Nothing was loosened: every moved criterion is in P6-02f word for word, with its sharpening from
  above. The code for them was written and tested on this branch first (PR commits `383daa1`, `8cba241`, `620779a`,
  `0fcc09c`), then reverted here; P6-02f can start from them. P6-02d keeps criteria 1–3, 6–9 and cases 11–14.
