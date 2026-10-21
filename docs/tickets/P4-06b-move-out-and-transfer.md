# P4-06b — Members: move-out (deactivate) and transfer (split from P4-06)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-06a |
| Replaces old | part of [P4-06](./P4-06-membership-administration.md) |
| Status | in progress |

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

(The original ticket's criteria 2, 5 and 6, sharpened while framing; criteria 1, 3, 4 and 7-15 added.
"Nothing written" means: the membership, its roles, its occupancies, invitations and audit events are
as before.)

1. **Deactivate (move-out).** A manager's `POST …/members/{id}/deactivate` `{reason}` on an `active` or
   `suspended` member returns 200 `MemberOut` with `status` `deactivated`, `status_reason` the reason, and
   no unit. The member's current occupancy (if any) gets `ended_at` = the transaction's `now()`; their
   roles are kept; their next request in this building is a 404 and their other buildings are unaffected.
   One audit event `membership.deactivated` (entity `membership`, actor the manager, metadata
   `{"unit_id": <the ended occupancy's unit or null>}`, never the reason). Their sessions are capped as
   for a role change (`apply_role_change`).
2. **Given** `a_resident1` is deactivated, **then** their occupancy has `ended_at` set. A package created
   for unit 101 afterwards is not visible to them (checked once P5 exists; for now, assert the occupancy
   window): `occupancy_window(a_resident1, 101, t)` is true for a `t` inside the old window and false for
   `t >= ended_at`.
3. **Deactivate refusals** (nothing written): the caller themself → 409 `cannot_target_self`; the last
   active manager (who can log in) → 409 `last_manager`; a `pending`, `denied` or `deactivated` member →
   409 `invalid_transition` (pending ones are denied through their join request instead); a missing,
   empty, too long or control-character reason, or an extra field → 422 (the suspend reason's rules).
4. **Transfer.** `POST …/members/{id}/transfer` `{unit_id, relationship}` moves an `active` member who
   holds `resident`: their current occupancy (if any) ends and a new current one of `unit_id` starts at the
   same instant (`transfer_occupancy`), and returns 200 `MemberOut` with the new unit and relationship. A
   resident with no current unit gets one. One audit event `occupancy.transferred` (entity `membership`,
   metadata `{"from_unit_id": <old unit or null>, "to_unit_id": …}`). The same unit with a new
   relationship is a transfer (history keeps both); the same unit and relationship is 200 with nothing
   written. Refusals (nothing written): not `active` → 409 `membership_not_active`; no `resident` role →
   409 `not_a_resident`; an unknown unit or another building's → 404 `unit_not_found` (tenant row 7); an
   inactive unit → 409 `unit_inactive` (the unit row is read `FOR KEY SHARE`, as P4-05b's approve).
5. **Given** `transfer` to unit 102, **then** the old occupancy ended, the new one is current, and history is
   preserved: the old row's `ended_at` equals the new row's `started_at`, earlier rows are unchanged, and
   the window is true for 101 before the transfer, false for 101 after it and true for 102 after it.
6. **Given** `a_security`, **then** 403 on both endpoints (also `a_resident1`, `a_council`). A building-B
   manager gets 404; so do `a_pending` and `a_suspended` callers; unauthenticated is 401. Another
   building's member or an unknown id is 404 `member_not_found`, with the same body.
7. **No client time.** Neither body accepts an `at` (or any extra field: 422), and both routes call the
   occupancy helpers without `at` (a test spies on the calls).
8. **Errors from the helpers.** An `OccupancyTimeError` (the stale-`now()` race: this transaction began
   before a concurrent occupancy writer for the same membership committed) is 409 `occupancy_changed` with
   nothing written; a test reproduces it with a transaction begun before a concurrent transfer commits.
   A stale manager still gets their own refusal first (P4-06a `_caller_first`).
9. **Races** (tenant row 10; real connections): two deactivations of one member → one 200, one 409
   `invalid_transition`, one audit event; two managers deactivating each other → one 200, one 409
   `last_manager`, one active manager left; a deactivation waiting for a transfer of the same member ends
   the new occupancy (no error).
10. **Carry (open Medium, PR #93).** A holds only `property_management`, B holds `property_management` and
    `council`; A removes B's manager role while B's request removing A's (leaving A no role) waits on the
    building lock: B gets 409 `last_manager`, not 403 (`LastManager` passes through `_caller_first`).
11. **Carry: a revoked manager's invitations.** After any members write, if the target member is no
    longer an active `property_management` member, every open invitation of this building they created
    is revoked in the same transaction (one `invitation.revoked` event each, actor the manager, metadata
    `{"membership_id": …}`). Applies to role removal, suspension and deactivation. Race with an accept
    (both take the building row lock): whichever commits first wins; an accept after the revocation is 404
    `invitation_invalid`, a revocation after the accept leaves it accepted.
12. **Carry: `status_reason`.** An invitation accept that reactivates a `deactivated` membership clears
    `status_reason`.
13. **Carry (P4-05b).** A join request left `pending` by an invitation stays hidden from the managers' list
    and count after the member is deactivated, and approving it is 409 `membership_not_pending`.
14. **Carry: P4-06a tests tightened.** The list's invalid non-cursor parameters are exactly 422; a role
    change adding two roles and removing two audits sorted `added` and `removed` lists; the
    `invalid_transition` details read correctly ("Only an active member…").
15. **Lock order.** Every new write takes the building row, then the target membership, then (transfer)
    the unit, then calls the helpers (which lock the membership again): no deadlock with P4-06a's writes or
    an invitation accept.

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

- Criteria added or sharpened: 2, 5 and 6 made exact (window checks, equal end/start instants, every
  tenant row that applies); added 1, 3, 4 (the routes' behaviour and refusals), 7-9 (the P1-03 carries:
  no client `at`, helper errors, stale `now()`, races), 10-14 (the P4-06a carries), 15 (lock order).
  Cases the ticket missed: deactivating a `suspended` member, transferring a resident with no current
  unit, the same-unit transfer, and a member's open invitations once they stop being a manager by
  deactivation (not only demotion or suspension).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Deactivate from `active` and `suspended`; `pending` is decided through its join request (P4-05b),
    `denied`/`deactivated` are 409 `invalid_transition`. Roles are kept (history; an invitation replaces
    them on return, P4-02b). Autonomous; ADR-0010 calls the move-out a deactivation.
  - Transfer needs `active` and the `resident` role (ADR-0010: an occupancy belongs to a resident
    membership, as P4-02b's `_activate_membership` already assumes) and an active unit locked
    `FOR KEY SHARE` (P4-05b's pattern). A same-unit relationship change is a transfer; an exact no-op is
    200 with nothing written (P4-06a's role no-op). Autonomous.
  - `OccupancyTimeError` → 409 `occupancy_changed`, not a retry: the race needs a concurrent occupancy
    writer for the same member inside a request's first milliseconds; the client reloads. Simplest,
    reversible. `IntegrityError` is not mapped: the unit is loaded in the building first and the
    membership lock prevents a second current occupancy, so one would be a bug (500), not a client error.
  - Revoked manager's invitations: revoke them in the same transaction (criterion 11) rather than check
    the creator at accept: an operator's invitation has no creator, and the revocation is visible in the
    invitations list and the audit log. Lasting: inbox "Decisions to audit" in step 6.
  - The P4-05b carry needs no change: `_membership_pending` hides a request whose membership is in any
    other status; criterion 13 tests it for `deactivated`.
- Estimate: ~250 non-test lines. No split.
- Split: part b of [P4-06](./P4-06-membership-administration.md), framed at the split (2026-10-20), and
  framed here (2026-10-21).
