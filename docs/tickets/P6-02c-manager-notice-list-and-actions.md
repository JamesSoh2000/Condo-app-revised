# P6-02c — Manager notice list, publish and archive

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02a, P6-01b |
| Replaces old | M6-T04 (manager list part) |
| Status | in progress |

Split from the P6-02 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-02a](./P6-02a-notices-feed-and-detail.md), before [P6-02d](./P6-02d-notice-editor.md).

## Goal

Property management manages the building's notices on one page: drafts, published, expired and archived, with
publish and archive actions. It replaces the legacy `ManagementNotices` page.

## Why

Journey 5's manager half ("The manager publishes a normal notice and an urgent notice"). The authoring API is
merged (P6-01b); this is its list and its two action endpoints in the UI. The editor that writes drafts is
P6-02d, so this page is usable with drafts written through the API first.

## Scope

- In (`frontend/src/features/notices/`):
  - **manager page** (route and roles decided in framing; `PAGE_ACCESS.ManagementNotices` today lists every staff
    role while only property management may author, P6-01b), tabs or a filter by `status`
    (`draft`, `published`, `archived`) over `notices_list`, in the order P6-02a settles, 25 a page with "Load
    more"; expired published notices are told apart
  - **publish** and **archive** confirm dialogs (`POST …/publish`, `…/archive`): one request per confirm, 409
    `invalid_transition` and 422 `notice_expired` turned into messages, the lists and the P6-02a feed and badge
    refreshed (`features/packages/PackageDialog.tsx::usePackageSubmit`)
  - each row shows its body through P6-02a's `NoticeBody` (or opens P6-02b's notice view, if merged), drafts
    included for the manager
  - delete `src/pages/ManagementNotices.jsx`; its legacy `/ManagementNotices` path reaches the new page
    (`app/routes.tsx::LegacyRedirect`); lower the ratchet
- Out: writing or editing a draft (P6-02d); bulk actions; scheduling

## Interfaces

Consumes `notices_list` with `status`, `notices_get`, `notices_publish` and `notices_archive` (property
management only; 403 for other roles, 409 `invalid_transition`, 422 `notice_expired`).

## Acceptance criteria

1. **Given** `a_manager` and notices in every status, **then** each status's list shows only its notices, in the
   order P6-02a settles, and an expired published notice is labelled expired.
2. **Given** a draft, **when** the manager confirms publish, **then** exactly one request is sent, the draft moves
   to the published list, and the feed and badge (P6-02a) refresh; the dialog shows 422 `notice_expired` and 409
   `invalid_transition` as messages and stays open.
3. **Given** a published notice or a draft, **when** the manager confirms archive, **then** it moves to archived;
   archiving an archived one (another tab) shows the 409 message.
4. **Given** two managers publishing the same draft at once, **then** one succeeds, the other sees the 409
   message, and both lists end the same (tenant row 10, UI side).
5. **Access (tenant rows 1, 2, 4).** Property management opens the page; a signed-out user goes to login; the
   roles framing excludes get `/403` without asking the API; a building with `notices` off gives `/403`.
6. **Given** 375 px in Chromium with a 200-character unbroken title, **then** rows and dialogs stay inside the
   viewport, and focus returns to the row's action after a dialog closes.
7. The legacy page is deleted, `/ManagementNotices` reaches the new page, and the ratchet is lowered.

Sharpened while framing (the criteria above keep their words; these say how they are tested):

- **1.** The page is `/manage/notices` (D2) with three lists, "Drafts", "Published" and "Archived", one shown at a
  time behind three toggle buttons (`aria-pressed`), Drafts first. Each asks `notices_list?status=<status>` (25 a
  page, "Load more" while `next_cursor` is set) and shows the API's order, newest written first (P6-02a D5). A
  published notice whose `expires_at` is at or before the device's clock (rechecked each minute) has an "Expired"
  label, as text; the server's clock still decides publishing (the 422 below).
- **2, 3.** A draft row has "Publish" and "Archive"; a published row (expired or not) has "Archive"; an archived row has
  none. One request per confirm, also for two clicks in the same tick. Whatever the answer, every notices query of the
  building (the three lists, the feed, the summary badge, the urgent banner, a notice) is cancelled, then asked again.
  On 409 `invalid_transition` the dialog says the notice was already published or archived elsewhere; on 422
  `notice_expired` that its expiry has passed and it must be edited first; any other failure (500, network, 429)
  says so with the rate-limit wording where it applies. In each case the dialog stays open, its buttons enabled
  again, and the alert takes focus.
- **6.** Focus after a dialog closes: Cancel and Escape (not while sending) return it to the row's button that opened
  the dialog; after a success the row leaves its list, so focus goes to the page's outcome message ("“<title>” was
  published." / "… archived."), as `WaitingList` does. If a refresh took the opener away while the dialog was open,
  focus goes to the list's heading.

Added while framing:

8. **A case the ticket missed: switching building.** With the page open in A, choosing building B shows only B's
   notices: nothing of A's rows shows while B's load, and an open dialog closes (the page is keyed by building).
9. **Carried from P6-02b:** in the feed (`NoticeList.tsx`), after "Mark as read" succeeds and its button is gone,
   focus is on the card (a container that stays mounted), not `<body>`; a failed read leaves focus on the button.
10. **Carried from P6-02b (step 8 promotion):** `CLAUDE.md` "Lessons learned" gains the lesson that a control which
    removes or disables itself drops focus to `<body>`: move focus to something that stays mounted first, and assert
    `document.activeElement` after the action in the test.
11. **Tenant row 3, UI side:** the page asks only the selected building's `/api/buildings/{id}/notices…` URLs, and a
    `building_not_found` from any of them marks the building denied as every building query does
    (`app/buildingDenial.ts`; the mutation key starts with `['b', buildingId]`).

## Test plan

- `frontend/src/features/notices/managerNotices.test.tsx`: criteria 1–5, 7
- Chromium check at 375 px (criterion 6); the journey on `make up`, transcript in the PR; `make check`

## Likely files

`frontend/src/features/notices/{ManagerNoticesPage.tsx,ManagerNoticeList.tsx,PublishDialog.tsx,
ArchiveDialog.tsx,api.ts}`, `frontend/src/app/{pages.ts,routes.tsx,routeScope.ts}`,
`frontend/src/pages/ManagementNotices.jsx` (deleted), `frontend/base44-baseline.txt`. Reuse
`features/packages/WaitingList.tsx`, `PackageDialog.tsx`, `features/residents/Modal.tsx`.

## Must explain (learning checkpoint)

1. Why does the UI never send `PATCH status`, and what does a 409 tell it?
2. Of two publishes at once, which wins and how does the loser's screen recover?
3. Which roles open this page and which only the feed, and why (as framing settles it)?

## Open decisions (resolve while framing)

1. **Who opens the page.** Only property management authors (P6-01b); `PAGE_ACCESS.ManagementNotices` lists
   every staff role. Framing decides whether security and council get the page read-only or not at all.
2. **The page's path** (a migrated `path`, as `Residents` has, or the legacy name).

## Carried from P6-02b (decide while framing)

- **First follow-up (step 8 promotion):** "a control that removes or disables itself drops focus to `<body>`" is
  in `docs/AGENT_MISTAKES_LOG.md` again (P2-06c, P4-07a, P4-08b, P5-03d, P6-02b R2 F1). Promote it: a `CLAUDE.md`
  lesson, or a fitness/test helper that asserts focus after an action that removes its own button.
- The feed card's "Mark as read" (`frontend/src/features/notices/NoticeList.tsx`, P6-02a) still drops focus to
  `<body>` when it disappears after a read. It's outside any dialog, so Low. Fix it with this ticket's list work, as
  the dialog and banner do (focus a container that stays mounted).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1, 2, 3 and 6 sharpened (above); 8–11 added. Criterion 6's "focus returns to the
  row's action" can't hold after a success, because the row leaves its list; it is sharpened to the outcome message
  then, and the opener otherwise (as `WaitingList`, P5-03d). That doesn't loosen it: the cases where the opener still
  exists keep it.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
  - **D1 Who opens the page: property management only** (open decision 1). Basis: the API. Only property
    management may publish or archive (P6-01b `_AUTHOR`), and `visible_notices` gives security and council only live
    notices, the feed's list. A read-only page for them would show the feed again with no drafts, so their notices
    oversight (PRODUCT_SCOPE: council "read-only oversight: notices") is the `/notices` feed. Alternative: keep
    `STAFF` with the actions hidden; lost because it duplicates `/notices` and invites a 403 on every action. Security
    and council lose a nav item ("Daily notices") that led to a placeholder; nothing worked there before.
  - **D2 Path `/manage/notices`, label "Manage notices"** (open decision 2). Basis: convention, as `Residents` took
    `/manage/residents` (P4-08b); `/ManagementNotices` redirects there (`LegacyRedirect`, query and hash kept).
    "Manage notices" tells it apart from the feed's "Notices" in the same nav.
  - **D3 One list at a time behind toggle buttons**, not three stacked lists (as `MyPackagesPage`) or a tablist.
    Basis: simplest reversible choice. Three stacked lists ask three paged queries on every mount; a WAI-ARIA
    tablist needs arrow-key handling the codebase doesn't have yet. Each list keeps its own query key, so switching
    back shows its cache and asks again (stale at once).
  - **D4 Expired by the device's clock.** No `expired` status exists; the API's `live()` uses the database clock but
    the list doesn't return a flag. Alternative: a second `live=true&status=published` query and mark what it lacks;
    lost: twice the requests and paging two lists against each other. Limitation: a device clock that is off shows
    the label early or late; publishing still checks the server's clock (422).
  - **D5 Rows show the body inline** through `NoticeBody`, drafts included, with no link to `/notices/<id>`: the
    feed's notice view (P6-02b) closes back to the feed, not here. The attachment shows in P6-02d's editor.
  - **D6 One dialog component for both actions** (`NoticeActionDialog.tsx`) instead of `PublishDialog` and
    `ArchiveDialog`: the two differ only in wording and endpoint. Unlike packages' `usePackageSubmit`, a 409 keeps the
    dialog open (criterion 2 says so), so it has its own small submit hook rather than a flag on the packages one.
  - **D7 Existing tests that used `/ManagementNotices`** as "a legacy staff page" (`shell.test.tsx`,
    `building.test.tsx`, `nav.test.tsx`) move to `/ManagementMaintenance`, which has the same `STAFF` roles and a
    feature. Same assertions on another page that still has the old shape; not a loosened test.
- Split: none. Estimate ~370 non-test lines (page and list ~180, measured against `WaitingList.tsx` at 206; dialog
  and submit hook ~100, against `PackageDialog.tsx` at 120; hooks ~45; routes, pages, feed focus, lesson ~45).
- Review (this run, James's in-session instruction): the one reviewer is Codex `gpt-6.1-sol` at high effort through the
  `codex-review` skill, in place of the Tier 2 fresh Claude reviewer; no Claude reviewer is spawned.
