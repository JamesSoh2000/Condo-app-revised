# P4-08 — Frontend onboarding and approval screens

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-05, P4-06, P2-06 |
| Replaces old | M4-T08 |
| Status | todo |

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

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
