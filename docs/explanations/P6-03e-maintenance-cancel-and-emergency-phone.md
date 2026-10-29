# Explanation — P6-03e Maintenance cancel and the emergency phone

> **PR:** #149 · **Source revision:** `61308d0` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1, Codex `gpt-6.1-sol` high, the only reviewer this
> run) reviewed this commit and said `MERGE`.
> **Merge commit:** not known when written; after the merge, `gh pr view 149 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `61308d0`: `git diff origin/main...HEAD` for every changed app file
> (`backend/app/maintenance/{service,router,schemas}.py`, `backend/app/buildings/{schemas,service}.py`,
> `backend/app/cli.py`, `backend/app/seed.py`, `backend/app/audit/actions.py`), ADR-0022, the ticket's criteria and
> Frame notes, the PR body (plan, the plan deviation, E1, review round 1), and the assertions of every test cited
> below. Captured the SQL of one cancel from a test run (§3). Ran `uv run pytest tests/maintenance/test_cancel.py
> tests/maintenance/test_emergency.py tests/maintenance/test_atomicity.py tests/maintenance/test_concurrency.py
> tests/maintenance/test_api.py tests/cli/test_bootstrap.py` on the local scratch Postgres 16: `189 passed, 6
> deselected` (the 6 reach `app/units`' Postgres 18 `RETURNING old` and fail on 16; they passed in CI on
> Postgres 18 at this commit). Differences from the plan: one, see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A.

## 1. What was built and why

A resident can now withdraw their own maintenance request while it is still `submitted`:
`POST /api/buildings/{b}/maintenance-requests/{id}/cancel`. Only the person who filed it can cancel it. A
co-occupant who can see it gets 403 `not_requester`; anyone else gets 404. Every answer about an `emergency`
request now carries the building's `emergency_phone`, so the client can show the resident who to call. The
app itself alerts no one by phone.

The two decisions that matter most:

- **The cancel locks the row before deciding.** It does not let the `UPDATE` wait on the lock. This change
  was made during implementation, after a test caught Postgres keeping a clock reading from before the wait
  (§2 E1).
- **The phone is a setting of the maintenance feature** (`building_features.config`, ADR-0022), not a new
  column, so no migration was needed.

## 2. Decisions

### D1. The emergency phone lives in the maintenance feature's `config` (ADR-0022)

- **Problem or constraint:** an emergency request must show the building's phone (P6-03 stub: "show the
  building's emergency phone, and never rely on the app"). No API edits building settings: buildings are made
  by `bootstrap-building` and the seed.
- **Chosen:** `building_features.config["emergency_phone"]` on the `maintenance` row. It is a printable,
  stripped string of 1–32 characters (the length of `users.phone`). `bootstrap-building --emergency-phone`
  and the seed write it; `backend/app/maintenance/service.py::emergency_phone` reads it.
- **Alternatives rejected:** a `buildings.emergency_phone` column needs a migration for a value only
  maintenance reads, and a building without maintenance would still carry it. A `building_settings` table
  adds a schema and an admin surface nobody asked for.
- **Tradeoffs and accepted limitations:** JSONB has no type or length check in the database. The writers
  validate, and the reader treats anything unexpected as "no phone" rather than failing. No API edits the
  phone (ticket scope "Out").
- **Basis:** P6-03b D1 (decision rule 3), confirmed in framing; lasting, so ADR-0022 and an inbox line.
- **Source:** recorded (ticket Frame notes D1; PR D1; ADR-0022).

### D3. Only the requester cancels; a co-occupant who sees it gets 403 `not_requester`

- **Problem or constraint:** `visible_maintenance` lets a co-occupant see a unit's request, through the
  occupancy window, even though they did not file it.
- **Chosen:** `require_roles(RESIDENT)`, then `requester_membership_id = ctx.membership_id`, both in the early
  check and in the `UPDATE`'s `WHERE`. The ownership check comes before the status check.
- **Alternatives rejected:** a 404 for the co-occupant would contradict their successful `GET`.
  `forbidden_role` would be wrong because they hold the right role; a distinct code lets the client explain
  why. Letting any occupant cancel was rejected because the stub says "cancelled by the resident".
- **Tradeoffs and accepted limitations:** a requester who has moved out can still cancel their own request
  (framing 1c), because visibility follows the requester.
- **Basis:** P6-03b D3 (rule 3), confirmed in framing. **Source:** recorded (ticket; PR D3).

### E1. Lock the request first, then the conditional `UPDATE` (changed during implementation)

- **Problem or constraint:** the cancel must lose cleanly to a concurrent start (criterion 1). Its
  `cancelled_at` and the audit's `from_status` must be read after any lock wait (framing 1a; the CLAUDE.md
  lesson "re-check it after the lock, with a fresh clock, in the writing statement").
- **Chosen:** `_for_cancel` reads through `visible_maintenance` with `FOR UPDATE OF maintenance_requests`, as
  `backend/app/notices/service.py::_locked` does, and answers from the committed row. The `UPDATE` still names
  the requester and `status IN sources(cancelled)` (CLAUDE.md rule 7).
- **Alternatives rejected:**
  - *The packages pattern* (`backend/app/packages/service.py::_transition`: an unlocked early check, and the
    `UPDATE` waits). This was the plan. A test showed that when the `UPDATE` waits on a lock released without
    a change, Postgres keeps the `clock_timestamp()` it computed **before** the wait. In that run,
    `cancelled_at` was `…53.835049` and the start's release was `…53.838668`.
  - *`RETURNING old.status`* (Postgres 18) fixes `from_status` but not the clock.
- **Tradeoffs and accepted limitations:** the early check is authoritative now, so two tests bypass it on
  purpose to prove that the `WHERE` refuses on its own. A co-occupant's refused cancel locks the row until
  its transaction ends, which is right after the 403.
- **Basis:** experiment (a test result). **Source:** recorded (PR E1 and the plan deviation; ticket Frame
  notes E1 addendum).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The phone is read at answer time and stripped | Copy it onto the request at create | A changed number would leave old requests stale | autonomous | PR table |
| One phone query per answer, only if it holds an emergency item | Join `building_features` in every list | A join on every read for a rare category | autonomous | PR table |
| The bootstrap plan and summary print `emergency phone: …` | Leave it out | The operator could not check a dry run | autonomous (framing 2d) | ticket E2, PR table |
| The bootstrap audit metadata is unchanged | Record the phone | It records no feature settings; IDs and field names only (rule 10) | convention | PR table |
| Maple's phone is `416-555-0199` | A real-looking number | 555-01xx numbers are fictional | autonomous | PR table |
| Codex `gpt-6.1-sol` (high) as the only reviewer | The playbook's fresh Claude reviewer | James's instruction for this run | James | PR table |

**Framing changes:** criteria 1a–1d, 2a–2d, and sharpenings of 3 (row 8 for each status, refusals write
nothing, rows 7 and 9 explained) and 4 (where the forced failure happens). Two missed cases were added: 1c (a
moved-out requester, and the unit's current occupant can't see the request) and 2d (the plan shows the
phone). The ADR number became 0022. Nothing was loosened.

**Plan versus final code:** one difference, E1 above. The plan said the cancel would follow the packages
pattern; the code locks first. The PR notes the deviation below its Plan.

## 3. How it is implemented

### Overview

- `backend/app/maintenance/router.py::cancel` is a resident-only action route behind the `maintenance`
  feature switch.
- `backend/app/maintenance/service.py::cancel_request` runs a locked early check (`_for_cancel`), the
  conditional `UPDATE`, the audit row, and the answer, with one commit.
- `backend/app/maintenance/service.py::emergency_phone` is the defensive JSONB read, and
  `backend/app/maintenance/service.py::_outs` adds it to emergency items in every answer (create, replay,
  list, get, cancel).
- `backend/app/buildings/schemas.py::BootstrapInput`, `backend/app/buildings/service.py::bootstrap_building`,
  `backend/app/cli.py::bootstrap_building_command` and `backend/app/seed.py::_building` write the phone.

### Walkthrough (variant A: `POST …/maintenance-requests/{id}/cancel`)

1. **HTTP:** the route `backend/app/maintenance/router.py::cancel` with `dependencies=_RESIDENT`, which is
   `require_feature(MAINTENANCE)` plus `require_roles(RESIDENT)`. Before routing, the CSRF middleware has
   already checked `Origin` and `X-Requested-With`. `get_tenant_context` gives 401 when signed out, and 404
   `building_not_found` to outsiders and pending or suspended members. The two guards give 403
   `feature_disabled` and `forbidden_role`.
2. **Locked early check:** `_for_cancel` → `_visible(..., lock=True)`. This SQL was captured from a test run:

   ```sql
   SELECT maintenance_requests.* FROM maintenance_requests
   WHERE maintenance_requests.building_id = $1
     AND (maintenance_requests.requester_membership_id = $2
          OR public.occupancy_window($3, maintenance_requests.unit_id, maintenance_requests.submitted_at))
     AND maintenance_requests.id = $4
   FOR UPDATE OF maintenance_requests
   ```

   No row means 404 `maintenance_request_not_found`, with the same body for someone else's request, another
   building's, or a random id. A row the caller didn't file means 403 `not_requester`. A status other than
   `submitted` means 409 `invalid_transition`, via `backend/app/maintenance/state.py::assert_transition`. If
   a start holds the row, this statement waits for it; under READ COMMITTED it then returns the committed
   row, so the answer is 409.
3. **Write:** the conditional `UPDATE` (captured):

   ```sql
   UPDATE maintenance_requests SET status=$1, cancelled_at=clock_timestamp(),
          cancelled_by_membership_id=$2, updated_at=now()
   WHERE id = $3 AND building_id = $4 AND requester_membership_id = $5 AND status IN ($6)
   RETURNING maintenance_requests.*
   ```

   `clock_timestamp()` is the statement's own clock, read after the lock in step 2. `now()` would be the
   transaction's start. If zero rows match, `_for_cancel` runs again to answer; that path is reachable only
   when the early check was bypassed (the tests do this).
4. **Side effects:** `record_audit(maintenance.cancelled, metadata={"from_status": …})`, with `from_status`
   read under the lock. The row is flushed with the commit; the captured log shows the `INSERT INTO
   audit_events` after the answer's reads. No notification is sent.
5. **Response:** `_out` gives `MaintenanceRequestOut`. It includes `emergency_phone` when the request is an
   emergency. `requester_name` is null for residents. Then one `db.commit()`.

### Data model changes

None. `building_features.config` (JSONB, default `{}`) already existed; this ticket is the first to read it.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/maintenance/service.py` | `cancel_request`, `_for_cancel`, `_visible`, `NotRequester`, `emergency_phone`, phone in `_outs` | +113 / −8 |
| `backend/app/maintenance/router.py` | the cancel route; "alerts no one" in the create's docstring | +20 / −5 |
| `backend/app/maintenance/schemas.py` | `MaintenanceRequestOut.emergency_phone` | +6 |
| `backend/app/buildings/schemas.py` | `BootstrapInput.emergency_phone` and its maintenance check | +17 / −1 |
| `backend/app/buildings/service.py` | the phone written into `config`; the plan line | +14 / −1 |
| `backend/app/cli.py` | `--emergency-phone` | +4 |
| `backend/app/seed.py` | Maple's phone | +8 / −1 |
| `backend/app/audit/actions.py` | `MAINTENANCE_CANCELLED` | +1 |
| `docs/adr/0022-…`, `docs/adr/README.md` | ADR-0022 | +40 |
| `frontend/src/api/schema.d.ts` | generated | +103 / −1 |
| tests | `backend/tests/maintenance/test_cancel.py`, `backend/tests/maintenance/test_emergency.py` (new); `backend/tests/maintenance/test_api.py`, `backend/tests/maintenance/test_atomicity.py`, `backend/tests/maintenance/test_concurrency.py`, `backend/tests/cli/test_bootstrap.py` (extended) | — |

`backend/app/maintenance/service.py::cancel_request`

```python
    from_status = (await _for_cancel(db, ctx, request_id)).status
    # The requester and the status are in the WHERE too, not only checked above: the UPDATE decides
    # (CLAUDE.md rule 7).
    cancelled = await db.scalar(
        update(MaintenanceRequest)
        .where(
            MaintenanceRequest.id == request_id,
            MaintenanceRequest.building_id == ctx.building_id,
            MaintenanceRequest.requester_membership_id == ctx.membership_id,
            MaintenanceRequest.status.in_(sources(MaintenanceStatus.CANCELLED)),
        )
        .values(
            status=MaintenanceStatus.CANCELLED,
            # The statement's clock, after the lock above.
            cancelled_at=func.clock_timestamp(),
            cancelled_by_membership_id=ctx.membership_id,
        )
        .returning(MaintenanceRequest)
        .execution_options(populate_existing=True)
    )
    if cancelled is None:
        # Zero rows: answer 404, 403 or 409 from the request as it is now.
        current = await _for_cancel(db, ctx, request_id)
        # Unreachable: the UPDATE would have matched a request the caller may still cancel.
        raise AssertionError(f"maintenance request {current.id} matched no cancel")
    await record_audit(
        # ...
        metadata={"from_status": from_status},
    )
    out = await _out(db, ctx, cancelled)
    await db.commit()
    return out
```

- **What it does:** reads `from_status` under the lock, writes the cancel only if the row is still the
  caller's and still `submitted`, audits it, answers, and commits once.
- **Why:** E1 (the lock) and D3 (the requester in the `WHERE`).
- **What breaks without key lines:**
  - Drop the requester line: `test_the_update_itself_refuses_someone_elses_request` fails (mutation m1).
  - Drop the status line: `test_the_update_itself_refuses_a_request_that_is_not_submitted` fails (m2).
  - Use `func.now()`: the race test's clock assertion fails (m5).

`backend/app/maintenance/service.py::_for_cancel` and `_visible`

```python
async def _visible(
    db: AsyncSession, ctx: TenantContext, request_id: UUID, *, lock: bool = False
) -> MaintenanceRequest:
    # ...
    stmt = visible_maintenance(ctx).where(MaintenanceRequest.id == request_id)
    if lock:
        stmt = stmt.with_for_update(of=MaintenanceRequest)
    request = await db.scalar(stmt.execution_options(populate_existing=True))
    if request is None:
        # The same answer for someone else's, another building's and no request (ADR-0004).
        raise MaintenanceRequestNotFound(detail="Maintenance request not found.")
    return request
# ...
async def _for_cancel(db: AsyncSession, ctx: TenantContext, request_id: UUID) -> MaintenanceRequest:
    request = await _visible(db, ctx, request_id, lock=True)
    if request.requester_membership_id != ctx.membership_id:
        raise NotRequester(detail="Only the resident who filed this request can cancel it.")
    assert_transition(request.status, MaintenanceStatus.CANCELLED)
    return request
```

- **What it does:** a visible-only read (CLAUDE.md rule 3: through `visible_maintenance`, never a hand-rolled
  filter), locked for the cancel, then ownership before status.
- **Why `OF maintenance_requests`:** inferred. It limits the lock to the request's row whatever the visibility
  clause grows into; today that clause is a function call, not a join.
- **What breaks without key lines:**
  - Without `lock=True`, the race test's rolled-back variant records a clock from before the wait (mutation
    m8 fails `test_a_cancel_blocked_by_a_start_gets_409`).
  - Swap the two checks, and a co-occupant on a started request gets 409 instead of 403 (1b).

`backend/app/maintenance/service.py::emergency_phone`

```python
async def emergency_phone(db: AsyncSession, building_id: UUID) -> str | None:
    config = await db.scalar(
        select(BuildingFeature.config).where(
            BuildingFeature.building_id == building_id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
    )
    phone = config.get("emergency_phone") if isinstance(config, dict) else None
    if not isinstance(phone, str):
        return None
    phone = phone.strip()
    return phone if 0 < len(phone) <= MAX_EMERGENCY_PHONE else None
```

- **What it does:** reads the phone and returns it only if it is a non-blank string of at most 32 characters
  inside an object. It filters on the caller's `building_id`, so another building's phone can't appear.
- **Why:** D1 and ADR-0022: no database check exists, so the reader is the last guard.
- **What breaks:** replace `isinstance(config, dict)` with `is not None`, and a `config` that is a JSON string
  or a list causes a 500 (`AttributeError`). `test_a_non_object_config_gives_null` fails (m4).

`backend/app/buildings/schemas.py::BootstrapInput` (the new field)

```python
    emergency_phone: Annotated[str, _stripped(32), _printable] | None = None

    @field_validator("emergency_phone")
    @classmethod
    def _phone_needs_maintenance(cls, value: str | None, info: ValidationInfo) -> str | None:
        # A field error, so the CLI names `--emergency-phone`; `features` is validated first.
        if value is not None and Feature.MAINTENANCE not in info.data.get("features", ()):
            raise ValueError("needs the maintenance feature")
        return value
```

- **What it does:** refuses control characters before the strip (`_printable`), blanks, and values over 32
  characters, and refuses the option without `maintenance`. The error is a field error, so the CLI's existing
  loop prints `--emergency-phone`.
- **Why it works:** `features` is declared earlier in the class, so `info.data` already holds it. If
  `features` itself failed validation, it is missing from `info.data`, and the phone is refused too.

`backend/tests/maintenance/test_concurrency.py::test_a_cancel_blocked_by_a_start_gets_409` (the hardest
criterion)

```python
        async def settle(db: AsyncSession) -> None:
            nonlocal released_at
            # The database clock while the cancel is still blocked: its `cancelled_at` must be
            # later, taken after the wait (1a). ...
            released_at = await db.scalar(select(func.clock_timestamp()))
            if start_commits:
                await savepoint.commit()
            else:
                await savepoint.rollback()

        outcome = await act_blocked_on_lock(
            sessions, hold=start, act=lambda db: _cancel(db, world, request), change=settle
        )
        # ... start-commits: "409 invalid_transition", still in_progress, no audit row
        # ... start-rolls-back: "200", cancelled, one audit row, cancelled_at > released_at
```

- **What it does:** `act_blocked_on_lock` proves the cancel was actually blocked by the start's lock, not
  merely slow. The start runs inside a savepoint, so the rolled-back variant can undo it and the helper can
  still commit the holder.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A co-occupant cancels | 403 `not_requester`, nothing written | `backend/tests/maintenance/test_cancel.py::test_a_co_occupant_who_sees_the_request_may_not_cancel_it` |
| Co-occupant on a started request | 403, not 409 (ownership first) | `::test_a_co_occupant_gets_not_requester_even_once_it_was_started` |
| The early check is bypassed | The `UPDATE` matches nothing; 403 / 409 from the re-check | `::test_the_update_itself_refuses_someone_elses_request`, `::test_the_update_itself_refuses_a_request_that_is_not_submitted` |
| Requester moved out | Still cancels; the unit's current occupant gets 404 | `::test_a_requester_who_moved_out_still_cancels_their_own` |
| Council + resident | Cancels own; `requester_name` null | `::test_a_council_resident_cancels_their_own` |
| A body names someone else | Ignored | `::test_a_body_is_ignored` |
| Not `submitted` | 409 for each of 4 statuses, nothing written | `::test_only_a_submitted_request_can_be_cancelled` |
| Staff cancel | 403 `forbidden_role` | `::test_staff_may_not_cancel` |
| Hidden, B or random id | The same 404 body | `::test_another_residents_request_is_the_same_404_as_none` |
| Signed out, outsiders, feature off | 401 / 404 / 403 | `backend/tests/maintenance/test_api.py::test_signed_out_is_401_on_every_route`, `::test_outsiders_get_building_not_found_on_every_route`, `::test_feature_off_is_403_on_every_route_and_writes_nothing` |
| Two cancels at once | One 200, one 409, one audit row | `backend/tests/maintenance/test_concurrency.py::test_two_concurrent_cancels_have_one_winner` |
| Start and cancel race | Cancel blocked; 409 or (start rolled back) 200 with a clock after the wait | `backend/tests/maintenance/test_concurrency.py::test_a_cancel_blocked_by_a_start_gets_409` |
| Failure after the `UPDATE` | All rolled back | `backend/tests/maintenance/test_atomicity.py::test_a_failure_after_the_cancel_update_leaves_it_submitted` |
| Bad or odd `config` | `emergency_phone: null` | `backend/tests/maintenance/test_emergency.py::test_a_building_without_a_usable_phone_gives_null`, `::test_a_non_object_config_gives_null` |
| Phone on other categories / buildings | Never | `::test_no_other_category_carries_the_phone`, `::test_a_mixed_list_carries_the_phone_on_emergency_items_only`, `::test_another_buildings_phone_is_never_shown` |
| Phone changes after create | Next read shows the new value | `::test_the_phone_is_read_at_answer_time_and_stripped` |
| Bootstrap input | Refused, naming the option; stripped; plan line | `::test_bootstrap_refuses_a_bad_phone`, `::test_bootstrap_strips_the_phone`, `::test_the_plan_shows_the_phone`; `backend/tests/cli/test_bootstrap.py::test_cli_bad_emergency_phone_names_the_option` |

**Acceptance criteria → tests:**

- 1: `backend/tests/maintenance/test_cancel.py` and the race test.
- 2: `backend/tests/maintenance/test_emergency.py`, including `::test_an_emergency_request_carries_the_phone_on_every_read`,
  `::test_a_replayed_create_carries_the_phone`, `::test_the_api_says_it_alerts_no_one`,
  `::test_the_seed_sets_maples_phone` and `::test_bootstrap_sets_the_phone_on_the_maintenance_feature`.
- 3: the tenant rows above.
- 4: feature-off and atomicity.

The PR's evidence table maps each sub-criterion.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| — | implementer's own test, before review | `6f046da` | — | The plan's unlocked cancel kept a pre-wait `clock_timestamp()` | Fixed in `ef891cb` (E1) |
| 1 | Codex `gpt-6.1-sol` (high), fresh | `61308d0` | **MERGE** | None | It corrected one evidence claim: one of the 20 local failures is `moto`'s upload policy, not Postgres 18. The PR was edited |

The only code-changing problem came before review. The failure: in
`test_a_cancel_blocked_by_a_start_gets_409[start-rolls-back]` at `6f046da`, the cancel's `cancelled_at`
came 3.6 ms *before* the moment the start released its lock. The evidence for the fix: after `ef891cb` the
same test passes. With the lock removed again (m8) or `now()` restored (m5), it fails. Decision E1 records it.

## 7. Not verified, accepted risks and follow-ups

- **Local runs used Postgres 16.2 (`pgserver`) and `moto`, not the compose stack.** Docker was unreachable
  (inbox PRE-8). Twenty tests fail on that setup, on `main` and on the branch alike: 19 hit Postgres 18 syntax
  and one hits `moto`'s upload policy. CI on Postgres 18 ran the full suite green at `61308d0`. The stack
  journey ran on uvicorn over that scratch database, not `make up` or `make prodlike`.
- **`scripts/mutation-probe.sh` was not used** because its `db-guard` needs the compose database. The same
  steps were run by hand, and the output is in the PR.
- **No UI** shows the cancel or the phone yet; that is P6-04b and P6-04c.
- **Managers are not told when a resident cancels.** Not in the ticket; a follow-up for P6-03c/P6-04d.
- **No API edits the phone** (scope "Out"); ADR-0022 says a later settings API writes the same key.
- **The NUL / lone-surrogate refusal of `--emergency-phone`** relies on the shared `printable_before_strip`.
  It is tested for other fields, not re-tested for this option.
- **P6-03c should copy the lock-first pattern** for any action that records a time or a `from_status` (E1).

Each follow-up goes to its ticket or the inbox in the bookkeeping commit.

## 8. How to change this safely

- **Add another cancellable status** (say `on_hold → cancelled`): add it to `ALLOWED` in
  `backend/app/maintenance/state.py`. The `UPDATE`'s `status IN sources(...)` follows automatically, and
  `from_status` is already read under the lock. Then extend `test_only_a_submitted_request_can_be_cancelled`.
- **Add another feature setting:** put it in that feature's `config` (ADR-0022). Validate it where it is
  written (the bootstrap schema, the seed), and read it defensively in the feature's own module, like
  `backend/app/maintenance/service.py::emergency_phone`.
- **P6-03c's actions:** copy `_for_cancel`'s lock-then-`UPDATE` shape. `backend/tests/maintenance/test_concurrency.py` and
  `act_blocked_on_lock` show how to prove each wait.

## 9. Must explain, then quiz

**1. Why does cancel put the requester check in the `UPDATE`'s `WHERE` rather than only in Python before it?**
The `UPDATE` is the statement that changes the row, so its `WHERE` is the last word (CLAUDE.md rule 7). Here
the early check runs under a row lock, so today the two always agree. But the `WHERE` keeps the write safe
even if a future change drops the lock, bypasses `_for_cancel`, or calls the write from another path.
`test_the_update_itself_refuses_someone_elses_request` bypasses the early check and shows the `UPDATE` alone
refuses (`backend/app/maintenance/service.py::cancel_request`).

**2. What does the API do for an emergency request, and what does it deliberately not promise?**
Every answer about it (201, replay, get, list, cancel) carries the building's `emergency_phone`, read at
answer time (`backend/app/maintenance/service.py::_outs`). The managers already get an emergency notification
and email (P6-03b). The API does not call or page anyone, and says so: "Call it: the app alerts no one" in
`MaintenanceRequestOut.emergency_phone` and in the create route's description. If no valid phone is set, it
returns `null`.

**3. Why does the phone live in the feature's `config`, and what does reading JSONB "defensively" cost?**
It only matters while maintenance is on, `config` already exists for that purpose, and it needs no migration
(ADR-0022). The cost is that Postgres doesn't check it. The writers must validate, and the reader must handle
any JSON (`backend/app/maintenance/service.py::emergency_phone`). A bad hand edit silently hides the phone
instead of failing loudly.

Quiz:

1. A co-occupant cancels a request that a manager has already started. What do they get, and why that and
   not the alternative?
2. Why would `cancelled_at = clock_timestamp()` still have been wrong with the plan's unlocked check?
3. In the race test, why is the start's `UPDATE` inside a savepoint?
4. What would break if we removed `isinstance(config, dict)` from `emergency_phone`?
5. How would you extend this so a manager can set the phone through the API?

<details><summary>Answers</summary>

1. 403 `not_requester`, not 409. `_for_cancel` checks ownership before status because they could never
   cancel it, and "it's started" would mislead (1b; `test_a_co_occupant_gets_not_requester_even_once_it_was_started`).
2. Postgres evaluates the `UPDATE`'s `SET` list when it scans the row. If the lock it then waits on is
   released without a change, it keeps those values, so the clock came from before the wait (E1).
3. `act_blocked_on_lock` always commits the holder. The savepoint lets the "start rolls back" variant undo
   the start inside the holder's transaction (`savepoint.rollback()` releases its row lock) and still let the
   helper commit.
4. A `config` that is a JSON string, list or number would raise `AttributeError` on `.get` and give a 500 for
   every emergency answer in that building (`test_a_non_object_config_gives_null`, mutation m4).
5. Add a property-management action (for example `PUT /maintenance/settings`) that validates like
   `BootstrapInput.emergency_phone`, writes the same `config` key with `jsonb_set`, and audits the field name.
   `emergency_phone` needs no change (ADR-0022, "Consequences").

</details>
