# Explanation — P4-06b Members: move-out and transfer

> **PR:** #94 · **Source revision:** `c08ee7e6a32be81c6eaf3fd0569e9fcb5a56ea53`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2) reviewed this
> commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 94 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `c08ee7e` the app diff (`git diff origin/main...HEAD -- backend/app`: 5
> files), the whole of `deactivate_member`, `transfer_member`, `_caller_first`, `_transition`, `_finish` and
> `_revoke_invitations_of_former_manager`, the occupancy helpers they call, and the assertions of every test
> named below; ran `make test DB_PORT=55432 PYTEST_ADDOPTS="tests/memberships tests/invitations/test_accept.py"`:
> 223 passed. The SQL in §3 was compiled from the service's own statements
> (`stmt.compile(dialect=postgresql.dialect())`), not copied from logs. Differences from the plan: see §2
> "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

Property managers can now **move a member out** (`POST /api/buildings/{b}/members/{id}/deactivate`) and
**move a resident to another unit** (`POST …/transfer`). A move-out sets the membership `deactivated` and
ends the member's current occupancy (their dated link to a unit, ADR-0010); a transfer ends the current
occupancy and starts a new one at the same instant. Rows are never deleted, so the history that decides
which unit records a person may see stays exact.

Both routes reuse P4-06a's machinery: the building row lock, the "is the caller still a manager?" re-read,
and the last-manager check. The PR also closes P4-06a's carries. The most consequential is **D1**: a member
who stops being an active manager loses the open invitations they created. **D2** decides the rare
stale-clock race: it is a 409 `occupancy_changed`, not a retry.

## 2. Decisions

### D1. A former manager's open invitations are revoked in the same transaction

- **Problem or constraint:** an invitation carries its creator's authority. After P4-06a, a demoted or
  suspended manager's pending invitations stayed valid, so a removed manager could still bring in a new
  manager (P4-06a review rounds 1-2, carried in the ticket).
- **Chosen:** after every members write (roles, suspend, reactivate, deactivate, transfer), `_finish` calls
  `backend/app/memberships/service.py::_revoke_invitations_of_former_manager`. If the target is no longer an
  `active` member holding `property_management`, every open invitation of this building they created
  (not accepted, not revoked; expired ones included, since a resend reopens them) gets `revoked_at` and an
  `invitation.revoked` audit event (actor: the manager; metadata `{"membership_id": …}`).
- **Alternatives rejected:** (a) the accept checks that the creator is still a manager: an operator's
  invitation (P4-03) has no creator, the rule would be invisible in the invitations list, and a manager
  restored later would revive invitations nobody re-approved. (b) Leave them valid: the security gap the
  reviewers raised.
- **Tradeoffs and accepted limitations:** a manager who moves out legitimately loses their pending
  invitations, and another manager re-sends them. An account-wide `users.is_active` change revokes nothing
  (no route does that yet). Invitations of managers demoted before this release are not revoked
  retroactively (review round 1, L3).
- **Basis:** ticket carry; autonomous (inbox "Decisions to audit").
- **Source:** recorded (PR #94 D1).

### D2. `OccupancyTimeError` is 409 `occupancy_changed`, not a retry

- **Problem or constraint:** the occupancy helpers (`backend/app/memberships/occupancy.py::_prepare`) stamp
  times with the transaction's `now()`, which Postgres fixes when the transaction **starts**. A request's
  transaction starts at the session lookup, before it waits for the building lock. If another writer
  committed a newer occupancy for the same member meanwhile, this transaction's `now()` is older than that
  row's `started_at`, and the helper raises `OccupancyTimeError` (a `ValueError`; P1-03 explanation §7).
  Writers that can do this: an onboarding approval (which doesn't take the building lock), or an invitation
  accept or another transfer that committed while this request waited.
- **Chosen:** `backend/app/memberships/service.py::_occupancy_changed` turns it into the domain error
  `OccupancyChanged` (409 `occupancy_changed`, "reload and try again"); the raise rolls the whole
  transaction back.
- **Alternatives rejected:** retrying the use-case in a fresh transaction (more code paths for a race inside
  a request's first milliseconds); passing `clock_timestamp()` as `at` (the helpers refuse an `at` after
  `now()`, and changing them was out of scope).
- **Tradeoffs and accepted limitations:** a manager occasionally sees a 409 and repeats the action.
- **Basis:** ticket carry ("decide retry or 409, and test it"); autonomous.
- **Source:** recorded (PR #94 D2).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Deactivate from `active` **or** `suspended` | active only | a suspended resident can still move out | autonomous | PR #94 table |
| `pending` member: 409 `invalid_transition` | deactivate it | its join request is decided by deny (P4-05b) | autonomous | PR #94 table |
| Roles are kept on deactivation | delete them | history; an invitation replaces them on return (P4-02b) | autonomous | PR #94 table |
| Transfer needs `active` + `resident` (409 `membership_not_active`, `not_a_resident`) | any member | an occupancy belongs to a resident membership | ADR-0010 | PR #94 table |
| Unit: 404 `unit_not_found` for any unit not in this building; 409 `unit_inactive`; read `FOR KEY SHARE` | no lock | a concurrent unit deactivation must see the occupancy or be seen | CLAUDE.md rule 2; P4-05b | PR #94 table |
| Same unit + new relationship is a transfer; same unit + same relationship is 200 with nothing written | 409 | mirrors P4-06a's role no-op | convention | PR #94 table |
| `IntegrityError` from the helpers is not mapped | map to 409 | unreachable after the in-building unit check and the membership lock; a 500 would show a bug | autonomous | PR #94 table |
| Audit metadata: `membership.deactivated` `{unit_id}`, `occupancy.transferred` `{from_unit_id, to_unit_id}` | add the relationship | IDs only | CLAUDE.md rule 10 | PR #94 table |
| P4-05b carry (join requests left `pending` by an invitation): no code change | close the request | `_membership_pending` already hides it for any non-pending status | code | ticket Frame notes |
| `LastManager` passes through `_caller_first` | keep the stale 403 | criterion 3 of P4-06a names 409 `last_manager` | ticket (PR #93 open Medium) | ticket criterion 10 |

**Framing changes:** criteria 2, 5 and 6 were made exact (window checks, equal end and start instants,
every tenant row that applies); criteria 1, 3, 4 and 7-15 were added. Criterion 3 was clarified during
implementation: `last_manager` on deactivate is reachable only in criterion 9's race, because the caller is
an active manager and can't target themself. Nothing was loosened.

**Plan versus final code:** two differences, both naming only. (1) Several tests carry different names from
the Plan's map (for example `test_deactivate_refusals` became `test_manager_cannot_deactivate_self` and
`test_deactivate_refuses_members_not_active_or_suspended`; `test_deactivate_caps_sessions` became
`test_deactivated_staff_session_is_not_lengthened`); §5 lists the real names. (2) The Plan listed the new
errors `NotAResident` and `OccupancyChanged`; the code also defines a local `UnitInactive` (code
`unit_inactive`), because the existing classes live in `invitations.service` and `onboarding.service`, and
`invitations.service` already imports from this module (inferred: avoiding the import cycle).

## 3. How it is implemented

### Overview

- `backend/app/memberships/router.py::deactivate` and `::transfer`: two routes behind the `Manager`
  dependency (`require_roles(Role.PROPERTY_MANAGEMENT)`) on the building router.
- `backend/app/memberships/service.py::deactivate_member` and `::transfer_member`: the use-cases, each in
  P4-06a's shape: `_lock_building` → work inside `_caller_first` → `_finish`.
- The P1-03 occupancy helpers (`end_occupancy`, `transfer_occupancy`) do the dated writes, called without
  `at`.
- `_finish` now also revokes a former manager's invitations (D1) before sessions, audit and the commit.

### Walkthrough (variant A): `POST /api/buildings/{b}/members/{id}/transfer`

1. **HTTP** → `backend/app/memberships/router.py::transfer`. The body is `MemberTransferIn`
   (`unit_id`, `relationship`), an `InputModel`, so an extra field such as `at` is a 422.
2. **Dependencies:** the session cookie, then `get_tenant_context` (404 if the caller isn't an active member
   of `b`), then `require_roles` (403 without `property_management`).
3. **Building lock:** `_lock_building` locks the `buildings` row `FOR NO KEY UPDATE`, so members writes and
   invitation accepts (which take it `FOR SHARE`) in this building run one at a time. It then re-reads the
   caller (`read_caller`): their context was read before the wait.
4. **Target:** `_target` loads the membership in this building `FOR NO KEY UPDATE`; another building's id
   or an unknown one gives 404 `member_not_found`.
5. **Checks:** `active` or 409 `membership_not_active`; holds `resident` or 409 `not_a_resident`. Then the
   unit, in this building, locked against a concurrent unit deactivation:

   ```sql
   SELECT units.is_active FROM units
   WHERE units.id = %(id_1)s::UUID AND units.building_id = %(building_id_1)s::UUID FOR KEY SHARE
   ```

   No row: 404 `unit_not_found`; `false`: 409 `unit_inactive`.
6. **No-op check:** the current occupancy's `(unit_id, relationship)` is read after the target's lock (every
   occupancy writer locks the membership too). If it equals the request, the caller is checked
   (`refuse_stale`) and the member is returned with nothing written.
7. **The move:** `transfer_occupancy` locks the membership again (already held), ends the current row at
   `now()` and inserts the new one starting at the same `now()`. An `OccupancyTimeError` becomes 409
   `occupancy_changed` (D2).
8. **`_finish`:** `_check_managers` (409 `last_manager` if no active manager who can log in is left, then
   the caller's own refusal if they lost authority); then D1's check:

   ```sql
   SELECT building_memberships.id FROM building_memberships
   WHERE building_memberships.id = %(id_1)s::UUID AND building_memberships.building_id = %(building_id_1)s::UUID
     AND building_memberships.status = %(status_1)s
     AND (EXISTS (SELECT * FROM membership_roles
                  WHERE membership_roles.building_id = building_memberships.building_id
                    AND membership_roles.membership_id = building_memberships.id
                    AND membership_roles.role = %(role_1)s))
   ```

   and, when that finds no row:

   ```sql
   UPDATE invitations SET revoked_at=%(revoked_at)s::TIMESTAMP WITH TIME ZONE, updated_at=now()
   WHERE invitations.building_id = %(building_id_1)s::UUID AND invitations.created_by_user_id = %(created_by_user_id_1)s::UUID
     AND invitations.accepted_at IS NULL AND invitations.revoked_at IS NULL RETURNING invitations.id
   ```

   Then `apply_role_change` caps the member's sessions, `occupancy.transferred` is audited, the member is
   read back (`_members_out`) and the transaction commits once.
9. **Response:** 200 `MemberOut` with the new `unit_id`, `unit_label`, `tower` and `relationship`.

`deactivate` follows the same path, with steps 5-7 replaced by: 409 `cannot_target_self` for the caller's
own membership, the conditional status change (`_transition`: `UPDATE … WHERE status IN ('active',
'suspended') … RETURNING`; zero rows → 409 `invalid_transition`), and `end_occupancy`.

**Lock order:** building → target membership → unit (transfer) → the helpers' membership lock (already
held). An invitation accept takes the building first too; P4-05b's approval locks the request and
membership rows but not the building, which is why D2's race exists.

### Data model changes

None. No migration.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/memberships/service.py` | the two use-cases, D1, D2, `_caller_first`, `_transition` | +215 −16 |
| `backend/app/memberships/router.py` | two routes | +36 −1 |
| `backend/app/memberships/schemas.py` | `MemberDeactivateIn`, `MemberTransferIn` | +13 |
| `backend/app/audit/actions.py` | two actions | +2 |
| `backend/app/invitations/service.py` | `_activate_membership` clears `status_reason` | +2 |
| `frontend/src/api/schema.d.ts` | regenerated | +208 |
| `backend/tests/memberships/test_move_out_transfer.py` | new: HTTP tests | +679 |
| `backend/tests/memberships/test_members_concurrency.py` | races | +297 −11 |
| `backend/tests/memberships/test_members.py`, `backend/tests/invitations/test_accept.py` | carries | +63 −1 |

**Key excerpts**

`backend/app/memberships/service.py::deactivate_member`

```python
    caller = await _lock_building(db, ctx)
    with _caller_first(caller):
        target = await _target(db, ctx, membership_id)
        if target.id == ctx.membership_id:
            raise CannotTargetSelf(detail="You can't deactivate yourself.")
        await _transition(
            db,
            ctx,
            target,
            (MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED),
            MembershipStatus.DEACTIVATED,
            data.reason,
            "Only an active or suspended member can be deactivated.",
        )
        with _occupancy_changed():
            # Never a client time (ADR-0016): the helper uses the transaction's now().
            ended = await end_occupancy(db, building_id=ctx.building_id, membership_id=target.id)
    return await _finish(
        db,
        ctx,
        caller,
        target,
        actions.MEMBERSHIP_DEACTIVATED,
        {"unit_id": ended.unit_id if ended is not None else None},
    )
```

- The status change and the end of the occupancy happen in one transaction; any raise later (in `_finish`)
  rolls both back.
- Without `end_occupancy`, the leaver would keep a current occupancy and see the unit's later records
  (mutation probe m5 made `test_deactivate_moves_the_resident_out` fail).

`backend/app/memberships/service.py::_caller_first`

```python
    try:
        yield
    except LastManager:
        raise
    except DomainError:
        refuse_stale(caller)
        raise
```

- Any domain error about the target is replaced by the caller's own refusal if they lost authority while
  waiting, so a demoted manager learns nothing about the target. `LastManager` is the exception (criterion
  10): `change_roles` can raise it inside this block (its "no roles left" path checks managers first), and
  the ticket requires 409 `last_manager` there. Without the `except LastManager` clause, the remove-only
  race returns 403 (mutation probe m1).

`backend/app/memberships/service.py::transfer_member` (the unit and no-op part)

```python
        unit_active = await db.scalar(
            select(Unit.is_active)
            .where(Unit.id == data.unit_id, Unit.building_id == ctx.building_id)
            .with_for_update(read=True, key_share=True)
        )
        if unit_active is None:
            raise UnitNotFound(detail="Unit not found.")
        if not unit_active:
            raise UnitInactive(detail="This unit is deactivated.")
        # ...
        if current is not None and tuple(current) == (data.unit_id, data.relationship):
            # Nothing to change, as `change_roles`; a stale manager still gets their refusal.
            refuse_stale(caller)
            [out] = await _members_out(db, ctx.building_id, [target.id])
            await db.commit()
            return out
```

- The `building_id` filter is CLAUDE.md rule 2: without it, building B's unit is found and the request no
  longer answers 404 `unit_not_found` (mutation probe m4 made
  `test_transfer_to_another_buildings_unit_is_not_found` fail; inferred: the composite foreign key would
  then refuse the insert).
- `FOR KEY SHARE` waits for `units/service.py::deactivate_unit`, which locks the unit `FOR UPDATE`, and
  then reads `is_active` as committed. Without it, the transfer moves the member into a unit deactivated
  meanwhile (mutation probe m6; review round 1, M1).

`backend/app/memberships/service.py::_revoke_invitations_of_former_manager` (D1) is shown in §3 step 8 as
SQL; the loop after the `UPDATE` writes one `invitation.revoked` event per id, sorted.

`backend/tests/memberships/test_members_concurrency.py::test_stale_clock_is_occupancy_changed` (D2)

```python
        async with sessions() as stale:
            # As a request's session lookup would: the transaction (and its now()) starts here.
            await stale.execute(select(1))
            await asyncio.sleep(0.05)
            async with sessions() as db:
                outcome = await _outcome(
                    _transfer(_ctx(world, world.a_manager), target, world.a_102.id), db
                )
            assert outcome == "ok"
            write = (
                _deactivate(_ctx(world, second), target)
                if late == "deactivate"
                else _transfer(_ctx(world, second), target, world.a_201.id)
            )
            assert await _outcome(write, stale) == "occupancy_changed"
```

- The test reproduces the race on real connections and then asserts nothing was written: the member is
  still `active` and current in 102, with no `membership.deactivated` event and only one
  `occupancy.transferred` event. Mutation probe m3 (mapping removed) made both cases fail.

## 5. Edge cases and tests

All tests below are in `backend/tests/memberships/test_move_out_transfer.py` unless another file is named.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A leaver still sees records for their old unit | the occupancy ends at `now()`; the window is false from then on | `test_deactivate_moves_the_resident_out` |
| A leaver keeps access | status `deactivated`; the next request is 404; other buildings unaffected | `test_deactivated_member_loses_access_here_only` |
| A deactivated staff member's session gets longer | `apply_role_change` only caps | `test_deactivated_staff_session_is_not_lengthened` |
| Self move-out; pending, denied or deactivated target | 409 `cannot_target_self` / `invalid_transition`, nothing written | `test_manager_cannot_deactivate_self`, `test_deactivate_refuses_members_not_active_or_suspended` |
| Bad reason | 422 | `test_deactivate_reason_validation` |
| Transfer loses history | the old row ends at the instant the new one starts; earlier rows unchanged | `test_transfer_moves_the_resident`, `test_transfer_criterion_5_resident1_to_102` |
| Resident without a unit; same unit with a new relationship; an exact no-op | starts one; a transfer; 200 with nothing written | `test_transfer_assigns_a_unit_to_a_resident_without_one`, `test_transfer_same_unit_new_relationship`, `test_transfer_same_unit_and_relationship_is_a_noop` |
| Transfer of a non-active member, a non-resident, or into an inactive unit | 409 | `test_transfer_refuses_members`, `test_transfer_refuses_a_deactivated_member`, `test_transfer_to_an_inactive_unit_is_refused` |
| Another building's unit (tenant row 7) | 404 `unit_not_found`, same body as an unknown id | `test_transfer_to_another_buildings_unit_is_not_found` |
| A client-chosen time | 422 for `at`; helpers called without `at` | `test_bodies_refuse_a_client_time`, `test_helpers_are_called_without_at` (spy) |
| Tenant rows 2, 3, 4, 6 | 401 / 404 / 403 / 404 | `test_unauthenticated_gets_401`, `test_other_building_and_inactive_callers_get_404`, `test_non_managers_get_403`, `test_another_buildings_member_is_not_found` |
| Stale `now()` | 409 `occupancy_changed`, nothing written | `test_members_concurrency.py::test_stale_clock_is_occupancy_changed` |
| Two move-outs at once (tenant row 10) | one 200, one 409, one event | `test_members_concurrency.py::test_concurrent_deactivations_give_one_winner` |
| Two managers move each other out | one 200, one 409 `last_manager` | `test_members_concurrency.py::test_managers_acting_on_each_other_leave_one_manager[deactivate]` |
| A move-out waits for a transfer | ends the new occupancy | `test_members_concurrency.py::test_deactivation_after_a_transfer_ends_the_new_occupancy` |
| A unit deactivation races a transfer | the transfer waits; 409 `unit_inactive`, or proceeds after a rollback | `test_members_concurrency.py::test_transfer_waits_for_a_unit_deactivation` |
| A manager demoted or suspended while their move waited | 403 / 404, nothing written | `test_members_concurrency.py::test_stale_manager_cannot_move_a_member` |
| The same, on a no-op transfer | `refuse_stale` in the no-op branch | **No test** (review round 2, L1; §7) |
| A former manager's invitations | revoked (open and expired); accepted ones, other managers' and other buildings' untouched | `test_lost_manager_invitations_are_revoked`, `test_managers_keep_their_invitations_through_other_changes`, `test_another_buildings_invitations_of_the_same_user_are_kept` |
| A revocation racing an accept | whichever commits first wins | `test_members_concurrency.py::test_revocation_and_accept_take_turns` |
| The move-out reason survives a return | an accept clears `status_reason` | `tests/invitations/test_accept.py::test_accept_clears_a_deactivation_reason` |
| An orphan join request reappears | it stays hidden; approve is 409 `membership_not_pending` | `test_orphan_join_request_stays_hidden_after_deactivation` |

Acceptance criteria → tests: 1 `test_deactivate_moves_the_resident_out` (+ access and session tests);
2 the same test's window assertions; 3 `test_manager_cannot_deactivate_self`,
`test_deactivate_refuses_members_not_active_or_suspended`, `test_deactivate_reason_validation`; 4 the
transfer tests above; 5 `test_transfer_criterion_5_resident1_to_102`; 6 the tenant-row tests; 7
`test_bodies_refuse_a_client_time`, `test_helpers_are_called_without_at`; 8
`test_stale_clock_is_occupancy_changed`, `test_stale_manager_cannot_move_a_member`; 9 the three race
tests; 10 `test_managers_acting_on_each_other_leave_one_manager[remove-only]`; 11 the invitation tests; 12
`test_accept_clears_a_deactivation_reason`; 13 `test_orphan_join_request_stays_hidden_after_deactivation`;
14 `test_members.py::test_list_refuses_bad_parameters`, `test_roles_change_audits_sorted_lists`,
`test_invalid_transition_details`; 15 indirectly: every race test completes (no deadlock), with no
dedicated lock-order assertion.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), security pass | `c187cb9` | MERGE | none | — |
| 1 | Claude Sonnet 5.5 (high), security pass | `c187cb9` | MERGE | M1: unit lock untested; criterion 8's stale-caller rule untested for the new routes; L1-L4 | M1 and criterion 8 fixed with tests in `c08ee7e`; L1-L3 accepted (§7); L4 fixed in the PR text |
| 2 | Codex `gpt-6.1-sol` (high), security pass | `c08ee7e` | MERGE | none | — |
| 2 | Claude Sonnet 5.5 (high), security pass, re-review | `c08ee7e` | MERGE | L1: stale caller on a no-op transfer untested; L2: `last_manager` reveals that no other manager exists | both accepted (§7) |

**Round 1, M1.** Failure: `deactivate_unit` (unit `FOR UPDATE`, no occupants, `is_active=false`) runs while
a transfer into that unit is in progress. With the lock removed, every test stayed green, yet the transfer
would read the unit as active and insert an occupancy of a deactivated unit. Fix: test only, since the
code was right. `test_transfer_waits_for_a_unit_deactivation[commits,rolls-back]` holds the unit `FOR
UPDATE`, asserts the transfer waits, then asserts 409 `unit_inactive` or the move. Evidence: mutation probe
m6 (lock removed) gave `1 failed, 1 passed`; restored, it gave `2 passed`.

## 7. Not verified, accepted risks and follow-ups

- **No test** for a stale caller sending a no-op transfer (round 2, L1). Sonnet's scratch proof showed the
  code returns 403 / 404. If `refuse_stale` is dropped from that branch, a just-demoted manager gets a 200
  with the member's data. Tracked: PR #94 follow-ups; P4-08 or the next members ticket should add
  `[noop]` to `test_stale_manager_cannot_move_a_member`.
- **Criterion 15** (lock order) is shown only by race tests completing. No test races a transfer against
  an onboarding approval or an invitation accept for the same member.
- **Accepted (round 1 L1, round 2 L2):** a stale caller can get 409 `last_manager` and so learn that no
  other active manager exists. Required by criteria 9-10.
- **Accepted (round 1 L2):** move-out and transfer times are the transaction's start, before the lock wait.
  A record for the old unit stamped during the wait is hidden from the leaver; one for the new unit is
  visible to the newcomer. This is ADR-0016's single clock, and the gap is the lock wait.
- **Accepted (round 1 L3):** invitations of managers demoted or suspended before this release are not
  revoked retroactively.
- **Accepted:** an account-wide `users.is_active` change revokes nothing (D1); `IntegrityError` from the
  helpers is unmapped (a 500).
- **Not run:** a browser journey (the UI is P4-08). The stack journey was curl only (PR evidence).

These are tracked in PR #94's "Follow-ups and accepted risks" and in this file. D1 is also in the inbox's
"Decisions to audit".

## 8. How to change this safely

- **A new members write:** take `caller = await _lock_building(db, ctx)`, do the target work inside
  `with _caller_first(caller):`, and end with `_finish`. That gives you the last-manager check, the stale
  refusal, D1's revocation, the session cap and the audit. Add it to
  `test_lost_manager_invitations_are_revoked` if it can remove a manager.
- **Any new occupancy write:** call the helpers without `at`, wrap them in `_occupancy_changed()`, and
  lock the unit `FOR KEY SHARE` before inserting. `test_helpers_are_called_without_at` and the race tests
  will catch regressions.
- **A new way to lose manager authority outside these routes** (an account deactivation, an operator
  command): it must revoke that user's open invitations too, or D1's guarantee no longer holds.

## 9. Must explain, then quiz

**1. Why is "deactivate" a move-out that ends occupancy, and not a delete?**
What a resident may see is decided by occupancy windows. `occupancy_window_clause` (in
`backend/app/memberships/occupancy.py`) shows a unit record to a membership only if that membership
occupied the unit when the record was created. Deleting the membership or its occupancies would erase that
history in two ways. The person's past records (packages delivered while they lived there) would lose their
owner, and the foreign keys are `RESTRICT`, so the database refuses the delete anyway (see
`backend/app/memberships/models.py::UnitOccupancy`). And the next occupant of the unit would have no
boundary separating their time from the leaver's. Ending the occupancy at `now()` and marking the
membership `deactivated` closes the leaver's window exactly. They see nothing for that unit from then on
(`test_deactivate_moves_the_resident_out` asserts the window is false at and after `ended_at`) and lose
access to the building (404). Their history stays intact, so an invitation can bring them back
(`backend/app/invitations/service.py::_activate_membership`), and the audit trail still names them.

**Quiz**

1. A manager is demoted while their transfer request waits for the building lock. What do they get, and
   where in the code is that decided?
2. Why does the transfer lock the unit `FOR KEY SHARE`, and which other writer is it guarding against?
3. What would break if we removed `except LastManager: raise` from `_caller_first`?
4. Why can a move-out fail with `occupancy_changed` even though only one manager acted on that member?
5. How would you extend D1 to an operator command that deactivates a user account everywhere?

<details><summary>Answers</summary>

1. 403 `forbidden_role` (or 404 if they were suspended). `_lock_building` re-reads the caller after the
   wait. Any domain error inside `_caller_first` is replaced by `refuse_stale`, and `_finish` →
   `_check_managers` refuses them even if their write succeeded; the raise rolls it back.
   `test_stale_manager_cannot_move_a_member`.
2. `deactivate_unit` locks the unit `FOR UPDATE` and checks it has no current occupants. `FOR KEY SHARE`
   conflicts with that, so the transfer waits and reads `is_active` as committed. Or the deactivation runs
   after the transfer and sees the new occupant. Without it the member can be moved into a deactivated
   unit (round 1 M1, probe m6).
3. In the race where B removes A's only role while A is removing B's manager role, B would get 403
   `forbidden_role` instead of 409 `last_manager`, contradicting criteria 3 and 10.
   `test_managers_acting_on_each_other_leave_one_manager[remove-only]` fails (probe m1).
4. The transaction's `now()` is fixed when the request's transaction starts, before the lock wait. An
   onboarding approval or an invitation accept for the same membership may have committed a newer
   occupancy meanwhile, and ending it at an earlier `now()` would put the end before the start (D2).
5. In the same transaction, under each building's lock, revoke the user's open invitations in every
   building where they lose manager authority, and audit each revocation. Better: factor
   `_revoke_invitations_of_former_manager` so the command can call it per building. Then add a race test
   with an accept, as in `test_revocation_and_accept_take_turns`.

</details>
