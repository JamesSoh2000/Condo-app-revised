# P6-02e — List focus fixes ("Load more", the feed card)

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02c |
| Replaces old | — |
| Status | todo |

Split from [P6-02d](./P6-02d-notice-editor.md) while framing (its D5): the two carries from
[P6-02c](./P6-02c-manager-notice-list-and-actions.md)'s review, which touch other features' lists.

## Goal

Keyboard focus never falls to `<body>` when a list's own control or row disappears.

## Scope

- In: the "Load more" button of `frontend/src/features/notices/{ManagerNoticeList,NoticeList}.tsx`,
  `features/packages/{WaitingList,MyPackageList}.tsx` and the residents lists; the feed card in
  `features/notices/NoticeList.tsx::Card`.
- Out: any other change to these lists.

## Acceptance criteria

1. **Given** a list with one more page, **when** "Load more" fetches the last page and removes itself, **then**
   focus moves to the first new row (or the list's heading if there is none), in each list above, one test per
   list, asserting `document.activeElement`.
2. **Given** focus inside a feed card, **when** a refresh removes that card, **then** focus moves to the list's
   heading, as `ManagerNoticeList.tsx::Row` does (P6-02c review round 1 F1).
3. Checked in Chromium (the CLAUDE.md lesson): focus after both actions, by keyboard.

## Test plan

- One test per list for criterion 1; `notices.test.tsx` for criterion 2; a Chromium check.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken:
- Split:
