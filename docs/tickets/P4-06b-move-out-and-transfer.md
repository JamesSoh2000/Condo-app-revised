# P4-06b — Members: move-out (deactivate) and transfer (split from P4-06)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-06a |
| Replaces old | part of [P4-06](./P4-06-membership-administration.md) |
| Status | todo |

## Goal

Property managers move a resident out (deactivate the membership and end the occupancy) or transfer them
to another unit, keeping occupancy history, without ever leaving the building without an active manager.

## Why

Moves are the most common membership change in a building, and they decide which unit records a person
may see (ADR-0010).

## Scope

- In (building router, `property_management`, on [P4-06a](./P4-06a-members-roles-suspension.md)'s
  members routes, building lock and last-manager check):
  - `POST /members/{membership_id}/deactivate` `{reason}`: move-out. Ends the current occupancy and sets
    the membership `deactivated` (`status_reason` the reason). The user's other buildings are unaffected.
  - `POST /members/{membership_id}/transfer` `{unit_id, relationship}` uses `transfer_occupancy` (P1-03).
  - Managers cannot deactivate themselves (409 `cannot_target_self`); deactivating the last active manager
    is 409 `last_manager`.
  - Audit `membership.deactivated` and `occupancy.transferred`; sessions follow (`apply_role_change`).
- Out: the frontend (P4-08); data export or deletion for leavers (pilot).

## Interfaces

`members_deactivate`, `members_transfer`.

## Acceptance criteria

(The original ticket's criteria 2, 5 and 6 for these routes. To sharpen while framing P4-06b.)

2. **Given** `a_resident1` is deactivated, **then** their occupancy has `ended_at` set. A package created
   for unit 101 afterwards is not visible to them (checked once P5 exists; for now, assert the occupancy
   window).
5. **Given** `transfer` to unit 102, **then** the old occupancy ended, the new one is current, and history is
   preserved.
6. **Given** `a_security`, **then** 403 on both endpoints. A building-B manager gets 404.

## Must explain (learning checkpoint)

1. Why is "deactivate" a move-out that ends occupancy, and not a delete?

## Carried from P1-03 (decide while framing)

From the P1-03 reviews (PR #45, ADR-0016). The occupancy helpers in `app/memberships/occupancy.py` are what
`deactivate` and `transfer` call:
- **Errors.** `start_occupancy`, `end_occupancy` and `transfer_occupancy` raise `OccupancyTimeError` (a
  `ValueError`) for times out of order, and `IntegrityError` for a second current occupancy or a unit or
  membership in another building. Map both to problem+json with stable codes; never return `str(exc)`.
- **Never pass a client-supplied `at`.** A start backdated into a previous occupant's time shows the
  newcomer that occupant's records (P1-03 review round 1, L1). Add a test that the endpoints call the helpers
  without `at`.
- **Lock order.** The helpers lock the membership row (`FOR NO KEY UPDATE`). The last-manager rule
  locks the `buildings` row: take the building first, then call the helpers.
- **Stale `now()`.** A transaction that began before a concurrent writer for the same membership committed
  can get `OccupancyTimeError` (its `now()` is older than that writer's row). Decide retry or 409, and test
  it; nothing tests it yet (P1-03 explanation §7).

## Carried from P4-06a (decide while framing)

- `status_reason` (added by P4-06a) must be cleared wherever a membership becomes `active` again: an
  invitation accept reactivating a `deactivated` membership (`app/invitations/service.py::_activate_membership`)
  would otherwise keep the move-out reason.
- Transfer: decide whether it needs the `resident` role and an active unit (P4-05b locks the unit
  `FOR KEY SHARE` and re-checks `is_active`), and whether a same-unit transfer (relationship change) is allowed.
- The P4-05b carry (requests left `pending` by an invitation) still applies to deactivation.
- **First, the open Medium from PR #93 (review round 3, Codex), test-first:** A holds only
  `property_management`, B holds `property_management` and `council`; A removes B's manager role while B's
  request removing A's waits on the building lock. B gets 403 `forbidden_role` instead of criterion 3's 409
  `last_manager`, because `change_roles` raises `LastManager` (the round 2 precedence check) inside
  `_caller_first`, which turns it into the stale refusal. Fix: let `LastManager` pass through `_caller_first`
  (keep the stale refusal for every other error), and add the case to
  `tests/memberships/test_members_concurrency.py::test_managers_acting_on_each_other_leave_one_manager`.
- **Pending invitations of a revoked manager** stay valid (Claude rounds 1-2): decide whether demoting or
  suspending a manager revokes the open invitations they created (in the same transaction, under the building
  lock), or whether the accept checks the creator; test the race with an accept.
- New writes follow P4-06a's pattern: `caller = await _lock_building(db, ctx)`, the target work inside
  `with _caller_first(caller):`, then `_finish` (see the P4-06a explanation §8).
- Tighten P4-06a's tests: criterion 8's non-cursor invalid parameters should assert 422 exactly; criterion 7
  with several roles added and removed (sorted lists). Fix the `invalid_transition` detail ("Only a active
  member…").

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: part b of [P4-06](./P4-06-membership-administration.md), framed at the split (2026-10-20); the
  rest is framed when it is picked.
