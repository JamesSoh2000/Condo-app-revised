# P6-02b — Urgent banner and notice attachments

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02a, P3-06 |
| Replaces old | M6-T04 (banner part) |
| Status | todo |

Split from the P6-02 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-02a](./P6-02a-notices-feed-and-detail.md).

## Goal

A member with an unread urgent notice sees a banner on every page of the building until they acknowledge it,
with copy saying this is not an emergency alert system; a notice's attachment opens through the files download
URL. The legacy `EmergencyAlertPopup` is gone.

## Why

Journey 5: "Residents see … an urgent banner". ADR-0012 promises urgent notices are visible within about a
minute while the app is open, through the same 30 s summary poll, and **not** emergency alerting, so the banner
must say so. Attachments carry P3-06's item: the legacy `NoticeAttachmentUpload` used a public
`attachment_url`; the migrated detail must authorize through the notice (ADR-0007).

## Scope

- In:
  - **urgent banner** in the building shell (`app/AppShell.tsx`), on every page of the selected building, driven
    by `notices_summary.urgent_unread` (the poll P6-02a uses): it names the urgent notice (or how many), links to
    it, and is acknowledged from the banner; it does not return for that notice after acknowledgement, and comes
    back for a new urgent one
  - the banner's **disclaimer copy** (stub decision, below)
  - **attachment** on the P6-02a detail: when `attachment_file_id` is set, a download link that asks
    `GET …/files/{id}/download-url` at click time (never a stored or public URL); images may show inline through
    `features/files/PrivateImage.tsx`
  - delete `src/components/EmergencyAlertPopup.jsx` (no route imports it today) and lower the ratchet
- Out: the editor's upload (P6-02d); push, SMS or email changes (P6-01c owns the urgent email)

## Interfaces

Consumes `notices_summary`, `notices_list`, `notices_read` and `files_download_url`
(`GET /api/buildings/{b}/files/{file_id}/download-url`, authorized by `app/notices/attachments.py`). Whether the
banner needs a list filter the API lacks is open decision 2.

## Acceptance criteria

1. **Given** `a_resident1` with one unread urgent notice, **when** they open any page of building A, **then** the
   banner shows its title and a link to `/notices/<id>`, within one poll (30 s) of publication while the tab is
   visible.
2. **Given** the banner, **when** the member acknowledges it, **then** it disappears on every page, the summary
   and P6-02a's unread state agree, and a reload doesn't bring it back; a second urgent notice published later
   brings it back.
3. **Given** two unread urgent notices, **then** the banner says so and links to each (or to the feed), as
   decided in framing.
4. **Given** the banner, **then** its text says the app is not an emergency alert system and, for an emergency,
   to call 911 (or the building's number, if one exists; framing checks), in the exact copy decided in framing.
5. **Given** a building with `notices` off, a normal (not urgent) unread notice, or a signed-out user, **then**
   no banner shows and no notices request is made where the feature is off.
6. **Given** a notice with a PDF attachment, **when** the member clicks it, **then** a fresh download URL is
   fetched and opened; a 404 `file_not_found` shows a message, not a broken link. No `attachment_url` or S3 key
   appears in the page.
7. **Given** 375 px in Chromium with a 200-character unbroken title, **then** the banner wraps inside the viewport
   and doesn't cover the navigation; it is announced to assistive technology without stealing focus.
8. `EmergencyAlertPopup.jsx` is deleted and the ratchet is lowered to the new count.

## Test plan

- `frontend/src/features/notices/banner.test.tsx`: criteria 1–5
- `frontend/src/features/notices/attachment.test.tsx`: criterion 6
- Chromium check at 375 px (criterion 7); the journey on `make up`, transcript in the PR; `make check`

## Likely files

`frontend/src/features/notices/{UrgentBanner.tsx,NoticeAttachment.tsx,api.ts,NoticeDetailDialog.tsx}`,
`frontend/src/app/AppShell.tsx`, `frontend/src/features/files/{PrivateImage.tsx,purposes.ts}`,
`frontend/src/components/EmergencyAlertPopup.jsx` (deleted), `frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. What is the worst-case delay before the banner shows, and why is that acceptable here?
2. What makes the banner go away, and why does it stay away after a reload?
3. Why is the download URL fetched at click time, and who decides whether the member may have it?

## Open decisions (resolve while framing)

1. **Banner copy** for "this is not an emergency alert system" (the stub's item; no default written down).
2. **Which notice the banner names.** The summary has only counts; framing decides how the banner finds the
   unread urgent notices (the list's pages, or an API filter).
3. **What "acknowledged" means**: marking the notice read (P6-02a's `notices_read`), or a separate dismissal.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
