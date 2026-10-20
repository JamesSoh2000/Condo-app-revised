# Explanation — P4-06a Members: list, roles, suspend, reactivate

> **PR:** #93 · **Source revision:** `b52a301827efe786e9f1a2f3a6c9c4d6acc519ac`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3) reviewed this
> commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 93 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `b52a301` the diff (`git diff origin/main...HEAD`, 18 files), the whole of
> `backend/app/memberships/service.py`, `router.py`, `schemas.py`, the migration, the invitations hunk, and
> the assertions of every test named below; ran `make test DB_PORT=55432 PYTEST_ADDOPTS="tests/memberships
> tests/invitations tests/onboarding"`: 360 passed. The SQL in §3 was compiled from the service's own
> statements (`stmt.compile(dialect=postgresql.dialect())`), not copied from logs. Differences from the
> plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

Property managers can now list a building's members and change their roles, suspend them and lift the
suspension, through four routes under `/api/buildings/{building_id}/members`. These are the first API
writes that can take access away from a manager, so they carry the ticket's invariant: the building never
ends up without an active manager. Every write takes the `buildings` row lock, makes its change, then
counts the remaining managers (409 `last_manager` if none). Two review rounds added the rest. A manager who
lost their own authority while waiting for that lock is refused. The invitation writes, which wait on the
same lock, refuse such a manager too. P4-06 was split while framing: move-out and transfer are P4-06b.

## 2. Decisions

### D1. The building row lock, then change-and-count

- **Problem or constraint:** two managers who remove each other's manager role at the same time would each
  see the other still active if they counted before either committed. Both would succeed and leave the
  building with no manager (ticket criterion 3).
- **Chosen:** every write starts with `SELECT … FROM buildings … FOR NO KEY UPDATE`
  (`backend/app/memberships/service.py::_lock_building`). Then it makes its change and counts active
  `property_management` memberships whose user is active (`_require_a_manager`). Zero raises 409
  `last_manager`, which rolls the change back. A second writer waits on the lock and then, under READ
  COMMITTED, counts against what the first committed.
- **Alternatives rejected:**
  - Plain `FOR UPDATE` (the ticket's wording) also blocks foreign-key checks from rows inserted for the
    building, and serializes these writes no better.
  - Locking only the managers' membership rows lets a new manager appear between the lock and the count.
  - `SERIALIZABLE` needs a retry loop in every caller.
  - Counting before the change needs a per-operation prediction of "would this remove a manager".
- **Tradeoffs and accepted limitations:** all members writes in one building run one at a time. The
  invitation accept's `FOR SHARE` on the building waits for them too.
- **Basis:** ticket; existing convention (`backend/app/invitations/service.py::_lock_building` uses the
  same mode).
- **Source:** recorded (PR D1).

### D2 and D4. The acting manager is re-read after the lock, and refused before anything about the target

- **Problem or constraint:** `get_tenant_context` reads the caller's roles before they wait on the lock.
  Another manager may demote or suspend them during that wait (CLAUDE.md lesson "don't write from a value
  read before a lock wait"). Two more constraints apply. Criterion 3 says the losing manager gets 409
  `last_manager`, and that loser is exactly such a stale caller. Criterion 4 lets a manager drop their own
  role.
- **Chosen:**
  - `read_caller` runs right after the lock, before this write's own change, so a manager's
    self-demotion doesn't count against them.
  - `_check_managers` first counts managers, then calls `refuse_stale(caller)`: 404
    `building_not_found` if they are no longer active, 403 `forbidden_role` without the role. Those are
    the answers their next request would get.
  - Round 1 added the `_caller_first` guard. Any domain error raised while loading or changing the target
    becomes the stale caller's refusal.
- **Alternatives rejected:**
  - Refusing the stale caller right after the lock: criterion 3's loser would get 403.
  - Re-reading the caller after the change (the plan): it refused a manager's own self-demotion
    (`test_manager_can_drop_own_role_when_another_remains` failed while implementing).
  - Re-checking in every error branch: seven branches, easy to miss one.
- **Tradeoffs and accepted limitations:**
  - A stale caller whose change would empty the building learns 409 `last_manager` (Claude round 2 L2,
    accepted).
  - A stale caller targeting a valid member has the change applied inside the transaction, and the
    refusal rolls it back.
  - **Open:** criterion 3's variant where the loser also holds another role now gives 403. See §7.
- **Basis:** CLAUDE.md lesson; review findings (round 1, Codex F2 and Claude L2).
- **Source:** recorded (PR D2, D4).

### D3. Where the suspension reason lives

- **Problem or constraint:** the ticket takes `{reason}` on suspend but names no place for it. Audit
  metadata can't hold free text (CLAUDE.md rule 10).
- **Chosen:** a nullable `building_memberships.status_reason` varchar(500). Suspend sets it, reactivate
  clears it, and managers see it in `MemberOut`. The member doesn't (`/api/auth/me` is unchanged).
- **Alternatives rejected:** accepting and dropping it; a history table (more than the pilot needs).
- **Tradeoffs and accepted limitations:** only the latest reason is kept. P4-06b must clear it where an
  invitation reactivates a deactivated membership (carried in its ticket).
- **Basis:** autonomous (in the inbox).
- **Source:** recorded (PR D3).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Split P4-06 into a (list, roles, suspend, reactivate) and b (move-out, transfer) | one PR | estimate ~490 non-test lines | playbook | Frame notes |
| A change that leaves no roles → 409 `no_roles_left` | allow it | P2-03: a roleless active member still passes "any member" routes | P2-03 carry, autonomous | Frame notes |
| `last_manager` comes before `no_roles_left` when `property_management` is removed | `no_roles_left` first | criterion 4 names `last_manager` | review round 2 (Codex) | PR review log |
| Removing `resident` while the member has a current unit → 409 `resident_has_unit` | ending the occupancy as a side effect | ending occupancies is P4-06b's, with its own audit | ADR-0010, autonomous | Frame notes |
| Roles change only on `active` memberships (409 `membership_not_active`) | also on pending or suspended | pending gets its role from the join request; reactivate first | autonomous | Frame notes |
| A wrong-status suspend or reactivate → 409 `invalid_transition` | a per-case code | CLAUDE.md rule 7 | rule | Frame notes |
| A roles request that changes nothing → 200, no audit (still refuses a stale caller) | 409, or an event with empty lists | idempotent retry; criterion 7 says "exact roles" | autonomous | PR |
| The manager count requires `users.is_active` | any active membership | an inactive user can't log in | review round 1 (Claude) | PR |
| `apply_role_change(target, active_session_id=None)` on every write | only when a staff role is added | the carry says every change; it never lengthens a window | P4-02b carry | PR |
| The list defaults to every status; `search` is a contains match with wildcards escaped | active only; prefix | managers look up suspended members | autonomous | PR |
| The members' join requests left `pending` by an invitation are not closed | close them | P4-06a never moves a membership out of `pending` | P4-05b carry, autonomous | Frame notes |
| `Reason` type shared with the P4-05b deny reason | a copy | one rule for text a person reads | convention | PR |

**Framing changes:**
- Sharpened: criteria 1, 3, 4, 6, 7.
- Added: 8–17 (list, target tenancy, invalid transitions, reactivate, role body, reason, sessions follow,
  stale manager, atomicity, concurrent suspends).
- None loosened. Criteria 2 and 5 moved to P4-06b unchanged.

**Plan versus final code** (all noted in the PR under "Deviations from the plan"):
1. The caller is re-read after the lock, not after the change (D2).
2. The `_caller_first` guard and the invitations' re-check (round 1).
3. `last_manager` precedence over `no_roles_left` (round 2).
4. The no-op path refuses a stale caller.
5. Size: 557 non-test lines, against the frame's ~340 estimate. Accepted by the reviewers and listed for
   audit.

## 3. How it is implemented

### Overview

- `backend/app/memberships/router.py`: four routes on `building_router(tags=["members"])`, all behind
  `require_roles(Role.PROPERTY_MANAGEMENT)`.
- `backend/app/memberships/service.py`: `list_members` (read only). The writes are `change_roles`,
  `suspend_member` and `reactivate_member`. Each runs the same steps: `_lock_building` → (inside
  `_caller_first`) `_target` and the change → `_finish` (`_check_managers`, `apply_role_change`,
  `record_audit`, one commit).
- `backend/app/invitations/service.py::_lock_building` now also calls `refuse_stale(await read_caller(...))`.
- Migration `8c7f60239d84` adds `status_reason`.

### Walkthrough (variant A): `POST /api/buildings/{A}/members/{id}/suspend {"reason": "Unpaid fees"}`

1. **HTTP.** `backend/app/memberships/router.py::suspend`. The body is `MemberSuspendIn`
   (`backend/app/memberships/schemas.py::MemberSuspendIn`), whose `reason` is
   `backend/app/onboarding/schemas.py::Reason`. It allows 3–500 characters after trimming, and no control
   or invisible characters, checked before the trim. Anything else is a 422 before the service runs.
2. **Dependencies.** The session leads to `get_tenant_context` (`backend/app/tenancy/deps.py::get_tenant_context`).
   A non-member or inactive member gets 404, a non-manager 403 (`require_roles`).
3. **Service.** `backend/app/memberships/service.py::suspend_member`:
   - `_lock_building` locks the building row and re-reads the caller.
   - `_target` loads the membership with `building_id = ctx.building_id` and locks it `FOR NO KEY UPDATE`.
     None means 404 `member_not_found`, the same body for another building's id.
   - Self → 409 `cannot_target_self`.
   - `_transition` runs the conditional `UPDATE … WHERE status = 'active' RETURNING id`. Zero rows means
     409 `invalid_transition`.
   - Any of these errors from a stale caller becomes their refusal (`_caller_first`).
4. **Database.** The SQL that isn't obvious from the code:
   ```sql
   SELECT buildings.id FROM buildings WHERE buildings.id = $1 FOR NO KEY UPDATE;

   -- read_caller
   SELECT building_memberships.status, EXISTS (SELECT * FROM membership_roles
     WHERE membership_roles.building_id = building_memberships.building_id
       AND membership_roles.membership_id = building_memberships.id
       AND membership_roles.role = 'property_management') AS manager
   FROM building_memberships WHERE building_memberships.id = $2 AND building_memberships.building_id = $1;

   -- _require_a_manager, after the change
   SELECT count(*) FROM building_memberships JOIN users ON users.id = building_memberships.user_id
   WHERE building_memberships.building_id = $1 AND building_memberships.status = 'active'
     AND users.is_active AND (EXISTS (SELECT * FROM membership_roles WHERE … role = 'property_management'));
   ```
5. **Side effects, in the same transaction.**
   - `apply_role_change` takes the member's user row lock and caps their sessions' idle deadlines to what
     their roles now allow.
   - `record_audit` writes `membership.suspended` with empty metadata (the reason is never in it).
6. **Response.** `MemberOut` with `status: "suspended"` and `status_reason`. The member's next request in
   building A is 404, because `get_tenant_context` reads `status = 'active'` on every request. Their
   other buildings are untouched.

### Data model changes

`building_memberships.status_reason varchar(500) NULL`. It has no constraint: it is free text for
managers, written only through `MemberSuspendIn`'s validated `Reason` and set to NULL on reactivate.
Nullable with no default, so adding it rewrites no rows (expand only).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/memberships/service.py` | new: list and the three writes, lock, checks | +430 |
| `backend/app/memberships/router.py` | new: four routes | +69 |
| `backend/app/memberships/schemas.py` | new: `MemberOut`, `MemberRolesIn`, `MemberSuspendIn`, `MemberSearch` | +52 |
| `backend/app/onboarding/schemas.py` | `Reason` extracted from `OnboardingDecisionIn` | +12 −8 |
| `backend/app/invitations/service.py` | stale-caller re-check after the lock | +4 |
| `backend/app/memberships/models.py` | `status_reason` | +4 |
| `backend/migrations/versions/8c7f60239d84_membership_status_reason.py` | add the column | +33 |
| `backend/app/audit/actions.py`, `backend/app/main.py` | three actions; include the router | +5 |
| `frontend/src/api/schema.d.ts`, `frontend/src/api/client.test.ts` | generated types; the new GET path | +426 |
| `backend/tests/memberships/*` | HTTP and real-connection tests | +1198 |
| `docs/tickets/*` | frame and split | +284 −13 |

`backend/app/memberships/service.py::_lock_building` (with `read_caller`)

```python
async def read_caller(db: AsyncSession, ctx: TenantContext) -> Caller:
    # ...
    caller = (
        await db.execute(
            select(
                BuildingMembership.status, _holds(Role.PROPERTY_MANAGEMENT).label("manager")
            ).where(
                BuildingMembership.id == ctx.membership_id,
                BuildingMembership.building_id == ctx.building_id,
            )
        )
    ).one()
    return Caller(active=caller.status == MembershipStatus.ACTIVE, manager=caller.manager)


async def _lock_building(db: AsyncSession, ctx: TenantContext) -> Caller:
    # ...
    await db.execute(
        select(Building.id).where(Building.id == ctx.building_id).with_for_update(key_share=True)
    )
    return await read_caller(db, ctx)
```

- **What it does:** serializes every members write in a building, then reads the caller as they stand now.
- **Why:** D1 and D2.
- **What breaks without it:** without `with_for_update`, the mutation probe failed 5 tests, including both
  criterion-3 tests. With `read_caller` ignored, the stale-manager tests fail.

`backend/app/memberships/service.py::_caller_first` and `_check_managers`

```python
@contextmanager
def _caller_first(caller: Caller) -> Iterator[None]:
    # ...
    try:
        yield
    except DomainError:
        refuse_stale(caller)
        raise


async def _check_managers(db: AsyncSession, ctx: TenantContext, caller: Caller) -> None:
    # ...
    await _require_a_manager(db, ctx)
    refuse_stale(caller)
```

- **What it does:** the guard turns target errors into the stale caller's refusal. After a change, the
  manager count comes first, then the caller.
- **Why:** the order is criterion 3's (`last_manager` for the loser), and the guard is round 1's F2.
- **What breaks without it:** probe `no-caller-first` failed 10 tests, and the stale callers learned
  members' statuses.

`backend/app/memberships/service.py::change_roles` (the decisions inside it)

```python
        added = sorted(set(data.add) - held)
        removed = sorted(set(data.remove) & held)
        if not added and not removed:
            # Nothing written, but a stale manager still gets their refusal, not the member.
            refuse_stale(caller)
            [out] = await _members_out(db, ctx.building_id, [target.id])
            await db.commit()
            return out
        if not (held - set(removed)) | set(added):
            if Role.PROPERTY_MANAGEMENT in removed:
                # Criterion 4 names `last_manager` when both apply (review round 2, Codex M1).
                await _require_a_manager(db, ctx, besides=target.id)
            raise NoRolesLeft(detail="A member must keep at least one role.")
        # ... resident_has_unit check, DELETE the removed roles, INSERT the added ones
    return await _finish(
        db,
        ctx,
        caller,
        target,
        actions.MEMBERSHIP_ROLES_CHANGED,
        {"added": [r.value for r in added], "removed": [r.value for r in removed]},
    )
```

- **What it does:**
  - Only roles that actually change are written and audited.
  - A no-op writes nothing.
  - Leaving no roles is refused, `last_manager` first when the manager role goes.
- **Why:** criteria 7 and 12, and round 2.
- **What breaks without it:** if `held` is dropped from the set arithmetic, `added` lists roles already
  held. `test_roles_change_audits_exact_lists` sends an already-held `resident` in `add` and asserts
  `{"added": ["security"], …}`, so it would fail. This is read from the test's assertion; no probe was
  run for this mutation.

`backend/app/memberships/service.py::suspend_member`

```python
    caller = await _lock_building(db, ctx)
    with _caller_first(caller):
        target = await _target(db, ctx, membership_id)
        if target.id == ctx.membership_id:
            raise CannotTargetSelf(detail="You can't suspend yourself.")
        await _transition(
            db, ctx, target, MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED, data.reason
        )
    return await _finish(db, ctx, caller, target, actions.MEMBERSHIP_SUSPENDED)
```

- **What it does:** the conditional `active → suspended` change, under the lock and the guard.
- **What breaks without it:** if `_finish` doesn't call `apply_role_change`, the mutation probe fails 6
  tests (the session caps and the four `take_turns`).

`backend/tests/memberships/test_members_concurrency.py::test_managers_acting_on_each_other_leave_one_manager`

```python
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        first = world.a_manager

        outcomes = await _held_then(
            sessions,
            action(_ctx(world, first), second.membership.id),
            action(_ctx(world, second), first.membership.id),
        )

        assert outcomes == ("ok", "last_manager")
        assert await _active_managers(sessions, world) == 1
```

- **What it does:** this is the hardest criterion, on real connections. `_held_then` runs the first write
  with its commit held. It starts the second write, asserts that the second is still waiting after 0.5 s,
  then commits the first.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Two managers demote or suspend each other | one 200, one 409 `last_manager`, one manager left | `test_managers_acting_on_each_other_leave_one_manager[demote, suspend]`, `test_concurrent_managers_without_holding_still_leave_one` |
| A manager demoted or suspended while waiting acts anyway | 403 / 404 after the lock, nothing written | `test_stale_manager_is_refused_after_the_lock[2]` |
| …and learns a target's state from a 409 | their refusal comes first | `test_stale_manager_gets_the_refusal_before_target_errors[12]` |
| …and invites a new manager instead | invitation create and resend refuse | `test_revoked_manager_cannot_create_or_resend_an_invitation[4]` |
| The revocation rolls back | the waiting manager's write lands | `test_a_revocation_that_rolls_back_leaves_the_waiting_manager_in_charge[2]` |
| The sole manager drops their manager role (also when it's their only role) | 409 `last_manager`, roles and audit unchanged | `test_single_manager_cannot_remove_own_manager_role`, `test_last_manager_comes_before_no_roles_left[2]` |
| The only other "manager" is suspended, inactive, or in building B | not counted | `test_last_manager_counts_only_active_managers`, `test_a_manager_whose_account_is_inactive_does_not_count`, `test_another_buildings_manager_does_not_count` |
| Two suspends of one member | one 200, one 409 `invalid_transition`, one event | `test_concurrent_suspends_give_one_winner` |
| A new staff role leaves a 7-day session open | capped to 12 h, also when racing a refresh | `test_staff_role_caps_existing_sessions`, `test_reactivating_staff_caps_existing_sessions`, `test_session_writes_and_a_staff_role_change_take_turns[4]`, `test_session_refresh_and_a_staff_reactivation_take_turns[2]` |
| The search text contains `%`, `_` or `\` | matched literally | `test_list_search_matches_wildcards_literally` |
| A bidi or zero-width character in the reason | 422 | `test_suspend_reason_validation[8]` |

Acceptance criteria → tests (the names are in `backend/tests/memberships/test_members.py` unless marked C
for `test_members_concurrency.py`):

| # | Test(s) |
|---|---|
| 1 | `test_suspended_resident_loses_access_on_next_request`, `test_suspension_in_one_building_leaves_the_other` |
| 3 | C `test_managers_acting_on_each_other_leave_one_manager`, C `test_concurrent_managers_without_holding_still_leave_one` (the variant in §7 is open) |
| 4 | `test_single_manager_cannot_remove_own_manager_role`, `test_manager_cannot_suspend_self`, `test_manager_can_drop_own_role_when_another_remains`, `test_last_manager_comes_before_no_roles_left` |
| 6 | `test_non_managers_get_403_on_every_route`, `test_other_building_and_inactive_members_get_404`, `test_unauthenticated_gets_401` |
| 7 | `test_roles_change_audits_exact_lists`, `test_roles_noop_writes_no_audit` |
| 8 | `test_list_returns_the_buildings_members_with_their_unit`, `test_list_filters_by_role_status_and_search`, `test_list_search_matches_wildcards_literally`, `test_list_refuses_bad_parameters`, `test_list_never_shows_another_buildings_members` |
| 9 | `test_another_buildings_member_is_not_found` |
| 10 | `test_invalid_transitions`, `test_denied_and_deactivated_members_are_not_suspended_or_reactivated` |
| 11 | `test_reactivated_member_regains_access`, `test_reactivate_clears_the_suspension_reason` |
| 12 | `test_roles_body_validation`, `test_cannot_remove_last_role`, `test_cannot_remove_resident_with_unit`, `test_resident_without_unit_can_lose_the_role` |
| 13 | `test_suspend_reason_validation`, `test_suspend_refuses_extra_fields` |
| 14 | the four session tests above |
| 15 | C `test_stale_manager_is_refused_after_the_lock`, C `test_stale_manager_gets_the_refusal_before_target_errors` |
| 16 | `test_single_manager_cannot_remove_own_manager_role`, `test_last_manager_refusal_leaves_sessions_unchanged` |
| 17 | C `test_concurrent_suspends_give_one_winner` |

Stack journey (curl on `make up` with the seed: list, suspend, 404 on the same session, `/me` shows
suspended, 409s, reactivate, role add and remove, the audit rows): in the PR's evidence section.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` high | `772c0b7` | BLOCK | High: a revoked manager's invitation writes; Medium: target errors before the stale refusal | both fixed in `1667e3d` |
| 1 | Claude (Sonnet 5.5, high) | `772c0b7` | MERGE | the same two as M1 and L2; L3 size; residuals: inactive-user managers, pending invitations | inactive users fixed in `1667e3d`; size accepted; pending invitations → follow-up |
| 2 | Codex | `2550309` | MERGE | Medium: sole manager whose only role is manager gets `no_roles_left` | fixed in `b52a301`; its passing proofs for criteria 14 and 16 adopted as tests |
| 2 | Claude | `2550309` | MERGE | M1 the pending-invitation carry not yet on the branch; L1 PR text; L2 `last_manager` disclosure | carry in step 6; text fixed; L2 accepted |
| 3 | Codex | `b52a301` | MERGE | Medium: criterion 3 variant gives 403 | **not fixed**, see §7 |
| 3 | Claude | `b52a301` | MERGE | none (residuals only) | — |

The findings that changed the code:

- **Round 1, invitations (Codex High / Claude M1).**
  - The failure: manager B's `POST /invitations` waited on the building lock while manager A suspended or
    demoted B. It then returned 201 and committed a pending `property_management` invitation to an email B
    chose. That gave B a way back in through a second account.
  - The fix: `refuse_stale(await read_caller(...))` in the invitations' `_lock_building`.
  - The evidence: `test_revoked_manager_cannot_create_or_resend_an_invitation` failed 4/4, now passes.
    Probe `no-invitation-recheck` fails 4.
- **Round 1, target errors (Codex Medium / Claude L2).**
  - The failure: a stale manager targeting a suspended or pending member got 409 `invalid_transition` or
    `membership_not_active`.
  - The fix: `_caller_first` (D4).
  - The evidence: `test_stale_manager_gets_the_refusal_before_target_errors` failed 10/10, now passes.
- **Round 1, inactive users (Claude residual).**
  - The failure: a co-manager whose user account is inactive was counted, so the last real manager could
    demote themselves.
  - The fix: the manager count joins `users.is_active`.
  - The evidence: `test_a_manager_whose_account_is_inactive_does_not_count`.
- **Round 2, precedence (Codex Medium).**
  - The failure: the sole manager whose only role was `property_management` got `no_roles_left` on
    `{"remove": ["property_management"]}`.
  - The fix: `_require_a_manager(…, besides=target.id)` before `NoRolesLeft`.
  - The evidence: `test_last_manager_comes_before_no_roles_left[2]` failed 2/2, now passes.

## 7. Not verified, accepted risks and follow-ups

- **Open Medium (round 3, Codex), criterion 3 variant.**
  - The case: manager A holds only `property_management`, and manager B holds `property_management` and
    `council`. A removes B's manager role while B's request removing A's waits on the lock. B gets 403
    `forbidden_role`, not 409 `last_manager`.
  - The cause: the round 2 precedence check raises `LastManager` inside `_caller_first`, which turns it
    into the stale refusal.
  - **Safety holds:** exactly one active manager remains, and nothing B asked for is written. Only the
    error code differs from the criterion.
  - Why it is open: round 3 was the last review round and both reviewers said MERGE, so it was not changed
    without review.
  - Tracked: P4-06b's ticket (fix test-first: let `LastManager` pass through `_caller_first`) and the
    inbox.
- **Policy gap.** A manager's pending invitations stay valid after the manager is demoted or suspended.
  The accept doesn't check the creator. Tracked: P4-06b's ticket and the inbox.
- **No direct test:**
  - Criterion 8's three non-cursor invalid parameters: the test accepts 400 or 422; only the cursor's 400
    is pinned.
  - Criterion 7's ordering of several roles in one list: each test changes one role per list.
  - `status_changed_at`: it is set by the same UPDATE as the asserted `status_changed_by_user_id`.
  - The three-manager stale case: it goes through the same `refuse_stale` path.
- **Not run:**
  - The concurrency tests run on one Postgres; no load or timing variation beyond the held-commit pattern.
  - The race tests prove the waiting by a 0.5 s check that the second write isn't done.
- **Accepted:**
  - Size, 557 non-test lines.
  - A stale caller learning `last_manager` (criterion 3's order).
  - Join requests left `pending` by an invitation are still not closed (P4-05b D1).
  - No notification to the member.
  - Only the latest reason is kept.
- **Later tickets:**
  - A suspended member keeps their occupancy. P5 fan-out to a unit's occupants must filter active members
    (`current_occupants` already says it returns any status).
  - The `invalid_transition` detail reads "Only a active member…" (wording).
  - Tracked: the PR's follow-ups and this file.

## 8. How to change this safely

- A new members write (P4-06b's deactivate and transfer) follows the same pattern as `suspend_member`:
  - `caller = await _lock_building(db, ctx)`;
  - the target work inside `with _caller_first(caller):`;
  - `return await _finish(...)`.
  The concurrency tests in `test_members_concurrency.py` are written around `_held_then`; add the new write
  to the stale-target and two-manager parametrizations.
- Occupancy helpers lock the membership row, so call them after `_lock_building` (building, then
  membership).
- Any other manager write that takes the building lock must call `refuse_stale(await read_caller(db, ctx))`
  after it (see the invitations).
- Changing what counts as a manager means changing `_require_a_manager`. The `last_manager` tests and the
  probes listed in the PR will show a regression.

## 9. Must explain, then quiz

**1. Why does locking the building row make the last-manager check safe? What race happens without it?**
Without a lock, two transactions that each remove the other manager both count before either commits.
Under READ COMMITTED each sees the other still active, both pass, and both commit: zero managers.
`_lock_building` makes every members write in the building take `FOR NO KEY UPDATE` on the same row first.
The second waits until the first commits. Its count statement then takes a fresh snapshot and sees the
first's change, so it raises `last_manager`. The probe without `with_for_update` failed 5 tests, including
`test_concurrent_managers_without_holding_still_leave_one`.

**2. Why does suspension apply on the very next request?**
Nothing about a membership is cached in the session. `backend/app/tenancy/deps.py::get_tenant_context`
reads the membership with `status = 'active'` on every building-scoped request. Once the suspension
commits, the member's next request finds no active membership and gets 404 `building_not_found`, on the
same session cookie (`test_suspended_resident_loses_access_on_next_request`).

**3. Why must a manager's own authority be re-checked after waiting for the building lock?**
Their tenant context was read before the wait. The write they waited for may be the one that demoted or
suspended them. Without `read_caller` they would act with authority they no longer have, for example
creating a manager invitation for themselves (round 1, Codex High).

**Quiz**

1. Manager A holds the lock and has suspended manager B, not yet committed. B's request to suspend
   resident R is waiting. What does B get after A commits, and is R suspended?
2. Why is the caller read right after the lock rather than after the write's own change?
3. What would break if `_caller_first` were removed?
4. A manager removes their own `property_management` role while another manager exists. Walk through
   `change_roles`: which checks run, and what is the response?
5. How would you extend this so that demoting a manager also revokes the pending invitations they
   created?

<details><summary>Answers</summary>

1. 404 `building_not_found`. `read_caller` sees B suspended. B's change applies inside the transaction,
   the count passes (A remains), then `refuse_stale` raises, which rolls R's suspension back. R stays
   active (`test_stale_manager_is_refused_after_the_lock[suspended]`).
2. So that a manager may drop their own role: read after the change, it would already lack
   `property_management` and get 403 (`test_manager_can_drop_own_role_when_another_remains` failed with
   that design while implementing).
3. A stale manager would get target-specific 409s (`invalid_transition`, `membership_not_active`,
   `member_not_found`). Those reveal members' states in a building they no longer manage. Probe
   `no-caller-first` failed 10 tests.
4. The lock, then `read_caller` (active manager). `_target` (active). `removed = [property_management]`;
   the result still has a role, so no `no_roles_left`. The DELETE, then `_finish`: the count finds the
   other manager, `refuse_stale` passes (read before the change), `apply_role_change`, the audit
   `{"added": [...], "removed": ["property_management"]}`. 200.
5. In `change_roles` and `suspend_member`, after the change and under the same building lock: when the
   target lost `property_management` or became suspended, revoke their pending invitations (an UPDATE
   setting `revoked_at` where `created_by_user_id` is the target's user and the invitation is open), with
   an audit event. Add tests for the race with an accept, which locks the building `FOR SHARE` and so
   waits. This is the policy follow-up carried to P4-06b.

</details>
