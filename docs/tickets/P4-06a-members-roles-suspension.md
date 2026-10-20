# P4-06a — Members: list, roles, suspend, reactivate (split from P4-06)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P2-04, P4-05b |
| Replaces old | part of [P4-06](./P4-06-membership-administration.md) |
| Status | in progress |

## Goal

Property managers list the building's members, change their roles, suspend and reactivate them. The
building can never be left without an active manager.

## Why

Real buildings constantly change staff. Access must change immediately and safely. The "last manager"
invariant is a good real-world concurrency exercise.

## Scope

- In (building router, `property_management`; paths under `/api/buildings/{building_id}`):
  - `GET /members?role=&status=&search=&cursor=&limit=`.
  - `POST /members/{membership_id}/roles` `{add: Role[], remove: Role[]}`.
  - `POST /members/{membership_id}/suspend` `{reason}` and `POST /members/{membership_id}/reactivate`.
  - **Last-manager invariant:** a change that would leave zero active `property_management` memberships in
    the building is 409 `last_manager`. Each write takes the `buildings` row lock first (serializes these
    writes per building), makes its change, then counts; refusing rolls the change back.
  - Managers cannot suspend themselves (409 `cannot_target_self`).
  - Audit: `membership.roles_changed` (metadata `added`, `removed`), `membership.suspended`,
    `membership.reactivated`.
  - Sessions follow every role or status change (`apply_role_change`, P4-02b carry).
  - A nullable `building_memberships.status_reason` column (the suspension's reason, shown to managers).
- Out:
  - deactivate (move-out) and transfer: [P4-06b](./P4-06b-move-out-and-transfer.md)
  - the frontend (P4-08)
  - telling the member (notification or email) that they were suspended or their roles changed

## Interfaces

`members_list`, `members_roles_update`, `members_suspend`, `members_reactivate`. Response of the three
writes: the member as the list shows it (`MemberOut`).

## Acceptance criteria

(The original ticket's criteria 1, 3, 4, 6 and 7, sharpened while framing; 8–17 added. Paths are under
`/api/buildings/{building_id}`.)

1. **Suspend.** **Given** `a_manager` suspends `a_resident1` (`POST /members/{id}/suspend`
   `{"reason": "Unpaid fees"}`), **then** 200 with `status: "suspended"` and `status_reason` the trimmed
   reason; the row's `status_changed_by_user_id` is the manager. `a_resident1`'s **existing** session then
   gets 404 `building_not_found` on `GET /api/buildings/{A}` (no new login), and `GET /api/auth/me` lists
   the A membership as `suspended`. Suspending `multi_in_a` leaves `multi`'s building-B membership working
   (200 on `GET /api/buildings/{B}`).
3. **Given** two active managers, **when** each concurrently removes the other's `property_management`
   role (real connections), **then** exactly one gets 200 and the other 409 `last_manager`; afterwards
   exactly one active manager remains. (Also with suspend: two managers suspending each other give one 200
   and one 409.)
4. **Given** a single manager, **when** they remove their own `property_management` role, **then** 409
   `last_manager` and their roles are unchanged. Suspending themselves gives 409 `cannot_target_self`.
   With a second manager present, removing their own manager role succeeds.
6. **Given** `a_security`, `a_resident1` or `a_council` (council without property_management), **then**
   403 `forbidden_role` on all four endpoints. A building-B manager gets 404 `building_not_found`;
   `a_pending` and `a_suspended` get 404; no session gets 401 (tenant rows 2, 3, 4, 6).
7. **Given** role changes, **then** one `membership.roles_changed` audit event (entity the membership)
   whose metadata lists exactly the roles added and removed, sorted. Roles sent but already held (add) or
   not held (remove) are not listed; a request that changes nothing is 200 with no audit event.
8. **List.** `GET /members` returns only building A's memberships, newest first, cursor-paginated:
   `membership_id`, `user_id`, `full_name`, `email`, `status`, `roles` (sorted), `status_reason`, and the
   current occupancy's `unit_id`, `unit_label`, `tower`, `relationship` (null when none). `role=` keeps
   members holding that role; `status=` keeps that status; `search=` keeps members whose name or email
   contains the text, any case, with `%`, `_` and `\` matched literally; they combine. `multi` appears with
   A's roles only. An invalid `role`/`status` value or a `search` over 100 characters is 422.
9. **Target tenancy.** A building-B membership id or a random id on any write is 404 `member_not_found`,
   with the same body (tenant rows 3/5).
10. **Invalid transitions.** Suspending a membership that is not `active` (pending, denied, suspended,
    deactivated) or reactivating one that is not `suspended` is 409 `invalid_transition`; changing the roles
    of a membership that is not `active` is 409 `membership_not_active`. Nothing changes and no audit event
    is written.
11. **Reactivate.** `a_suspended` reactivated → 200, `status: "active"`, `status_reason` null; their
    existing session then gets 200 on `GET /api/buildings/{A}`; audit `membership.reactivated`.
12. **Role body.** `add` and `remove` both empty, a role in both, an unknown role, or an extra field is 422.
    A change that would leave the membership with no roles is 409 `no_roles_left` (P2-03 carry). Removing
    `resident` while the member has a current occupancy is 409 `resident_has_unit` (ADR-0010: an occupancy
    belongs to a resident membership; P4-06b's move-out or transfer handles units).
13. **Reason.** A suspend reason missing, shorter than 3 or longer than 500 characters after trimming, or
    with a control or invisible (`Cf`, `Zl`, `Zp`) character is 422 (the same rule as the P4-05b deny
    reason). The reason is never in audit metadata (CLAUDE.md rule 10).
14. **Sessions follow (P4-02b carry).** Adding `security` to `a_resident1`, or reactivating a suspended
    security member, caps their existing sessions to the staff idle window (ADR-0003, 12 h): after 13 idle
    hours the session no longer resolves. A session refresh racing the change (real connections, both
    orders) takes turns on the per-user lock, and the session still ends after 13 idle hours.
15. **Stale manager.** A manager whose request waited on the building lock while another manager removed
    their `property_management` role (or suspended them) is refused after the lock: 403 `forbidden_role`
    (role removed) or 404 `building_not_found` (no longer active), the same answers their next request
    gets; nothing is written. `last_manager` is checked first, so criterion 3's loser still gets 409.
16. **Atomicity.** A role change that fails at the last-manager check leaves roles, audit and sessions
    as they were (the error rolls the transaction back).
17. **Concurrency on one member (tenant row 10).** Two concurrent suspends of the same member give one 200
    and one 409 `invalid_transition`, and one `membership.suspended` event.

## Test plan

- `tests/memberships/test_members.py` (HTTP: list, roles, suspend, reactivate, tenant rows),
  `tests/memberships/test_members_concurrency.py` (real connections: criteria 3, 14, 15, 17).
- Commands: `make check`, `make gen-api`.

## Must explain (learning checkpoint)

1. Why does locking the building row make the last-manager check safe? What race happens without it?
2. Why does suspension apply on the very next request?
3. Why must a manager's own authority be re-checked after waiting for the building lock?

## Carried from P2-03 (decide while framing)

- An active membership with **no roles** still gets a `TenantContext` (`my_roles: []`); every
  `require_roles` route refuses it, but "any member" routes admit it (P2-03 review round 1, L2). Decided:
  refuse with 409 `no_roles_left` (criterion 12).

## Carried from P4-02b (do while framing)

- **Sessions follow role changes.** Every write here that changes a user's roles or a membership's status
  (suspend, reactivate, change roles) must call
  `backend/app/auth/service.py::apply_role_change(db, user_id, active_session_id=...)` in the same transaction,
  after the change. Copy `backend/tests/invitations/test_concurrency.py::test_session_writes_and_a_staff_accept_take_turns`
  for the races (criterion 14).

## Carried from P4-05b (do while framing)

From PR #92; see [the explanation](../explanations/P4-05b-onboarding-decisions.md) §7.
- **Requests left pending by an invitation.** Decided: P4-06a doesn't close them. Its status changes start
  only from `active` (suspend) or `suspended` (reactivate), never from `pending`, so it never leaves a
  `pending` request on a membership it moved out of `pending`; the stale ones an invitation leaves stay
  hidden from the managers' list and undecidable (P4-05b D1). Closing them needs a new request state and a
  migration: still a follow-up.
- Optional `Cf`/`Zl`/`Zp` refusal for unit labels and names: not taken (out of scope).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (exact body, existing session, `/me`, the user's other building), 3
  (real connections; one manager remains; also with suspend), 4 (roles unchanged; the allowed case), 6
  (every route; resident and council; rows 2, 3, 6), 7 (only roles actually changed; no-op writes no event);
  added 8 (list), 9 (target tenancy), 10 (invalid transitions), 11 (reactivate), 12 (role body, no roles
  left, resident with a unit), 13 (reason), 14 (sessions follow), 15 (stale manager, the case the ticket
  missed), 16 (atomicity), 17 (concurrent suspends).
- Criteria loosened (with reason; also listed in the inbox): none. Criterion 2 (deactivate) and 5
  (transfer) moved to P4-06b unchanged.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Split** into P4-06a / P4-06b (playbook: estimate ~490 non-test lines; part a ~340, part b ~150).
    Default.
  - **Building lock mode:** `FOR NO KEY UPDATE` (`with_for_update(key_share=True)`), as
    `app/invitations/service.py::_lock_building`, not plain `FOR UPDATE`: it conflicts with itself and with
    the invitation accept's `FOR SHARE`, so these writes still run one at a time per building, but
    foreign-key checks from rows inserted into tenant tables don't wait on it. Autonomous; matches the code.
  - **Change, then count:** each write makes its change under the lock, then counts active
    `property_management` memberships; zero raises 409 `last_manager`, which rolls the change back. One
    count covers every way to lose a manager (role removal, suspension). Autonomous.
  - **Stale manager re-check after the lock** (criterion 15), after the last-manager check so criterion 3
    keeps its 409. CLAUDE.md lesson "don't write from a value read before a lock wait". Autonomous.
  - **No roles left:** refused, 409 `no_roles_left` (P2-03 carry). Autonomous, reversible.
  - **`resident` removal with a current unit:** refused, 409 `resident_has_unit`, rather than ending the
    occupancy as a side effect (as an invitation accept does): ending occupancies is P4-06b's move-out and
    transfer, with their own audit. Autonomous, reversible.
  - **Roles change only on `active` memberships** (409 `membership_not_active`): pending ones get their
    role from the join request (P4-05b approves "exactly `resident`"), and a suspended member is
    reactivated first. Autonomous, reversible.
  - **Status codes:** suspend/reactivate from the wrong status are 409 `invalid_transition` (CLAUDE.md
    rule 7's conditional `UPDATE … WHERE status = … RETURNING`). Ticket + rule.
  - **Reason storage:** a new nullable `building_memberships.status_reason` varchar(500) (expand-only
    migration), set by suspend, cleared by reactivate, returned in `MemberOut`. The ticket takes a reason but
    names no place for it; audit metadata can't hold free text (rule 10). Autonomous; listed in the inbox in
    step 6.
  - **List defaults:** no status filter by default (every status, so a manager finds a suspended member);
    `search` is a contains match on name or email, wildcards escaped. Autonomous, reversible.
  - **Sessions:** `apply_role_change(db, target_user_id, active_session_id=None)` after every change: the
    target's sessions, not the manager's (P4-02b carry). Ticket carry.
  - **Pending requests left by invitations** (P4-05b carry): not closed here; see above. Autonomous.
  - **Lock order:** building (NO KEY UPDATE) → membership (conditional UPDATE) → user
    (`lock_idle_deadlines` in `apply_role_change`). The invitation accept takes building → … → user, the
    join submission building → membership, a session refresh only the user: no cycle.
- Split: part a of [P4-06](./P4-06-membership-administration.md). Estimate ~340 non-test lines (service
  ~210, router ~60, schemas ~45, migration and model ~20, actions ~5).
