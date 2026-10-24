# P6-02a — Notices feed and detail

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-01c, P5-05 |
| Replaces old | M6-T04 (feed part) |
| Status | todo |

Split from the P6-02 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); before
[P6-02b](./P6-02b-urgent-banner-and-attachments.md), [P6-02c](./P6-02c-manager-notice-list-and-actions.md) and
[P6-02d](./P6-02d-notice-editor.md).

## Goal

Every member of a building with `notices` on reads its live notices in a feed with an unread state, opens one at
`/notices/<id>` (the link P6-01c's notifications carry), which marks it read, and sees an unread count on the nav
item. The legacy `BuildingUpdatesFeed` and `ArchivedUpdatesModal` are gone.

## Why

Journey 5's resident half (`docs/PRODUCT_SCOPE.md`: "Residents see the feed, an unread badge…; marking a notice
read clears the badge"). The notice API is merged (P6-01a–c) but no migrated screen reads it, and every
`notice.published` notification links to a page that doesn't exist yet. Markdown is rendered here first, so the
no-raw-HTML rule is set before the editor's preview (P6-02d) reuses it. ADR-0011 (strangler), ADR-0012 (polling).

## Scope

- In (`frontend/src/features/notices/`):
  - `api.ts`: React Query hooks for `notices_list` (infinite, cursor pages), `notices_get`, `notices_summary`
    and `notices_read`, keys under `['b', buildingId, 'notices', …]` (`features/packages/api.ts::packagesKey`)
  - **feed page** at `/notices`, any active member, feature `notices`: published notices newest first, each with
    title, priority (urgent marked), published time in the building's timezone, and an unread marker from
    `read_at`; 25 a page with "Load more"; loading, empty, failed and failed-"Load more" states
  - **detail** at `/notices/:noticeId`: the title, the body rendered from Markdown, priority, published and
    expiry times; opening it sends `notices_read` once and the feed and badge update
  - the shared **Markdown renderer** (`NoticeBody`), which never renders raw HTML (stub decision, below)
  - **nav badge** from `notices_summary.unread`, on the 30 s visible-tab cadence of the notification summary
  - `PAGE_ACCESS` row `Notices` (label, path, feature), its route under `RequirePageAccess`, keyed by building
  - delete `src/components/BuildingUpdatesFeed.jsx` and `ArchivedUpdatesModal.jsx`, remove their uses from the
    legacy `Dashboard.jsx` (and the `i18n.js` entry if only they use it), lower `frontend/base44-baseline.txt`
  - **first follow-up (from P5-05 review round 3, open Medium):** `frontend/src/test/buildingDenial.test.ts`
    resolves each hook callee with the TypeScript checker (`ts.createProgram` over `src/app` and
    `src/features`, `getSymbolAtLocation`, following aliases) instead of its own name tables, so a
    function-local alias (`const read = useBuildingDenied`), a declaration shadowing a module-level hook,
    `useBuilding!(…)`, `(useBuilding)(…)` and `useBuilding.call(…)` can't make it pass a passive reader that
    reads no denial; the round-1 to round-3 cases stay as tests (the reviewers' proofs are in PR #121's
    "Independent review")
- Out: the urgent banner and attachments (P6-02b); the manager list, actions and editor (P6-02c, P6-02d); the
  dashboard's notice card (P6-05); E2E (P6-07)

## Interfaces

Consumes `notices_list` (`GET /api/buildings/{b}/notices?status=&cursor=&limit=`), `notices_get`,
`notices_summary` (`{unread, urgent_unread}`) and `notices_read` (`POST …/notices/{id}/read`, 204, idempotent).
`NoticeOut` carries `priority`, `status`, `published_at`, `expires_at`, `read_at` and `attachment_file_id`. No API
change is planned; framing decides whether one is needed (open decision 2).

## Acceptance criteria

1. **Given** `a_resident1` and three live notices in A, one read, **when** they open `/notices`, **then** three
   rows show newest first, two marked unread, and the nav item reads "Notices, 2 unread"; with none unread, or
   after a failed summary, it is plain "Notices".
2. **Given** an unread notice, **when** the member opens `/notices/<id>` (from the feed or a notification),
   **then** the detail shows it, `notices_read` is sent once, and the row's unread marker and the badge clear
   without a reload. Opening it again sends nothing new, or a repeat the API ignores (decided in framing).
3. **Given** a body containing `<script>`, `<img src=x onerror=…>`, a raw `<a href>` and a Markdown link to
   `javascript:alert(1)`, **then** no element from the HTML is created, no script runs and the link has no
   `javascript:` href; headings, emphasis, lists and `https` links render.
4. **Given** `/notices/<id>` for a draft, archived or expired notice (as a non-manager), another building's
   notice, a random UUID, or a segment that isn't a UUID, **then** the same "Notice not found" state shows
   (the last without asking the API), the feed stays behind it, and closing it goes to `/notices`.
5. **Access (tenant rows 1, 2, 4).** Every active role opens `/notices`; a signed-out user goes to login with the
   way back; a building with `notices` off gives `/403` without asking the notices API. Another building's id in
   the path follows the existing building-denial path (`app/buildingDenial.ts`).
6. **Given** the polled unread count changes while the feed is open, **then** the feed is asked again (the
   P5-04 criterion 9 lesson: the list follows the badge).
7. **Given** 375 px in Chromium with a 200-character title without spaces and a 10 000-character body, **then**
   nothing is wider than the viewport, and the unread marker has a text alternative.
8. **Given** the fitness test, **then** each shape in the follow-up above fails it when a passive reader doesn't
   read the denial, and today's code passes.
9. The legacy feed files are deleted and the ratchet is lowered to the new `scripts/base44-count.sh` count.

## Test plan

- `frontend/src/features/notices/notices.test.tsx` (`renderApp`, `stubApi`): criteria 1, 2, 4–6
- `frontend/src/features/notices/noticeBody.test.tsx`: criterion 3 (each payload)
- `frontend/src/test/buildingDenial.test.ts`: criterion 8, with the PR #121 cases kept
- Chromium check at 375 px (criterion 7), output in the PR
- `make check`; the journey on `make up` (publish via the API, read in the UI), transcript in the PR

## Likely files

`frontend/src/features/notices/{api.ts,NoticesPage.tsx,NoticeList.tsx,NoticeDetailDialog.tsx,NoticeBody.tsx,
NoticesNavLabel.tsx}`, `frontend/src/app/{pages.ts,routes.tsx,routeScope.ts,MainNav.tsx}`,
`frontend/src/test/buildingDenial.test.ts`, `frontend/src/pages/Dashboard.jsx`,
`frontend/src/components/{BuildingUpdatesFeed,ArchivedUpdatesModal}.jsx` (deleted),
`frontend/base44-baseline.txt`. Reuse `features/packages/MyPackageList.tsx`, `PackageDetailDialog.tsx`,
`PackagesNavLabel.tsx`, `features/residents/Modal.tsx`.

## Must explain (learning checkpoint)

1. Which server function decides what the feed shows, and why does the browser not filter it again?
2. Why can't a notice body run script, and which line ensures it?
3. How do the unread marker and the badge clear after a read, and what keeps them from disagreeing?
4. How does the fitness test know which function a call names?

## Open decisions (resolve while framing)

1. **Markdown rendering.** Stub default: Markdown only, **no raw HTML** (the body is never rendered as HTML).
   Framing picks the renderer (`react-markdown` is already a dependency) and how links are restricted.
2. **The manager's feed.** `visible_notices` gives property management expired notices too, so the feed's
   `?status=published` would show them expired ones that residents don't see. Framing decides (hide them, mark
   them, or a list parameter).
3. **The legacy Dashboard.** It embeds `BuildingUpdatesFeed` in several role views; what replaces those embeds
   until P6-05 (nothing, or a link to `/notices`).
4. **Mark read on open, or on an explicit action.** The stub says only "an unread state".

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
