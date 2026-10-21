# P4-08c — Members administration screen (split from P4-08)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08b, P4-06b |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | todo |

Split from P4-08 while framing P4-08a (2026-10-21). Not framed yet: frame it when it is picked.

## Goal

Managers administer a building's members in the new typed frontend.

## Scope

- In:
  - The "Members" tab of `/manage/residents` ([P4-08b](./P4-08b-manager-pending-requests.md)): filter by
    role and status, search, row actions (roles editor, suspend/reactivate, deactivate (move-out) with a
    reason, transfer unit), with confirmation dialogs.
  - 409 `last_manager`, `cannot_target_self`, `occupancy_changed` (reload and retry), `not_a_resident`,
    `unit_inactive`, `membership_not_active`, `no_roles_left`, `invalid_transition` shown as clear messages.
- Out: bulk actions.

## Acceptance criteria (P4-08's, to sharpen when framing)

1. **Given** the last manager tries to remove their own role, **then** the `last_manager` message shows, and
   nothing changes.
2. **Given** mobile width (375 px), **then** the members list and its actions are usable.

## Carried from P4-06b (via P4-08)

- Backend test gap (review round 2, L1 of PR #94): add a `[noop]` case to
  `backend/tests/memberships/test_members_concurrency.py::test_stale_manager_cannot_move_a_member` (a
  demoted manager's same-unit, same-relationship transfer must still get 403 / 404). The code is correct
  today (`transfer_member` calls `refuse_stale` in its no-op branch); nothing proves it.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
