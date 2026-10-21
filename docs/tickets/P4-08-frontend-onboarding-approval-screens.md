# P4-08 — Frontend onboarding and approval screens (split)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-05, P4-06, P2-06 |
| Replaces old | M4-T08 |
| Status | split into [P4-08a](./P4-08a-join-flow-and-status-screens.md), [P4-08b](./P4-08b-manager-pending-requests.md), [P4-08c](./P4-08c-members-administration.md) |

Split while framing (2026-10-21): the estimate was ~1,100 non-test lines. P4-08a is the join flow and the
pending, denied and no-membership screens (criteria 1–3 and the join half of 6 and 7); P4-08b the manager's
pending tab, decisions and nav badge (criterion 4, the pending-list half of 6, the `Residents` half of 7);
P4-08c the members tab (criterion 5). The carried items moved with the part they belong to.

## Goal

Residents join a building from its link and see their pending or denied status. Managers review the pending
queue, approve or deny, and administer members, all in the new typed frontend.

## Why

This completes demo journey 3 in the browser, and replaces the legacy `ResidentSetup`, `Onboarding`,
`Residents` and `PendingApprovalBlock` Base44 code.

## Scope

- In:
  - **`/join/:code`:**
    - looks up the building; an invalid code shows a friendly screen
    - if logged out: sign-up form (or "already have an account? log in" with `next`)
    - then the unit picker (search combobox using `join_units`, debounced) and the relationship choice (owner,
      tenant, household member, with plain-language help text)
    - submit, then the pending screen
  - **Pending screen** (from the P2-06 guard), with real data from `/onboarding/me`: the unit and
    relationship submitted, and "the building manager will review your request".
  - **Denied screen:** the reason, plus "submit again" (back to the unit picker).
  - **Manager `/manage/residents`:**
    - tabs "Pending requests" and "Members"
    - pending tab: approve, and deny (dialog with a required reason); the pending count badge in the nav
    - members tab: filter by role and status, search, row actions (roles editor, suspend/reactivate,
      deactivate (move-out) with a reason, transfer unit)
    - confirmation dialogs; 409 `last_manager`, `cannot_target_self` and `already_decided` shown as clear
      messages
  - Remove the legacy pages from the route allowlist, delete them if unused, and lower the ratchet.
- Out:
  - a bulk-approval UI
  - document evidence

## Interfaces

Consumes `auth_signup`, `join_*`, `onboarding_*` and `members_*`.

## Acceptance criteria

1. **Given** a fresh browser on `/join/MAPLE-2026`, **when** the user signs up, picks 1003 as a tenant and
   submits, **then** the pending screen shows unit 1003.
2. **Given** a manager approves in another browser, **when** the resident reloads, **then** they land on the
   resident home.
3. **Given** a deny with a reason, **then** the resident sees the reason and can resubmit.
4. **Given** a double-click on Approve, **then** one request is sent (button disabled while pending). A 409
   from a colleague's decision shows "Already decided by someone else" and refreshes the list.
5. **Given** the last manager tries to remove their own role, **then** the `last_manager` message shows, and
   nothing changes.
6. **Given** mobile width (375 px), **then** the join flow and the manager pending list are usable.
7. **Given** the ratchet, **then** the Base44 count drops by the removed legacy pages.

## Test plan

- Vitest for the join form validation and the decision dialogs.
- E2E in P4-09.
- Manual on the local stack.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`.

## Likely files

`frontend/src/features/onboarding/**`, `frontend/src/features/members/**`, `frontend/src/app/routes.tsx`,
`frontend/src/app/routeScope.ts`, legacy `frontend/src/pages/{ResidentSetup,Onboarding,Residents}.jsx`
(removed), `frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. How does the pending screen get its data without operational building access?
2. Why disable the button *and* rely on the server's conditional update?
3. How do you explain "owner vs tenant vs household" to a non-technical resident in the UI?

## Carried from P2-06b

- `NoMembershipScreen` (`frontend/src/features/membership/MembershipScreens.tsx`) should let the user enter a
  join link or code (P2-06's scope). P2-06b left the field out because the join route and its lookup didn't
  exist; add it with the join flow. `DeniedScreen` should show the manager's reason once P4-05 returns one.

## Carried from P4-06b

- Backend test gap (review round 2, L1 of PR #94): add a `[noop]` case to
  `backend/tests/memberships/test_members_concurrency.py::test_stale_manager_cannot_move_a_member` (a
  demoted manager's same-unit, same-relationship transfer must still get 403 / 404). The code is correct
  today (`transfer_member` calls `refuse_stale` in its no-op branch); nothing proves it.
- The screens should handle the new 409 codes: `occupancy_changed` (reload and retry), `not_a_resident`,
  `unit_inactive`, `cannot_target_self`, `last_manager`.

## Carried from P4-07b

- **Four Lows from P2-06c's account menu** (`frontend/src/app/AccountMenu.tsx`, PR #65 round 3), carried
  through P4-07a and P4-07b, which didn't touch the menu. Fix them test-first if this ticket touches the menu:
  - Back to the history entry where the panel was opened shows it again (`open = openAt === key`): clear
    `openAt` when the key changes.
  - A `/me`-driven change of the selected building leaves the panel open with new contents: also close it
    when `buildingId` changes.
  - During a building 401/404 the nav hides but the menu still offers "View as" from cached roles: apply the
    same 401/404 check in `BuildingChoices` (or in `useCanViewAs`).
  - Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space: use `pointerdown`.
- A signup or join that logs a new user in while the signed-in tree may be mounted must sweep the previous
  user's queries and call `useNewSession()` (`frontend/src/app/AuthProvider.tsx`), as
  `AcceptInvitePage.tsx` does after an accept (PR #96 D5/D6, review round 3 R3-1).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: see the status above; each part has its own Frame notes.
