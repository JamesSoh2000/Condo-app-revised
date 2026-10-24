# P6-02d — Notice editor with preview and attachment

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02c, P3-06 |
| Replaces old | M6-T04 (editor part) |
| Status | todo |

Split from the P6-02 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-02c](./P6-02c-manager-notice-list-and-actions.md).

## Goal

Property management writes and edits a draft notice (title, Markdown body, priority, expiry, one attachment),
previews it exactly as members will see it, and publishes it from the editor. The legacy
`NoticeAttachmentUpload` and the legacy Dashboard's Base44 notice form are gone.

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
  - **publish** from the editor: save then `notices_publish`, with P6-02c's error handling
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
   clearing the expiry or the attachment sends `null` for it.
3. **Given** the preview, **then** it renders the body with `NoticeBody` (no raw HTML, P6-02a criterion 3) and
   matches what the feed shows for the same text.
4. **Given** an expiry of 18:00 on a date in a building in `America/Toronto`, **then** the request carries that
   instant in Toronto time (DST included), not the device's zone; a past expiry shows the API's 422
   `notice_expired` on the field.
5. **Given** an attachment, **then** it uploads through `FileUpload` with `purpose="notice_attachment"` and the
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
   preview and upload stay inside the viewport.
10. The legacy upload and the Dashboard's notice form are deleted and the ratchet is lowered.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
