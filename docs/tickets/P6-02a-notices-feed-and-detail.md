# P6-02a — Notices feed

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-01c, P5-05 |
| Replaces old | M6-T04 (feed part) |
| Status | done |

Split from the P6-02 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); before
[P6-02b](./P6-02b-urgent-banner-and-attachments.md), [P6-02c](./P6-02c-manager-notice-list-and-actions.md) and
[P6-02d](./P6-02d-notice-editor.md). Framing moved the one-notice view at `/notices/<id>` to P6-02b (Frame notes).

## Goal

Every member of a building with `notices` on reads its live notices in a feed, each with its Markdown body and an
unread state, marks one read, and sees an unread count on the nav item. The legacy `BuildingUpdatesFeed` and
`ArchivedUpdatesModal` are gone.

## Why

Journey 5's resident half (`docs/PRODUCT_SCOPE.md`: "Residents see the feed, an unread badge…; marking a notice
read clears the badge"). The notice API is merged (P6-01a–c) but no migrated screen reads it, and every
`notice.published` notification links to a page that doesn't exist yet. Markdown is rendered here first, so the
no-raw-HTML rule is set before the editor's preview (P6-02d) reuses it. ADR-0011 (strangler), ADR-0012 (polling).

## Scope

- In (`frontend/src/features/notices/`):
  - `api.ts`: React Query hooks for `notices_list` (infinite, cursor pages, `live=true`), `notices_summary` and
    `notices_read`, keys under `['b', buildingId, 'notices', …]` (`features/packages/api.ts::packagesKey`)
  - **feed page** at `/notices` (and `/notices/<anything>`, so P6-01c's notification links land on it until
    P6-02b gives them their notice), any active member, feature `notices`: the live notices in the API's order,
    each a card with title, an "Urgent" label, "Published <time>" and, if set, "Until <time>" in the building's
    timezone, the body rendered from Markdown, and for an unread one an "Unread" label and a "Mark as read"
    button; 25 a page with "Load more"; loading, empty, failed and failed-"Load more" states
  - the shared **Markdown renderer** (`NoticeBody`), which never renders raw HTML (D1)
  - **nav badge** from `notices_summary.unread`, on the 30 s visible-tab cadence of the notification summary
  - `PAGE_ACCESS` row `Notices` (label, path, feature), its route under `RequirePageAccess`, keyed by building
  - **API:** `notices_list` takes `live=true`: only notices `app/notices/queries.py::live` admits (published, not
    expired by the database clock), the same rule the summary counts (D2)
  - delete `src/components/BuildingUpdatesFeed.jsx` and `ArchivedUpdatesModal.jsx`, remove their uses from the
    legacy `Dashboard.jsx` (and the `i18n.js` entries if only they use them), lower `frontend/base44-baseline.txt`
  - **first follow-up (from P5-05 review round 3, open Medium):** `frontend/src/test/buildingDenial.test.ts`
    resolves each hook callee with the TypeScript checker (`ts.createProgram` over `src/app` and
    `src/features`, `getSymbolAtLocation`, following aliases) instead of its own name tables, so a
    function-local alias (`const read = useBuildingDenied`), a declaration shadowing a module-level hook,
    `useBuilding!(…)`, `(useBuilding)(…)` and `useBuilding.call(…)` can't make it pass a passive reader that
    reads no denial; the round-1 to round-3 cases stay as tests (the reviewers' proofs are in PR #121's
    "Independent review")
- Out: one notice at `/notices/<id>` with its not-found state, the urgent banner and attachments (P6-02b); the
  manager list, actions and editor (P6-02c, P6-02d); "mark all read"; the dashboard's notice card (P6-05); E2E
  (P6-07)

## Interfaces

Consumes `notices_list` (`GET /api/buildings/{b}/notices?live=&status=&cursor=&limit=`), `notices_summary`
(`{unread, urgent_unread}`) and `notices_read` (`POST …/notices/{id}/read`, 204, idempotent; 404
`notice_not_found` for a notice the caller no longer sees). `NoticeOut` carries `priority`, `published_at`,
`expires_at`, `read_at`.

API change: `notices_list` gains `live: bool = False`. With `live=true` the list is `visible_notices(ctx)` narrowed
by `queries.py::live()`; with `status` too, both apply. Without it, nothing changes.

## Acceptance criteria

1. **Given** `a_resident1` and three live notices in A, one read, **when** they open `/notices`, **then** three
   cards show in the feed's order (newest written first, D5), two with the "Unread" label and a "Mark as read"
   button, and the nav item's accessible name is "Notices, 2 unread"; with none unread, or after a failed
   summary, it is plain "Notices". The feed asks `notices_list` with `live=true` for every role.
2. **Given** an unread card, **when** the member presses "Mark as read", **then** one `notices_read` is sent (a
   second press while it is out sends nothing), and afterwards the card's label and button are gone and the badge
   shows one fewer, without a reload. A failed request keeps the card unread with a message on it; a 404
   `notice_not_found` (archived or expired meanwhile) says the notice is no longer available and the feed is
   asked again.
3. **Given** a body containing `<script>`, `<img src=x onerror=…>`, a raw `<a href>`, a Markdown link to
   `javascript:alert(1)` and a Markdown image, **then** no element from the HTML is created (it shows as text), no
   script runs, the `javascript:` link has no `href`, and no `<img>` is rendered; headings, emphasis, lists,
   quotes, code and `https` and `mailto` links render, the links opening in a new tab with
   `rel="noopener noreferrer"`.
4. **Access (tenant rows 1, 2, 4).** Resident, security, property management and council open `/notices`; a
   signed-out user goes to login with the way back; a building with `notices` off gives `/403` without asking the
   notices API, and its nav has no Notices item. `/notices/<id>` shows the same feed.
5. **Given** the polled unread count changes while the feed is open, **then** the feed is asked again, cancelled
   first, and the feed waits for the first count (the P5-04 criterion 9 lesson and the CLAUDE.md "refreshes on
   a signal" lesson).
6. **Given** 375 px in Chromium with a 200-character title without spaces and a 10 000-character body with a
   2 000-character word, **then** nothing is wider than the viewport, and the unread state is text, not colour
   alone.
7. **Given** the fitness test, **then** each shape in the follow-up above fails it when a passive reader doesn't
   read the denial, every case from PR #121's rounds 1–3 still holds, and today's code passes.
8. The legacy feed files are deleted, their uses gone from `Dashboard.jsx`, and the ratchet is lowered to the new
   `scripts/base44-count.sh` count.
9. **API (tenant rows 1, 3).** `GET …/notices?live=true` gives property management only published, unexpired
   notices (no drafts, archived or expired), and a resident the same list as without it; `live=true&status=draft`
   is empty; another building's member gets 404 `building_not_found`, as for the list without it.

Added while framing:

10. **A case the ticket missed: switching building.** With the feed open in A, choosing building B shows B's
    feed and badge only: nothing of A's cards or counts shows while B's load (the page is keyed by building).
11. **Times.** `2026-03-15T23:30:00Z` in an `America/Toronto` building shows as Mar 15, 2026, 7:30 PM, in the
    building's locale, not the device's zone (as P5-04 criterion 4).

## Test plan

- `frontend/src/features/notices/notices.test.tsx` (`renderApp`, `stubApi`): criteria 1, 2, 4, 5, 10, 11
- `frontend/src/features/notices/noticeBody.test.tsx`: criterion 3 (each payload)
- `frontend/src/test/buildingDenial.test.ts`: criterion 7, with the PR #121 cases kept
- `backend/tests/notices/test_api.py`: criterion 9
- Chromium check at 375 px (criterion 6), output in the PR
- `make check`; the journey on `make up` (publish via the API, read and mark read in the UI), transcript in the PR

## Likely files

`frontend/src/features/notices/{api.ts,NoticesPage.tsx,NoticeList.tsx,NoticeBody.tsx,NoticesNavLabel.tsx}`,
`frontend/src/app/{pages.ts,routes.tsx,MainNav.tsx}`, `frontend/src/test/buildingDenial.test.ts`,
`frontend/src/pages/Dashboard.jsx`, `frontend/src/components/{BuildingUpdatesFeed,ArchivedUpdatesModal}.jsx`
(deleted), `frontend/base44-baseline.txt`, `backend/app/notices/{router.py,service.py}`,
`frontend/src/api/schema.d.ts`. Reuse `features/packages/MyPackageList.tsx`, `pages/MyPackagesPage.tsx`,
`PackagesNavLabel.tsx`, `time.ts::buildingTime`.

## Must explain (learning checkpoint)

1. Which server function decides what the feed shows, and why does the browser not filter it again?
2. Why can't a notice body run script, and which line ensures it?
3. How do the unread label and the badge clear after a read, and what keeps them from disagreeing?
4. How does the fitness test know which function a call names?

## Open decisions (resolved in the Frame notes)

1. Markdown rendering (stub default: no raw HTML). 2. The manager's feed. 3. The legacy Dashboard. 4. Mark read
on open, or on an explicit action. 5. Feed order.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (the cards' fields, `live=true` for every role, the accessible name), 2 (the
  read is an explicit action, one request, its failure and 404), 3 (images and allowed links), 4 (every role,
  the feature off, `/notices/<id>`), 5 (cancel and wait for the first count), 6 (the longest values the API
  allows), 7 (the PR #121 cases), 9 (the `live` parameter, new); 10–11 added (10 is the missed case).
- Criteria moved, not loosened (also listed in the inbox): the drafted criterion 2 (opening `/notices/<id>`
  shows that notice) and criterion 4 (the not-found state for a hidden, other-building, random or non-UUID id)
  move to P6-02b with the one-notice view, unchanged. Reason: the drafted ticket measured ~490 non-test lines
  (`MyPackagesPage` 83 + `MyPackageList` 139 + `PackageDetailDialog` 108 + `PackagesNavLabel` 23 + hooks ~75 +
  renderer ~45 + routing ~15), over the ~400 limit; showing the body in the feed removes the dialog, and
  `/notices/<id>` reaches the feed meanwhile, so no notification link is a dead end.
- Decisions taken:
  - **D1 Markdown.** `react-markdown` 9.1 (already a dependency, used by legacy pages) with no `rehype-raw`:
    measured on this checkout, it renders raw HTML as escaped text and empties a `javascript:` href. Added:
    `img` disallowed (an external image would be a tracking request; the CSP's `img-src` blocks other hosts
    anyway, and notice images are P6-02b's attachments), links kept only for `http`, `https`, `mailto`, `tel`,
    opening in a new tab. Rejected: DOMPurify over an HTML render (a new dependency and an HTML path the stub
    rules out); `skipHtml` (it would hide the author's text silently). Basis: stub default + autonomous.
  - **D2 The manager's feed** uses `live=true`, a new list parameter, so every role's feed is what the summary
    counts, by the database clock. Rejected: hiding expired notices in the browser by the device clock (it can
    disagree with the badge, the P5-04 lesson), and showing them to the manager labelled (the manager's full list
    is P6-02c's page). Additive and reversible. Basis: autonomous; `queries.py::live` already exists for this.
  - **D3 The legacy Dashboard** isn't routed (`app/routes.tsx` renders `BeingMigrated` for legacy pages), so its
    `BuildingUpdatesFeed` embeds are removed with nothing in their place; P6-05 replaces the page. Basis: code.
  - **D4 Mark read by an explicit "Mark as read" button.** The body shows in the feed, so there is no "open" to
    hang it on, and marking everything on screen read would clear notices nobody read. P6-02b may also mark read
    when a notice is opened at `/notices/<id>`. Basis: autonomous, reversible.
  - **D5 Order: newest written first** (`notices_list` pages by `Notice.id`, P6-01b D4). A draft written early and
    published late sorts below newer ones; ordering by `published_at` needs a keyset and an index migration.
    Accepted limitation, a follow-up for the inbox. Basis: existing API.
- Estimate: ~370 non-test lines: hooks ~65, page with the badge-follow logic ~70 (`MyPackagesPage` 83 has two
  lists and the focus handling this page lacks), list with cards and the read button ~140 (`MyPackageList` 139),
  renderer ~45, nav label ~23, pages, routes and nav ~15, backend parameter ~10. The fitness test rewrite is test
  code.
- Split: the one-notice view moved to P6-02b (above).
