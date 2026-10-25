# P6-02e — List focus fixes ("Load more", the feed card)

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-02c |
| Replaces old | — |
| Status | in progress |

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

The lists (seven components): the feed (`notices/NoticeList`), the manager's lists (`notices/ManagerNoticeList`), the
desk's "Waiting" (`packages/WaitingList`), the resident's packages (`packages/MyPackageList`, both its lists), and the
residents tabs' `Members`, `Invitations` and `PendingRequests`. "The list's heading" is the heading focus already
falls back to there: the feed page's `h1`, the manager page's list `h2`, and each other list's own `h2` (made
focusable with `tabIndex={-1}` where it is not yet).

1. **Given** a list with one more page and focus on its "Load more" (or "Show more"), **when** it is pressed, **then**
   focus moves at once to the last row shown (the button disables while the page loads, which drops focus in a
   browser), and when the page has landed it moves to the first new row, or to the list's heading if the page
   added no row; the button removes itself after the last page. One test per list, asserting `document.activeElement`
   after the last page.
2. **Given** focus inside a feed card, **when** a refresh removes that card, **then** focus moves to the feed's heading,
   as `ManagerNoticeList.tsx::Row` does (P6-02c review round 1 F1).
3. Checked in Chromium (the CLAUDE.md lesson): focus after both actions, by keyboard.
4. (Added) **Given** a page that is not the last, **when** it lands, **then** focus moves to its first new row too, and
   the button stays (enabled again).
5. (Added) **Given** the next page fails, **then** focus moves back to the button, which stays, and the existing alert
   says so.
6. (Added) **Given** the press did not leave focus on the button (a mouse in a browser that does not focus buttons),
   or focus has moved elsewhere by the time the page lands (the user tabbed on), **then** focus is left where it is.
7. (Added) **Given** a feed card unmounts with the whole feed (leaving the page), **then** nothing is focused by it.

## Test plan

- One test per list for criterion 1; `notices.test.tsx` for criterion 2; tests for 4–7 on the shared hook through one
  list each; a Playwright Chromium script against the stack for criterion 3.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 names the seven components and each fallback heading, and adds the first step
  (focus parks on the last row before the button disables: in Chromium a focused button that becomes `disabled`
  loses focus to `<body>`, which also happens on a press that is not the last page). 4–7 added: a page that is not
  the last, a failed page, a press or landing where focus is not on the button, and the feed unmounting. The
  10-case tenant table does not apply: no endpoint changes (frontend only).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken:
  - D1: one shared hook for the seven lists (P6-02c review round 1 F2: "one fix for all of them belongs in one
    place"), in a new `frontend/src/features/lists/`, since no shared feature folder exists. Rows become focusable
    with `tabIndex={-1}`, as the feed card already is.
  - D2: the first new row is found by position in the list element after the page lands (the row count at the
    press), not by item id, so the hook needs no knowledge of each list's item type. A refresh that reorders rows
    during the load can land focus on a different row, never on `<body>`.
  - D3: out of scope, recorded as follow-ups: a "Load more" that is disabled by a background refresh (a focus
    refetch) while it holds focus, and the notifications panel's "Load more" (not named in the ticket's scope).
- Split: none. Estimate ~120 non-test lines (hook ~45, seven lists ~8–12 each).
