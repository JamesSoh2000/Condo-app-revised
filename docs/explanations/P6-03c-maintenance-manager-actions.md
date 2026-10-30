# Explanation — P6-03c Maintenance manager actions: start, hold, resolve, reopen

> **PR:** #158 · **Source revision:** `608adeabfb77b32178d6e35d4561b0133bb45104`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 158 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `608adea` the diff (`git diff origin/main...HEAD`, 17 paths), the whole of
> `backend/app/maintenance/service.py::move_request`, `::_move_columns`, `::_requester_who_sees`,
> `backend/app/maintenance/state.py::MOVES`, the model, the migration, the router, the PR body (both review rounds)
> and the assertions of every test cited below; ran `uv run pytest tests/maintenance/test_transitions.py
> tests/maintenance/test_status_notify.py tests/maintenance/test_atomicity.py tests/maintenance/test_concurrency.py
> tests/notices/test_concurrency.py tests/test_world.py tests/helpers/test_lock_wait.py`: 189 passed. `make check`
> at this head: 3307 backend and 1450 frontend tests passed. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A.

## 1. What was built and why

A property manager now moves a maintenance request through its life: **start** (or resume a held one), **hold**,
**resolve**, and **reopen** a resolved one within 14 days. These are four action endpoints
(`POST …/maintenance-requests/{id}/start|hold|resolve|reopen`) over one service function,
`backend/app/maintenance/service.py::move_request`. Each move locks the request, writes the new status with a
conditional `UPDATE` (CLAUDE.md rule 7), writes a row in the new `maintenance_status_events` table (the timeline
P6-04c will show, ADR-0020), tells the requester in-app and by email, and writes an audit row, all in one commit.

The two decisions that matter most: **reopen's 14-day window is checked again after the last statement that can
wait on a lock**, so a window that closes during a wait refuses the reopen (criterion 5). And **who gets told is
read only after any access change in flight has committed**: the read waits on the building lock that every
suspension and role change takes (review round 1).

## 2. Decisions

### D1. The lock-wait test helper is the existing `act_blocked_on_lock` (framing; a loosened criterion)

- **Problem or constraint:** the ticket asked for a new helper, `hold_row_lock` in a new file `locks.py` under the test helpers, that
  holds `FOR UPDATE` in its own session and proves the request under test is waiting on it. The ticket was drafted
  before WF-02b built `backend/tests/helpers/lock_wait.py::act_blocked_on_lock`, which does exactly that.
- **Chosen:** use `act_blocked_on_lock`. The notices fan-out test
  (`backend/tests/notices/test_concurrency.py::test_a_notice_expiring_while_its_fan_out_waits_is_not_published`)
  is rewritten on it, as the ticket said, still asserting the same outcome. `backend/tests/README.md` documents it
  ("A wait before a check").
- **Alternatives rejected:** a second helper: two ways to do one thing, and a weaker proof (the old test used a
  `before_cursor_execute` event and a sleep; `act_blocked_on_lock` checks `pg_blocking_pids` for the action's own
  backend).
- **Tradeoffs and accepted limitations:** the ticket's named interface does not exist; its Frame notes explain why.
- **Basis:** P6-03e's carry in the ticket ("prove each wait with `act_blocked_on_lock`"); autonomous.
- **Source:** recorded (ticket Frame notes; PR #158 D1).

### D2. Who is told of a status change, and how (framing; autonomous)

- **Problem or constraint:** criterion 6 left the recipients and the notification kind to framing. Criterion 6a:
  `notify`'s email dedupe key is `<kind>:<entity_id>:<user_id>`, unique forever, so a second hold of the same
  request would send no email if the request were the entity.
- **Chosen:** only the requester, if their membership is active and holds a role that sees their own request
  (`backend/app/maintenance/service.py::_requester_who_sees`, the rule P6-03d uses for staff replies), and never
  the actor. One kind, `maintenance.status_changed`, which emails with the `notification` template. The
  notification's entity is the **status event**, so each move has its own dedupe key and `notify` is unchanged.
  Managers are not told of a resident's cancel or of another manager's move.
- **Alternatives rejected:** a kind per status (four kinds, one template, one audience; nothing reads kinds
  separately yet). Telling co-occupants (P6-03d tells only the requester about replies). Keeping the request as the
  entity and changing `notify` (a shared helper P6-03d also avoided changing).
- **Tradeoffs and accepted limitations:** a co-occupant who sees the request learns of changes only by looking.
  Every move emails, including start and hold.
- **Basis:** P6-03d D2 for who is told; autonomous otherwise. **Source:** recorded (PR #158 D2, ticket Frame notes).

### D3. The reopen window: 409 `reopen_window_closed`, open strictly before 14 days (framing)

- **Problem or constraint:** the ticket left the status and code open; criterion 4 says that at exactly 14 days
  the window is closed.
- **Chosen:** `resolved_at > statement_timestamp() - interval '14 days'`
  (`backend/app/maintenance/service.py::reopen_window_open`), refused with 409 `reopen_window_closed`.
- **Alternatives rejected:** 422 (as `notice_expired`): the request is well formed; the request's state refuses
  it, like `invalid_transition`.
- **Basis:** the ticket's example; autonomous. **Source:** recorded (PR #158 D3).

### D4. Status events carry `from_status` (framing; autonomous)

- **Problem or constraint:** ADR-0020 lists the event's columns as building, request, status, at, by. Three moves
  lead to `in_progress` (a first start, a resume, a reopen); a timeline can't tell them apart without the audit
  log, which residents can't read.
- **Chosen:** add `from_status`, with `CHECK (from_status <> status)`.
- **Alternatives rejected:** deriving it from the previous event: the first event's source is implicit, and every
  reader must order the events.
- **Basis:** autonomous. **Source:** recorded (PR #158 D4).

### D5. The recipient read waits on the building lock (review round 1)

- **Problem or constraint:** round 1 (R1-F1) showed a suspension committing after the requester was read, while a
  later `INSERT` waited, still got the requester told and emailed. A role change deletes `membership_roles` rows
  and never touches the membership row.
- **Chosen:** `_requester_who_sees` first takes `SELECT … FROM buildings … FOR SHARE`, then reads the requester in a
  new statement. Every write that takes access away (`suspend_member`, `deactivate_member`, `change_roles`) first
  takes the building `FOR NO KEY UPDATE` (`backend/app/memberships/service.py::_lock_building`), and the two locks
  conflict.
- **Alternatives rejected:** `FOR SHARE` on the requester's membership (it catches a suspension, not a role
  change); checking again after the `INSERT`s (the change could still commit between that check and this
  commit).
- **Tradeoffs and accepted limitations:** a move or a staff reply and a membership write in the same building run
  one after the other. The managers' own eligibility (`staff_user_ids`, read on create and on a resident's comment)
  has the same unlocked read; that is a follow-up (§7).
- **Basis:** review finding (round 1). **Source:** recorded (PR #158 "Independent review", D5).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Security can't act; property management only | security starts and resolves | the stub's default | ticket | recorded |
| `hold` takes no reason (no body on any verb) | a `MaintenanceHold` body | the stub has none; a public comment carries it | ticket, autonomous | recorded (Frame notes) |
| `start` also resumes from `on_hold` | a fifth verb `resume` | the ticket names four verbs; ADR-0020 calls the resume `on_hold → in_progress` | ticket | recorded |
| Reopen leads to `in_progress`, clears `resolved_*`, keeps `started_*`; `cancelled` is final | reopen to `submitted`; reopen a cancel | ADR-0020 | ADR-0020 | recorded |
| One clock per move: the `UPDATE`'s `statement_timestamp()`, returned and reused as the event's `at` | `clock_timestamp()` per statement | the row's `*_at` and its event would differ | criterion 2 | recorded (PR table) |
| One `move_request(verb)` instead of four service functions | `start_request`… wrappers | each would be one line | autonomous | recorded (PR deviations) |

**Framing changes** (ticket Frame notes, commits `774d34b` and `556411b`): the statuses each verb takes; criterion
2a (one status event per move); lock first; reopen's semantics and window; criterion 5's list of statements that can
wait; the recipients and kind; 6a's per-event entity; two added recipient cases (a manager moving their own request,
a suspended requester). **Loosened**, each to be listed in the inbox: the helper is `act_blocked_on_lock` (D1); and
**criterion 3** said "exactly one wins" for hold vs resolve and resolve vs reopen, but `ALLOWED` lets the second move
follow the first (`on_hold → resolved`, `resolved → in_progress`). Restated: the second move runs on the state the
first committed, and is 409 only if no move is allowed from there.

**Plan versus final code** (compared with the PR's Plan): one `move_request` instead of four functions; no
`_notify_status` helper (the `notify` call is inline); the event table has no `created_at`/`updated_at` (written
once; `at` is its time); its status columns are the project's non-native enums (`varchar` plus a named CHECK, as
`maintenance_requests.status`), not a reused Postgres enum type; and `_requester_who_sees` gained the building lock
in round 1 (D5). All are listed below the Plan in the PR.

## 3. How it is implemented

### Overview

- `backend/app/maintenance/router.py::start`, `::hold`, `::resolve`, `::reopen`: four routes on the building router,
  each requiring the `maintenance` feature and the property-management role, each calling `move_request` with its
  verb.
- `backend/app/maintenance/state.py::MOVES`: each verb's target status and the statuses it takes.
- `backend/app/maintenance/service.py::move_request`: lock → check → conditional `UPDATE` → event → notify → audit
  → (reopen) window again → commit.
- `backend/app/maintenance/models.py::MaintenanceStatusEvent` and migration `838f08f4cac6`: the history table.
- `backend/app/notifications/kinds.py::KINDS` gains `maintenance.status_changed`; `backend/app/audit/actions.py`
  gains `maintenance.started|held|resolved|reopened`.

### Walkthrough (variant A): `POST /api/buildings/{b}/maintenance-requests/{id}/reopen`

1. **HTTP and guards.** `backend/app/maintenance/router.py::reopen`. Its dependencies (`_MANAGER`) run
   `require_feature(Feature.MAINTENANCE)` (403 `feature_disabled`) and `require_roles(Role.PROPERTY_MANAGEMENT)`
   (403 `forbidden_role`) after `get_tenant_context` (401 signed out; 404 `building_not_found` for a non-member,
   a pending or a suspended member).
2. **Lock.** `move_request` calls `_visible(db, ctx, id, lock=True)`: `visible_maintenance(ctx)` narrowed to the id,
   `FOR UPDATE OF maintenance_requests`. Another building's request or none: 404 `maintenance_request_not_found`,
   the same body. If another move holds the row, this statement waits, then returns the row that move committed.
3. **Check.** The locked row's status must be one of `MOVES["reopen"]`'s sources (`resolved`), else 409
   `invalid_transition`. `resolved_at` is kept for step 8.
4. **Write.** One statement decides:
   `UPDATE maintenance_requests SET status='in_progress', resolved_at=NULL, resolved_by_membership_id=NULL
   WHERE id=… AND building_id=… AND status IN ('resolved') AND resolved_at > statement_timestamp() - '14 days'
   RETURNING maintenance_requests.*, statement_timestamp()`. No row back, with the row locked and `resolved`, can
   only mean the window: 409 `reopen_window_closed`.
5. **Event.** `INSERT INTO maintenance_status_events (… from_status='resolved', status='in_progress', at=<the
   UPDATE's clock>, by_membership_id=<the actor>)`.
6. **Notify.** `_requester_who_sees` takes the building `FOR SHARE`, then reads the requester's user if they are
   active and hold a role that sees their request. The actor is removed. `notify` writes the notification row and
   one `email.send` job with the key `maintenance.status_changed:<event id>:<user id>`.
7. **Audit.** `maintenance.reopened`, metadata `{"from_status": "resolved", "to_status": "in_progress"}`.
8. **Window again.** After a `flush`, `SELECT <resolved_at read in step 3> > statement_timestamp() - '14 days'`.
   False: 409 `reopen_window_closed`, and the request's session rolls back everything from steps 4–7.
9. **Response.** `_out` builds `MaintenanceRequestOut`; one `commit`; 200.

Start, hold and resolve follow steps 1–7 and 9; only reopen has a time limit.

### Data model changes

`maintenance_status_events` (migration `838f08f4cac6`, additive):

| Column / constraint | Why |
|---|---|
| `id` uuid7 | ordering a request's events by id is their order |
| `building_id` + composite FK `(building_id, request_id)` → `maintenance_requests` | the event is in its request's building (ADR-0005); RESTRICT, history isn't deleted |
| composite FK `(building_id, by_membership_id)` → `building_memberships` | the actor is a member of that building |
| `from_status`, `status` (enum CHECKs) and `ck_maintenance_status_events_status_changes` (`from_status <> status`) | an event is a change |
| `at` timestamptz | the `UPDATE`'s clock: equal to the new `*_at` for start, hold and resolve |
| index `(building_id, request_id, id)` | a request's timeline in order |

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/maintenance/service.py` | `move_request`, `_move_columns`, `reopen_window_open`, `ReopenWindowClosed`; the lock in `_requester_who_sees` | +165 −5 |
| `backend/app/maintenance/router.py` | four routes | +53 |
| `backend/app/maintenance/models.py` | `MaintenanceStatusEvent`, the entity type | +48 |
| `backend/migrations/versions/838f08f4cac6_maintenance_status_events_p6_03c.py` | the table | +104 |
| `backend/app/maintenance/state.py` | `MOVES`, `REOPEN_WINDOW` | +15 |
| `backend/app/notifications/kinds.py`, `backend/app/audit/actions.py` | the kind, four actions | +11 |
| `backend/tests/maintenance/test_transitions.py` (new), `test_status_notify.py` (new), `test_concurrency.py`, `test_atomicity.py` | criteria 1–8 | +1060 −7 |
| `backend/tests/notices/test_concurrency.py`, `backend/tests/README.md`, `backend/tests/test_world.py` | D1; the new table's row count | +55 −30 |
| `frontend/src/api/schema.d.ts` | `make gen-api` | +361 |
| `docs/tickets/…` | framing, status | +66 −3 |

`backend/app/maintenance/state.py::MOVES`

```python
MOVES: Mapping[str, tuple[MaintenanceStatus, tuple[MaintenanceStatus, ...]]] = {
    "start": (S.IN_PROGRESS, (S.SUBMITTED, S.ON_HOLD)),  # from on_hold: the resume
    "hold": (S.ON_HOLD, (S.IN_PROGRESS,)),
    "resolve": (S.RESOLVED, (S.IN_PROGRESS, S.ON_HOLD)),
    "reopen": (S.IN_PROGRESS, (S.RESOLVED,)),
}
```

- Each verb's sources, used both in the early check and in the `UPDATE`'s `WHERE`.
- Why not `sources(target)`: `start` and `reopen` share `in_progress`, so `sources(IN_PROGRESS)` would let `start`
  take a `resolved` request and skip the window (`test_start_never_reopens_a_resolved_request`).
- `test_the_verbs_and_cancel_cover_allowed_exactly` fails if `MOVES` and `ALLOWED` drift apart.

`backend/app/maintenance/service.py::move_request` (trimmed)

```python
    target, froms = MOVES[verb]
    # Locked first (as `cancel_request`): a concurrent move holding the row makes this wait, and
    # everything below, the status recorded and the UPDATE's clock, comes after the wait.
    request = await _visible(db, ctx, request_id, lock=True)
    from_status, resolved_at = request.status, request.resolved_at
    if from_status not in froms:
        raise InvalidTransition(detail=f"A {from_status} request can't be moved with {verb}.")
    # The status is in the WHERE too, not only checked above: the UPDATE decides (rule 7).
    where = [
        MaintenanceRequest.id == request_id,
        MaintenanceRequest.building_id == ctx.building_id,
        MaintenanceRequest.status.in_(froms),
    ]
    if verb == "reopen":
        where.append(reopen_window_open(MaintenanceRequest.resolved_at, _NOW))
    row = (
        await db.execute(
            update(MaintenanceRequest)
            .where(*where)
            .values(status=target, **_move_columns(verb, ctx.membership_id))
            .returning(MaintenanceRequest, _NOW)
            .execution_options(populate_existing=True)
        )
    ).one_or_none()
    if row is None:
        # The row is locked and in a source status: only the window can have refused it.
        raise ReopenWindowClosed(detail="This request was resolved 14 days ago or more.")
    moved, at = row
    # ... INSERT the status event with at=at; notify the requester (entity: the event); record_audit
    if verb == "reopen":
        # Again after the last statement that can wait (CLAUDE.md, criterion 5): ...
        await db.flush()
        assert resolved_at is not None  # noqa: S101 (a resolved row has it: `resolved_state`)
        if not await db.scalar(select(reopen_window_open(literal(resolved_at), _NOW))):
            raise ReopenWindowClosed(detail="This request was resolved 14 days ago or more.")
    out = await _out(db, ctx, moved)
    await db.commit()
    return out
```

- **Lock first** (P6-03e's lesson): an `UPDATE` that itself waits on a row lock keeps the clock it computed before
  the wait. Here the wait happens in the earlier `SELECT … FOR UPDATE`, so the `UPDATE`'s `statement_timestamp()`
  and the `from_status` read are from after it. Without the lock, two identical moves race inside the `UPDATE` and
  the loser gets `reopen_window_closed` instead of `invalid_transition` (mutation m4: 9 race tests fail).
- **The second window check** covers the statements after the `UPDATE` that can wait (D3, criterion 5). Without
  it, a window that closes while the event, notification or audit `INSERT` waits is still reopened (mutation m2:
  four wait cases fail). Moved before `notify` it misses two of them (m1, criterion 9).

`backend/app/maintenance/service.py::_move_columns`

```python
    cleared_hold = {"on_hold_at": None, "on_hold_by_membership_id": None}
    match verb:
        case "start":
            return {
                "started_at": func.coalesce(MaintenanceRequest.started_at, _NOW),
                "started_by_membership_id": func.coalesce(
                    MaintenanceRequest.started_by_membership_id, membership_id
                ),
            } | cleared_hold
        case "hold":
            return {"on_hold_at": _NOW, "on_hold_by_membership_id": membership_id}
        case "resolve":
            return {"resolved_at": _NOW, "resolved_by_membership_id": membership_id} | cleared_hold
        case _:  # reopen
            return {"resolved_at": None, "resolved_by_membership_id": None}
```

- Sets exactly the columns P6-03a's per-status CHECKs require, so the database never refuses a move the API
  accepted (no 500). `coalesce` keeps the first start through a resume; resolving a held request clears `on_hold_*`
  (`resolved_state` forbids them).

`backend/app/maintenance/service.py::_requester_who_sees` (the round-1 lock)

```python
    await db.execute(
        select(Building.id).where(Building.id == request.building_id).with_for_update(read=True)
    )
    user_id = await db.scalar(
        select(BuildingMembership.user_id).where(
            BuildingMembership.id == request.requester_membership_id,
            BuildingMembership.building_id == request.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            # ... and an EXISTS on a role that sees their own request
        )
    )
```

- D5. Without the first statement, a suspension committing while a later `INSERT` waits is still told (mutation m6:
  all six recipient-race tests fail).

`backend/tests/maintenance/test_concurrency.py::test_a_reopen_whose_window_closes_while_it_waits_is_refused` (core)

```python
        async def hold(db: AsyncSession) -> None:
            # Resolved 14 days ago less `_LEFT`, by the database clock, then the lock.
            async with sessions() as setup:
                await setup.execute(
                    update(MaintenanceRequest)
                    .where(MaintenanceRequest.id == request.id)
                    .values(resolved_at=func.clock_timestamp() - REOPEN_WINDOW + _LEFT)
                )
                await setup.commit()
            await db.execute(WAITS[held](world, request))

        async def outlast(db: AsyncSession) -> None:
            await db.execute(text(f"SELECT pg_sleep({_WAIT_SECONDS})"))

        outcome = await act_blocked_on_lock(
            sessions,
            hold=hold,
            act=lambda db: _move(db, world, request, "reopen"),
            change=outlast,
        )

        assert outcome == "409 reopen_window_closed"
        # ... the row is still resolved; no event, audit, notification or job was written
```

- Parametrized over `WAITS`: the request, the building, the actor's membership, the recipient's membership and the
  actor's user. The window has 2 s left, the holder sleeps 2.5 s on the database clock, and the helper proves the
  reopen's own backend was blocked by the holder.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A role other than property management acts | 403 `forbidden_role`, nothing written | `backend/tests/maintenance/test_transitions.py::test_other_roles_may_not_move_a_request`, `::test_multi_in_a_may_not_move_a_request` |
| Another building's request on A's URL | 404, same body as a random id | `::test_another_buildings_request_is_the_same_404_as_none` |
| A move from a status it doesn't take | 409 `invalid_transition`, nothing written | `::test_every_disallowed_source_is_invalid_transition` (every pair outside `MOVES`) |
| `start` on a resolved request | 409, it stays resolved | `::test_start_never_reopens_a_resolved_request` |
| A resume overwrites the first start | `coalesce` keeps it | `::test_each_move_sets_exactly_its_columns_and_one_event` |
| Hold, resume, hold again | one event each, in order | `::test_a_held_resumed_and_held_again_request_keeps_every_event` |
| Reopen at exactly 14 days | closed | `::test_the_window_is_open_strictly_before_14_days`, `::test_reopen_at_14_days_and_after_is_window_closed_and_changes_nothing` |
| Reopen a cancelled request | 409 `invalid_transition` | `::test_a_cancelled_request_cannot_be_reopened` |
| The window closes during a wait | 409, nothing written | `backend/tests/maintenance/test_concurrency.py::test_a_reopen_whose_window_closes_while_it_waits_is_refused` |
| Two identical moves at once | one 200, one 409, one set of writes | `::test_two_identical_moves_at_once_have_one_winner` |
| Two different moves at once | the second runs on the committed state | `::test_a_move_blocked_by_another_runs_on_the_state_it_committed` |
| The requester is suspended or loses the role meanwhile | not told | `::test_a_requester_suspended_while_a_move_waits_is_not_told`, `::test_a_requester_losing_the_resident_role_while_a_move_waits_is_not_told`, `::test_a_requester_suspended_while_a_staff_reply_waits_is_not_told` |
| A manager moves their own request | not told | `backend/tests/maintenance/test_status_notify.py::test_a_manager_moving_their_own_request_is_not_told` |
| Repeated moves of one kind | one email each | `backend/tests/maintenance/test_status_notify.py::test_repeated_moves_of_one_kind_each_email` |
| A failure after the `UPDATE` | everything rolled back | `backend/tests/maintenance/test_atomicity.py::test_a_failure_after_a_move_leaves_the_row_and_writes_nothing` |

Acceptance criteria → tests:
1. `test_transitions.py` (tenant rows, `test_every_disallowed_source_is_invalid_transition`); row 10:
   `backend/tests/maintenance/test_concurrency.py::test_two_identical_moves_at_once_have_one_winner`.
2, 2a. `backend/tests/maintenance/test_transitions.py::test_each_move_sets_exactly_its_columns_and_one_event`.
3. (restated) `backend/tests/maintenance/test_concurrency.py::test_a_move_blocked_by_another_runs_on_the_state_it_committed`.
4. `test_transitions.py`: the four reopen tests above.
5. `backend/tests/maintenance/test_concurrency.py::test_a_reopen_whose_window_closes_while_it_waits_is_refused`.
6. `backend/tests/maintenance/test_status_notify.py::test_each_move_tells_the_requester_in_app_and_by_email` and the recipient tests.
6a. `backend/tests/maintenance/test_status_notify.py::test_repeated_moves_of_one_kind_each_email`.
7. `backend/tests/maintenance/test_atomicity.py::test_a_failure_after_a_move_leaves_the_row_and_writes_nothing`.
8. `backend/tests/maintenance/test_transitions.py::test_each_move_is_audited_with_ids_only`.
9. Mutation m1 in the PR's evidence.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high (sole reviewer for this run, James's instruction) | `4cc3e29` | `MERGE` | R1-F1 (Medium): a requester whose access is removed while a move waits is still told | fixed in `37d020f`, `608adea` |
| 2 | Codex `gpt-6.1-sol`, high (a new run) | `608adea` | `MERGE` | none; the R1-F1 fix accepted | — |

Each round's first launch failed with "Selected model is at capacity" before reviewing, and was rerun.

**R1-F1.** Failure: `_requester_who_sees` read the requester's membership with no lock before the notification
`INSERT`. A suspension committing in between got a suspended member a notification and an email (Codex's proofs:
four failures with a held membership lock, four with the real `suspend_member`). Evidence for the fix: the three
tests in the recipient row of §5, run with `act_blocked_on_lock` holding the real `suspend_member` or
`change_roles` uncommitted, failed before the fix ("the action was never blocked by the holder's lock") and pass
after; mutation m6 confirms. Produced D5.

## 7. Not verified, accepted risks and follow-ups

- **Managers as recipients** (`staff_user_ids`, read on create and on a resident's comment) are read without the
  building lock: a manager losing the role while one of those waits could still be told. Not on this ticket's
  paths. Tracked in the PR's follow-ups; will be added to the inbox in the bookkeeping commit.
- **Who is told** (D2): managers aren't told of a resident's cancel or another manager's move; co-occupants aren't
  told of status changes. Will be in the inbox's "Decisions to audit".
- **Criterion 3 and the helper** were loosened in framing (§2); both go to the inbox.
- **No read endpoint for status events**: P6-04c adds the timeline's read.
- **Not run by the reviewers:** Codex reran the backend and frontend suites and an in-memory version of mutation
  m1, but not `scripts/mutation-probe.sh` or the stack journey; those are the implementer's evidence in the PR.
- **Email rendering** was seen only through Mailpit's subjects in the stack journey, not each body.

## 8. How to change this safely

- **A new move** (say `cancel` by a manager): add it to `MOVES` and `_move_columns`, `_MOVE_AUDIT`, `_MOVE_WORDS`,
  `backend/app/audit/actions.py` and a route. `test_the_verbs_and_cancel_cover_allowed_exactly` fails until `MOVES`
  and `ALLOWED` agree, and the parametrized tests in `test_transitions.py` pick up the new verb.
- **Another statement in `move_request` that can wait** (a new `INSERT` with a foreign key, a lock): if it runs
  after the reopen window check, move the check after it, and add the locked row to `WAITS` in
  `test_concurrency.py`.
- **Another recipient**: read them after a lock that their access changes take (D5), and add a race test like
  `test_a_requester_suspended_while_a_move_waits_is_not_told`.

## 9. Must explain, then quiz

**1. Every statement of `POST …/reopen` that can wait, and which one the window is checked after.** In order:
the request's `SELECT … FOR UPDATE` (`_visible`); the `UPDATE` (cannot wait: the row is already ours, and it sets
no foreign key); the status event `INSERT` (FK `KEY SHARE` on the building and the actor's membership); the
building `FOR SHARE` in `_requester_who_sees`; the notifications `INSERT` (the building, the recipient's
membership); the `jobs` `INSERT` (no FK, and its unique key names this move's new event, so it never waits); the
audit `INSERT` (the building, the actor's user). The `UPDATE`'s `WHERE` checks the window after the first; the
final `SELECT` in `move_request` checks it after all of them. In publish (P6-01c R1) the expiry was checked only in
the `UPDATE`, before the fan-out's `INSERT`s, so an expiry passing while one of them waited was still published.

**2. Which clock, and why not `now()` or the host's.** `statement_timestamp()` (`_NOW`): the start of the current
statement, taken after any wait in an earlier statement. `now()` is the transaction's start, before every wait,
so a window closing during a wait would still look open. The host's clock is another machine's time, and the
`resolved_at` it is compared with is the database's.

**3. A cancel and a start at once.** The request's row lock decides: both lock it first (`_for_cancel`, `_visible`).
The second waits, reads the status the first committed, and gets 409 `invalid_transition` (`submitted` is gone),
writing nothing (`test_a_move_blocked_by_another_runs_on_the_state_it_committed[start-then-cancel]` and
`[cancel-then-start]`).

**4. How the helper proves a request was waiting.** `act_blocked_on_lock` runs the action in a session on a
connection of its own, records that backend's pid and start time, and polls `pg_blocking_pids` until the action's
backend is blocked by the holder's. If the action finishes or times out first, it raises
`AssertionError(NEVER_BLOCKED)`. Slowness alone never passes.

Quiz:

1. Why does `move_request` check `from_status not in froms` before the `UPDATE` when the `UPDATE`'s `WHERE` checks
   the status too?
2. A manager resolves while another manager holds the same `in_progress` request. What does each get, and what does
   the second's event say?
3. Why is the email dedupe key built from the status event and not the request?
4. What would break if the building `FOR SHARE` were removed from `_requester_who_sees`?
5. How would you add a "resolved requests reopen automatically when the resident comments within 14 days" rule?

<details><summary>Answers</summary>

1. The early check gives the right error: after the lock, zero rows from the `UPDATE` must mean the window, so a
   wrong status has to be refused before it. The `WHERE` keeps the `UPDATE` the decider (rule 7) if the code above
   changes.
2. Hold first: hold 200, resolve waits, sees `on_hold`, resolves (200), event `on_hold → resolved`. Resolve first:
   resolve 200, hold waits, sees `resolved`, 409 `invalid_transition`.
3. `jobs.dedupe_key` is unique forever; with the request as the entity, a second hold (or a resolve after a
   reopen) would queue no email (criterion 6a).
4. A suspension or role change committing while a later `INSERT` waited would still notify and email someone who
   can no longer see the request; the three recipient-race tests fail (m6).
5. In `add_comment`, for a resident's comment on a `resolved` request, call the reopen path inside the same
   transaction after the comment insert: lock first, the window in the `UPDATE` and again after the last wait, one
   event, and add a race test that holds the request and a membership while the window closes.

</details>
