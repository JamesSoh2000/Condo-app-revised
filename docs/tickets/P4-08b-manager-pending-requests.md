# P4-08b — Manager pending requests (split from P4-08)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08a, P4-05b, P2-06c |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | todo |

Split from P4-08 while framing P4-08a (2026-10-21). Not framed yet: frame it when it is picked.

## Goal

Managers review the pending join requests and approve or deny them in the new typed frontend.

## Scope

- In:
  - **Manager `/manage/residents`** (replaces the legacy `Residents` placeholder route and nav item): tabs
    "Pending requests" and "Members" (the members tab's content is [P4-08c](./P4-08c-members-administration.md);
    until then it says so).
  - Pending tab (`onboarding_list`): approve, and deny (dialog with a required reason, 3–500 characters
    as `OnboardingDecisionIn`); confirmation dialogs.
  - The pending count badge in the nav (`onboarding_summary`).
  - 409 `already_decided` ("Already decided by someone else", and the list refreshes),
    `membership_not_pending` and `unit_inactive` as clear messages.
  - Remove `Residents` from the route allowlist, delete `pages/Residents.jsx` if unused, lower the ratchet.
- Out: a bulk-approval UI; document evidence.

## Acceptance criteria (P4-08's, to sharpen when framing)

1. **Given** a double-click on Approve, **then** one request is sent (button disabled while pending). A 409
   from a colleague's decision shows "Already decided by someone else" and refreshes the list.
2. **Given** mobile width (375 px), **then** the manager pending list is usable.
3. **Given** the ratchet, **then** the Base44 count drops by the removed legacy page.

## Carried from P4-07b (via P4-08)

- **Four Lows from P2-06c's account menu** (`frontend/src/app/AccountMenu.tsx`, PR #65 round 3). Fix them
  test-first if this ticket touches the menu:
  - Back to the history entry where the panel was opened shows it again (`open = openAt === key`): clear
    `openAt` when the key changes.
  - A `/me`-driven change of the selected building leaves the panel open with new contents: also close it
    when `buildingId` changes.
  - During a building 401/404 the nav hides but the menu still offers "View as" from cached roles: apply the
    same 401/404 check in `BuildingChoices` (or in `useCanViewAs`).
  - Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space: use `pointerdown`.

## Must explain (learning checkpoint)

1. Why disable the button *and* rely on the server's conditional update?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
