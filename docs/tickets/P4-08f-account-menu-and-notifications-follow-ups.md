# P4-08f — Account menu and notifications panel follow-ups (from P4-08d)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08d |
| Replaces old | — |
| Status | todo |

Created by [P4-08d](./P4-08d-pending-badge-and-onboarding-follow-ups.md) (PR #101) for follow-ups it left out of scope.
Not framed yet: frame it when it is picked.

## Goal

The account menu's four open Lows and the notifications panel's paging race are fixed, test-first.

## Scope

- In:
  - **Four Lows from P2-06c's account menu** (`frontend/src/app/AccountMenu.tsx`, PR #65 round 3; carried through
    P4-07b, P4-08, P4-08b and P4-08d, which took them only if it touched the menu):
    - Back to the history entry where the panel was opened shows it again (`open = openAt === key`): clear `openAt`
      when the key changes.
    - A `/me`-driven change of the selected building leaves the panel open with new contents: also close it when
      `buildingId` changes.
    - During a building 401/404 the nav hides but the menu still offers "View as" from cached roles: apply the same
      401/404 check in `BuildingChoices` (or in `useCanViewAs`).
    - Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space: use `pointerdown`
      (the bell, `NotificationBell.tsx`, has the same listener).
  - **The notifications panel's "Show more"** (`frontend/src/features/notifications/NotificationPanel.tsx`): it calls
    `fetchNextPage()` without `cancelRefetch: false` and is disabled only while the next page loads, the shape PR #99
    round 2 F1 fixed in `PendingRequests` (a next page cancels a refresh after mark-read and appends to old pages). Not
    verified: write the test first. Also check the failed-refresh case (PR #99 round 3 F1).
- Out: anything else in the menu or the panel.

## Acceptance criteria (to sharpen when framing)

1. Each Low above has a failing test first, then passes.
2. **Given** a mark-read whose list refresh is in flight or failed, **then** "Show more" doesn't leave a read
   notification shown as unread (or the test shows it can't happen).
