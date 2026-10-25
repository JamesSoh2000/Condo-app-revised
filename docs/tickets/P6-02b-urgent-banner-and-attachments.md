# P6-02b — One notice, urgent banner and attachments

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02a, P3-06 |
| Replaces old | M6-T04 (banner part) |
| Status | done |

Split from the P6-02 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-02a](./P6-02a-notices-feed-and-detail.md).

## Goal

A notice opens on its own at `/notices/<id>` (the link P6-01c's notifications carry; moved here from P6-02a
when it was framed). A member with an unread urgent notice sees a banner on every page of the building until
they acknowledge it, with copy saying this is not an emergency alert system; a notice's attachment opens through
the files download URL. The legacy `EmergencyAlertPopup` is gone.

## Why

Journey 5: "Residents see … an urgent banner". ADR-0012 promises urgent notices are visible within about a
minute while the app is open, through the same 30 s summary poll, and **not** emergency alerting, so the banner
must say so. Attachments carry P3-06's item: the legacy `NoticeAttachmentUpload` used a public
`attachment_url`; the migrated detail must authorize through the notice (ADR-0007).

## Scope

- In:
  - **the notice at `/notices/:noticeId`** (moved from P6-02a): a notice view, or the feed scrolled to it (the
    stub's carry leaves either open), with the title, the body through P6-02a's `NoticeBody`, priority, published
    and expiry times, and P6-02a's "Mark as read" (or marking it read on open, as framing decides); it replaces
    P6-02a's interim `/notices/<anything>` → feed
  - **urgent banner** in the building shell (`app/AppShell.tsx`), on every page of the selected building, driven
    by `notices_summary.urgent_unread` (the poll P6-02a uses): it names the urgent notice (or how many), links to
    it, and is acknowledged from the banner; it does not return for that notice after acknowledgement, and comes
    back for a new urgent one
  - the banner's **disclaimer copy** (stub decision, below)
  - **attachment** on the notice view above: when `attachment_file_id` is set, a download link that asks
    `GET …/files/{id}/download-url` at click time (never a stored or public URL); images may show inline through
    `features/files/PrivateImage.tsx`
  - delete `src/components/EmergencyAlertPopup.jsx` (no route imports it today) and lower the ratchet
- Out: the editor's upload (P6-02d); push, SMS or email changes (P6-01c owns the urgent email)

## Interfaces

Consumes `notices_summary`, `notices_list`, `notices_read` and `files_download_url`
(`GET /api/buildings/{b}/files/{file_id}/download-url`, authorized by `app/notices/attachments.py`). Whether the
banner needs a list filter the API lacks is open decision 2.

## Acceptance criteria

Moved from P6-02a's draft, unchanged:

- **A.** **Given** an unread notice, **when** the member opens `/notices/<id>` (from the feed or a notification),
  **then** that notice shows; **when** it is marked read, **then** `notices_read` is sent once for that action and
  the feed's unread label and the badge clear without a reload. A repeat sends nothing new, or a repeat the API
  ignores (204, first `read_at` kept).
- **B.** **Given** `/notices/<id>` for a draft, archived or expired notice (as a non-manager), another building's
  notice, a random UUID, or a segment that isn't a UUID, **then** the same "Notice not found" state shows (the last
  without asking the API), the feed stays behind it, and closing it goes to `/notices`.

1. **Given** `a_resident1` with one unread urgent notice, **when** they open any page of building A, **then** the
   banner shows its title and a link to `/notices/<id>`, within one poll (30 s) of publication while the tab is
   visible.
2. **Given** the banner, **when** the member acknowledges it, **then** it disappears on every page, the summary
   and P6-02a's unread state agree, and a reload doesn't bring it back; a second urgent notice published later
   brings it back.
3. **Given** two unread urgent notices, **then** the banner says so and links to each (or to the feed), as
   decided in framing.
4. **Given** the banner, **then** its text says the app is not an emergency alert system and where to turn in
   an emergency instead, in the exact copy decided in framing (open decision 1).
5. **Given** a building with `notices` off, a normal (not urgent) unread notice, or a signed-out user, **then**
   no banner shows and no notices request is made where the feature is off.
6. **Given** a notice with a PDF attachment, **when** the member clicks it, **then** a fresh download URL is
   fetched and opened; a 404 `file_not_found` shows a message, not a broken link. No `attachment_url` or S3 key
   appears in the page.
7. **Given** 375 px in Chromium with a 200-character unbroken title, **then** the banner wraps inside the viewport
   and doesn't cover the navigation; it is announced to assistive technology without stealing focus.
8. `EmergencyAlertPopup.jsx` is deleted and the ratchet is lowered to the new count.

## Test plan

- `frontend/src/features/notices/notice.test.tsx`: criteria A and B
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
3. **Whether opening `/notices/<id>` marks the notice read**, or only its button does (P6-02a D4).
4. **What "acknowledged" means**: marking the notice read (P6-02a's `notices_read`), or a separate dismissal.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - **A** (sharpened): the notice opens as a dialog over the feed (`NoticeDetailDialog`, as `/packages/<id>`, P5-04
    D2), with title, `NoticeBody`, an "Urgent" label, published and "Until" times in the building timezone, and the
    attachment (criterion 6). Opening it sends no `notices_read`; its "Mark as read" button sends exactly one per
    press, guarded against a double click in the same tick, and on success the dialog's own copy, the feed's card and
    the nav badge show it read without a reload (every notices query is under `['b', id, 'notices']`).
  - **B** (sharpened): "Notice not found" is the dialog's heading; the non-UUID segment sends no `GET …/notices/{id}`;
    Close (and Escape) go back to the feed it came from, or replace the URL with `/notices` for a link from
    elsewhere (the bell, a bookmark), as `/packages/<id>`. A manager sees what `notices_get` gives them (drafts and
    archived ones too, labelled with their status); the criterion is about non-managers, as written.
  - **1** (sharpened): the banner is a region named "Urgent notices", placed between the main navigation and the
    page, in the normal flow (not fixed or overlaid). It lists the unread urgent notices from
    `GET …/notices?live=true&priority=urgent&unread=true&limit=3` (decision 2), each title linking to
    `/notices/<id>`. It shows within one 30 s summary poll of publication while the tab is visible, because
    `urgent_unread` rising asks that list again.
  - **2** (sharpened): "Acknowledge" on a banner row sends `notices_read` for that notice, once per press. Then
    the summary, feed and list are asked again; the row leaves and the banner disappears once `urgent_unread` is 0.
    After a reload, `urgent_unread` is 0, so no banner list request is made. A later urgent notice raises
    `urgent_unread` and brings the banner back with that notice.
  - **3** (sharpened): with two (or three) unread urgent notices the banner says "2 urgent notices" and lists each
    with its own link and Acknowledge; with more than three it lists the newest three and adds "and N more", linked
    to `/notices`.
  - **5** (sharpened): no banner, and neither `notices/summary` nor the banner list is requested, when the
    building has `notices` off, the building is denied, there is no selected building (session-only pages such as
    `/403` or onboarding), or the user is signed out. With only normal unread notices (`urgent_unread` 0) there is no
    banner and no banner list request.
  - **7** (sharpened): measured in Chromium at 375 px with a 200-character unbroken title and three rows: no
    horizontal scroll, and the nav's bottom edge is above the banner's top. The banner content sits in a
    polite live region that is mounted before content arrives, so it is announced; focus doesn't move when it
    appears. (Implementation note: an `aria-live="polite"` wrapper, not `role="status"`, which would collide with the
    shell's other unnamed status regions; see the PR's deviations.)
  - **8** (corrected, not loosened): `EmergencyAlertPopup.jsx` has no `base44.`/`@base44/` reference
    (`scripts/base44-count.sh`: 247, baseline 247), so deleting it cannot lower the Base44 ratchet. The criterion
    becomes: the file is deleted, nothing imports it, and `scripts/base44-count.sh` still passes at the baseline
    (unchanged, 247). (Also added to the inbox's "Decisions to audit" in step 6.)
  - **9** (added, the missed case): a banner row whose notice was archived or expired before Acknowledge
    (`notices_read` 404) shows no error loop: the row leaves after the refresh, and the next summary decides whether
    the banner stays.
  - **10** (added, tenant table: building switch and denial): switching building A → B shows nothing of A's
    banner in B (keyed by building), and B's banner comes from B's own summary; in a denied building the banner
    is gone.
  - **11** (added, API, decision 2): `GET …/notices` accepts `priority` and `unread=true`. `unread` keeps the
    caller's own unread notices, `priority` narrows by priority, both inside `visible_notices`, and other members'
    reads don't count. Backend tests: a resident's `priority=urgent&unread=true` returns only their unread urgent
    live notices; another resident's read doesn't hide it; another building's notice never appears; a bad
    `priority` is a 422.
  - **6** (sharpened): the attachment is a "Download attachment (PDF)" button, not a link with an `href`. A click
    asks `GET …/files/{attachment_file_id}/download-url` at that moment (never cached: each click asks again), then
    goes to the URL, which S3 serves as `Content-Disposition: attachment`, so the PDF downloads and the page stays.
    (Implementation note: framing first planned a new tab; the stack showed the PDF downloads and leaves that tab
    blank, see the PR's D5.) On 404 `file_not_found` (or any failure) nothing is opened and the dialog says "The
    attachment is not available." (or the rate-limit or generic message). The DOM never contains
    the URL, the file id as a link, or an S3 key. Notice attachments are PDF only (`PURPOSE_RULES.notice_attachment`),
    so no inline image.
- Criteria loosened (with reason; also listed in the inbox): none. Criterion 8's "lower the ratchet" is a correction
  of fact (above), not a loosened gate.
- Decisions taken (with basis):
  1. **Banner copy** (autonomous; no default written down): "Urgent building notice. This app is not an emergency
     alert system: in an emergency, call 911." Basis: ADR-0012 (not emergency alerting); 911 covers the seeded
     buildings (Canada, Toronto timezone). Alternatives: naming the front desk or security (not every building has
     one, and the app doesn't hold their numbers), or a building-configurable line (new setting, out of scope).
  2. **How the banner finds the notices**: a list filter on the API, `priority` + `unread`
     (autonomous, simplest exact option). Alternatives: paging the live feed on the client until `urgent_unread`
     notices are found (unbounded requests, and an older urgent notice can sit behind many pages), or a new
     `/notices/urgent` endpoint (one more route for what is a filter on the existing list). Tradeoff: a small backend
     change and an OpenAPI regeneration (`schema.d.ts`, a hot file) in a lane-B ticket.
  3. **Opening `/notices/<id>` does not mark it read**; only its button does (P6-02a D4, kept; basis: convention).
     A notification click or a prefetch shouldn't count as reading it.
  4. **"Acknowledged" means marked read** (`notices_read`) (basis: simplest, and criterion 2 requires the summary
     and the unread state to agree, which a separate dismissal would break). No new table or local storage.
  5. **When the banner list is asked**: only while `urgent_unread > 0`, again whenever `urgent_unread` changes,
     cancelled before invalidating (the CLAUDE.md lesson, as `NoticesPage`). It doesn't poll on its own (ADR-0012).
     Accepted limitation: if within one poll one urgent notice is read on another device and another is published,
     the count doesn't move and the banner keeps the old row until a focus, a mount or its own Acknowledge (a 204).
- Split: none. Estimate about 360 non-test lines (backend filter ~20, `api.ts` ~35, `UrgentBanner.tsx` ~110,
  `NoticeDetailDialog.tsx` ~110, `NoticeAttachment.tsx` ~55, page/route/shell wiring ~30).
