# P6-02c — Manager notice list, publish and archive

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02a, P6-01b |
| Replaces old | M6-T04 (manager list part) |
| Status | todo |

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
  - each row opens the P6-02a detail (`NoticeBody`), drafts included for the manager
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
3. Why can security see the feed but not this page?

## Open decisions (resolve while framing)

1. **Who opens the page.** Only property management authors (P6-01b); `PAGE_ACCESS.ManagementNotices` lists
   every staff role. Framing decides whether security and council get the page read-only or not at all.
2. **The page's path** (a migrated `path`, as `Residents` has, or the legacy name).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
