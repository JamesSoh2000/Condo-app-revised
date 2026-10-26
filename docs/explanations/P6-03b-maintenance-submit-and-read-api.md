# Explanation — P6-03b Maintenance submit and read API

> **PR:** #138 · **Source revision:** `725721a` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (4, Codex `gpt-6.1-sol` high, verify only) reviewed
> this commit and said `MERGE`.
> **Merge commit:** not known when written; after the merge, `gh pr view 138 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `725721a`: `git diff origin/main...HEAD` (stat, then the service, router,
> schemas, `occupancy.py`, the onboarding and invitations changes, `backend/app/maintenance/models.py`), the whole of
> `backend/app/maintenance/service.py` and `backend/app/memberships/occupancy.py`, ADR-0016 and ADR-0021, the
> ticket's criteria and Frame notes, the PR body (decisions, four review rounds), and the assertions of every
> test cited below. Ran `uv run pytest tests/maintenance tests/memberships tests/onboarding tests/invitations
> tests/test_occupancy_helpers.py -q`: **748 passed**; `make check DB_PORT=55432` at `c1d49ee` (exit 0; backend
> 3011, frontend 1333); CI green at `725721a`; the stack journey at `725721a` (PR body). SQL in §3 is compiled
> from the code with the Postgres dialect, not captured from a log. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A.

## 1. What was built and why

Residents can now file a maintenance request (a category, a description, their unit or a common area, up to
five photos), and every member can list and read the requests `visible_maintenance` lets them see. The
building's managers are told in-app, and by email too for an emergency. This is the resident half of journey 6
in `docs/PRODUCT_SCOPE.md`. It is also the first create where a **resident** names a unit, so the unit check is
part of the security boundary: a request filed for someone else's unit would show up in that household's list.

The decisions that matter most:
- **The unit check is race-proof**: it locks the caller's membership `FOR SHARE`, so a move-out can't commit
  between the check and the insert (D10). The request is stamped with the transaction's `now()`, the clock
  occupancy writes use (D11).
- **The record fence** (D12, [ADR-0021](../adr/0021-occupancy-record-fence.md), James's answer to inbox B-10):
  an occupancy write whose transaction began before a request of its unit, but that reaches the occupancy
  after the request committed, is refused with 409 `occupancy_changed`. Without it, a manager's transfer could
  end the requester's window before their own request, and the incoming household would read it.

Cancel and the emergency phone were split out to P6-03e while building (§2, "Framing changes").

## 2. Decisions

### D10. Lock the caller's membership `FOR SHARE` before reading their occupancy

- **Problem or constraint:** criterion 2 must stop a move-out committing between the occupancy check and the
  insert; otherwise the request lands on a unit its requester just left. Occupancy writes lock the
  **membership** row `FOR NO KEY UPDATE` (`backend/app/memberships/occupancy.py::_prepare`). The draft's
  `FOR KEY SHARE` doesn't conflict with that lock.
- **Chosen:** `FOR SHARE` on the caller's membership row, then read the current occupancy (joined to an active
  membership) in the next statement (`backend/app/maintenance/service.py::_check_unit`).
- **Alternatives rejected:** `FOR KEY SHARE` (the draft): mutation m1 in the PR shows the race tests fail with
  it. Locking the occupancy row itself: a transfer also *inserts* a row the lock wouldn't cover, and `_prepare`
  already serializes on the membership.
- **Tradeoffs:** a create waits behind any occupancy write for the same membership (rare, short).
- **Basis:** ticket criterion 2 (sharpened in framing); tests below. **Source:** recorded (PR D10).

### D11. Stamp the request with the transaction's `now()`, and refuse a later move-in

- **Problem or constraint:** review round 1 F1 (High): the plan stamped `submitted_at` with
  `clock_timestamp()` after the lock. A transfer that began while the create held the lock, then waited, ended
  the occupancy at its own earlier `now()`. The request then fell *after* the requester's move-out, inside the
  incoming household's window.
- **Chosen:** `submitted_at` is the column default `now()` (ADR-0016's "one clock"). `_check_unit` raises 409
  `occupancy_changed` if the caller's occupancy started after this transaction's `now()`, so a request is never
  stamped in the unit's previous occupancy.
- **Alternatives rejected:** keep `clock_timestamp()` and make occupancy writers stamp after their lock (changes
  ADR-0016 for every record: James's call; it became B-10 option B).
- **Tradeoffs:** one case was left: a write that began *before* the create and locked *after* it. D12 closes it.
- **Basis:** review finding (round 1), ADR-0016. **Source:** recorded (PR D11).

### D12. The record fence (ADR-0021)

- **Problem or constraint:** review round 2 F1 (High, reproduced): two manager transfers whose transactions
  began before a resident's create, but took their locks after it, ended resident1's occupancy and started
  resident2's at their earlier `now()`. The incoming household read the outgoing one's request and photo. The
  create can't see a transaction that hasn't locked yet, so there is no fix inside maintenance. Changing
  ADR-0016 was a stop rule; the ticket was blocked as inbox B-10.
- **Chosen (James, option A):** `start_occupancy`, `end_occupancy` and `transfer_occupancy`, called **without
  `at`**, raise `OccupancyTimeError` when a registered record of a unit they end or start was stamped after
  their `at` (`backend/app/memberships/occupancy.py::_fence`). Domains register their records with
  `register_unit_record`, called next to the model (`backend/app/maintenance/models.py::register_unit_record`),
  so `memberships` never imports maintenance. Onboarding approve and invitation accept now map
  `OccupancyTimeError` to 409 `occupancy_changed`; before this ticket an `OccupancyTimeError` there was a 500.
- **Why it is enough:** the **end side** is complete: the create holds the requester's membership `FOR SHARE`
  until it commits, and ending that membership's occupancy locks the same row first, so the fence sees the
  committed request (READ COMMITTED gives each statement a fresh snapshot). The **start side** is
  conservative: a newcomer's start locks the newcomer's membership, so it only sees committed requests. When it
  misses an uncommitted one, the result is the same as the serial order "move in, then the request": the
  newcomer was a co-occupant when the request was filed, which `visible_maintenance` allows by design (review
  round 3 raised this; §6).
- **Alternatives rejected:** B, `clock_timestamp()` after the lock (supersedes "one clock", breaks the
  same-transaction rule many tests pin); C, accept the leak (CLAUDE.md rule 3).
- **Tradeoffs and accepted limitations:** a racing move-out, transfer, approval or accept gets a 409 and is
  retried by the user. The fence refuses on any later record of the unit, a co-occupant's too. An explicit `at`
  (seeds, backfills) isn't fenced. Packages aren't registered yet and keep the gap (follow-up).
- **Basis:** James's answer to B-10 (in session, 2026-10-26); ADR-0021. **Source:** recorded (ADR-0021, PR D12).

### D7. `Idempotency-Key` is required, and another member's key is a 409

- **Problem or constraint:** P6-03a made the key NOT NULL and unique **per building**. Packages look a key up
  through `visible_packages`, which works because only staff create packages. A resident can't see another
  resident's request, so copying that lookup would find nothing, hit `ON CONFLICT DO NOTHING`, find nothing
  again and fail the assert: a 500.
- **Chosen:** `_by_key` reads the caller's own request through `visible_maintenance(ctx)` narrowed to their
  membership; if none, a bare existence check on `(building_id, key)` gives 409 `idempotency_key_reused`. The
  other member's request is never returned.
- **Alternatives rejected:** a key unique per `(building, requester)` (a migration on P6-03a's merged table);
  reading the row without `visible_maintenance` and comparing in Python (hand-rolled visibility, rule 3).
- **Tradeoffs:** a resident learns that *some* request uses that key; keys are random client strings.
- **Basis:** ticket row 9. **Source:** recorded (PR D7).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D2 Only residents file (`require_roles(RESIDENT)`); council + resident files as a resident | Property management files too | On-behalf filing needs a "for whom" field and changes who sees it; follow-up | rule 2/3 (autonomous) | PR D2 |
| D4 Any resident may file a common-area request, with or without a unit | Only current occupants | No rule asks for it | rule 3 (autonomous) | PR D4 |
| D5 Active `property_management` members minus the caller are told; `maintenance.submitted` in-app, `…_emergency` also emails; body = category + unit name or "a common area" | Notify security; put the description in the body | Security doesn't run maintenance; resident free text would reach an email | notices convention (P6-01c D2) | PR D5 |
| D6 Order `id DESC` (`paginate`) | `submitted_at, id` keyset | uuid7 ids are creation order; equal times can't tie | convention | PR D6 |
| D8 `requester_name` for staff only (`sees_requester_names`) | Show co-occupants the name | Matches packages' `sees_recipient_names` | convention | PR D8 |
| D9 422 `unit_not_occupied`; 404 `unit_not_found`; 409 `unit_inactive` | 422 `unit_inactive` (draft) | `app/packages`' `UnitInactive` is a 409: one code, one status | code is the truth | PR D9 |
| R1 F2 re-read the caller's own request by id after finding the key taken | REPEATABLE READ | One statement instead of an isolation change | review round 1 | PR |
| R1 F3 claim photos in UUID order, write positions in the order sent | Lock all files first | `claim_file` already locks each row; one order is enough | review round 1 | PR |
| Reuse packages' `check_idempotency_key`, `request_hash` (widened to `InputModel`), `UnitInactive` | a shared module under `backend/app/core/` | Moving packages code is out of scope; follow-up | rule 3 | PR |
| `multiline_before_strip` moved from `backend/app/notices/schemas.py` to `backend/app/units/schemas.py`, used by notices and the description | A copy | One rule for "multi-line text refuses control characters except tab/CR/LF" | Inferred: reuse | — |

**Framing changes:** sharpened row 4, row 9 (the required key, its 400s, and **another resident's key**, the
case the draft missed), row 10, criterion 2 (`unit_not_occupied`, `a_council`/`multi_in_a`, the lock mode
corrected to `FOR SHARE` with a two-session test), 5 (`requester_name`, order) and 8. Changed, not loosened:
`idempotency_key_reused` and `unit_inactive` are 409 as in `app/packages`, not the draft's 422 (inbox "Decisions
to audit" in the bookkeeping commit). Moved, not loosened: cancel (criterion 6) and the emergency phone
(criterion 7) went to **P6-03e**, whose ticket file is in this PR; its code waits on the local branch
`p6-03e-start`.

**Plan versus final code:** the plan stamped `submitted_at` with `clock_timestamp()` after the lock; review
round 1 replaced it with `now()` plus the `occupancy_changed` check (D11). The plan had no change outside
`app/maintenance`; review round 2 F1 and B-10 added the record fence in `backend/app/memberships/occupancy.py` and the
409 mappings in onboarding and invitations (D12).

## 3. How it is implemented

### Overview

- `backend/app/maintenance/router.py::create`, `backend/app/maintenance/router.py::list`, `backend/app/maintenance/router.py::get`: the three routes, all behind
  `require_feature(Feature.MAINTENANCE)`; create also needs the resident role.
- `backend/app/maintenance/service.py::create_request`: key check → replay or unit check → insert → photo
  claims → notify → audit → one commit.
- `backend/app/maintenance/queries.py::visible_maintenance` (P6-03a): who sees what. Every read and the key
  lookup go through it.
- `backend/app/memberships/occupancy.py::_fence`: the record fence the occupancy helpers run after their lock.

### Walkthrough (variant A): `POST /api/buildings/{b}/maintenance-requests`

1. **HTTP.** `backend/app/maintenance/router.py::create` takes `MaintenanceRequestCreate` and the `Idempotency-Key` header. The building
   router's tenant context (`backend/app/tenancy/deps.py::get_tenant_context`) answers 401/404 first; `_RESIDENT`
   answers 403 `feature_disabled` or `forbidden_role`.
2. **Schema.** `backend/app/maintenance/schemas.py::_location_shape` gives 422 for a unit request without a unit
   (or with a common area), and the reverse. `PhotoFileIds` caps photos at `MAX_PHOTOS` (5) and refuses
   duplicates; `Description` keeps tabs and newlines and refuses other control characters.
3. **Key.** `check_idempotency_key` (400 `idempotency_key_required` / `invalid_idempotency_key`), then
   `request_hash` of the validated body. `_by_key` runs **first**, so a retry replays even if the unit was
   deactivated or the caller moved since.
4. **Unit check** (`_check_unit`), only for a unit request. The SQL it runs (compiled from the code):

   ```sql
   SELECT units.label, units.tower, units.is_active FROM units
    WHERE units.id = $1 AND units.building_id = $2 FOR KEY SHARE;
   SELECT building_memberships.id FROM building_memberships
    WHERE building_memberships.id = $1 AND building_memberships.building_id = $2 FOR SHARE;
   -- then the caller's current occupancy of the unit, joined to an ACTIVE membership,
   -- and 409 occupancy_changed if it started after SELECT now()
   ```

   The `FOR SHARE` conflicts with every occupancy write's `FOR NO KEY UPDATE` on the same row, so a move-out
   in flight finishes first (and this reads what it committed), and one that starts later waits for this
   commit. If the check refuses, `create_request` looks the key up once more: the original may have committed
   while this waited (round 2 F2).
5. **Insert.** `INSERT … ON CONFLICT (building_id, idempotency_key) DO NOTHING RETURNING id`. If another create
   with the key won, this waits for it, then replays its row.
6. **Photos.** `claim_file(…, MAINTENANCE_PHOTO, "maintenance_request", id)` for each id in UUID order, then
   the photo rows with positions in the order sent.
7. **Side effects in the same transaction:** `notify` the managers (in-app rows, plus an `email.send` job per
   manager for an emergency), `record_audit` `maintenance.submitted` (unit id, category, photo ids; no text).
8. **Response.** `_out` builds `MaintenanceRequestOut` (photos in order, the unit's tower and label,
   `requester_name` for staff only), then the single `commit`. 201, or 201 with `Idempotent-Replayed: true`.

**The other side: an occupancy write after this create.** A manager's `transfer_member` or `deactivate_member`
calls the helpers without `at`. `_prepare` locks the membership (`FOR NO KEY UPDATE`, which waits for the
create's `FOR SHARE`), then `_fence` runs, per registered record type:

```sql
SELECT EXISTS (SELECT * FROM maintenance_requests
 WHERE maintenance_requests.building_id = $1 AND maintenance_requests.unit_id = $2
   AND maintenance_requests.submitted_at > $3) AS anon_1
```

where `$3` is the write's `at`, its transaction's `now()`. A hit raises `OccupancyTimeError`; the service maps
it to 409 `occupancy_changed` and the request's session rolls back. The index
`ix_maintenance_requests_building_id_unit_id_submitted_at` (P6-03a) serves the lookup.

### Data model changes

None (P6-03a's tables). New notification kinds `maintenance.submitted` (in-app) and
`maintenance.submitted_emergency` (emails the existing `notification` template); audit action
`maintenance.submitted`.

## 4. The code

**Files changed** (from `git diff --numstat origin/main...HEAD`)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/maintenance/service.py` | create, list, get, the unit check, the key lookup | +374 |
| `backend/app/maintenance/router.py`, `schemas.py` | routes; `MaintenanceRequestCreate` / `Columns` / `Out` | +73, +89 |
| `backend/app/maintenance/queries.py` | `sees_requester_names` | +6 |
| `backend/app/maintenance/models.py` | registers the request with the record fence | +8 |
| `backend/app/memberships/occupancy.py` | the record fence | +59 −4 |
| `backend/app/onboarding/service.py`, `router.py` | approve maps `OccupancyTimeError` to 409 | +19 −8, +2 −1 |
| `backend/app/invitations/service.py`, `router.py` | accept maps `OccupancyTimeError` to 409 | +25 −14, +2 −1 |
| `backend/app/units/schemas.py`, `backend/app/notices/schemas.py` | `multiline_before_strip` moved and shared | +15, +3 −18 |
| `backend/app/packages/service.py` | `request_hash` takes any `InputModel` | +2 −1 |
| `backend/app/notifications/kinds.py`, `backend/app/audit/actions.py`, `backend/app/main.py` | kinds, action, router | +7, +2, +2 |
| `backend/tests/maintenance/test_{api,idempotency,notify,atomicity,concurrency,record_fence}.py` | tests | +1922 |
| `backend/tests/notifications/test_notify.py`, `frontend/src/api/client.test.ts` | enumerations of kinds and GET paths | +3 −1, +2 |
| `frontend/src/api/schema.d.ts` | regenerated | +349 −2 |
| `docs/adr/0021-occupancy-record-fence.md`, ADR-0016 status line, ADR index | the fence's ADR | +70, +1 −1, +1 |
| `docs/tickets/…` (P6-03b, new P6-03e, P6-03c/P6-04b/P6-04c deps, index), `docs/HUMAN_INBOX.md` | framing, split, B-10 resolved | +232 −59 |

**Key excerpts**

`backend/app/maintenance/service.py::create_request` (the head; the insert, photos, notify and audit follow as
in §3)

```python
    key = check_idempotency_key(idempotency_key)
    digest = request_hash(data)
    # First, so a retry gets the original even if the unit was deactivated or the caller moved
    # since.
    existing = await _by_key(db, ctx, key)
    if existing is not None:
        return await _replay(db, ctx, existing, digest)
    try:
        unit_name = await _check_unit(db, ctx, data.unit_id) if data.unit_id is not None else None
    except UnitNotFound, UnitInactive, UnitNotOccupied, OccupancyChanged:
        # The original may have committed while this waited on the check's locks (review round 2,
        # F2): a retry of a request that exists replays it.
        existing = await _by_key(db, ctx, key)
        if existing is None:
            raise
        return await _replay(db, ctx, existing, digest)
```

- The key lookup comes before any lock, so a retry is answered by what exists, not by today's unit state.
- The `except` is Python 3.14's unparenthesized multi-exception form.
- Without the second `_by_key`, a retry whose original committed while it waited gets a 422 instead of the
  request it already made (round 2 F2; `test_a_retry_replays_even_if_the_unit_check_would_now_refuse`).

`backend/app/maintenance/service.py::_check_unit` (the lock and the clock check)

```python
    await db.execute(
        select(BuildingMembership.id)
        .where(
            BuildingMembership.id == ctx.membership_id,
            BuildingMembership.building_id == ctx.building_id,
        )
        .with_for_update(read=True)
    )
    started_at = await db.scalar(
        select(UnitOccupancy.started_at)
        # ...
        .where(
            UnitOccupancy.building_id == ctx.building_id,
            UnitOccupancy.membership_id == ctx.membership_id,
            UnitOccupancy.unit_id == unit_id,
            UnitOccupancy.ended_at.is_(None),
            # Re-read after the lock: a suspension committed since the tenant context was built.
            BuildingMembership.status == MembershipStatus.ACTIVE,
        )
    )
    if started_at is None:
        raise UnitNotOccupied(detail="You can file a request only for the unit you live in.")
    if started_at > (await db.execute(select(func.now()))).scalar_one():
        # Moved in after this transaction began: its `now()` would stamp the request in the unit's
        # previous occupancy (ADR-0016's retry case; review round 1, F1).
        raise OccupancyChanged(detail="Your unit changed while you were filing; try again.")
```

- `with_for_update(read=True)` is `FOR SHARE` (D10). Change it to `key_share=True` and a move-out can commit
  between the read and the insert (mutation m1 in the PR).
- The occupancy is read in a **separate statement after** the lock, so READ COMMITTED gives it a snapshot that
  includes what the waited-for move-out committed.
- Remove the `started_at > now()` check and a resident moved in after the create began gets a request stamped
  in the previous occupant's time (`test_a_move_in_committed_after_the_create_began_is_occupancy_changed`).

`backend/app/maintenance/service.py::_by_key`

```python
    own = await db.scalar(
        visible_maintenance(ctx)
        .where(
            MaintenanceRequest.idempotency_key == key,
            MaintenanceRequest.requester_membership_id == ctx.membership_id,
        )
        .execution_options(populate_existing=True)
    )
    if own is not None:
        return own
    taken = await db.scalar(
        select(MaintenanceRequest.id).where(
            MaintenanceRequest.building_id == ctx.building_id,
            MaintenanceRequest.idempotency_key == key,
        )
    )
    if taken is None:
        return None
    # The caller's own may have committed between the two reads (review round 1, F2).
    own = await db.scalar(
        visible_maintenance(ctx)
        .where(
            MaintenanceRequest.id == taken,
            MaintenanceRequest.requester_membership_id == ctx.membership_id,
        )
        .execution_options(populate_existing=True)
    )
    if own is None:
        raise IdempotencyKeyReused(detail="This Idempotency-Key was used with a different request.")
    return own
```

- The only read that isn't through `visible_maintenance` returns an id and nothing else, and only decides
  between "none" and 409 (D7).

`backend/app/memberships/occupancy.py::_fence`, and its use in `backend/app/memberships/occupancy.py::end_occupancy` and `backend/app/memberships/occupancy.py::transfer_occupancy`

```python
async def _fence(db: AsyncSession, building_id: UUID, unit_id: UUID, at: datetime) -> None:
    """Refuse when a record of the unit was stamped after `at`. Runs after the membership lock: a
    create that held it has committed, and READ COMMITTED shows its row to this statement."""
    for building_col, unit_col, time_col in _unit_records:
        later = await db.scalar(
            select(exists().where(building_col == building_id, unit_col == unit_id, time_col > at))
        )
        if later:
            raise OccupancyTimeError("a record of the unit was stamped after `at`")

# in end_occupancy, after the conditional UPDATE … RETURNING:
    if fenced and ended is not None:
        await _fence(db, building_id, ended.unit_id, at)
    return ended

# in transfer_occupancy:
    fenced = at is None
    at = await _prepare(db, building_id, membership_id, at)
    # The inner calls get `at`, so they don't fence: the fence is for the implicit `now()` only.
    ended = await end_occupancy(db, building_id=building_id, membership_id=membership_id, at=at)
    if fenced:
        if ended is not None:
            await _fence(db, building_id, ended.unit_id, at)
        await _fence(db, building_id, new_unit_id, at)
```

- `fenced` is decided **before** `_prepare` replaces `None` with `now()`: an explicit `at` (seeds, backfills)
  is never fenced. `start_occupancy` fences the unit it starts the same way.
- `transfer_occupancy` still goes through the public `end_occupancy` / `start_occupancy` (with an explicit
  `at`), so `backend/tests/test_occupancy_helpers.py::test_transfer_failing_after_the_end_persists_neither_change`,
  which patches `start_occupancy`, still exercises it.
- Remove the `end_occupancy` call to `_fence` and the R2 F1 proof passes the stale transfer again (the
  mutation probe in the PR: 4 tests fail with `_fence` returning early).

`backend/tests/maintenance/test_record_fence.py::test_a_move_out_that_began_before_a_request_is_refused_then_a_retry_ends_after_it`

```python
        async with sessions() as stale:
            await stale.scalar(select(func.now()))
            request = await _submit(sessions, world, _data(world))
            code = await _code(deactivate_member(stale, manager, resident, MOVE_OUT))
        assert code == "occupancy_changed"
        assert await _current_unit(sessions, resident) == world.a_101.id

        async with sessions() as retry:
            await deactivate_member(retry, manager, resident, MOVE_OUT)
        # ...
        assert ended is not None and ended > request.submitted_at
```

- "Began before" is a session whose first statement ran before the create, as an HTTP request's auth queries
  do. The refusal leaves the occupancy current; the retry ends it after the request.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A move-out commits between the unit check and the insert | The create waits for it, then answers 422 (or succeeds if it rolls back) | `backend/tests/maintenance/test_concurrency.py::test_a_create_waits_for_a_move_out_in_flight` (`commits`, `rolls-back`) |
| A move-out starts while a create holds the lock | It waits, and ends the occupancy after the request | `backend/tests/maintenance/test_concurrency.py::test_a_move_out_waits_for_a_create_in_flight`, `backend/tests/maintenance/test_concurrency.py::test_a_move_out_starting_during_a_create_ends_after_the_request` |
| Transfers start during a create (R1 F1) | Both wait; the request stays in the outgoing occupancy only | `backend/tests/maintenance/test_concurrency.py::test_an_incoming_household_does_not_inherit_the_outgoing_ones_request` |
| A move-in committed after the create began | 409 `occupancy_changed`, nothing written | `backend/tests/maintenance/test_concurrency.py::test_a_move_in_committed_after_the_create_began_is_occupancy_changed` |
| Transfers that began **before** the create, locking after it (R2 F1) | Both 409 `occupancy_changed`; the incoming household can't read the request | `backend/tests/maintenance/test_concurrency.py::test_earlier_manager_transactions_do_not_expose_an_outgoing_request` |
| The same through a move-out, an approval, an invitation accept | 409 `occupancy_changed`; a retry succeeds | `backend/tests/maintenance/test_record_fence.py::test_a_move_out_that_began_before_a_request_is_refused_then_a_retry_ends_after_it`, `backend/tests/maintenance/test_record_fence.py::test_an_approval_that_began_before_a_request_is_refused`, `backend/tests/maintenance/test_record_fence.py::test_an_invitation_accept_that_began_before_a_request_is_refused` |
| A request elsewhere (common area, another unit) | No refusal | `backend/tests/maintenance/test_record_fence.py::test_a_request_elsewhere_does_not_refuse_a_move_out` (both cases) |
| An explicit `at` | Not fenced | `backend/tests/maintenance/test_record_fence.py::test_an_explicit_time_is_not_fenced` |
| An uncommitted request the start side can't see (R3 F1) | Same result as the serial order: a co-occupant sees it | `backend/tests/maintenance/test_record_fence.py::test_a_newcomer_who_moved_in_before_a_request_keeps_it_after_the_requester_leaves` |
| Another resident's key | 409, never their request, nothing written | `backend/tests/maintenance/test_idempotency.py::test_another_residents_key_is_409_and_never_their_request` |
| Two creates with one key at once | One created, one replay; one set of notifications | `backend/tests/maintenance/test_concurrency.py::test_two_concurrent_creates_of_one_key_give_one_request` |
| Original commits between the two key reads (R1 F2) | Replay | `backend/tests/maintenance/test_concurrency.py::test_a_retry_whose_original_commits_between_the_two_key_reads_replays` |
| Retry behind a unit refusal (R2 F2), or behind a move-out | Replay | `backend/tests/maintenance/test_concurrency.py::test_a_retry_replays_even_if_the_unit_check_would_now_refuse`, `backend/tests/maintenance/test_concurrency.py::test_a_retry_waiting_behind_a_move_out_replays` |
| Two creates claiming the same photos in opposite orders (R1 F3) | One 201, one 422; no deadlock | `backend/tests/maintenance/test_concurrency.py::test_two_creates_claiming_the_same_photos_in_opposite_orders_give_one_422` |
| A failure after insert and claims | Nothing persists; files unattached | `backend/tests/maintenance/test_atomicity.py::test_a_failure_after_the_insert_and_claims_leaves_nothing` |

Acceptance criteria → tests (all in `backend/tests/maintenance/`):
1. Tenant table: `test_api.py` (`test_signed_out_is_401_on_every_route`, `test_outsiders_get_building_not_found_on_every_route`,
   `test_staff_may_not_file`, `test_council_alone_lists_an_empty_page`, `test_another_residents_request_is_the_same_404_as_none`,
   `test_another_buildings_unit_or_none_is_unit_not_found`, `test_another_buildings_photo_is_file_not_found_and_writes_nothing`,
   `test_each_persona_lists_and_reads_what_visible_maintenance_grants`); row 9 `test_idempotency.py`; row 10 the two concurrency tests above.
2. Unit check: `backend/tests/maintenance/test_api.py::test_resident_files_only_for_the_unit_they_live_in_now`, `backend/tests/maintenance/test_api.py::test_multi_files_for_their_a_unit_from_a`,
   `::test_resident_without_a_current_unit_may_file_only_for_a_common_area`, `::test_a_deactivated_unit_is_refused`,
   `::test_submitted_at_is_the_transactions_now`, and the concurrency and fence rows above.
3. `backend/tests/maintenance/test_api.py::test_location_shape_is_checked_by_the_schema`. 4. `backend/tests/maintenance/test_api.py::test_photo_limits_are_checked_by_the_schema`,
   `::test_a_photo_the_caller_may_not_attach_is_invalid_file`, `::test_photos_download_for_everyone_who_sees_the_request`,
   `backend/tests/maintenance/test_concurrency.py::test_photos_keep_the_order_sent_whatever_the_claim_order`.
5. `::test_each_persona_lists_and_reads_what_visible_maintenance_grants`, `::test_status_filter_takes_one_status`,
   `::test_cursor_pages_without_skipping_or_repeating_on_equal_times`, `::test_requester_name_is_shown_to_staff_only`.
6–7. Moved to P6-03e. 8. `test_notify.py` (all seven). 9. `backend/tests/maintenance/test_api.py::test_feature_off_is_403_on_every_route_and_writes_nothing`.
10. `test_atomicity.py`. 11. `backend/tests/maintenance/test_api.py::test_bad_input_is_422`, `backend/tests/maintenance/test_api.py::test_a_lone_surrogate_in_the_description_is_422`,
   `::test_description_keeps_its_longest_value`. 12. `::test_create_audit_holds_ids_and_field_values_only`.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` high | `c1bd2cc` | BLOCK | F1 High: `clock_timestamp()` lands after a waiting transfer's end; F2 Medium: original commits between the key reads → 409; F3 Medium: opposite photo orders deadlock → 500 | All fixed (D11; the re-read; UUID-order claims) |
| 2 | Codex, fresh | `a5938cb` | BLOCK | F1 High: transfers that began before the create expose the request; F2 Medium: a retry behind a unit refusal answers 422 | F2 fixed; F1 blocked as inbox B-10, then fixed by D12 (James: option A) |
| 3 | Codex, fresh, verify only | `c1d49ee` | BLOCK | R3 F1 High: an incoming transfer fences before an uncommitted request; note: `test_a_retry_waiting_behind_a_move_out_replays` never ran | R3 F1 dismissed (serial-equivalent, co-occupant visibility by design; now a test); the test fixed |
| 4 | Codex, fresh, verify only (James) | `725721a` | **MERGE** | none | — |

- **R1 F1.** A transfer that began while the create held the lock ended the occupancy at its own `now()`, which
  was earlier than the create's `clock_timestamp()`: Codex's proof printed "old occupancy ended …50.717, new
  started …50.841, submission …50.928". Fixed by D11; the three R1 tests in §5 were red, then green.
- **R2 F1.** The same leak, through transactions that began *before* the create. Codex's proof returned the
  outgoing household's description to the incoming one. Kept as a strict `xfail` while blocked. After James
  chose option A, the fence's tests were red (3 failed / 3 passed), then green, and the `xfail` became a plain
  test. Mutation probe: `_fence` returning early fails all four fence tests (`PROBE OK`).
- **R3 F1.** Codex reproduced an incoming transfer whose fence ran before the create committed. I ran the same
  operations serially (move-in commits, then the request, then the move-out): resident2 sees the request just
  the same, because they were a co-occupant when it was filed. R2 F1's outcome (the requester's own window
  ending before their request) matches no serial order; R3 F1's does. Dismissed with that test. James chose a
  4th verify-only round instead of overruling the BLOCK, and round 4 accepted the dismissal.
- **R3 note.** The test had no `_run(...)`, so it passed without running. Once it ran it hung: Postgres may wake
  the retry before the waiting move-out, and the retry's replay kept its transaction (and the lock) open, where
  an HTTP request would have closed it. The test now ends the retry's transaction and accepts either order. An
  `ast` scan found no other scratch-database test without its top-level call.

## 7. Not verified, accepted risks and follow-ups

Not verified:
- The fence's 409 is tested at the service level; no test drives it through HTTP. The routes reuse each
  service's existing problem mapping, and the OpenAPI docstrings list `occupancy_changed`.
- The invitation accept's `end_occupancy` branch (a reactivated membership without a unit) shares the 409
  mapping but has no fence test. A deactivated membership has no current occupancy there, so no row is
  normally fenced.
- No load test of the fence's extra `EXISTS` per occupancy write (indexed).
- The fence closes the gap only for **registered** records. Packages (`received_at = now()`) still have it.

Accepted risks and follow-ups (each reaches the inbox or the index in the bookkeeping commit):
- **P6-03e**: cancel and the emergency phone (ticket file in this PR; code on the local branch `p6-03e-start`).
- Register packages with the record fence (ADR-0021's "Negative").
- Property management filing requests, on a resident's behalf or for a common area (D2).
- Shared idempotency helpers in a module under `backend/app/core/` if a third domain needs them.
- Security isn't told of an emergency request (D5).
- Racing occupancy writes now answer 409 `occupancy_changed` in onboarding approve and invitation accept. No
  client code was changed for it, and nothing retries automatically: the user retries. How each screen shows
  this 409 was not checked (tracked only here).

## 8. How to change this safely

- **A new unit-addressed record type** (packages, a future one): call `register_unit_record(Model.building_id,
  Model.unit_id, Model.<stamp>)` in its `models.py`, stamp it with `now()`, and copy
  `backend/tests/maintenance/test_record_fence.py::test_a_move_out_that_began_before_a_request_is_refused_then_a_retry_ends_after_it` for
  it. Also give its create a `FOR SHARE` on the requester's membership if a resident creates it, or the end
  side isn't complete for it.
- **A new occupancy write path:** call the helpers without `at` and map `OccupancyTimeError` to 409
  `occupancy_changed` (see `backend/app/memberships/service.py::_occupancy_changed`). A missed mapping
  surfaces as an uncaught `OccupancyTimeError` (a 500); copy one of `test_record_fence.py`'s "began before"
  tests for the new path to catch it.
- **Changing the create:** keep `_by_key` before `_check_unit`, the lock before the occupancy read, and one
  commit. `test_concurrency.py` and `test_atomicity.py` catch each.

## 9. Must explain, then quiz

1. **Trace `POST /maintenance-requests` from HTTP to COMMIT.** `backend/app/maintenance/router.py::create` → `create_request`: the key
   (`check_idempotency_key`, `_by_key`), then the unit in `_check_unit` (unit `FOR KEY SHARE`, membership
   `FOR SHARE`, then the occupancy read), then the insert, then each photo in `claim_file` (UUID order), the
   photo rows, `notify`, `record_audit`, `_out`, and one `commit`. A move-out can't commit in between because
   it must first lock the same membership `FOR NO KEY UPDATE` (`backend/app/memberships/occupancy.py::_prepare`), which conflicts with
   the create's `FOR SHARE` held to commit. One already in flight finishes first, and the occupancy read (a new
   statement) sees it. A move-out whose transaction began earlier, but locked later, is refused by the record
   fence.
2. **Why does another resident's `Idempotency-Key` give 409, not their request?** The key is unique per
   building, but `_by_key` only returns the caller's own request (through `visible_maintenance`). If the key
   belongs to anyone else, a bare existence check gives 409 `idempotency_key_reused`. Returning theirs would
   show a resident another household's request; finding nothing would hit `ON CONFLICT DO NOTHING` twice and
   fail with a 500.
3. **Why can't a resident file for a unit they don't occupy, when the composite FK keeps the unit in the
   building?** The FK only proves the unit is in the building. Visibility is by occupancy window
   (`visible_maintenance`), so a request filed for 102 by a 101 resident would appear in 102's household list
   and let one household write into another's. `_check_unit` requires a current occupancy of that unit by an
   active membership.
4. **Who hears of a new request, by which channel, with what text?** Active `property_management` members of
   the building, minus the requester (`staff_user_ids`, then the filter in `create_request`). `maintenance.submitted`
   is in-app only; `maintenance.submitted_emergency` is in-app plus an email job (template `notification`).
   Security, council and residents aren't told. Title: "New maintenance request" / "Emergency maintenance
   request"; body: the category's fixed name and the unit's name, or "a common area". The description and the
   common-area text never reach a notification. A replay notifies no one.

Quiz:

1. A manager opens the "move out" dialog, which starts a transaction, and submits 2 s later. In between,
   the resident files a request for their unit. What does the manager see, and what happens when they retry?
2. Why is `fenced` computed before `_prepare` is called, not after?
3. Two creates send photos `[A, B]` and `[B, A]` at once. Why doesn't that deadlock now, and in what order do
   the photos appear on the winning request?
4. What would break if `_check_unit` locked the membership `FOR KEY SHARE` instead of `FOR SHARE`?
5. How would you extend the record fence to packages, and what else must a packages create do for the end side
   to be complete?

<details><summary>Answers</summary>

1. 409 `occupancy_changed`: the move-out's `at` is its transaction's start, earlier than the request's
   `submitted_at`, and `_fence` finds the request after the lock. Nothing is written. The retry runs in a new
   transaction whose `now()` is after the request, so it succeeds and ends the occupancy after the request
   (`test_a_move_out_that_began_before_a_request_is_refused_then_a_retry_ends_after_it`).
2. `_prepare` replaces `None` with `now()`, so after it the helper can't tell an implicit `at` from a caller's
   explicit one. Explicit times (seeds, backfills) must not be fenced; `test_an_explicit_time_is_not_fenced`.
3. Both claim in UUID order (`sorted(data.photo_file_ids)`), so the second waits on the first file instead of
   holding one the first needs. It then finds the file claimed and answers 422. The photo rows use positions in
   the order sent, not the claim order (`test_photos_keep_the_order_sent_whatever_the_claim_order`).
4. `FOR KEY SHARE` doesn't conflict with `FOR NO KEY UPDATE`. A move-out could commit between the occupancy
   read and the insert, leaving a request on a unit its requester just left. It would also break the record
   fence's end side, which relies on the move-out waiting for the create's commit (mutation m1 fails the race
   tests).
5. Call `register_unit_record(Package.building_id, Package.unit_id, Package.received_at)` in
   `backend/app/packages/models.py`, and add fence tests for packages. Packages are created by staff and hold no
   recipient membership lock, so a move-out wouldn't wait for an uncommitted package. The create would need to
   lock the unit's current occupants' memberships `FOR SHARE` (or another lock the occupancy write also takes)
   for the end side to see it.

</details>
