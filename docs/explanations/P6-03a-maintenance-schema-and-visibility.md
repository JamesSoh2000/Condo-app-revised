# Explanation — P6-03a Maintenance request schema, state machine and visibility

> **PR:** #137 · **Source revision:** `690c1f2`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1, Codex `gpt-6.1-sol` high) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 137 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `690c1f2` the diff (`git diff --name-status origin/main...HEAD`, 21 files),
> every file under `backend/app/maintenance/`, the `occupancy.py`, `main.py` and `registry.py` patches, the
> migration `2cb174aca098_maintenance_p6_03a.py`, `backend/app/files/service.py::download_url` and
> `_may_view` (the caller of the hook), and the assertions of every test cited below; compiled
> `visible_maintenance` for a resident to SQL (§3); ran
> `uv run pytest tests/maintenance tests/test_world.py tests/packages/test_visibility.py -q` against the local
> Postgres on port 55432: `209 passed`. Differences from the plan: four, listed in §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C (schema and a download; no endpoint exists yet).

## 1. What was built and why

The first of four maintenance tickets split from the P6-03 stub. It adds the `maintenance_requests` table and
its photos (`maintenance_request_photos`), the state machine
(`backend/app/maintenance/state.py::ALLOWED`), the one query that decides who sees which request
(`backend/app/maintenance/queries.py::visible_maintenance`), and the download rule for a request's photos
(`backend/app/maintenance/photos.py::can_view_maintenance_photo`). There are no endpoints yet: P6-03b adds
submit, list, read and cancel, P6-03c the manager's actions, P6-03d comments, all built on these pieces.

The two decisions that matter most: the row holds only the request's **current** state, and the history of
status changes goes to a status-event table that P6-03c adds (D3/D4, ADR-0020); and the photo limit (5) is a
**database** guarantee, not a service check (D5).

## 2. Decisions

### D3/D4. The row is the current state; history goes to P6-03c's status events

- **Problem or constraint:** the state machine repeats statuses. A held request is resumed
  (`on_hold → in_progress`) and may be held again, and a resolved one may be reopened
  (`resolved → in_progress`). One `on_hold_at` column can't hold two holds. P6-04c shows residents a timeline,
  and the audit log is not readable by residents, so it can't be the timeline's source.
- **Chosen:** each status has its own columns and every other status's columns are NULL, enforced by one
  check per status (`backend/app/maintenance/models.py::_state_check`). `started_*` is the first start and is
  kept through hold, resolve and reopen; `on_hold_*` exists only while on hold, `resolved_*` only while
  resolved, `cancelled_*` only when cancelled. The moves are in `backend/app/maintenance/state.py::ALLOWED`:
  `submitted → in_progress | cancelled`, `in_progress → on_hold | resolved`, `on_hold → in_progress |
  resolved`, `resolved → in_progress`; `cancelled` is final. P6-03c adds `maintenance_status_events` with
  the actions that write it.
- **Alternatives rejected:** never clearing a `*_at` once set: a second hold overwrites the first anyway, and
  the checks would depend on the order of earlier moves. An event table in this ticket: nothing here writes
  it, and it would push the ticket over budget.
- **Tradeoffs and accepted limitations:** until P6-03c lands, the row alone shows only the latest of each
  status. P6-03c must write an event in the same transaction as each conditional `UPDATE`. Its 14-day reopen
  window reads `resolved_at`, which is on the row exactly while the request is `resolved`.
- **Basis:** autonomous (decision rule 3); [ADR-0020](../adr/0020-maintenance-request-shape.md).
- **Source:** recorded (ticket Frame notes D3, D4; PR decision D3/D4; ADR-0020).

### D2. A common area is free text, seen by its requester

- **Problem or constraint:** a common-area request has no unit to point at; and the ticket asked who sees
  one.
- **Chosen:** `common_area varchar(120)`, not blank, present exactly when `location = 'common_area'`
  (`ck_maintenance_requests_location_matches`, `..._common_area_not_blank`). Visibility follows from the
  occupancy clause, which is false without a unit, so a resident sees a common-area request only if they filed
  it. Staff see all of them.
- **Alternatives rejected:** a table of each building's areas: a new admin surface and migration, over the
  ticket's budget (the ticket says so). A fixed enum: buildings have different areas (a gameroom, a
  speakeasy). Every resident seeing common-area requests: that makes them a building-wide record, like a
  notice, and conflicts with "residents see only their own records" (CLAUDE.md rule 3).
- **Tradeoffs and accepted limitations:** no per-area reporting. Two residents reporting the same broken
  lobby door file two requests and don't see each other's.
- **Basis:** autonomous (rule 3) for the shape; ticket default for visibility; ADR-0020.
- **Source:** recorded (Frame notes D2, PR decision D2).

### D5. Photos: a join table, at most 5, enforced by the database

- **Problem or constraint:** a request has several photos, in order; a file must belong to one request; the
  ticket asked for a limit "as a database guarantee or a service check P6-03b tests".
- **Chosen:** `maintenance_request_photos` with primary key `(request_id, position)`,
  `CHECK (position BETWEEN 0 AND 4)` and `UNIQUE (building_id, file_id)`. Five distinct positions fit, so a
  sixth photo has nowhere to go.
- **Alternatives rejected:** one `photo_file_id` column (the stub asks for photos); a limit checked only in the
  service (a later endpoint could skip it).
- **Tradeoffs and accepted limitations:** nothing makes positions dense (0 and 3 with no 1 and 2 is
  accepted); P6-03b assigns them in order. Raising the limit means widening the check in a migration.
- **Basis:** stub default (join table); 5 autonomous.
- **Source:** recorded (Frame notes D5, PR decision D5).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D1 security sees every request | the resident rule | stub default "read and comment only"; actions stay with the manager (P6-03c) | ticket | Frame notes D1 |
| D6 categories `plumbing`, `electrical`, `heating_cooling`, `appliance`, `doors_windows`, `pest_control`, `other`, `emergency` | free text | filters and P6-03b's emergency rule need fixed values; adding one is expand-only | autonomous | Frame notes D6 |
| D7 `description` varchar(2000), blank (incl. only tabs/newlines) refused | 200 (package) or 10,000 (notice) | a fault report, not a label or an article; widening is cheap | autonomous | Frame notes D7 |
| D8 council alone sees none | all | the packages pattern (`backend/app/packages/queries.py::_SEE_ALL`); P6-05's counts are the "summaries" | convention | Frame notes D8 |
| D9 `idempotency_key`, `request_hash` NOT NULL, unique key per building | nullable, or none | the recipe's create pattern; the packages shape | recipe | Frame notes D9 |
| D10 manager list index `(building_id, status, id DESC)` | `submitted_at DESC` | `backend/app/core/pagination.py::paginate` orders by id, as notices do | convention | Frame notes D10 |

**Framing changes:** criteria 2 (photo-table FK names), 4 (one case per status and column), 5 (one case per
`*_at`, the `started_at` bounds, equal bounds accepted), 7 (council resolved to "own only"; `a_former` as a
co-occupant of 102 added; a council-only context added) and 12 (the database limit) sharpened; 13 (idempotency
key per building) and 14 (blank common area) added. None loosened.

**Plan versus final code** (each recorded below the PR's Plan):
- **Line count:** 640 non-test lines, 337 without the autogenerated, hand-edited migration (303). The ticket
  estimated 150 for the migration. Counted as P5-01 (#109) did.
- **Time checks:** `on_hold_at` and `resolved_at` are bounded by `started_at`, not `submitted_at`. Since both
  require `started_at`, which must follow `submitted_at`, the bound holds by transitivity, and each early time
  breaks exactly one named constraint.
- **Location check** is `(location <> 'unit' OR …) AND (location <> 'common_area' OR …)`. The first form,
  `(unit AND …) OR (common_area AND …)`, also failed for an unknown location, so the enum test saw the wrong
  constraint name on its first run.
- **`backend/app/memberships/occupancy.py::occupancy_window_clause`** now accepts a nullable unit column in its
  type hint. It already documented that a NULL unit makes it false; no behaviour changed.

## 3. How it is implemented

### Overview

- `backend/app/maintenance/models.py::MaintenanceRequest` and `::MaintenanceRequestPhoto`: the two tables;
  every rule about a single row is a database constraint.
- `backend/app/maintenance/state.py::ALLOWED`: which status may follow which. It has no callers yet; P6-03b's
  cancel and P6-03c's actions will use `assert_transition` and `sources`.
- `backend/app/maintenance/queries.py::visible_maintenance`: the only visibility filter.
- `backend/app/maintenance/photos.py::can_view_maintenance_photo`: registered for `maintenance_photo` when
  `backend/app/main.py` imports it. The files module calls it on download.

### Walkthrough (variant C: a row hitting the schema, then a download)

1. **An INSERT.** P6-03b's create will insert a row. Postgres checks the composite FKs: the
   requester, unit and every `*_by` membership must be in the row's building. Then the checks: location
   agrees with `unit_id`/`common_area`, the status has its columns and no others, the times are in order, the
   text isn't blank, the enums hold known values. A violation is an `IntegrityError` naming the constraint,
   for example `ck_maintenance_requests_on_hold_state`.
2. **Photos.** Each photo is a `files` row claimed with `attached_type = 'maintenance_request'` and
   `attached_id = <request id>` (`backend/app/files/service.py::claim_file`), plus one
   `maintenance_request_photos` row. The FKs keep both in the request's building; the unique key and the
   position check enforce one request per file and at most five photos.
3. **A read.** For a resident, `visible_maintenance` compiles to (compiled at `690c1f2`):
   ```sql
   SELECT maintenance_requests.id FROM maintenance_requests
   WHERE maintenance_requests.building_id = %(building_id_1)s::UUID
     AND (maintenance_requests.requester_membership_id = %(requester_membership_id_1)s::UUID
          OR public.occupancy_window(%(occupancy_window_1)s::UUID, maintenance_requests.unit_id,
                                     maintenance_requests.submitted_at))
   ```
   Staff get `… AND true`; any other role `… AND false`.
4. **A download.** `GET /api/buildings/{b}/files/{id}/download-url` → `backend/app/files/service.py::download_url`
   loads a `ready` file of the context's building, and `_may_view` passes an attached file to the hook for its
   purpose. `can_view_maintenance_photo` refuses any other `attached_type`, then asks whether
   `visible_maintenance(ctx)` contains the request named by `attached_id` **and** that request has a photo row
   for this file. If not, `download_url` gives 404 `file_not_found`, the same body as a random id.
5. **Failure:** members of another building, and pending or suspended members, never get this far:
   `get_tenant_context` answers 404 `building_not_found`. Signed out is 401.

### Data model changes

`maintenance_requests` (migration `2cb174aca098`, revises `b006d25a3f56`):

| Constraint | Refuses | Why |
|---|---|---|
| 6 composite FKs `fk_maintenance_requests_building_id_<column>` | a requester, unit or actor from another building | ADR-0005: a building's row can't name another building's records |
| `uq_maintenance_requests_building_id_id` | — | the target of the photos' (and P6-03d's comments') composite FK |
| `uq_..._building_id_idempotency_key` | a second request with the same key in one building | P6-03b's retry returns the original (D9) |
| `ck_..._location_matches` | `unit` without a unit or with a common area; `common_area` with a unit or without its text | D2 |
| `ck_..._<status>_state` (5) | a column of another status, or missing its own | D3 |
| `started_after_submitted`, `on_hold_after_started`, `resolved_after_started`, `cancelled_after_submitted` | a time before what it follows | a timeline can't run backwards |
| `description_not_blank`, `common_area_not_blank` | `''` or only spaces, tabs, newlines | the API strips strings, so `''` would pass NOT NULL (the P5-01 carry) |
| `ck_..._maintenance_status/location/category` | unknown enum values | string enums (`backend/app/models/types.py::database_enum`) |
| indexes `(building_id, status, id DESC)`, `(building_id, unit_id, submitted_at DESC)`, `(requester_membership_id)` | — | the lists P6-03b asks for (D10) |

`maintenance_request_photos`: PK `(request_id, position)`, composite FKs to the request and the file,
`UNIQUE (building_id, file_id)`, `CHECK (position BETWEEN 0 AND 4)` (D5).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/maintenance/models.py` | the two tables and their constraints | +179 |
| `backend/migrations/versions/2cb174aca098_maintenance_p6_03a.py` | the migration, hand-edited | +303 |
| `backend/app/maintenance/queries.py` | `visible_maintenance` | +44 |
| `backend/app/maintenance/photos.py` | the download hook | +42 |
| `backend/app/maintenance/state.py` | the state machine | +37 |
| `backend/app/maintenance/enums.py` | the three enums | +30 |
| `backend/app/main.py`, `backend/app/models/registry.py`, `backend/app/memberships/occupancy.py` | register the hook and models; widen a type hint | +5 / −3 |
| `backend/tests/maintenance/*` (5 files), `backend/tests/test_world.py` | tests | +~1,000 |
| `docs/adr/0020-maintenance-request-shape.md`, ADR index, ticket, index | docs | |

**Key excerpts**

`backend/app/maintenance/models.py::_state_check`

```python
_STARTED = ("started_at", "started_by_membership_id")
_ON_HOLD = ("on_hold_at", "on_hold_by_membership_id")
_RESOLVED = ("resolved_at", "resolved_by_membership_id")
_CANCELLED = ("cancelled_at", "cancelled_by_membership_id")
# Each status's own columns (ADR-0020); every other status column is NULL.
_OWN: dict[MaintenanceStatus, tuple[str, ...]] = {
    MaintenanceStatus.SUBMITTED: (),
    MaintenanceStatus.IN_PROGRESS: _STARTED,
    MaintenanceStatus.ON_HOLD: _STARTED + _ON_HOLD,
    MaintenanceStatus.RESOLVED: _STARTED + _RESOLVED,
    MaintenanceStatus.CANCELLED: _CANCELLED,
}


def _state_check(status: MaintenanceStatus) -> CheckConstraint:
    own = _OWN[status]
    others = [c for c in _STARTED + _ON_HOLD + _RESOLVED + _CANCELLED if c not in own]
    tests = [f"{c} IS NOT NULL" for c in own] + [f"{c} IS NULL" for c in others]
    return CheckConstraint(
        f"status <> '{status}' OR ({' AND '.join(tests)})", name=f"{status}_state"
    )
```

- Builds one check per status from a single table of "own" columns (D3), so the five checks can't drift
  apart in the model. The migration holds the rendered SQL, and `alembic check` compares the two.
- Without it, a row could be `resolved` with no `resolved_at`, or `submitted` with a `cancelled_at`, and
  every later read would need to guess which columns to trust.

`backend/app/maintenance/models.py::MaintenanceRequest` (constraints, trimmed)

```python
        CheckConstraint(
            "(location <> 'unit' OR (unit_id IS NOT NULL AND common_area IS NULL))"
            " AND (location <> 'common_area' OR (unit_id IS NULL AND common_area IS NOT NULL))",
            name="location_matches",
        ),
        *(_state_check(status) for status in MaintenanceStatus),
        # on_hold_at and resolved_at need started_at (the state checks), so they also follow
        # submitted_at.
        CheckConstraint("started_at >= submitted_at", name="started_after_submitted"),
        CheckConstraint("on_hold_at >= started_at", name="on_hold_after_started"),
        CheckConstraint("resolved_at >= started_at", name="resolved_after_started"),
        CheckConstraint("cancelled_at >= submitted_at", name="cancelled_after_submitted"),
```

- The location check tests one thing: given a known location, are the right columns set? Unknown values are
  the enum check's job (the deviation in §2).
- A NULL time passes a `>=` check (SQL treats it as unknown, which a check accepts); the state checks are
  what make a time required.

`backend/app/maintenance/models.py::MaintenanceRequestPhoto`

```python
        # A file is the photo of one request.
        UniqueConstraint("building_id", "file_id"),
        # With the primary key, the database caps a request's photos at MAX_PHOTOS.
        CheckConstraint(f"position BETWEEN 0 AND {MAX_PHOTOS - 1}", name="position_range"),
    )

    request_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    position: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=False)
```

- The primary key makes each position unique per request, and the check allows five positions, so the limit
  holds whatever endpoint writes the rows (D5). A mutation probe that widened the check to 5 failed 2 tests.

`backend/app/maintenance/queries.py::_grant`

```python
def _grant(ctx: TenantContext) -> ColumnElement[bool]:
    if ctx.has_any(*_SEE_ALL):
        return true()
    if ctx.has_any(Role.RESIDENT):
        # Always the context's own membership, never a value from the request.
        return or_(
            MaintenanceRequest.requester_membership_id == ctx.membership_id,
            occupancy_window_clause(
                ctx.membership_id, MaintenanceRequest.unit_id, MaintenanceRequest.submitted_at
            ),
        )
    return false()
```

- Copied from `backend/app/packages/queries.py::_grant`, with `submitted_at` as the record's time. The
  window function (ADR-0016) is false for a NULL unit, which is what hides common-area requests from other
  residents.
- Removing the occupancy clause (a mutation probe) failed 6 visibility tests: a former occupant would lose
  their old unit's requests and a co-occupant wouldn't see the household's.

`backend/app/maintenance/photos.py::can_view_maintenance_photo`

```python
    if file.attached_type != MAINTENANCE_REQUEST_ATTACHED_TYPE:
        return False
    listed = (
        select(MaintenanceRequestPhoto.file_id)
        .where(
            MaintenanceRequestPhoto.building_id == MaintenanceRequest.building_id,
            MaintenanceRequestPhoto.request_id == MaintenanceRequest.id,
            MaintenanceRequestPhoto.file_id == file.id,
        )
        .exists()
    )
    shown = visible_maintenance(ctx).where(MaintenanceRequest.id == file.attached_id, listed)
    return bool(await db.scalar(select(shown.exists())))
```

- Both sides must agree: the file says which request it's attached to, and that request's photo rows list
  the file. The `EXISTS` subquery correlates with the outer `MaintenanceRequest`, so it checks the photo rows
  of the request in `visible_maintenance`, not of any request.
- Mutation probes: dropping `listed` failed 2 tests (a claimed file with no photo row, and a photo row whose
  file is attached to another request, became downloadable). Dropping the `attached_type` test failed 2
  tests.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A reference to building B on an A request | composite FK refuses it | `backend/tests/maintenance/test_schema.py::test_a_reference_to_another_building_is_refused` (6), `test_a_photo_of_another_buildings_request_is_refused`, `test_a_photo_of_another_buildings_file_is_refused` |
| A status with a column of another status, or missing its own | that status's check refuses it | `test_the_status_check_refuses_a_row_that_breaks_its_status` (40 cases) |
| An early time; a time exactly at its bound | refused; accepted | `test_a_time_before_submitted_at_is_refused` (4), `test_a_time_before_started_at_is_refused` (2), `test_times_equal_to_their_bound_are_accepted` |
| A blank description or common area; tabs and newlines kept | refused; kept | `test_a_blank_description_is_refused` (3), `test_a_blank_common_area_is_refused` (3), `test_a_description_keeps_its_newlines` |
| A sixth photo, position −1 / 5 / 2³¹−1, a taken position, one file on two requests | refused | `test_five_photos_are_accepted_and_a_sixth_is_refused`, `test_a_position_outside_the_limit_is_refused`, `test_a_taken_position_is_refused`, `test_a_file_is_the_photo_of_one_request_only` |
| A request filed exactly at T1 (a_former's window end) or T2 (a_resident1's start) | `started_at <= T < ended_at` | `backend/tests/maintenance/test_visibility.py::test_a_window_includes_its_start_and_excludes_its_end` (5 edges) |
| A co-occupant of the requester's unit | sees it; not the requester's common-area request | `test_visibility_by_persona[a_former]` |
| Council alone; a context with no role | none | `test_council_alone_sees_no_request`, `test_a_context_with_no_role_sees_no_request` |
| A photo whose two sides disagree, or another `attached_type` | 404, manager included | `backend/tests/maintenance/test_photos.py::test_a_file_attached_to_a_request_but_not_in_its_photo_rows_is_refused`, `test_a_photo_row_whose_file_is_attached_to_another_request_is_refused`, `test_a_file_of_another_attached_type_is_refused`, `test_the_hook_refuses_another_attached_type_directly` |
| A hidden photo's 404 differs from a random id's | identical body minus `request_id` | `test_the_download_url_follows_the_requests_visibility` (7 personas × 3 photos) |
| The server starts without the hook | registered by `app.main`'s imports | `test_importing_the_app_alone_registers_the_maintenance_photo_hook` |
| A `maintenance_request_photos` row naming a file of another purpose | **No test, no constraint** | see §7 |

Acceptance criteria → tests: 1 `test_migration_downgrades_and_upgrades`; 2 the FK tests above and
`test_references_in_the_requests_own_building_are_accepted`; 3 `test_the_location_check_refuses_a_mismatched_row`;
4 the status, blank and `test_a_value_outside_the_enum_is_refused` tests; 5 the time tests;
6 `backend/tests/maintenance/test_state.py` (all 25 pairs); 7 and 8 `test_visibility.py`; 9 `test_photos.py`;
10 `test_download_url_is_404_building_not_found_for_non_members[a_pending, a_suspended]`; 11 the two hook
registration tests; 12 to 14 the photo, idempotency and common-area tests.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high effort (the only reviewer, by James's instruction for this run) | `690c1f2` | MERGE | none | — |

The reviewer ran the full backend suite (2,908 passed), ruff, mypy, the link check, and the migration
round-trip on disposable databases. No finding changed the code.

## 7. Not verified, accepted risks and follow-ups

- **A photo row's file purpose is not constrained.** Nothing in the schema stops a `maintenance_request_photos`
  row from naming a `package_photo` or `notice_attachment` file. Such a file can't leak through this hook (the
  files module dispatches on the file's purpose, and the other hooks check their own `attached_type`), but
  the row would be wrong. P6-03b's `claim_file(…, FilePurpose.MAINTENANCE_PHOTO, …)` is what keeps it out;
  no test in this ticket covers it.
- **An unattached maintenance photo is downloadable by its uploader** (`backend/app/files/service.py::_may_view`):
  files-module behaviour, unchanged here.
- **Dense positions** aren't enforced (D5); P6-03b assigns them.
- **The state machine is not used yet.** `ALLOWED` is tested on its own; that the actions write rows the checks
  accept is P6-03b/c's criterion ("the checks never refuse a request the API accepted").
- **History:** until P6-03c adds `maintenance_status_events`, the row shows only the latest of each status
  (D4). Follow-up added to P6-03c in the bookkeeping commit.
- Residual risks the reviewer named, all in later tickets: endpoint authorization, transactional transitions,
  idempotency replay, status-event history.
- No stack journey: no endpoint can create a request yet. The download route was exercised through the app's
  HTTP stack in tests, and the migration was applied to the dev database.

## 8. How to change this safely

- **A new status or column:** add it to `_OWN` in `backend/app/maintenance/models.py`, write a migration that
  drops and re-creates the affected `*_state` checks (never edit `2cb174aca098`), and extend `OWN` in
  `backend/tests/maintenance/test_schema.py`, which generates a case per status and column.
- **A different photo limit:** change `MAX_PHOTOS` and migrate the `position_range` check; the schema tests
  use the literal 5.
- **Comment photos (P6-03d):** add a branch to `can_view_maintenance_photo` for its own `attached_type`, built
  on `visible_maintenance` plus the comment's own rules (internal comments must never reach a resident).
- **Anything that reads requests** narrows `visible_maintenance(ctx)`; never write a second filter.

## 9. Must explain, then quiz

1. **Which request does `a_former` see for unit 101, and which `a_resident1`, and why `submitted_at` rather
   than `now()`?** `a_former` lived in 101 until T1 and `a_resident1` from T2. `a_former` sees 101's requests
   submitted before T1, `a_resident1` those from T2 on, and nobody (but the requester and staff) those in
   between (`test_each_occupant_sees_101s_requests_from_their_own_time`). The window is compared with when the
   request was filed: comparing with `now()` would show a new occupant every past request of the unit, and
   take a former occupant's own household history away the day they moved (ADR-0016, history follows the
   person).
2. **Why is a common-area request invisible to other residents, and what would change it?** The occupancy
   clause needs a unit; a common-area request has `unit_id` NULL, so only the requester clause can match.
   Showing them to every resident would mean a third branch in `_grant` (for example
   `location = 'common_area'` for any resident), and would make them building-wide records, like notices
   (D2).
3. **How does the photo hook stop a photo from reaching someone who can't see its request, and why must both
   sides agree?** It only grants a file whose `attached_id` names a request in `visible_maintenance(ctx)` and
   whose request lists it in `maintenance_request_photos`. With only `attached_*`, a stray file attached by
   mistake to a visible request would be served though the request doesn't show it; with only the photo row,
   a row pointing at a file attached to another (hidden) request would be served through the visible one. The
   two refused cases in `test_photos.py` are exactly these.
4. **Which rows does each check refuse, and why constraints rather than service checks?** See the table in §3.
   As constraints they hold for every writer: P6-03b, P6-03c, a seed, a backfill, a future endpoint, with no
   code to forget. The service still validates first, so a user gets a 422 and not a 500; the constraint is
   the last line.

**Quiz**

1. What breaks if `listed` is removed from `can_view_maintenance_photo`?
2. A request is resolved, reopened and resolved again. What does the row say, and where will the first
   resolution be recorded?
3. Why does `test_a_time_before_submitted_at_is_refused` expect `on_hold_after_started`, not an
   `on_hold_after_submitted` check?
4. How would you extend this so security can see only open requests?
5. Why does an unknown `location` value fail on `ck_maintenance_requests_maintenance_location` and not on
   `location_matches`?

<details><summary>Answers</summary>

1. A file attached to a visible request but not listed in its photos, and a listed file attached to another
   request, become downloadable by anyone who sees the request; the mutation probe failed 2 tests.
2. `status = resolved`, `started_*` from the first start, `resolved_*` from the second resolution, `on_hold_*`
   NULL. The first resolution is lost from the row (reopen cleared it); it goes in P6-03c's
   `maintenance_status_events`.
3. There is no `on_hold_after_submitted`: an on-hold row must have `started_at`, which must follow
   `submitted_at`, so `on_hold_at >= started_at` covers it, and each early time breaks one named constraint.
4. Move security out of `_SEE_ALL` and give it its own branch in `_grant`, for example
   `MaintenanceRequest.status.in_(…)`; every read and the photo hook follow, since they all narrow
   `visible_maintenance`.
5. The location check is written per known value (`location <> 'unit' OR …`), so an unknown value passes it
   and only the enum check refuses it.

</details>
