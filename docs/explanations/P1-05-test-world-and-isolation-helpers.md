# Explanation — P1-05 Test world fixtures and tenant-isolation helpers

> **PR:** #50 · **Source revision:** `90a38bb` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit (`90a38bb`), by both
> reviewers (Codex and a fresh Claude reviewer).
> **Merge commit:** not known when written; after the merge, `gh pr view 50 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> is rebased onto `origin/main` (`git merge-base --is-ancestor origin/main HEAD` succeeds).
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: full. Tier: 1. Walkthrough variant: C (one test run that uses the world, from fixture setup to
> rollback). There is no HTTP request to follow: the ticket adds no endpoint.

## 1. What was built and why

The ticket adds test infrastructure only; nothing under `backend/app/` changed. A `world` fixture builds two
buildings (A "maple", B "birch") with twelve users covering every role, membership status and occupancy
situation the 10-case tenant test table needs (docs/ENGINEERING_PRACTICES.md §7). Plain async factories build
the rows, and `assert_integrity_error` checks a named constraint violation inside a savepoint so the test can
keep using its session afterwards. The point (ticket "Why") is that tenant tests only get written if each
case is one or two lines.

Two items carried from earlier reviews were taken in scope: an ORM "fitness test" (a test that checks a rule
across every model, not one behaviour) for `delete-orphan` cascades (P1-02), and a per-process scratch
database for the migration round-trip tests (P1-03).

The decisions that matter most: `assert_integrity_error` **requires** the expected constraint name (D1), and
it flushes pending rows **before** opening the savepoint, so a mistake in the test's own setup can't pass as
the expected violation (D5, from review round 1).

## 2. Decisions

### D1. `assert_integrity_error` requires the constraint name

- **Problem or constraint:** an `IntegrityError` from the wrong constraint (say a duplicate slug in setup)
  would let a cross-building test pass without testing anything.
- **Chosen:** a required keyword `constraint=`, compared exactly with asyncpg's `constraint_name`, reached
  through `exc.orig.__cause__` (`backend/tests/helpers/db.py::assert_integrity_error`). No error, or an error
  on another constraint, calls `pytest.fail`; any other exception propagates. It returns the error.
- **Alternatives rejected:** the ticket's two-argument form `(db, coro)`: it accepts any violation. An
  optional `match=` regex like `pytest.raises(..., match=...)`: optional means forgettable, and a regex on
  the message can match a name that only appears in the SQL text.
- **Tradeoffs and accepted limitations:** tied to asyncpg's exception shape. If the driver changes, every
  call fails loudly (the name comes back `None`), never silently.
- **Basis:** autonomous (test-only). Frame notes 3 and 6; mutations M5–M7 in the PR.
- **Source:** recorded (PR decision D1).

### D2. Occupancies go through the app's helpers; personas are chosen so a 404 proves the right thing

- **Problem or constraint:** the P1-03 review asked that the world can't hold overlapping occupancy history
  (ADR-0016). And a pending or suspended persona with no role or no unit could get a 404 for the wrong
  reason, hiding a missing status check.
- **Chosen:** `backend/tests/factories.py::make_occupancy` calls
  `backend/app/memberships/occupancy.py::start_occupancy`, then `end_occupancy` when `ended_at` is given,
  with explicit past instants (`World.T0 < T1 < T2`, all in 2025). `a_pending` holds the resident role;
  `a_suspended` is a resident with a current household occupancy of A-201.
- **Alternatives rejected:** raw `UnitOccupancy` inserts (faster, but allow overlaps the helpers refuse);
  `a_suspended` without a unit (the ticket's list gives none, and then a status bug could hide behind a
  missing occupancy).
- **Tradeoffs and accepted limitations:** A-201 has three current occupants (council, suspended, multi);
  a later test that counts 201's occupants must allow for that. The PR says this is "documented in the
  README table": the table lists each persona's unit, but doesn't say "201 has three" in so many words.
  `a_pending` has no occupancy (the ticket asked for that), so on a *unit-addressed* route its 404 could
  still come from the occupancy filter rather than the status check (see §7).
- **Basis:** ticket "Carried from P1-03"; ADR-0016; frame notes; mutation M8.
- **Source:** recorded (PR decision D2).

### D3. Carried P1-02 items: two taken as tests, two closed without change

- **Problem or constraint:** the ticket says take each carried item in scope or move it to a named ticket.
- **Chosen:** the delete-orphan fitness test and the `passive_deletes` / `user` pins are in this PR
  (`backend/tests/test_orm_relationships.py`). Review L-A (no `building` relationship on memberships, roles
  and units) and L3 (no index on `membership_roles.building_id` or
  `building_memberships.status_changed_by_user_id`) are closed with no change: nothing deletes buildings or
  users (they are deactivated; the FKs are RESTRICT), so there is no ticket to move them to.
- **Alternatives rejected:** adding the relationships and indexes now (app and migration changes for a
  delete path nothing has); parking them on an unrelated ticket.
- **Tradeoffs and accepted limitations:** whichever ticket first deletes a building or a user must revisit
  both. The PR and Frame notes say this closure is listed in `docs/HUMAN_INBOX.md` "Decisions to audit"; at
  the source revision it is not (the PR doesn't touch the inbox). Reported to the implementer.
- **Basis:** autonomous; mutations M1–M3.
- **Source:** recorded (PR decision D3, Frame notes).

### D4. Scratch database per process; `condo_test` itself stays shared

- **Problem or constraint:** the three migration round-trip tests shared one fixed scratch database,
  `condo_migrations_test`, so two concurrent runs (parallel worktrees, reviewers) could collide.
- **Chosen:** `backend/tests/conftest.py::scratch_database_url` names it `condo_migrations_<pid>_test`,
  keeps the `_test` suffix that `assert_safe_test_database_url` requires (the guard still runs), recreates
  it, and drops it `WITH (FORCE)` afterwards (`backend/tests/conftest.py::_drop_database`).
- **Alternatives rejected:** a uuid suffix (the PID is enough per server and readable when one leaks); a
  per-run `condo_test` too (the carried item names only the scratch database, and the Makefile and CI set
  `TEST_DATABASE_URL`; out of scope).
- **Tradeoffs and accepted limitations:** two concurrent full suites still collide on `condo_test`; run them
  with distinct `TEST_DATABASE_URL=..._test` meanwhile. Two containers with equal PIDs on one server would
  share the scratch name (review round 1 L3, accepted).
- **Basis:** ticket "Carried from P1-03"; autonomous for the `condo_test` scope cut.
- **Source:** recorded (PR decision D4, Frame notes).

### D5. A violation in pending setup propagates; it doesn't count as the expected one (review round 1)

- **Problem or constraint:** SQLAlchemy's `begin_nested()` flushes the session's pending rows *before* it
  emits `SAVEPOINT`. So a bad row the test added with `db.add()` failed inside the helper's
  `except IntegrityError`, matched the constraint, and the helper reported success without ever running the
  operation under test (§6).
- **Chosen:** the helper calls `await db.flush()` itself, before the savepoint and outside the `except`. A
  pending invalid row raises a plain `IntegrityError` (the test errors), and the unrun coroutine is closed.
  The README says to create the invalid row inside the awaitable.
- **Alternatives rejected:** treating the pending row as the operation under test
  (`db.add(bad); assert_integrity_error(db, db.flush(), ...)`): it needs a savepoint opened without the
  session's pre-flush, that is a raw connection-level savepoint behind the session's back, and it blurs
  setup and operation. `if not started: raise` inside the `except` (the reviewer's first option): same
  effect, but the failed flush is still outside any savepoint, so the session is unusable afterwards either
  way; the explicit flush says what it does.
- **Tradeoffs and accepted limitations:** the `db.add(bad); flush()` style now errors instead of passing.
  Intended and documented in `backend/tests/README.md`.
- **Basis:** review finding (round 1, both reviewers).
- **Source:** recorded (PR decision D5, review round 1 H1).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Personas are `Member(user, membership)`; `multi` exposes `multi_in_a` / `multi_in_b` | separate `a_manager_user` / `a_manager_membership` attributes | half the attributes; `as_user(world.a_manager.user)` reads naturally in P2-01 | autonomous | PR table, Frame notes |
| `World.T0/T1/T2` fixed at 2025-01-01, 2025-07-01, 2025-07-15 UTC, as class constants | relative to `now()` | exact, reproducible assertions | autonomous | PR table |
| `make_building(features=...)` | a separate `make_feature` | one call sets a building up; nobody needs features alone | autonomous | PR table |
| Unique defaults from one module-level `itertools.count` (`backend/tests/factories.py::_seq`) | uuid strings | readable, unique per session; rows roll back anyway | autonomous | PR table |
| Default unit label `U<n>`, not `str(100 + n)` | the numeric default | `100 + n` collided with the world's "101", "102", "201" depending on test order | review round 1 L1 | PR review log |
| Leak check placed *after* the two world tests | before them (first draft) | a probe with a committing world passed the "before" version; the "after" one fails | experiment | PR table, leak probe |
| Table-walking tests import `app.models.registry` | rely on whatever models are already imported | a model module nothing else imports would be missed | review round 1 L2 | PR review log |
| `world` is function-scoped and built on `db` | a session- or module-scoped world | the ticket's interface; it rolls back with the test | ticket | ticket "Interfaces" |

**Framing changes:** criteria 1–4 sharpened (an exact persona table with statuses, roles and occupancies;
strict `T1 < T2`; a required constraint name; exact row counts per table and an empty-tables check).
Criteria 6–10 added: the helper can fail (6); factories use the occupancy helpers (7); the world supports the
occupancy window, including case 5 (8); the carried P1-02 ORM tests (9); the carried P1-03 scratch database
(10). Loosened: none.

**What an interviewer would ask:** why not use `pytest.raises(IntegrityError)` directly (§9 Must explain 2);
why the leak test depends on file order and whether that is fragile (§7); why a fitness test reads
SQLAlchemy internals (`local_remote_pairs`) and what happens on a SQLAlchemy upgrade (the non-vacuity test
`test_the_fitness_check_covers_membership_roles` would fail loudly).

## 3. How it is implemented

### Overview

- `backend/tests/factories.py`: five plain async factories. Each flushes (so the row has its id and server
  defaults) and never commits. `make_membership` and `make_occupancy` take the session from the object they
  are given (`async_object_session`), matching the ticket's signatures.
- `backend/tests/world.py`: `Member`, the frozen `World` dataclass with `T0/T1/T2`, and `build_world(db)`.
- `backend/tests/conftest.py`: the `world` fixture (on the existing per-test `db`), and
  `scratch_database_url` for migration tests.
- `backend/tests/helpers/db.py`: `assert_integrity_error`.
- Tests: `backend/tests/test_world.py` (23 tests) and `backend/tests/test_orm_relationships.py` (5).

### Walkthrough (variant C: one test run that uses the world)

Take `test_cross_building_occupancy_fails_and_the_session_keeps_working` in `backend/tests/test_world.py`.

1. **Trigger:** `make test` runs pytest. The session fixture `migrated_test_database` (P0-05) has already
   rebuilt `condo_test` and run the migrations once.
2. **Connection and outer transaction:** `backend/tests/conftest.py::db_connection` opens one connection and
   `BEGIN`s a transaction that is always rolled back at the end. The `db` fixture binds the app's own session
   factory to it with `join_transaction_mode="create_savepoint"`, so a `commit()` in code under test only
   releases a savepoint.
3. **World:** `backend/tests/conftest.py::world` awaits `backend/tests/world.py::build_world`. It creates the
   two buildings (with three feature rows each), the four units, the twelve users and memberships with their
   roles, and then eight occupancies through `make_occupancy`. `a_former`'s history is written first: 101
   from T0, ended at T1, then 102 from T1. Only then is 101 re-let to `a_resident1` from T2. Order matters:
   `start_occupancy` refuses a start inside the same membership's earlier occupancy, and the half-open window
   (`started_at <= T < ended_at`, ADR-0016) lets 102 start at exactly T1. Every helper call takes a
   `SELECT … FOR NO KEY UPDATE` lock on the membership row; inside one test's transaction this costs
   nothing. Measured here: `world built in 72 ms` (criterion 5 asks < 300 ms).
4. **The test body:** it makes an extra A unit "301" (flushed), then calls
   `assert_integrity_error(db, make_occupancy(world.a_manager.membership, world.b_101, ...), constraint=
   "fk_unit_occupancies_building_id_unit_id")`. The helper flushes (nothing pending), emits `SAVEPOINT`, and
   awaits the coroutine. `start_occupancy` inserts a row with `building_id = A` and `unit_id = B-101`; the
   composite FK `(building_id, unit_id) → units` (ADR-0005) rejects it. The `begin_nested()` context rolls
   back to the savepoint, the helper reads `constraint_name` from asyncpg's exception, finds it equal to the
   expected name, and returns the error.
5. **After:** the test checks that unit 301 is still there (the savepoint undid only the failed insert), that
   there are 5 units, and that a new valid occupancy still flushes.
6. **End:** `db` closes and `db_connection` rolls back the outer transaction, so the world disappears.
   `test_after_two_worlds_a_test_without_one_sees_every_table_empty` proves that.
7. **Where it fails and what you'd see:** a wrong constraint gives
   `Failed: expected an IntegrityError on 'X', got one on 'Y'`; no error gives
   `Failed: no IntegrityError raised (expected one on 'X')`; a bad pending setup row raises the raw
   `IntegrityError` in the test. A world that commits would make the second world test error on
   `uq_buildings_slug` (the PR's leak probe).
8. **Re-run:** safe at any time; everything rolls back. The migration tests' scratch database is recreated
   at fixture start, so one left behind by a crash is reset on the next run with the same PID.

### Data model changes

None. No tables, columns, constraints or migrations.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/tests/factories.py` | new: the five factories | +110 |
| `backend/tests/world.py` | new: `Member`, `World`, `build_world` | +134 |
| `backend/tests/helpers/db.py` | new: `assert_integrity_error` | +40 |
| `backend/tests/helpers/__init__.py` | new, empty | 0 |
| `backend/tests/conftest.py` | `world` and `scratch_database_url` fixtures, `_drop_database` | +38 |
| `backend/tests/test_world.py` | new: criteria 1–8 | +399 |
| `backend/tests/test_orm_relationships.py` | new: criterion 9 | +132 |
| `backend/tests/test_schema_buildings_units.py`, `test_schema_identity.py`, `test_schema_occupancy.py` | migration test takes `scratch_database_url` | +3/−8 each |
| `backend/tests/README.md` | the world, the 10 cases, factories, the helper | +86 |
| `CLAUDE.md` | pointer to `backend/tests/README.md` (review round 1 L4) | +1/−1 |
| `docs/tickets/P1-05-test-world-and-isolation-helpers.md`, `docs/tickets/README.md` | Frame notes; status `in progress` | +61/−4 |

**Key excerpts**

`backend/tests/helpers/db.py::assert_integrity_error`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/90a38bb3f36d0ae562a5826dad93372c8ac7a013/backend/tests/helpers/db.py#L11-L40))

```python
async def assert_integrity_error(
    db: AsyncSession, awaitable: Awaitable[object], *, constraint: str
) -> IntegrityError:
    # ... docstring
    started = False
    try:
        # begin_nested() flushes pending rows before the savepoint exists. Flush them here, outside
        # the `except`, so a violation in the caller's setup propagates instead of passing as the
        # expected one (review round 1). Add the invalid row inside `awaitable`.
        await db.flush()
        try:
            async with db.begin_nested():
                started = True
                await awaitable
        except IntegrityError as exc:
            # asyncpg's own exception, behind SQLAlchemy's DBAPI adapter, names the constraint.
            name = getattr(exc.orig.__cause__, "constraint_name", None) if exc.orig else None
            if name != constraint:
                pytest.fail(f"expected an IntegrityError on {constraint!r}, got one on {name!r}")
            return exc
    finally:
        if not started and inspect.iscoroutine(awaitable):
            awaitable.close()  # never awaited: don't leave a "never awaited" warning behind
    pytest.fail(f"no IntegrityError raised (expected one on {constraint!r})")
```

- Runs the awaitable inside a savepoint; on an `IntegrityError` the `async with` rolls back to the savepoint
  (undoing only what the awaitable did), then the name is compared exactly.
- The first `flush()` is D5; the required `constraint` is D1; the `finally` closes a coroutine that never
  ran so no "never awaited" warning leaks into another test.
- Remove the `flush()`: a pending bad row passes as the expected violation (round-1 H1; both regression
  tests fail, as the round-2 reviewer confirmed by mutation). Remove `begin_nested()`: the whole test
  transaction is aborted and every later query fails (mutation M7). Skip the name check: a violation of any
  constraint passes (M5).
- Note `pytest.fail` raises `Failed`, which is not an `IntegrityError`, so the inner `pytest.fail` escapes
  the `except` cleanly.

`backend/tests/world.py::build_world` (occupancy part)
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/90a38bb3f36d0ae562a5826dad93372c8ac7a013/backend/tests/world.py#L79-L111))

```python
async def build_world(db: AsyncSession) -> World:
    t0, t1, t2 = World.T0, World.T1, World.T2
    a = await make_building(db, slug="maple", name="Maple Court", features=FEATURES)
    b = await make_building(db, slug="birch", name="Birch House", features=FEATURES)
    a_101, a_102, a_201 = [await make_unit(db, a, label=label) for label in ("101", "102", "201")]
    b_101 = await make_unit(db, b, label="101")
    # ...
    a_pending = await _member(db, a, "a_pending", resident, MembershipStatus.PENDING)
    a_suspended = await _member(db, a, "a_suspended", resident, MembershipStatus.SUSPENDED)
    a_former = await _member(db, a, "a_former", resident)
    # ...
    multi = await make_user(db, email="multi@example.com", full_name="multi")
    multi_in_a = await make_membership(multi, a, roles=resident)
    multi_in_b = await make_membership(multi, b, roles=(Role.SECURITY,))
    no_membership = await make_user(db, email="no_membership@example.com", full_name="nobody")

    # a_former's history first: 101 until T1, then 102 from T1 (a transfer), then 101 is re-let.
    await make_occupancy(a_former.membership, a_101, started_at=t0, ended_at=t1)
    await make_occupancy(a_former.membership, a_102, started_at=t1)
    await make_occupancy(a_resident1.membership, a_101, started_at=t2)
    await make_occupancy(a_resident2.membership, a_102, relationship=OWNER, started_at=t0)
    await make_occupancy(a_council.membership, a_201, relationship=OWNER, started_at=t0)
    await make_occupancy(a_suspended.membership, a_201, relationship=HOUSEHOLD, started_at=t0)
    await make_occupancy(multi_in_a, a_201, relationship=HOUSEHOLD, started_at=t0)
    await make_occupancy(b_resident1.membership, b_101, started_at=t0)
```

- Builds the persona table from the Frame notes. Note that both buildings have a unit labelled "101": B-101
  is a different unit with a different id, which is what case 7 ("related ID from another building") needs.
- The gap between T1 and T2 means 101 is empty for two weeks, so the "former left before resident1 moved in"
  criterion is strict (frame note 2).
- Change `ended_at=t1` to `t2` and the persona and history tests fail (mutation M4). Write the 102 row before
  the 101 end and `start_occupancy` raises `IntegrityError` on `uq_unit_occupancies_current_membership`
  (one current row per membership).

`backend/tests/factories.py::make_occupancy`

```python
    db = _session_of(membership)
    occupancy = await start_occupancy(
        db,
        building_id=membership.building_id,
        membership_id=membership.id,
        unit_id=unit.id,
        relationship=relationship,
        at=started_at,
    )
    if ended_at is not None:
        ended = await end_occupancy(
            db, building_id=membership.building_id, membership_id=membership.id, at=ended_at
        )
        assert ended is occupancy
    return occupancy
```

- Goes through the app helpers (D2), so the world can only hold history the app itself could write.
- `building_id` comes from the membership, not the unit: a cross-building unit therefore reaches the
  database and trips the composite FK, which is exactly what the criterion-3 test needs.
- `assert ended is occupancy` relies on the session's identity map: `end_occupancy`'s `UPDATE … RETURNING`
  returns the same object that `start_occupancy` added.

`backend/tests/test_orm_relationships.py::_pk_child_relationships`

```python
def _pk_child_relationships(reg: registry) -> list[RelationshipProperty[Any]]:
    """One-to-many relationships whose child-side FK columns include a child primary-key column."""
    found = []
    for mapper in reg.mappers:
        for rel in mapper.relationships:
            if rel.direction is not RelationshipDirection.ONETOMANY:
                continue
            child_fk_columns = {remote for _local, remote in rel.local_remote_pairs}
            if child_fk_columns & set(rel.mapper.primary_key):
                found.append(rel)
    return found


def _missing_delete_orphan(reg: registry) -> list[str]:
    return [str(rel) for rel in _pk_child_relationships(reg) if not rel.cascade.delete_orphan]
```

- Walks every mapper and finds one-to-many relationships whose child FK is part of the child's primary key
  (today only `BuildingMembership.roles`: `membership_roles`' key includes `membership_id`).
- Why: without `delete-orphan`, removing a child from the collection makes the ORM set its FK, a primary-key
  column, to NULL, which crashed in P1-02 round 2 (module docstring).
- It is proven non-vacuous twice: it finds `BuildingMembership.roles`, and on a synthetic `ProbeBase` it
  flags exactly `Parent.children` (and not `owned` or `loose`). Drop `delete-orphan` from `roles` and it
  fails (M1).

`backend/tests/conftest.py::scratch_database_url`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/90a38bb3f36d0ae562a5826dad93372c8ac7a013/backend/tests/conftest.py#L111-L136))

```python
@pytest.fixture
def scratch_database_url() -> Iterator[str]:
    # ... docstring
    url = make_url(settings.test_database_url).set(database=f"condo_migrations_{os.getpid()}_test")
    scratch = url.render_as_string(hide_password=False)
    assert_safe_test_database_url(scratch, settings.database_url)
    asyncio.run(_recreate_test_schema(scratch))
    try:
        yield scratch
    finally:
        asyncio.run(_drop_database(scratch))
```

- One database per pytest process, so two runs on one server no longer share it (D4); the safety guard still
  runs on it.
- `_recreate_test_schema` is outside the `try`: if it fails after `CREATE DATABASE`, the database is left
  behind until the next run with the same PID (review round 2 L6, open).
- It is function-scoped, so each of the three migration tests recreates and drops it (rationale not
  recorded; the cost is small).

<details><summary>Deeper: the leak test (criterion 4)</summary>

`test_two_worlds_in_a_row_have_the_same_row_counts` runs twice (parametrized `[1]`, `[2]`) and asserts the
exact per-table counts in `EXPECTED_ROW_COUNTS` (2 buildings, 6 features, 4 units, 12 users,
12 memberships, 13 roles, 8 occupancies). Then `test_after_two_worlds_a_test_without_one_sees_every_table_empty`
asserts every table in `Base.metadata` holds zero rows. The order comes from pytest's file order; there is no
random-order plugin. The PR's probe built the world on its own committed session: the "after" test failed and
the second world test errored on `uq_buildings_slug` ("maple" already existed). A "before" version of the
empty check passed that probe, which is why it was moved after.

</details>

## 5. Edge cases and tests

All tests below are in `backend/tests/test_world.py` unless stated. I ran `make test` (port 55432,
`condo_explain_test`): **341 passed**; and `pytest -s tests/test_world.py -k fast`: `world built in 72 ms`.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A persona with the wrong status, role or unit | exact table of expectations per membership | `test_every_persona_has_its_status_roles_and_occupancies` |
| A persona accidentally a member of two buildings | each user's memberships listed exactly | `test_each_persona_is_one_user_with_memberships_only_where_stated` |
| Extra or missing feature rows | the set of `(building, feature, enabled)` is exact | `test_both_buildings_enable_exactly_packages_notices_and_maintenance` |
| `a_former`'s history overlaps `a_resident1`'s | T1 < T2 checked, transfer at T1 | `test_former_occupant_left_101_before_resident1_moved_in_and_transferred_to_102` |
| The world can't express "visible then, not now" | the app's `occupancy_window_clause` is evaluated at T0 + 1 day and at `now()` | `test_a_record_in_101_during_the_former_occupancy_is_visible_to_the_former_only`, `test_a_record_in_101_now_is_visible_to_resident1_only` |
| Helper passes when nothing fails | `pytest.fail("no IntegrityError…")` | `test_assert_integrity_error_fails_when_nothing_is_raised` |
| Helper passes on the wrong constraint | exact name compare; session still usable | `test_assert_integrity_error_fails_on_another_constraint` |
| Helper swallows other errors | only `IntegrityError` is caught | `test_assert_integrity_error_lets_other_errors_through` |
| A bad pending setup row passes as expected | pre-flush outside the `except` | `test_a_violation_in_pending_setup_is_not_taken_for_the_expected_one` |
| "coroutine was never awaited" warning | `awaitable.close()` | `test_assert_integrity_error_never_leaves_an_unawaited_coroutine` |
| Valid pending setup lost by the rollback | pre-flush puts it before the savepoint | `test_pending_valid_setup_survives_the_rolled_back_savepoint` |
| Factory bypasses ADR-0016 rules | goes through the helpers | `test_make_occupancy_refuses_a_second_current_occupancy`, `test_make_occupancy_refuses_a_start_inside_an_earlier_occupancy` |
| Default labels collide with the world | `U<n>` labels | `test_default_unit_labels_never_collide_with_the_worlds_units` |
| Data leaks between tests | outer transaction rolled back | `test_two_worlds_in_a_row_have_the_same_row_counts`, `test_after_two_worlds_a_test_without_one_sees_every_table_empty` |
| Missing `delete-orphan` on a PK-child relationship | fitness walk | `backend/tests/test_orm_relationships.py`: `test_one_to_many_relationships_into_a_childs_primary_key_cascade_delete_orphan`, `test_the_fitness_check_covers_membership_roles`, `test_the_fitness_check_flags_a_relationship_without_delete_orphan` |
| `passive_deletes` removed from `roles` | ORM would `SELECT membership_roles` first | `backend/tests/test_orm_relationships.py::test_deleting_a_membership_leaves_its_unloaded_roles_to_the_database_cascade` |
| `BuildingMembership.user` removed | flush order breaks | `backend/tests/test_orm_relationships.py::test_a_new_user_and_its_membership_flush_together_through_user_alone` |
| A `Task`/`Future` passed instead of a coroutine | could start during the pre-flush, outside the savepoint | **no test** (review round 2 L5, open) |
| Scratch setup fails after `CREATE DATABASE` | database left behind | **no test** (review round 2 L6, open) |

Acceptance criteria → tests:

1. Buildings, units, personas: `test_world_has_two_buildings_with_their_units` and the three persona/feature
   tests above.
2. Former/resident1 history: `test_former_occupant_left_101_before_resident1_moved_in_and_transferred_to_102`.
3. Cross-building insert, `db` usable after: `test_cross_building_occupancy_fails_and_the_session_keeps_working`.
4. No leaks: the two leak tests.
5. < 300 ms: `test_building_the_world_is_fast` prints it (72 ms here; 69–75 ms in the PR and reviews). Not asserted, as the ticket says.
6. Helper can fail: the three `test_assert_integrity_error_*` tests.
7. Factories use the occupancy helpers: the two `test_make_occupancy_refuses_*` tests,
   `test_make_occupancy_with_ended_at_records_a_past_occupancy`, `test_factories_fill_sensible_defaults`.
8. Visibility window: the two `test_a_record_in_101_*` tests.
9. ORM fitness and pins: the five tests in `backend/tests/test_orm_relationships.py`.
10. Per-process scratch database: the three `test_migration_*` tests now take `scratch_database_url`; the PR
    shows no `condo_migrations_<pid>_test` left after `make check`. No test asserts the drop itself.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Codex (`gpt-6-astra`, medium) | `b23e366` | MERGE | Medium: pending setup error taken as the expected violation | fixed in `e888ccc` (D5) |
| 1 | Claude reviewer + security pass | `b23e366` | BLOCK | High H1: same bug; L1 default labels collide; L2 table walks may miss unimported models; L3 PID collisions across containers; L4 stale CLAUDE.md pointer | H1 fixed `e888ccc`; L1, L2, L4 fixed `90a38bb`; L3 dismissed (accepted risk) |
| 2 (final) | Codex (`gpt-6-astra`, medium) | `90a38bb` | MERGE | none | — |
| 2 (final) | new Claude reviewer + security pass | `90a38bb` | MERGE | L5 a `Task`/`Future` could run outside the savepoint; L6 scratch DB left if setup fails | not fixed; follow-ups |

**H1 (round 1).** Inputs: `db.add(Unit(... label="101"))`, then
`assert_integrity_error(db, make_unit(db, a, label="777"), constraint="uq_units_building_id_tower_label")`.
Wrong outcome: `begin_nested()` flushed the pending duplicate before the savepoint existed; the error landed
in the helper's `except`, matched the name, and the helper returned success. The operation under test (a
valid unit) never ran, and the session was left in `PendingRollbackError`. Codex's proof
`test_pre_savepoint_error_is_not_success[awaitable_ran|session_survives]` failed 2/2. Fix: the pre-flush
(D5). Evidence: `test_a_violation_in_pending_setup_is_not_taken_for_the_expected_one` and
`test_assert_integrity_error_never_leaves_an_unawaited_coroutine` were red before and green after; the
neighbour `test_pending_valid_setup_survives_the_rolled_back_savepoint` was green both times. The round-2
reviewer removed the pre-flush and saw both regression tests fail.

**L1 (round 1).** The default label `str(100 + n)` gave "101", "102" or "201" for n = 1, 2, 101, so a test's
factory-made unit could collide with the world's units depending on test order.
`test_default_unit_labels_never_collide_with_the_worlds_units` failed with
`uq_units_building_id_tower_label`; with `U<n>` it passes.

**L2 (round 1).** Hardening only: all 7 tables were already loaded; the import makes it independent of import
order.

## 7. Not verified, accepted risks and follow-ups

Not verified:

- **No HTTP case is exercised.** The world provides personas for cases 1, 3, 4, 5, 6 and 7, but no endpoint
  exists yet; whether the personas actually catch the bugs they target is proven only when P2-03 and later
  tickets use them. Cases 2 and 8–10 have no persona (they are per-endpoint).
- **`a_pending` has no occupancy** (as the ticket asked). On a unit-addressed route its 404 could come from
  the occupancy filter instead of the status check, so it proves the status check only on routes that don't
  depend on occupancy. `a_suspended` (who lives in 201) covers the unit-addressed case. The README's "a 404
  for them proves the status check rather than a missing role or unit" is slightly broader than this.
- **The leak test depends on file order.** A random-order plugin, or `-k` selecting only the "after" test,
  would make it pass without having seen two worlds first.
- **The scratch drop** is shown by a manual `pg_database` query in the PR, not by a test.
- **mypy:** `make check` type-checks `app/` only; the new test modules were type-checked by hand in the PR.
- **The fitness test reads SQLAlchemy internals** (`local_remote_pairs`, `cascade`); a major upgrade could
  change them. The non-vacuity test would then fail loudly rather than pass silently.

Accepted risks and follow-ups (all listed in the PR's "Follow-ups and accepted risks"):

| Item | Tracked where |
|---|---|
| `condo_test` is one per server; concurrent full suites collide (D4) | PR #50 only; tracked only here |
| Round 2 L5: type the parameter as `Coroutine` or check `inspect.iscoroutine` | PR #50 only; tracked only here |
| Round 2 L6: move `_recreate_test_schema` inside the `try` | PR #50 only; tracked only here |
| Round 1 L3: PID-named scratch DB could collide across containers | PR #50 only; tracked only here |
| P1-02 L-A and L3 closed without change; revisit on the first building/user delete (D3) | PR #50 and the ticket's Frame notes; **not** in `docs/HUMAN_INBOX.md` at the source revision, though the PR says it is |
| Personas have `password_hash` NULL; `as_user` must set a password or create the session directly | PR #50 only; the P2-01 ticket doesn't mention it |
| Add `tests/` to the mypy gate | PR #50 only; tracked only here |

## 8. How to change this safely

- **Add a persona:** add the field to `backend/tests/world.py::World`, build it in `build_world`, add a row
  to the persona table in `backend/tests/README.md`, a line to the `expected` dict in
  `test_every_persona_has_its_status_roles_and_occupancies`, and update `EXPECTED_ROW_COUNTS` in
  `backend/tests/test_world.py`. The count tests and the persona test fail until all agree. Write any new
  occupancy after the rows it must not overlap, through `make_occupancy`, with a past instant.
- **Add a model:** register it in `backend/app/models/registry.py`; the leak test and the fitness test pick it up.
  A new one-to-many into a child's primary key needs `cascade="all, delete-orphan"`, or the fitness test fails.
- **Change `assert_integrity_error`:** keep the pre-flush outside the `except` and the exact name compare;
  the six helper tests in `backend/tests/test_world.py` cover both.
- **A new migration round-trip test:** take the `scratch_database_url` fixture; never hard-code a database name.

## 9. Must explain, then quiz

**1. Why does the world include a former occupant, a pending member and a multi-building user? Name the bug
each one catches.**

- `a_former` lived in A-101 from T0 to T1, and `a_resident1` lives there from T2. It catches the
  unit-turnover privacy bug (ADR-0010): a visibility filter that checks "has ever lived in the unit" (a join
  on occupancies without the time window) instead of "lived there when the record was created". With that
  bug the former tenant still sees packages delivered to 101 after leaving, and the new tenant sees the old
  tenant's history. `test_a_record_in_101_now_is_visible_to_resident1_only` shows the app's
  `backend/app/memberships/occupancy.py::occupancy_window_clause` gets this right with the world's data.
- `a_pending` holds the resident role but is not approved. It catches a guard that checks that a membership
  (or role) exists without checking `status = active`: a person who only applied would see building data.
  Case 6 expects 404. Because `a_pending` has the role, a 404 can't be blamed on a missing role.
- `multi` is a resident in A and security in B. It catches code that takes a user's role from the wrong
  membership, for example "has the security role in any building" or `user.memberships[0]`: `multi` would
  get staff access in building A. Case 3 in the README uses it that way.

**2. Why do we need a nested savepoint to assert an `IntegrityError` inside a transactional test?**

Each test runs inside one outer transaction that is rolled back at the end (`backend/tests/conftest.py::db_connection`).
In Postgres, a failed statement aborts the whole transaction: every later statement fails with "current
transaction is aborted" until a rollback. SQLAlchemy's session also refuses further work after a failed
flush (`PendingRollbackError`). Rolling back the outer transaction would throw away the world and the test's
setup, and plain `pytest.raises(IntegrityError)` leaves the transaction aborted. A savepoint
(`db.begin_nested()`) is a rollback point inside the transaction: rolling back to it undoes only the failed
insert, so the test continues with everything else intact. `test_cross_building_occupancy_fails_and_the_session_keeps_working`
proves it; removing the savepoint fails it (M7). The pre-flush (D5) exists because `begin_nested()` itself
flushes pending rows before the savepoint is created.

**3. Why "same building, other resident" tests in addition to cross-building tests?**

They test different layers. Cross-building isolation comes from the path-scoped tenant dependency and
`building_id` filters (ADR-0004) and composite FKs (ADR-0005). A query that filters only by
`ctx.building_id` passes every cross-building test and still shows a resident their neighbour's packages.
Record-level visibility (CLAUDE.md rule 3: own records, and unit-addressed records only during one's
occupancy) is a separate filter that only a same-building test exercises: `a_resident2` on `a_resident1`'s
record, and `a_former` on a record in 101 stamped after T1 (case 5, expected 404).

**Quiz**

1. In `assert_integrity_error`, why is `await db.flush()` placed outside the inner `try`, rather than just
   before `await awaitable` inside the savepoint?
2. `make_occupancy` takes `building_id` from the membership, not from the unit. How does that choice make
   the criterion-3 test possible?
3. Why does the world write `a_former`'s 101 end before starting `a_former`'s 102 row, and what would the
   database say if you swapped them?
4. What would break if we removed the `import app.models.registry` line from `backend/tests/test_world.py`?
5. How would you extend the world to support a "unit deactivated" case (a unit with `is_active = false`) so
   that a test can prove a resident can't create a record for it?

<details><summary>Answers</summary>

1. Inside the savepoint is too late: `begin_nested()` flushes pending rows *before* it emits `SAVEPOINT`, and
   that implicit flush happens inside the `try … except IntegrityError`. A bad setup row would then be caught
   and matched as the expected violation (round-1 H1). Flushing first, outside the `except`, makes a setup
   error propagate as a plain error; a valid pending row is written before the savepoint and survives the
   rollback (`test_pending_valid_setup_survives_the_rolled_back_savepoint`).
2. The occupancy row gets `building_id = A` (from `a_manager`'s membership) and `unit_id = B-101`. The composite
   FK `fk_unit_occupancies_building_id_unit_id` requires `(building_id, unit_id)` to exist in `units`; it
   doesn't, so the database raises the named violation the test expects. Taking `building_id` from the unit
   would make the membership side fail instead (a different constraint), or not test the unit FK at all.
3. A membership can have only one current occupancy (`uq_unit_occupancies_current_membership`), and
   `start_occupancy` refuses a start inside an earlier occupancy (`OccupancyTimeError`). Ending 101 at T1 first
   leaves no current row, and the half-open window lets 102 start at exactly T1. Swapped, starting 102 while
   101 is still current raises `IntegrityError` on `uq_unit_occupancies_current_membership`.
4. Today nothing visible: all 7 tables are already imported by other modules (review L2 says it is hardening).
   Later, a model module that no test or app code imports would be missing from `Base.metadata`, so
   `_row_counts` wouldn't count its table, and a leak into that table would go unnoticed by the leak tests.
5. Add a unit (say `a_301`) with `is_active=False` through `make_unit(db, a, label="301", is_active=False)`,
   add it to `World` and the README; decide whether anyone occupies it (an occupant makes "occupied but
   inactive" testable). Update `EXPECTED_ROW_COUNTS` (5 units) and the unit-list assertion in
   `test_world_has_two_buildings_with_their_units`. Note the occupancy helpers don't check `Unit.is_active`
   (their docstring says services do), so the rule itself belongs in the service that P4 adds; the world only
   supplies the unit.

</details>
