# Explanation — P4-01a Units API and unit options

> **PR:** #84 · **Source revision:** `8e6260e`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed `00ce62a`. `8e6260e` adds only R2-F1's
> fix (one annotation in `backend/app/units/schemas.py`, its test, regenerated `schema.d.ts`). James skipped
> round 3 for this run, so that commit had no independent review (§7).
> **Merge commit:** not known when written; after the merge, `gh pr view 84 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `8e6260e` the diff (`git diff --stat origin/main...HEAD`, 17 paths), the whole
> of `backend/app/units/{schemas,service,router}.py`, the `record_audit` changes, the assertions of the tests
> cited below, PR #84's description and both Codex review files. Ran
> `uv run pytest tests/units tests/audit/test_audit.py`: 133 passed. Compiled the deactivate and search
> statements with the Postgres dialect for §3. CI was green on `8e6260e`. Differences from the plan: the
> CSV import was split off to P4-01b (§2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A.

## 1. What was built and why

Staff can now list and search a building's units (`GET /api/buildings/{id}/units`), and property management
can create, rename, deactivate and activate them. `search_unit_options` gives P4-05's join flow a query that
returns only `{id, tower, label}` of active units. The ticket also carried three Low `record_audit` edges
from P2-04, fixed here before `record_audit` gets its first domain caller.

The decisions that matter most:
- A unit can't be deactivated while anyone currently occupies it (409 `unit_has_occupants`). The check takes
  a row lock first, so it can't interleave with an occupancy being inserted (D2).
- The original ticket P4-01 was **split after implementation**: the CSV import (criterion 5) is now
  P4-01b (D4).

## 2. Decisions

### D1. What counts as a unit's occupant

- **Problem or constraint:** the ticket says "current occupants" without defining them. Memberships have
  statuses, and a suspended member can still hold a current occupancy.
- **Chosen:** a `unit_occupancies` row with `ended_at IS NULL`, whatever the membership's status. The same
  rule drives `current_occupant_count` and the deactivation block.
- **Alternatives rejected:** counting only active memberships. A unit with only a suspended or pending
  occupant would then deactivate, leaving that occupant in an inactive unit.
- **Tradeoffs and accepted limitations:** a manager must first end a suspended member's occupancy (P4-06
  membership administration) before deactivating the unit.
- **Basis:** autonomous. It matches `backend/app/memberships/occupancy.py::current_occupants` ("Any
  membership status").
- **Source:** recorded (PR #84 D1; ticket Frame notes).

### D2. Deactivation locks the unit before checking occupants

- **Problem or constraint:** "check no occupant, then update" races with a concurrent occupancy insert.
  The insert's foreign key check takes `FOR KEY SHARE` on the unit row. A plain `UPDATE units SET is_active`
  takes `FOR NO KEY UPDATE`, which does not conflict with it. So the deactivation neither waits for the
  insert nor sees it while it is uncommitted.
- **Chosen:** `SELECT … FOR UPDATE` on the unit (it conflicts with `FOR KEY SHARE`), then the occupancy
  check as a new statement, then a conditional `UPDATE … WHERE is_active IS true RETURNING`, all in one
  transaction.
- **Alternatives rejected:** a single `UPDATE … WHERE NOT EXISTS (…)`: under READ COMMITTED it doesn't see
  the uncommitted insert, and it takes no conflicting lock. SERIALIZABLE: it needs retry handling the
  codebase doesn't have.
- **Tradeoffs and accepted limitations:** this covers "insert first, deactivate second". In the other order
  (the deactivation commits first, and then an occupancy starts in an inactive unit), the occupancy side is
  responsible. P4-05 must check `is_active` in the same statement that locks the unit. Neither the occupancy
  helpers nor this ticket enforce that (§7).
- **Basis:** Postgres's row-lock conflict table. Proved by
  `backend/tests/units/test_concurrency.py::test_deactivate_waits_for_a_concurrent_occupancy_start`, which
  fails twice with the `FOR UPDATE` removed (mutation in the PR).
- **Source:** recorded (PR #84 D2, Plan "Risks").

### D3. 409 `unit_exists` comes from the constraint, not a pre-check

- **Problem or constraint:** a duplicate `(building, tower, label)` must be a 409 even when two requests race.
- **Chosen:** create uses `INSERT … ON CONFLICT ON CONSTRAINT uq_units_building_id_tower_label DO NOTHING
  RETURNING`. No row back means 409. On PATCH, the flush runs inside a savepoint, and its `IntegrityError` is
  turned into the same 409.
- **Alternatives rejected:** a `SELECT` pre-check, then the write. A concurrent create between the two would
  surface as an `IntegrityError`, which is a 500.
- **Tradeoffs and accepted limitations:** the PATCH handler treats *any* `IntegrityError` at that flush as a
  duplicate. Its comment gives the reason: changing tower or label can break only that constraint. A future
  column with its own constraint would make that wrong.
- **Basis:** the existing constraint (P1-01, NULLS NOT DISTINCT).
- **Source:** recorded (PR #84 D4, added in step 6; it was decided while coding but not written down then).

### D4. Split after implementation

- **Problem or constraint:** the framing estimate was ~390 non-test lines. Implemented, P4-01 measured 613.
  The playbook says over the limit means split, and earlier deviations stopped around 490–510.
- **Chosen:** split before review. P4-01a (this PR) has criteria 1–4 and 6–8. P4-01b has criterion 5, the
  CSV import. The import code and its tests were removed from this branch. The complete version (with
  `make check` green and a stack run) stays at `4c015f0` in PR #84's history, and
  `docs/tickets/P4-01b-units-csv-import.md` points to it. This PR is 412 added and 8 deleted non-test lines.
- **Alternatives rejected:** keeping it whole as a recorded deviation. It was further over the limit than
  any precedent.
- **Tradeoffs and accepted limitations:** the import was never reviewed. P4-01b must frame and review it as
  new work.
- **Basis:** playbook step 3, "Over the limit means split".
- **Source:** recorded (PR #84 "Deviation from the plan"; Frame notes "Split").

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The list keeps the standard `id DESC` keyset order | order by tower and label | `paginate` fixes the order; changing that is cross-cutting | convention (`backend/app/core/pagination.py::paginate`) | recorded (PR table) |
| No index for the label prefix | `lower(label)` pattern index | about 300 units per building at planning size | autonomous | recorded |
| `floor` is a strict integer in −20…300 | any int4, lax coercion | catches typos and stays inside the column; lax mode stored `true` as 1 | autonomous; review round 1 | recorded |
| A blank tower means no tower | 422 for `""` | the CSV's empty cell means NULL, and the API matches it | autonomous | inferred (schema comment) |
| A PATCH that changes nothing writes no audit row | always audit | an audit row records a change | autonomous | recorded |
| Activating or deactivating twice is 409 `invalid_transition` | 204 no-op | CLAUDE.md rule 7 | rule | recorded (Frame notes) |
| `PATCH label` is optional but not nullable in OpenAPI | `string \| null` | the API refuses null | review round 2 | recorded |

**Framing changes:** every criterion got a "Framed" sub-bullet. Criterion 7 (PATCH) and criterion 8 (the
P2-04 carry-over) were added. Nothing was loosened. Criterion 5 moved to P4-01b in the split.

**Plan versus final code:** compared against PR #84's Plan. The differences: (1) the split (D4), which
dropped `parse_units_csv`, `import_units`, the CLI command and the import tests (`test_import.py`, removed); (2) `floor` is
strict (round 1); (3) `UnitUpdate.label` is out of the null schema (round 2); (4) the planned rejection of
lone surrogates is done by pydantic, not by our validator, which was found unreachable and removed
(`94948d9`). The behaviour, a 422, is as planned.

## 3. How it is implemented

### Overview

- `backend/app/units/router.py` holds five routes on `building_router(tags=["units"])`. The list allows
  security and property management; the writes allow property management only (`require_roles`).
- `backend/app/units/schemas.py` holds input validation (`Label`, `Tower`, `Floor`, `SearchText`) and the
  output shapes `UnitOut` and `UnitOption`.
- `backend/app/units/service.py` holds the use cases. Each write commits once, and `search_unit_options`
  only reads.
- `backend/app/audit/service.py::record_audit` records `unit.created`, `unit.updated`, `unit.deactivated`
  and `unit.activated` in the same transaction.

### Walkthrough (variant A): `POST /api/buildings/{b}/units/{id}/deactivate`

1. **HTTP:** `backend/app/units/router.py::deactivate`, status 204.
2. **Dependencies:** the session cookie gives `get_current_user`. Then
   `backend/app/tenancy/deps.py::get_tenant_context` loads the caller's *active* membership in `{b}`, or
   returns 404 `building_not_found`. Then `require_roles(Role.PROPERTY_MANAGEMENT)` returns 403
   `forbidden_role` for any other role. The CSRF middleware has already checked `Origin` and
   `X-Requested-With`.
3. **Service:** `backend/app/units/service.py::deactivate_unit`:
   - `_get_unit(..., lock=True)` reads the unit **filtered by `ctx.building_id`** with `FOR UPDATE`. Another
     building's unit, or no unit, gives 404 `unit_not_found`. That happens before any occupancy check, so an
     occupied unit in building A answers a building-B manager with 404, not 409.
   - Already inactive gives 409 `invalid_transition`.
   - Any current occupancy gives 409 `unit_has_occupants`.
   - `_set_active` runs the conditional UPDATE, records the audit row and commits.
4. **Database** (compiled with the Postgres dialect):

```sql
SELECT units.* FROM units
WHERE units.id = :id AND units.building_id = :building_id FOR UPDATE;

SELECT EXISTS (SELECT * FROM unit_occupancies
  WHERE unit_occupancies.building_id = :building_id AND unit_occupancies.unit_id = :unit_id
    AND unit_occupancies.ended_at IS NULL);

UPDATE units SET is_active = false, updated_at = now()
WHERE units.id = :id AND units.building_id = :building_id AND units.is_active IS true
RETURNING units.id;
```

5. **Side effects:** one `audit_events` row (`unit.deactivated`, actor, building, unit id, empty metadata),
   written by the same commit.
6. **Response:** 204, no body. Errors are problem+json with the codes above.

The list (`list_units`) filters by building, optional label prefix (`ILIKE :p || '%' ESCAPE '/'`, with
`%` and `_` in the search escaped by `autoescape=True`), exact `tower` and `is_active`. It pages with
`paginate`, then counts current occupancies for that page's ids in one grouped query
(`_occupant_counts`). `paginate` reads one entity per row, which is why the count isn't a column of the same
query.

### Data model changes

None. `units` already had `is_active` and the unique `(building_id, tower, label)` with NULLS NOT DISTINCT
(P1-01).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/units/service.py` | new: use cases, domain errors | +233 |
| `backend/app/units/schemas.py` | new: input and output schemas | +80 |
| `backend/app/units/router.py` | new: five routes | +71 |
| `backend/app/audit/service.py` | P2-04 edges: surrogates, falsy metadata, node cap | +27 −6 |
| `backend/app/audit/actions.py` | four `unit.*` actions | +5 |
| `backend/app/main.py` | include the router | +2 |
| `backend/tests/units/test_api.py`, `test_options.py`, `test_concurrency.py` | new tests | +670 |
| `backend/tests/audit/test_audit.py` | criterion 8 tests | +46 |
| `frontend/src/api/schema.d.ts` | regenerated | +479 |
| `frontend/src/api/client.test.ts` | units path in the generated-paths type check | +1 |
| `docs/tickets/…` | frame, split into P4-01a/P4-01b, index | — |

`backend/app/units/service.py::deactivate_unit`

```python
async def deactivate_unit(db: AsyncSession, ctx: TenantContext, unit_id: UUID) -> None:
    unit = await _get_unit(db, ctx.building_id, unit_id, lock=True)
    if not unit.is_active:
        raise InvalidTransition(detail="The unit is already inactive.")
    if await db.scalar(select(_current_occupancy(ctx.building_id, unit_id))):
        raise UnitHasOccupants(detail="End the unit's current occupancies first.")
    await _set_active(db, ctx, unit_id, active=False)
```

- It refuses an occupied unit, after locking the row (D2).
- Without `lock=True`, `test_deactivate_waits_for_a_concurrent_occupancy_start` fails: the task finishes
  before the occupancy commits, and the "commits" case ends with an inactive, occupied unit.
- Without the building filter in `_get_unit`, `test_other_buildings_unit_is_404_on_every_write` fails
  (mutation in the PR: 2 failed).

`backend/app/units/service.py::create_unit`

```python
    unit = await db.scalar(
        insert(Unit)
        .values(building_id=ctx.building_id, tower=data.tower, label=data.label, floor=data.floor)
        .on_conflict_do_nothing(constraint="uq_units_building_id_tower_label")
        .returning(Unit)
    )
    if unit is None:
        raise _exists()
    await _audit(db, ctx, actions.UNIT_CREATED, unit.id, _FIELDS)
    await db.commit()
```

- `building_id` comes from the tenant context, never from the body. `UnitCreate` is an `InputModel`
  (`extra="forbid"`), so a `building_id` or `is_active` in the body is a 422.
- The constraint is NULLS NOT DISTINCT, so `(NULL, "101")` twice conflicts, which is criterion 2.

`backend/app/units/schemas.py::UnitUpdate`

```python
class UnitUpdate(InputModel):
    tower: Tower = None
    label: Label | SkipJsonSchema[None] = None
    floor: Floor | None = None

    @field_validator("label", mode="before")
    @classmethod
    def _label_is_required_when_sent(cls, value: Any) -> Any:
        if value is None:
            raise PydanticCustomError("label_required", "a unit needs a label")
        return value
```

- "Left out" and "sent as null" must differ: a left-out field doesn't change, and `tower: null` or
  `floor: null` clears the value. A label can't be cleared.
- Pydantic doesn't validate defaults, so the validator only sees an explicit null. `SkipJsonSchema` keeps
  `null` out of OpenAPI (round 2). `update_unit` reads `model_dump(exclude_unset=True)`, so only sent fields
  count.

`backend/app/units/schemas.py::printable` and `Floor`

```python
def printable(value: str) -> str:
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise PydanticCustomError("control_characters", "must not contain control characters")
    return value
# ...
Floor = Annotated[int, Field(strict=True, ge=MIN_FLOOR, le=MAX_FLOOR)]
SearchText = Annotated[str, StringConstraints(max_length=20), AfterValidator(printable)]
```

- NUL in a label or a query parameter would otherwise reach Postgres and fail as a `DBAPIError` (a 500).
  That is the CLAUDE.md lesson on validating input by what Postgres accepts.
- `SearchText` applies the same rule to `?search=` and `?tower=`
  (`test_list_rejects_query_values_postgres_cannot_take`).

`backend/app/audit/service.py::_check_structure` (criterion 8)

```python
    nodes = 0
    while pending:
        value, depth = pending.pop()
        nodes += 1
        if nodes > MAX_NODES:
            raise ValueError(f"audit metadata has more than {MAX_NODES} nodes")
```

- It counts every node once **per path**. A shared sub-object (`x = [x, x]`) counts each time it is
  reached, as JSON would write it out, so the walk stops after 10,000 steps instead of 2^25. Counting per
  path, rather than skipping visited ids, also bounds the later `json.dumps`, which would expand the shared
  object too.
- `_storable` now refuses a lone-surrogate key (values already failed in the size check's `encode`).
  `record_audit` passes `{} if metadata is None else metadata`, so `False`, `0`, `""` and `[]` reach the
  "must be a dict" check.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Search `"1_"` matches `101` via the LIKE wildcard | `autoescape=True` | `backend/tests/units/test_api.py::test_search_treats_percent_and_underscore_literally`, `backend/tests/units/test_options.py::test_options_search_treats_wildcards_literally` |
| A resident or council member lists units | 403 `forbidden_role` | `test_resident_and_council_get_403_on_list` |
| B's manager acts on A's unit | 404 `unit_not_found`, same body as a random id, no write, no audit | `test_other_buildings_unit_is_404_on_every_write` |
| An occupied unit of another building leaks through a 409 | building filter first, then 404 | `test_occupied_unit_of_another_building_is_404_not_409` |
| Pending, suspended, non-member, unknown building | 404 `building_not_found` | `test_non_members_get_404_and_other_buildings_roles_get_403`, `test_unknown_building_is_building_not_found_on_every_route` |
| `multi` uses B's security role in A | 403 (A's role is resident) | same test, `multi` case; `test_multi_lists_building_b_with_its_security_role` |
| A suspended occupant | still blocks deactivation | `test_a_suspended_occupant_also_blocks_deactivation` |
| Deactivate twice / activate an active unit | 409 `invalid_transition`, no audit | `test_repeated_transitions_are_409_invalid_transition` |
| Concurrent occupancy insert | deactivate waits; commit → 409, rollback → 204 | `backend/tests/units/test_concurrency.py::test_deactivate_waits_for_a_concurrent_occupancy_start` |
| Rename onto an existing unit | 409 `unit_exists`, unchanged, no audit | `test_patch_rename_onto_existing_is_409` |
| NUL, a too-long value, a newline, `floor: true`, `"3"`, out of range | 422 `validation_error`, nothing written | `test_create_rejects_invalid_input_and_writes_nothing` (18 cases), `test_patch_rejects_invalid_input` |
| A lone surrogate in a body | pydantic's `json_invalid`, 422 | `test_create_rejects_invalid_input_and_writes_nothing` (raw JSON case) |
| NUL in `?search=` | 422 | `test_list_rejects_query_values_postgres_cannot_take` |
| Options leak inactive units or occupant data | active only; `UnitOption` has 3 fields | `backend/tests/units/test_options.py::test_options_return_only_id_tower_label_of_active_units` |
| Options asked for 1,000 rows | clamped to 50 (and 0 → 1) | `test_options_limit_is_clamped` |
| Concurrent duplicate create | `ON CONFLICT DO NOTHING` gives 409 | No test with two real connections. The single-request duplicate is tested. |

Acceptance criteria → tests:
1. `test_security_search_lists_prefix_matches_in_own_building_only`, `test_list_item_body_and_occupant_counts`, `test_resident_and_council_get_403_on_list`
2. `test_duplicate_null_tower_label_is_409_unit_exists`, `test_manager_creates_a_unit_with_audit_row`
3. `test_deactivating_an_occupied_unit_is_409`, `test_unit_deactivates_after_its_occupancies_end`, the concurrency test
4. `test_other_buildings_unit_is_404_on_every_write`
5. moved to P4-01b
6. `test_options.py` (6 tests)
7. `test_patch_changes_only_sent_fields_and_audits_names`, `test_noop_patch_writes_no_audit_row`, `test_patch_rename_onto_existing_is_409`
8. `backend/tests/audit/test_audit.py::test_record_audit_refuses_falsy_metadata_that_is_not_a_dict`, `test_record_audit_refuses_a_lone_surrogate_key`, `test_record_audit_refuses_shared_sub_objects_without_walking_every_path`

## 6. Review log

Reviewer for every round: Codex `gpt-6.1-sol`, effort high, a fresh session through the `codex-review`
skill. James asked for it in place of the Claude reviewer for this run, with no Claude cross-check.

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol (high) | `86eb72a` | MERGE | R1-F1 Low: `floor` accepted booleans | fixed in `00ce62a` |
| 2 | Codex gpt-6.1-sol (high), new session | `00ce62a` | MERGE | R2-F1 Low: OpenAPI offered `label: null` for PATCH | fixed in `8e6260e` |
| 3 | — | — | skipped | — | James told me to skip round 3 after round 2's MERGE |

- **R1-F1.** `POST {"label": "boolean-proof", "floor": true}` returned 201 and stored floor 1. Pydantic's
  lax `int` accepts `bool`. The proof failed when I reran it; six new cases in the create and PATCH input
  tests failed, then passed with `Field(strict=True)`. Neighbours: `"3"` is refused too, and `label: 101`
  was already refused. Strict mode also changes P4-01b: its CSV parser must convert floors to int first,
  noted in that ticket.
- **R2-F1.** The generated TypeScript said `label?: string | null`, but the API refuses null with 422.
  `test_patch_schema_documents_label_as_optional_but_not_nullable` failed, then passed with `SkipJsonSchema`.
  It also asserts that `tower` and `floor` keep `null`.

## 7. Not verified, accepted risks and follow-ups

- **`8e6260e` had no independent review.** It contains R2-F1's fix: one schema annotation, its test, and the
  regenerated types. James skipped round 3.
- **The opposite deactivation race is not covered:** the deactivation commits first, then an occupancy starts
  in the now-inactive unit. `start_occupancy` does not check `is_active`. P4-05 must lock the unit
  (`FOR KEY SHARE`) and check `is_active` in the same statement. This will be added to P4-05's ticket in the
  bookkeeping commit. Both reviewers named it as a residual risk.
- **A concurrent duplicate create** relies on `ON CONFLICT DO NOTHING`; no test runs two real connections.
- **The PATCH `IntegrityError` → 409 mapping** assumes the only constraint a tower or label change can
  break is the unique one (D3). No test covers a different constraint, because none exists today.
- **List order** is newest first (`id DESC`), not by label. A label-ordered staff list is tracked only here
  and in PR #84's follow-ups, until a UI ticket needs it.
- **The CSV import** (original criterion 5) is P4-01b, `todo`. Its starting code at `4c015f0` was never
  reviewed.
- The stack journey ran the API routes as seeded users (PR #84 evidence); no frontend uses these routes yet.

## 8. How to change this safely

- **A new unit field** (for example `notes`): add it to `UnitCreate`, `UnitUpdate` (decide whether null
  clears it) and `UnitOut`, plus a migration. Then check D3's assumption in `update_unit`: a field with its own
  constraint needs its own error mapping. Run `make gen-api`, and add cases to
  `test_create_rejects_invalid_input_and_writes_nothing`.
- **Another state change** (for example archiving): follow `_set_active`. Lock, check, conditional UPDATE,
  audit, one commit. Add a 409 `invalid_transition` test.
- **Anything that starts an occupancy** (P4-05, P4-06): lock the unit and check `is_active` in one statement
  (§7). The concurrency test shows how to test it on real connections.
- **Changing what `search_unit_options` returns**: `test_options_return_only_id_tower_label_of_active_units`
  pins the three fields on purpose.

## 9. Must explain, then quiz

**1. Why does the join flow get a separate, minimal unit query instead of reusing the staff list?**
The staff list (`backend/app/units/service.py::list_units`) returns `current_occupant_count` and inactive
units, and needs a tenant context with a staff role. The join flow's caller is a signed-up user who is not
yet a member (P4-05's `GET /api/join/{join_code}/units`), so it has no `TenantContext`. Telling that user
which units are occupied, and by how many people, would leak who lives where. `search_unit_options` takes
a `building_id` directly and returns only `UnitOption`'s three fields for active units. The ticket records
"No occupant data". Linking that to the privacy of non-members is inferred.

**2. Why block deactivating an occupied unit rather than cascading?**
Recorded: occupancy rows are history and are "ended, never deleted" (`UnitOccupancy`'s docstring,
ADR-0010). Who saw which records depends on those windows. A cascade would have to end real residents'
occupancies as a side effect of a unit edit, which changes what each of them may see, with no audit of a
membership decision. Blocking (`deactivate_unit`, 409 `unit_has_occupants`) makes the manager end each
occupancy deliberately, through the membership flows that record it. The cascade comparison itself is
inferred; the ticket states only the rule.

**3. Why does deactivation lock the unit row before checking for occupants?**
See D2. An occupancy insert holds `FOR KEY SHARE` on the unit until it commits. Only `FOR UPDATE` conflicts
with that, so deactivation waits. The `EXISTS` check after it is a new statement, and under READ COMMITTED
it sees the insert once committed. `test_deactivate_waits_for_a_concurrent_occupancy_start` proves it in
both outcomes.

Quiz:

1. A building-B manager sends `POST /api/buildings/{B}/units/{A's occupied unit}/deactivate`. Which status
   and code come back, and which line makes it so?
2. Why does `update_unit` use `model_dump(exclude_unset=True)` instead of `model_dump()`?
3. Why does `_check_structure` count nodes per path instead of skipping objects it has already visited?
4. What would break if `autoescape=True` were removed from `_label_prefix`?
5. How would you extend this so P4-05's join request refuses an inactive unit even when it races a
   deactivation?

<details><summary>Answers</summary>

1. 404 `unit_not_found`. `_get_unit` filters by `Unit.building_id == building_id` and raises before the
   occupancy check runs, so no 409 reveals that the unit exists.
2. Without it, every field missing from the body would be `None` and would clear tower and floor. With it,
   only fields actually sent count as changes, and a no-op PATCH writes no audit row.
3. Skipping visited objects would make the walk linear, but `json.dumps` later expands a shared object once
   per path, so `x = [x, x]` would still blow up there. Counting per path bounds both the walk and the
   serialization.
4. `_` and `%` in the search would act as LIKE wildcards: `"1_"` would match `101`, and `"%"` every unit.
   `test_search_treats_percent_and_underscore_literally` and the options test would fail (mutation: 6
   failed).
5. In P4-05's service, read the unit with `select(Unit.id).where(Unit.id == unit_id, Unit.building_id ==
   b, Unit.is_active).with_for_update(key_share=True)` before `start_occupancy`. If deactivation holds its
   `FOR UPDATE`, this waits. Postgres then re-checks the WHERE against the committed row, so an inactive
   unit returns no row and is refused. Test it the way `test_concurrency.py` does, on real connections.

</details>
