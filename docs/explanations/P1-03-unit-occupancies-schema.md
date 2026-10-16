# Explanation — P1-03 Unit occupancies schema

> **PR:** #45 · **Source revision:** `ba903b9` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (5) did not review `ba903b9` itself. Codex reviewed
> `cab5ecc`; the round-5 Claude reviewer reviewed `cab5ecc` and `e18b5a7` (the fix for Codex's only finding).
> `ba903b9` came after both. I checked `git diff e18b5a7 ba903b9`: it touches only
> `backend/tests/test_occupancy_helpers.py` (the function-attributes test also pins `prosecdef` and
> `proconfig`), `docs/HUMAN_INBOX.md` and `docs/adr/0016-occupancy-windows-and-writes.md`. No production code
> changed after the last review.
> **Merge commit:** not known when written; after the merge, `gh pr view 45 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. James did make one design decision in session (D5). This describes the PR's changes at the
> source revision. Commits after it (bookkeeping) and the squash merge are not described here, and a rebase
> after it gives the same changes new SHAs. The branch is rebased onto `origin/main` (`caf22ca`).
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: full. Tier: 1. Walkthrough variant: C (process: `alembic upgrade`, then a helper call inside a
> caller's transaction, then a read query that uses the window filter).

**What I ran** (2026-10-15, this worktree at `ba903b9`, compose db on port 55432):
`make test DB_PORT=55432` gave **205 passed** (69 of them in `backend/tests/test_occupancy_helpers.py`, 21 in
`backend/tests/test_schema_occupancy.py`). I also compiled the window filter and the lock statement to
Postgres SQL. A small script ran a real `transfer_occupancy` against `condo_test` with a cursor listener
(rolled back) to capture the SQL in §3. I ran no mutations. Every mutation result below is quoted from the
PR.

## 1. What was built and why

Residents are now linked to units through dated rows in `unit_occupancies` (relationship `owner`, `tenant`
or `household`). Rows are ended, never deleted, so history is kept
([ADR-0010](../adr/0010-unit-occupancy-relationship.md)). Composite foreign keys keep a row's unit and
membership in the row's own building ([ADR-0005](../adr/0005-tenant-integrity-in-the-database.md)). The
helpers in `backend/app/memberships/occupancy.py` start, end and transfer occupancies. They flush but never
commit. They also lock the membership row, so two writers for one person run one after the other.

The piece that matters most is `occupancy_window_clause`. It is the filter P5-01 will use so a new tenant
never sees the previous tenant's packages. Its rules: windows are half-open (`started_at <= T < ended_at`),
and both sides use the database's clock. After four review rounds found query shapes that made the
filter always true, James decided to move the test into a Postgres function, `public.occupancy_window`
([ADR-0016](../adr/0016-occupancy-windows-and-writes.md)).

## 2. Decisions

Terms used below. An **occupancy window** is the time interval in which a membership occupied a unit. A
**half-open** interval includes its start but not its end. **READ COMMITTED** is Postgres's default
isolation level: each statement sees the data committed before that statement started. A **row lock**
(`SELECT … FOR [NO KEY] UPDATE`) makes another transaction that wants a conflicting lock on the same row
wait until the holder commits or rolls back. A **partial index** indexes only the rows matching its
`WHERE`.

### D1. Windows are half-open; a transfer ends and starts at the same instant

- **Problem or constraint:** ADR-0010 says a resident sees a unit's record only if it was "created during"
  their occupancy. It doesn't say what happens at the edges. In a transfer, one instant is both the end of
  the old window and the start of the new one.
- **Chosen:** an occupancy covers `started_at <= T < ended_at`, or from `started_at` onwards while
  `ended_at` is NULL. `transfer_occupancy` ends the old row and starts the new one with the same `at`. A
  record stamped exactly at that instant belongs to the new window only.
- **Alternatives rejected:** closed windows (`T <= ended_at`): a record at the transfer instant would be
  visible to both the former and the new occupant.
- **Tradeoffs and accepted limitations:** a zero-length occupancy (`ended_at = started_at`) is allowed and
  covers no instant (PR D1).
- **Basis:** autonomous; lasting, so ADR-0016.
- **Source:** recorded (ticket Frame notes, PR D1, ADR-0016). Evidence:
  `backend/tests/test_occupancy_helpers.py::test_window_clause_against_literal_records` pins both edges. The
  PR reports that the `>=` mutation fails it.

### D2. One clock: the database's `now()`; future times refused

- **Problem or constraint:** records (packages, later) are stamped by Postgres `now()`, and the window is
  compared against those stamps. A transfer's end and start must be the same instant.
- **Chosen:** `at=None` means `SELECT now()`. That is the start time of the current transaction, so every
  call in one transaction gets the same value. An explicit `at` must be timezone-aware (`ValueError`
  otherwise) and not in the future (`OccupancyTimeError`). A past `at` is allowed. The docstring and
  ADR-0016 say it is for seeds, tests and backfills only and must never come from a client
  (`backend/app/memberships/occupancy.py::_prepare`).
- **Alternatives rejected:**
  - `datetime.now(UTC)` in Python: two clocks that drift.
  - Allowing a future `at`: `current_occupants` would list that row before its window opens (review
    round 1, L2).
  - A code guard against a past `at`: seeds, tests and backfills need one.
- **Tradeoffs and accepted limitations:** a backdated start can still show a newcomer the previous
  occupant's records if a caller ever passes a client-supplied value (round 1, L1). Only documentation
  guards against this; a P4-06 follow-up covers it (§7).
- **Basis:** autonomous; ADR-0016.
- **Source:** recorded (Frame notes, PR D2, ADR-0016).

### D3. Writes for one membership serialize on a `FOR NO KEY UPDATE` lock of the membership row

- **Problem or constraint:** two writers can act on one person at the same time, for example a staff
  member's transfer and a move-out. The plan relied on a conditional `UPDATE … WHERE ended_at IS NULL` plus
  the unique index. While writing criterion 11's test, the agent found a problem: a move-out racing a
  transfer runs its `UPDATE` with a snapshot taken before the transfer committed, so it never sees the row
  the transfer inserted. The person is silently left with a current occupancy.
- **Chosen:** each write helper first runs `SELECT building_memberships.id … FOR NO KEY UPDATE`, scoped by
  building. A second writer waits there. Under READ COMMITTED, its next statements take a fresh snapshot and
  see what the first writer committed.
- **Alternatives rejected:**
  - No lock: the move-out bug above.
  - Plain `FOR UPDATE`: it also blocks foreign-key checks from other tables that reference the membership,
    so for example a `membership_roles` insert would wait (PR D3; review round 2 found this mutation
    uncaught, and a test was added).
- **Tradeoffs and accepted limitations:**
  - A writer whose transaction began before the other committed gets an older `now()`. It can then get
    `OccupancyTimeError`, and the caller retries (ADR-0016).
  - The lock is held until the transaction ends. Services that also lock the building row (P4-06) must lock
    the building first, then the membership.
- **Basis:** autonomous; ADR-0016. This changed criterion 11 during implementation: "one commits, the other
  gets `IntegrityError`" became "both apply in order" (Frame notes; not a loosening).
- **Source:** recorded (Frame notes "Changed during implementation", PR D3, ADR-0016).

### D4. No overlapping history per person, enforced in Python

- **Problem or constraint:** the partial unique index allows only one *current* row per membership. But a
  backdated start could overlap an ended row, and the person would then see two units' records for the
  same period.
- **Chosen:** `start_occupancy` refuses an `at` earlier than any of the membership's `ended_at`.
  `end_occupancy` refuses an `at` earlier than the current row's `started_at`. Both raise
  `OccupancyTimeError`.
- **Alternatives rejected:** an exclusion constraint,
  `EXCLUDE USING gist (membership_id WITH =, tstzrange(started_at, ended_at) WITH &&)`. It needs the
  `btree_gist` extension, which is new database infrastructure that CLAUDE.md rule 13 reserves for its own
  ADR.
- **Tradeoffs and accepted limitations:** raw SQL (seeds, manual fixes) can still write overlapping rows.
  ADR-0016 says to revisit this when a second feature needs `btree_gist` anyway.
- **Basis:** autonomous; ADR-0016.
- **Source:** recorded (Frame notes, PR D4, ADR-0016).

### D5. The window test is a database function, `public.occupancy_window(membership, unit, at)` (James's decision)

- **Problem or constraint:** `occupancy_window_clause(membership_id, record_unit_col, record_time_col)` must
  be true exactly when the membership occupied the record's unit at the record's time, **whatever the
  caller's query looks like**. Every version built in Python as an `EXISTS (SELECT … FROM
  unit_occupancies …)` subquery had some query shape in which a name from the caller's query resolved to
  the subquery's own table. The membership condition then compared a column with itself, which is always
  true, so a new occupant saw the former occupant's records (§6 has the chain).
- **Chosen** (James, in session, after round 4: the inbox's option B):
  - A hand-written function in the migration, `public.occupancy_window(uuid, uuid, timestamptz) RETURNS
    boolean`, declared `LANGUAGE sql STABLE PARALLEL SAFE`.
  - It has a SQL-standard body (`RETURN EXISTS (…)`). Postgres parses that kind of body and binds it to
    `public.unit_occupancies` when the function is created.
  - It is not `STRICT`, so a NULL argument gives false rather than NULL.
  - `occupancy_window_clause` returns `func.public.occupancy_window(...)`. The call is schema-qualified
    after round 5.
  - The caller's three expressions are evaluated in the caller's scope and passed in as values. No name in
    the caller's query can reach inside the body.
- **Alternatives rejected** (PR D5, ADR-0016):
  - Extend the round-3 guard (refuse table-less columns and `text()`, compare names case-insensitively).
    Both round-4 reviewers prototyped this. It would be a fourth blacklist after three that each missed a
    shape, and it can't see an outer CTE.
  - An anonymous SQLAlchemy alias: it renders as `unit_occupancies_1` and doesn't avoid explicit names that
    collide with it. A test failed.
  - A random alias name per call: it churns SQLAlchemy's statement cache, and a collision is only
    improbable, not impossible.
  - A literal `membership_id` only (inbox option C): it doesn't protect the record columns.
- **Tradeoffs and accepted limitations:**
  - `alembic check` doesn't compare functions. Tests pin the function's attributes, and the round-trip test
    checks that it is created and dropped. Changing the function needs a new migration
    (`CREATE OR REPLACE`).
  - The body is bound to the table. Dropping the table, or dropping or retyping `membership_id`, `unit_id`,
    `started_at` or `ended_at`, needs the function dropped and recreated in the same migration.
  - A SQL function whose body has a subquery isn't inlined, so the test runs once per record. Each run is an
    index lookup on `(membership_id, unit_id, started_at)`, which is fine at pilot scale.
  - The ticket said "returns an `exists()` clause"; the clause now returns a boolean SQL expression. P5-01's
    call is unchanged.
  - Residual (round 5, L2): a record column of type `timestamp` (without time zone) would be cast to
    `timestamptz` in the session's time zone.
- **Basis:** review findings in rounds 1–4, then James's decision (recorded in the inbox's Resolved B-2 row
  and in ADR-0016's Deciders line).
- **Source:** recorded (Frame notes "Changed in review", PR D5, ADR-0016, `docs/HUMAN_INBOX.md` B-2).

Smaller decisions, one row each:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `end_occupancy` and `transfer_occupancy` take `building_id` too (keyword) | The ticket's original signatures | Every helper statement is scoped to one building (CLAUDE.md rule 1). A membership id from another building is a no-op | Autonomous (sharpened in the frame) | Frame notes, PR |
| Helpers flush, never commit | Commit inside | CLAUDE.md rule 5: only a service's use-case commits, once, so a transfer is atomic in the caller's transaction | Existing rule | Frame notes, ADR-0016 |
| `_prepare` flushes before its checks | No flush | The session doesn't autoflush, so the overlap check must still see the caller's pending rows | Review round 2 (an uncaught mutation) | PR table |
| `OccupancyTimeError(ValueError)` in `backend/app/memberships/occupancy.py` | A domain error in P1-04's errors module | That module arrives with P1-04 (lane B, not merged); P4-06 maps the error | Default, reversible | Frame notes |
| `transfer_occupancy` with no current occupancy just starts one; a transfer to the same unit ends and restarts (a relationship change) | Raise | The ticket says "end + start", and end is a no-op without a current row | Ticket | PR table |
| Helpers ignore membership status, `Unit.is_active`, roles and audit; `current_occupants` returns any status | Check here | Services do this (P4-02, P4-05, P4-06); audit (P2-04) doesn't exist yet. ADR-0010's "end also deactivates the membership" belongs to P4-06 | Ticket scope | Frame notes |
| No `building_id` argument on the window clause | Add one | A unit id belongs to one building, and the composite FKs keep an occupancy's unit and membership in it | ADR-0005 | Frame notes |
| All three FKs `ON DELETE RESTRICT`, composite ones `ON UPDATE NO ACTION` | CASCADE | Occupancies are history; an occupied unit or membership can't move building | Existing pattern (P1-01/P1-02) | Frame notes |
| ORM `unit`/`membership` relationships (`lazy="raise"`, `overlaps`) through `orm.relationship` | No relationships | Without them a flush orders inserts by class name and inserts the occupancy first. The bare name `relationship` is the column in this class body | Existing pattern (P1-02) | PR table, model comment |
| Extra index `(membership_id, unit_id, started_at)` | Only the ticket's `(building_id, unit_id, ended_at)` | The window function filters by membership and unit; the index also serves the membership FK's RESTRICT check | Autonomous | Frame notes |
| `current_occupants` orders by `(started_at, membership_id)` | Unordered | Criterion 5 asks for start order; Inferred: `membership_id` breaks ties so the order is stable | Ticket | Criterion 5; tiebreak rationale not recorded |
| FK names written by hand (`fk_unit_occupancies_building_id_unit_id`, …) | Convention names | The generated names exceed Postgres's 63-character limit | Existing pattern (P1-02) | PR table |

**Framing changes:** criteria 1, 3, 4, 5, 6 and 7 were sharpened; 8–12 were added (see the ticket). During
implementation criterion 11 changed from "one gets `IntegrityError`" to "both apply in order, plus a move-out
race" (D3). In review, criterion 7 gained the query shapes from rounds 2–4. Nothing was loosened (Frame notes).

**What an interviewer would ask:** "Why not an exclusion constraint?" (D4: `btree_gist` is new
infrastructure, and the cost is that raw SQL can overlap). "Why a database function instead of a subquery?"
(D5: name resolution; arguments become values). "Why `NO KEY UPDATE` instead of `FOR UPDATE`?" (D3: FK checks
take `KEY SHARE`, which conflicts with `FOR UPDATE` but not with `NO KEY UPDATE`). "What happens at
exactly the transfer instant?" (D1).

## 3. How it is implemented

### Overview

- **Schema** (migration `8887ac143e98`): the table `unit_occupancies`, its constraints and three indexes,
  and the function `public.occupancy_window`.
- **Model** `backend/app/memberships/models.py::UnitOccupancy` mirrors the table (so `alembic check` is
  clean), and its ORM relationships make flushes insert the unit and membership first.
- **Write helpers** `start_occupancy`, `end_occupancy` and `transfer_occupancy` all go through `_prepare`
  (resolve `at`, flush, lock), then run one guarded statement each.
- **Read helpers:** `current_occupants` (a unit's current members) and `occupancy_window_clause` (the filter
  later `visible_*` helpers use).
- **No callers yet** besides tests. P4-02, P4-05 and P4-06 will call the write helpers from services, and
  P5-01 will call the window clause.

### Walkthrough (variant C: a transfer, then a read through the window)

1. **Trigger: `alembic upgrade head`** runs `8887ac143e98`'s `upgrade()`. It creates the table, then the
   indexes, then the function. The function must come last because its body is bound to the table at
   creation. `downgrade()` drops the function first for the same reason.
2. **A caller transfers M from 101 to 102.** Today the only callers are tests; P4-06's service will be
   one. The caller calls
   `transfer_occupancy(db, building_id=A, membership_id=M, new_unit_id=u102, relationship=OWNER)`. This is
   the SQL it sends, captured from a real run (trimmed):

   ```sql
   SELECT now();                                          -- transfer's _prepare: at = transaction start
   SELECT building_memberships.id FROM building_memberships
    WHERE id = $1 AND building_id = $2 FOR NO KEY UPDATE; -- the lock; a concurrent writer waits here
   SELECT now(); SELECT … FOR NO KEY UPDATE;              -- end_occupancy's _prepare (same now, lock already held)
   UPDATE unit_occupancies SET ended_at=$1, updated_at=now()
    WHERE building_id=$2 AND membership_id=$3 AND ended_at IS NULL AND started_at <= $4
    RETURNING …;                                          -- end the current row at `at`
   SELECT now(); SELECT … FOR NO KEY UPDATE;              -- start_occupancy's _prepare
   SELECT unit_occupancies.id FROM unit_occupancies
    WHERE building_id=$1 AND membership_id=$2 AND ended_at > $3 LIMIT 1;  -- overlap check (D4)
   INSERT INTO unit_occupancies (building_id, unit_id, membership_id, relationship, started_at, ended_at, id)
    VALUES (…, 'owner', $5, NULL, $7) RETURNING created_at, updated_at;
   ```

   Because the inner helpers each run `_prepare` again, a transfer sends `now()` and the lock three times.
   That is harmless: within one transaction `now()` returns the same value, and the lock is already held.
   Inferred: it keeps each helper safe to call on its own.
3. **The caller commits or rolls back.** Nothing is visible to other transactions until the caller's
   single `commit()`. On any exception the caller rolls back, and neither the end nor the start persists
   (criterion 6).
4. **A read uses the window.** P5-01 will write something like
   `select(Package).where(Package.building_id == ctx.building_id, occupancy_window_clause(ctx.membership_id,
   Package.unit_id, Package.received_at))`. Compiled against a stand-in `packages` table, it is:

   ```sql
   SELECT packages.id FROM packages
   WHERE packages.building_id = $1::UUID
     AND public.occupancy_window($2::UUID, packages.unit_id, packages.received_at)
   ```

   For each candidate row, Postgres evaluates the function with that row's `unit_id` and `received_at` as
   values. The function's body then looks up `public.unit_occupancies` through the
   `(membership_id, unit_id, started_at)` index.
5. **Where it fails and what you see:**
   - `IntegrityError` naming `uq_unit_occupancies_current_membership`: a second current row for M.
   - `IntegrityError` naming `fk_unit_occupancies_building_id_unit_id` or
     `fk_unit_occupancies_building_id_membership_id`: the unit or membership is in another building.
   - `IntegrityError` naming `ck_unit_occupancies_ended_after_started` or
     `ck_unit_occupancies_relationship`: a raw write with bad times or a bad relationship value.
   - `OccupancyTimeError` (a `ValueError`): `at` is in the future, overlaps history, or comes before the
     current start.
   - `ValueError("at must be timezone-aware")`: a naive datetime was passed.
   - A long wait in `_prepare`: another transaction is writing occupancies for the same membership.
6. **Recover:** the caller rolls back the transaction and may retry. Inferred: an `OccupancyTimeError` caused by a
   stale `now()` (D3) succeeds on retry in a new transaction, which gets a fresh `now()`. To undo the schema, run
   `alembic downgrade 2b2e5bcaf6b4`. It drops the function, then the table, and with it every occupancy
   row.

### Data model changes

`unit_occupancies` (new):

| Column / constraint | What it is | Why it exists (the bug it prevents) |
|---|---|---|
| `id` uuid7 PK, `created_at`, `updated_at` | Standard mixins | Convention |
| `building_id` FK → `buildings` RESTRICT | Tenant column | Every tenant-owned table has one (ADR-0005) |
| `(building_id, unit_id)` → `units(building_id, id)` RESTRICT | Composite FK | A building-A occupancy of a building-B unit is impossible; an occupied unit can't be deleted or moved to another building |
| `(building_id, membership_id)` → `building_memberships(building_id, id)` RESTRICT | Composite FK | The same for the membership; history can't be erased by deleting a member |
| `relationship` + `ck_unit_occupancies_relationship` | `owner`/`tenant`/`household`, stored as text with a CHECK | A raw write can't store an unknown value (the migration removed autogenerate's duplicate CHECK) |
| `started_at timestamptz NOT NULL DEFAULT now()` | Window start | Timestamps, not dates, so the window is exact (ADR-0010) |
| `ended_at timestamptz NULL` | Window end; NULL means current | History is ended, not deleted |
| `ck_unit_occupancies_ended_after_started` (`ended_at IS NULL OR ended_at >= started_at`) | Order check | A row can't end before it starts; equal times are allowed (zero length) |
| `uq_unit_occupancies_current_membership` UNIQUE `(membership_id) WHERE ended_at IS NULL` | Partial unique index | One current unit per person, while any number of ended rows are allowed |
| `ix_unit_occupancies_building_id_unit_id_ended_at` | Index | `current_occupants` |
| `ix_unit_occupancies_membership_id_unit_id_started_at` | Index | The window function's lookup, and the membership FK's RESTRICT check |

Function `public.occupancy_window(uuid, uuid, timestamptz) RETURNS boolean`: see D5 and §4.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/memberships/enums.py` | `OccupancyRelationship` | +8 |
| `backend/app/memberships/models.py` | `UnitOccupancy` model, constraints, indexes, relationships | +77 / −2 |
| `backend/app/memberships/occupancy.py` | New: helpers, `_prepare`, window clause, `OccupancyTimeError` | +189 |
| `backend/migrations/versions/8887ac143e98_unit_occupancies_p1_03.py` | New migration: table, indexes, function | +151 |
| `backend/tests/test_occupancy_helpers.py` | New: helpers, window, concurrency and review-round tests | +1198 |
| `backend/tests/test_schema_occupancy.py` | New: constraints, RESTRICT, flush order, migration round-trip | +416 |
| `docs/adr/0016-occupancy-windows-and-writes.md` | New ADR | +85 |
| `docs/ARCHITECTURE.md`, `docs/adr/README.md` | Link ADR-0016 | +4, +1 |
| `docs/tickets/P1-03-unit-occupancies-schema.md` | Frame notes, sharpened criteria, review changes | +107 / −16 |
| `docs/HUMAN_INBOX.md`, `docs/tickets/README.md` | B-2 moved to Resolved; status `in progress` | +1/−1 each |

**Key excerpts.**

`backend/migrations/versions/8887ac143e98_unit_occupancies_p1_03.py::CREATE FUNCTION`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/ba903b9233059fc333653e391b8fcdbe4683a57f/backend/migrations/versions/8887ac143e98_unit_occupancies_p1_03.py#L117-L135))

```python
    op.execute(
        """
        CREATE FUNCTION public.occupancy_window(
            p_membership_id uuid, p_unit_id uuid, p_at timestamptz
        )
        RETURNS boolean
        LANGUAGE sql
        STABLE
        PARALLEL SAFE
        RETURN EXISTS (
            SELECT 1
            FROM public.unit_occupancies AS o
            WHERE o.membership_id = p_membership_id
              AND o.unit_id = p_unit_id
              AND o.started_at <= p_at
              AND (o.ended_at IS NULL OR o.ended_at > p_at)
        )
        """
    )
```

- What it does: true if some occupancy of M for this unit has `started_at <= at` and either no end or an end
  after `at` (D1's half-open window).
- Why this way: D5. `RETURN EXISTS (…)` without quotes is the SQL-standard body form, which is parsed and
  bound when the function is created. A quoted `AS $$ … $$` body would instead be resolved through the
  search path each time it runs. The PR reports that this "late-bound string body" mutation fails 2 tests.
- What breaks without key parts: change `>` to `>=` and a record at the transfer instant becomes visible to
  the former occupant as well (PR mutation: 3 failures). Add `STRICT` and a NULL argument returns NULL
  instead of false (1 failure).

`backend/app/memberships/occupancy.py::occupancy_window_clause`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/ba903b9233059fc333653e391b8fcdbe4683a57f/backend/app/memberships/occupancy.py#L168-L189))

```python
def occupancy_window_clause(
    membership_id: UUID | SQLColumnExpression[UUID],
    record_unit_col: SQLColumnExpression[UUID],
    record_time_col: SQLColumnExpression[datetime],
) -> ColumnElement[bool]:
    # ... docstring
    # Schema-qualified: an unqualified call is resolved through the search path, where an earlier
    # schema's function of the same signature would win (review round 5).
    return func.public.occupancy_window(
        membership_id, record_unit_col, record_time_col, type_=Boolean
    )
```

- What it does: wraps the function call as a SQLAlchemy boolean expression, so P5-01 can put it in a
  `.where()`.
- Why `func.public.…`: review round 5, Codex M1. With `search_path = shadow, public`, a
  `shadow.occupancy_window` returning `true` would win the lookup.
- What breaks without the `public.`: `test_window_clause_ignores_look_alikes_earlier_on_the_search_path[function]`
  fails (PR: "Unqualifying the call fails it").

`backend/app/memberships/occupancy.py::_prepare`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/ba903b9233059fc333653e391b8fcdbe4683a57f/backend/app/memberships/occupancy.py#L32-L57))

```python
async def _prepare(
    db: AsyncSession, building_id: UUID, membership_id: UUID, at: datetime | None
) -> datetime:
    """Resolve `at`, flush, and lock the membership for the rest of the transaction."""
    if at is not None and at.utcoffset() is None:
        raise ValueError("at must be timezone-aware")
    now = (await db.execute(select(func.now()))).scalar_one()
    if at is None:
        at = now
    elif at > now:
        # A future start would be listed as current before its window opens.
        raise OccupancyTimeError("`at` is in the future")
    # The session doesn't autoflush: the checks below must also see the caller's pending rows.
    await db.flush()
    # ... comment on serialization
    await db.execute(
        select(BuildingMembership.id)
        .where(
            BuildingMembership.id == membership_id,
            BuildingMembership.building_id == building_id,
        )
        .with_for_update(key_share=True)
    )
    return at
```

- What it does: validates and resolves `at` on the database clock (D2), flushes pending ORM rows, then takes
  the row lock (D3). `with_for_update(key_share=True)` renders as `FOR NO KEY UPDATE` (I compiled it).
- Why the order: the naive and future checks raise before any write. The flush happens before the lock and
  the checks, so the overlap query sees rows the caller added but hadn't flushed.
- What breaks without each part:
  - Without the lock, both race tests fail (PR mutation).
  - With `key_share=False` (plain `FOR UPDATE`), `test_the_membership_lock_leaves_fk_checks_on_the_membership_unblocked`
    hits its 2-second `lock_timeout`.
  - Without the flush, `test_start_occupancy_sees_the_callers_unflushed_rows` fails.
  - If the membership isn't in `building_id`, the lock selects nothing and no error is raised; the write
    that follows fails on the composite FK instead.

`backend/app/memberships/occupancy.py::end_occupancy` and `transfer_occupancy`

```python
    at = await _prepare(db, building_id, membership_id, at)
    current = (
        UnitOccupancy.building_id == building_id,
        UnitOccupancy.membership_id == membership_id,
        UnitOccupancy.ended_at.is_(None),
    )
    ended = await db.scalar(
        update(UnitOccupancy)
        .where(*current, UnitOccupancy.started_at <= at)
        .values(ended_at=at)
        .returning(UnitOccupancy)
    )
    if ended is None and await db.scalar(select(exists().where(*current))):
        raise OccupancyTimeError("the current occupancy starts after `at`")
    return ended
# ...
async def transfer_occupancy(...) -> UnitOccupancy:
    at = await _prepare(db, building_id, membership_id, at)
    await end_occupancy(db, building_id=building_id, membership_id=membership_id, at=at)
    return await start_occupancy(
        db, building_id=building_id, membership_id=membership_id,
        unit_id=new_unit_id, relationship=relationship, at=at,
    )
```

(`transfer_occupancy`'s call is shown on fewer lines than in the file.)

- What it does: `end_occupancy` is a conditional `UPDATE … RETURNING`. Zero rows means one of two things:
  there is no current row (a no-op that returns `None`) or the current row started after `at` (an error).
  The follow-up `EXISTS` tells the two apart. `transfer_occupancy` resolves `at` once and passes it to both
  steps, so the old window's end equals the new window's start.
- Why: D1 (one instant), D4 (time order), and "never commit" (criterion 6). Atomicity comes from the
  caller's transaction.
- What breaks: commit between the end and the start, and the two transfer-failure tests plus
  `test_helpers_never_commit` fail (PR mutation). Drop `started_at <= at`, and both
  `test_end_before_the_current_occupancy_started_is_refused` and the transfer variant fail (PR mutation).

`backend/app/memberships/models.py::uq_unit_occupancies_current_membership`

```python
        CheckConstraint("ended_at IS NULL OR ended_at >= started_at", name="ended_after_started"),
        # One current unit per membership. A plain unique constraint can't say "among current rows":
        # it would also forbid a second, ended row. Several current occupants per unit are fine.
        Index(
            "uq_unit_occupancies_current_membership",
            "membership_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
        ),
```

- What it does: the database guarantee behind "one current unit per resident" (criterion 1). It holds even
  for raw SQL and for two transactions that bypass the helpers' lock.
- What breaks without the `WHERE`: a person's second-ever occupancy is rejected. The PR's "current index not
  partial" mutation gave 9 failures and 13 errors, starting with
  `test_new_occupancy_after_the_previous_ended_is_accepted_and_history_is_kept`.

`backend/tests/test_occupancy_helpers.py::_race` (the proof for criterion 11)

```python
    async with engine.connect() as c1, engine.connect() as c2:
        s1, s2 = AsyncSessionLocal(bind=c1), AsyncSessionLocal(bind=c2)
        pid = (await c2.execute(select(func.pg_backend_pid()))).scalar_one()
        await c2.commit()  # the pid query's transaction; `second` starts a fresh one

        await first(s1)

        async def run_second() -> None:
            await second(s2)
            await s2.commit()

        task = asyncio.create_task(run_second())
        try:
            await _wait_until_blocked_on_a_lock(engine, pid)
        finally:
            await s1.commit()
            await task
```

- What it does: runs the first writer without committing, starts the second on another connection, and
  checks in `pg_stat_activity` that the second is really waiting on a lock (`wait_event_type = 'Lock'`).
  Only then does it commit the first. This proves serialization rather than lucky timing.
  `test_move_out_racing_a_transfer_ends_the_new_occupancy` uses it to show the D3 bug is gone: the
  move-out ends the row the transfer inserted, so nothing is current.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Record stamped exactly at the transfer instant | Belongs to the new occupant only | `test_window_clause_against_literal_records` (`former`/`current` at T1) |
| Record at `started_at` | Inside | same (`former`, 101, T0) |
| New occupant asks about a record from before their move-in | False | same (`current`, 101, T1 − 1s) |
| Another membership's occupancy, or M's other unit | False | same (last two cases) |
| NULL unit, time or membership | False (not NULL) | `test_window_clause_fails_closed_on_nulls` |
| Window used against a real table of records | Exactly the in-window rows | `test_window_clause_correlates_with_an_outer_table_of_records` |
| Caller's query also reads `unit_occupancies`, passes its columns, aliases it (9 names) | Arguments are values | `test_window_clause_works_when_the_outer_query_joins_unit_occupancies`, `test_window_clause_uses_the_outer_queries_membership_column`, `test_window_clause_with_every_argument_from_an_outer_unit_occupancies_query`, `test_window_clause_with_an_outer_time_column_from_unit_occupancies` |
| Unqualified args (`column`, `literal_column`, textual FROM), upper-case alias, outer CTE, temp table | Body is bound to `public.unit_occupancies` | `test_window_clause_with_unqualified_column_arguments`, `test_window_clause_with_a_record_alias_of_any_name`, `test_window_clause_ignores_an_outer_cte_named_unit_occupancies`, `test_window_clause_ignores_a_temporary_table_named_unit_occupancies` |
| Look-alike function or table earlier on the search path | Call and body are `public.`-qualified | `test_window_clause_ignores_look_alikes_earlier_on_the_search_path` |
| Function later made `STRICT`, `VOLATILE`, `SECURITY DEFINER`, string body | Attributes pinned | `test_window_function_is_stable_not_strict_and_bound_at_creation` |
| Future, naive, overlapping, or out-of-order `at` | `OccupancyTimeError` / `ValueError`, nothing written | `test_future_times_are_refused`, `test_naive_times_are_refused_before_any_write`, `test_start_before_an_earlier_occupancy_ended_is_refused`, `test_end_before_the_current_occupancy_started_is_refused`, `test_transfer_before_the_current_occupancy_started_is_refused` |
| Zero-length occupancy | Allowed | `test_ending_at_the_instant_it_started_is_allowed`, `test_ended_equal_to_started_is_accepted` |
| Caller's unflushed earlier row | Seen by the overlap check | `test_start_occupancy_sees_the_callers_unflushed_rows` |
| Membership id from another building passed to `end_occupancy` | No-op | `test_end_occupancy_scoped_to_another_building_changes_nothing` |
| The lock blocks unrelated FK writes | It doesn't (`NO KEY UPDATE`) | `test_the_membership_lock_leaves_fk_checks_on_the_membership_unblocked` |
| Stale `now()` in a writer that started before the other committed | `OccupancyTimeError`; caller retries (ADR-0016) | **No test in the repo.** Codex ran a scratch proof in round 1 and deleted it |
| Window function performance (not inlined) | One index lookup per record | **No test**; round-5 Claude reviewer reported checking the index scan |

<details><summary>Deeper: acceptance criteria → tests (all in the 205 that passed in my run)</summary>

1. `backend/tests/test_schema_occupancy.py::test_second_current_occupancy_of_a_membership_is_rejected`, `test_second_current_occupancy_of_the_same_unit_is_rejected`, `test_start_occupancy_twice_is_rejected_by_the_current_index`
2. `test_new_occupancy_after_the_previous_ended_is_accepted_and_history_is_kept`
3. `test_occupancy_of_a_unit_in_another_building_is_rejected`, `test_occupancy_of_a_membership_in_another_building_is_rejected`, `test_occupancy_within_one_building_is_accepted`, `test_model_occupancy_of_a_unit_in_another_building_is_rejected`, `test_start_occupancy_of_another_buildings_unit_is_rejected`
4. `test_ended_before_started_is_rejected`, `test_ending_an_occupancy_before_it_started_is_rejected`, `test_ended_equal_to_started_is_accepted`, `test_relationship_outside_the_enum_is_rejected_by_the_database`, `test_relationship_check_lists_exactly_the_enum_values`
5. `test_two_memberships_may_both_currently_occupy_one_unit`, `test_current_occupants_lists_current_memberships_in_start_order`, `test_current_occupants_of_a_unit_in_another_building_is_empty`
6. `test_transfer_failing_after_the_end_persists_neither_change`, `test_transfer_hitting_a_constraint_after_the_end_persists_neither_change`, `test_helpers_never_commit`
7. The window rows in the table above
8. `test_end_occupancy_sets_ended_at_and_returns_the_row`, `test_end_occupancy_without_a_current_one_is_a_no_op`, `test_transfer_ends_and_starts_at_the_same_instant`, `test_transfer_by_default_shares_the_transactions_now`, and others
9. The `OccupancyTimeError`/naive rows above
10. `test_deleting_a_unit_with_occupancies_is_restricted`, `test_deleting_a_membership_with_occupancies_is_restricted`, `test_moving_an_occupied_unit_to_another_building_is_rejected`, `test_moving_a_membership_with_occupancies_to_another_building_is_rejected`
11. `test_concurrent_transfers_apply_one_after_the_other`, `test_move_out_racing_a_transfer_ends_the_new_occupancy`
12. `backend/tests/test_schema_occupancy.py::test_migration_upgrades_downgrades_and_upgrades_again` (pinned `8887ac143e98` ↔ `2b2e5bcaf6b4`, checks the function too, ends with `alembic check`), `test_new_unit_membership_and_occupancy_can_be_flushed_together`

</details>

## 6. Review log

Rounds 1–3 ran before two rebases. The PR's SHA map (old → current): 1cc21f8 → a334acc, 7abd6f8 → b327ffa,
145844b → 74edd13, baa2e4d → 1533680, 78b3fe6 → c92fda1, 78e365a → 777d059, f83bec8 → 74bef61.

| Round | Reviewer | Commit reviewed (current SHA) | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Claude (security pass) | 1cc21f8 (a334acc) | MERGE | L1 backdated `at`; L2 future `at`; L3 window clause raised when the outer query selects `unit_occupancies`; L4 bookkeeping | L1 docs only + P4-06 follow-up; L2, L3 fixed test-first in b327ffa; L4 bookkeeping |
| 1 | Codex (`gpt-6-astra`, high) | 1cc21f8 (a334acc) | MERGE | None (ran 5 scratch proofs, deleted) | — |
| 2 | Codex | 7abd6f8 (b327ffa) | BLOCK | H1: L3's fix made the clause always true | Fixed in 74edd13 (private alias) |
| 2 | Claude (security pass) | 7abd6f8 (b327ffa) | BLOCK | Same H1; L1 rounds not recorded (dismissed); L2 lazy-load on returned row (not reproduced, guarded by a test); two uncaught mutations | Mutations now caught (74edd13, 1533680) |
| 3 | Codex | baa2e4d (1533680) | BLOCK | High: a caller alias named like the private alias shadowed it | Fixed in c92fda1 (guard); unreviewed → stop rule |
| 3 | Claude (security pass) | baa2e4d (1533680) | MERGE | M1 same collision; L1 no test for ending at start; L2 ticket signatures | M1 → c92fda1; L1, L2 fixed in 777d059 |
| — | Stop rule 4 → inbox B-2 | — | blocked | — | James: a fourth round with Claude reviewers only (Codex unavailable) |
| 4 | Claude (security pass only, standing in for Codex) | f83bec8 (74bef61) | BLOCK | H1 unqualified args bypass the guard; L1 upper-case alias; L2 outer CTE named `unit_occupancies` | All fixed by the function (c949a74), after James chose option B |
| 4 | Claude (full + security) | f83bec8 (74bef61) | MERGE | M1 same hole; L1 follow-ups only in PR body; nit alias count; equivalent mutations | M1 → c949a74; L1 → bookkeeping |
| 5 | Codex | cab5ecc | MERGE | M1 unqualified function call resolved through the search path | Fixed test-first in e18b5a7 |
| 5 | Claude (security pass) | cab5ecc and e18b5a7 | MERGE | L1 `prosecdef`/`proconfig` not pinned; L2 naive `timestamp` record column; L3 doc fixes | L1, L3 fixed in ba903b9; L2 → P5-01 follow-up (see §7) |

**The always-true chain** (the findings that changed the design). Each step below gives the input and the
wrong result. All of them led to D5.

- **Round 1, L3:** a plain `exists()` correlates every table it shares with the outer query. When the outer
  query also selected `unit_occupancies`, the subquery lost its own `FROM`, and SQLAlchemy raised. The fix
  was `correlate_except(UnitOccupancy)`: always keep `unit_occupancies` inside.
  - Test: `test_window_clause_works_when_the_outer_query_joins_unit_occupancies`.
- **Round 2, H1 (both reviewers):** with that fix, passing an outer `UnitOccupancy.membership_id` as the
  membership argument rendered as `unit_occupancies.membership_id = unit_occupancies.membership_id`
  inside the EXISTS. Both sides referred to the inner table, so the condition was always true, and the
  current occupant saw the former occupant's record. The fix was a private alias for the inner table.
  - Tests: `test_window_clause_uses_the_outer_queries_membership_column` and two neighbours. Reverting the
    alias fails all three.
- **Round 3 (Codex High, Claude Medium):** the alias had a fixed name, `window_occupancy`. A caller's alias
  with that same name was shadowed inside the subquery. An anonymous alias didn't help, because an outer
  alias named `unit_occupancies_1` collided with it (a test failed). The fix renamed the alias
  `occupancy_window` and refused any argument qualified by that name.
- **Round 4 (H1 security pass, M1 full review):**
  - Unqualified arguments slipped past the guard. `column("unit_id")` renders as a bare `unit_id`, which
    Postgres resolves to the innermost scope, the alias. The reviewer proved this in both directions.
  - Postgres folds an unquoted `OCCUPANCY_WINDOW` alias to lower case, so the name check missed it.
  - An outer `WITH unit_occupancies AS (…)` replaced the real table.
  - Evidence for the function: the PR reports that 12 of the new shape tests failed on the guard version
    and pass on the function.
- **Round 5 (Codex M1):** an unqualified function call is itself resolved through the search path. The fix
  was `func.public.occupancy_window`, tested with a shadow schema.

Other code-changing findings:

- **Round 1, L2** (a future `at` would be listed as current early) → the future check in `_prepare`
  (`test_future_times_are_refused`).
- **Round 2's uncaught mutations** → `test_the_membership_lock_leaves_fk_checks_on_the_membership_unblocked`
  (plain `FOR UPDATE`) and `test_start_occupancy_sees_the_callers_unflushed_rows` (no flush).
- **Round 5, L1** → the attributes test now also asserts the function is not `SECURITY DEFINER` and has no
  `SET` clauses.

## 7. Not verified, accepted risks and follow-ups

**Not verified by any test in the repo:**

- **The stale-`now()` path** (D3): a writer whose transaction began before a concurrent writer committed
  gets `OccupancyTimeError`. ADR-0016 says the caller retries. No repo test shows it; Codex's round-1
  proof was deleted. No caller retries yet.
- **Performance of the per-record function call:** pilot-scale only. ADR-0016 says to revisit if a
  resident's list query gets slow. The index-scan check was a reviewer's manual check, not a test.
- **`PARALLEL SAFE`:** it is in the migration but not pinned by the attributes test.
- **Behaviour against real `packages`:** the window was tested only against temporary tables and literals.
  P5-01 adds the real table.

**Accepted risks:**

| Risk | Where tracked |
|---|---|
| Raw SQL can write overlapping history for one membership (only "one current row" is enforced by the DB) | ADR-0016 Consequences and "Revisit when" |
| A backdated `at` from a client would expose a previous occupant's records; only docs guard it | Docstring, ADR-0016; follow-up for P4-06 below |
| `alembic check` doesn't compare the function; changing it needs a new migration; table/column changes need it recreated | ADR-0016 Consequences |
| Naive `timestamp` record columns are cast in the session time zone (round 5, L2) | PR D5 residual only. **Not** in the PR's Follow-ups list, and `docs/tickets/P5-01-package-schema-state-machine.md` doesn't yet pin `received_at` as `timestamptz`, although D5 says it does (reported as a finding) |

**Follow-ups** (in the PR's "Follow-ups" section; the implementer's bookkeeping commit after this
explanation is to copy them into the named tickets, and the D1–D5 decisions into the inbox's "Decisions to
audit"; at `ba903b9` neither is done yet):

- P4-06: map `OccupancyTimeError` and `IntegrityError` to problem+json; lock the building row before the
  membership.
- P4-06: test that no endpoint passes a client-supplied `at`.
- P5-01: `visible_packages` always selects from `packages` with a building filter, pinned by a test (round 3
  residual: with no outer FROM for the record table, the old EXISTS searched the whole table). Inferred:
  with the function, the record columns are evaluated in the caller's query, so that exact mechanism is
  gone. The follow-up still holds as a rule for `visible_packages`.
- P3-03 / P5-02a: `current_occupants` returns any membership status; filter to active members before
  notifying or accepting a pickup.
- Tests: give `test_migration_upgrades_downgrades_and_upgrades_again` (here and in P1-01/P1-02) a per-run
  scratch database name. **No ticket is named for this one, and nothing in the repo tracks it** (reported
  as a finding).

ADR-0010's "end_occupancy also deactivates the membership" and "all audited" are deferred to services
(Frame notes). P4-06's ticket already describes move-out as ending the occupancy and deactivating the
membership.

## 8. How to change this safely

- **Change the window rule** (for example, a grace period): write a new migration with
  `CREATE OR REPLACE FUNCTION public.occupancy_window(...)`. Never edit `8887ac143e98` (rule 11). Keep the
  SQL-standard `RETURN` body, `STABLE`, not `STRICT`, and schema-qualified names.
  `test_window_clause_against_literal_records`, `test_window_clause_fails_closed_on_nulls`,
  `test_window_function_is_stable_not_strict_and_bound_at_creation` and the search-path test will tell you
  if you broke the edges or the attributes.
- **Touch the table's window columns** (`membership_id`, `unit_id`, `started_at`, `ended_at`): drop and
  recreate the function in the same migration. Postgres refuses otherwise, because the body depends on
  them.
- **Allow non-resident owners with several units** (ADR-0010): relax `uq_unit_occupancies_current_membership`
  for `relationship = 'owner'` in a new migration. Then `transfer_occupancy`/`end_occupancy`, which assume
  at most one current row, need a `unit_id` argument. Criterion 1's tests will fail first, which is how you
  know.
- **Add a new write helper:** call `_prepare` first, flush, never commit, and scope every statement by
  `building_id`. Add a `_race` test if it can run concurrently with the others.
- **Add a new unit-addressed record type:** use `occupancy_window_clause` with a `timestamptz` column. Do not
  write your own `EXISTS` (CLAUDE.md rule 3).

## 9. Must explain, then quiz

**1. The unit-turnover privacy bug, and how the window prevents it.** Alice rents 101 until 1 March; Bob moves
in on 1 March. If visibility were "packages addressed to my unit", Bob would see every package Alice ever
received at 101: her name, senders and pickup history. With dated occupancies, a unit-addressed record is
visible only if `occupancy_window(viewer, record.unit_id, record.received_at)` is true, that is, if the
viewer occupied that unit when the record was created
(`backend/app/memberships/occupancy.py::occupancy_window_clause`). Alice's packages fall in
`[Alice.started_at, 1 March)`, which is not Bob's window. A package received at exactly the transfer instant
belongs to Bob only (D1). Once Alice has moved to 102, she also stops seeing new packages for 101.

**2. Partial unique index vs normal unique constraint.** `UNIQUE (membership_id) WHERE ended_at IS NULL`
(`backend/app/memberships/models.py::uq_unit_occupancies_current_membership`) indexes only current rows. Two
current rows for one membership collide; ended rows aren't in the index at all. A plain
`UNIQUE (membership_id)` would allow only one row per membership ever, and so destroy history. A plain
`UNIQUE (membership_id, ended_at)` doesn't work either, because NULLs are distinct by default, so it would
never stop two current rows. Postgres's `UNIQUE … NULLS NOT DISTINCT` would stop them, but it would also
forbid two ended rows with the same end time.

**3. Why timestamps, not dates.** A transfer happens at an instant, and packages are stamped with
`received_at` to the microsecond. With dates, a move-out and a move-in on the same day would share the
whole day. Every package that day would either be visible to both people (a leak) or to neither, depending
on the comparison. ADR-0010 chose timestamps "so the visibility window is exact". ADR-0016 adds that both
sides use the database's `now()`, so the comparison also uses one clock.

**4. Why the helpers never commit.** `transfer_occupancy` is "end, then start". If either helper committed,
a failure after the end would leave the person with no current unit. Criterion 6 tests exactly that, with
a patched failure and with a real FK error. More generally, P4-06's move-out will end the occupancy,
deactivate the membership and write an audit event, and all of that must commit together or not at all.
CLAUDE.md rule 5 puts the single `commit()` in the service; `test_helpers_never_commit` enforces it here.

**Quiz**

1. A caller passes `at=None` to `transfer_occupancy` inside a transaction that started 3 seconds ago. What
   instant is stored as both the old `ended_at` and the new `started_at`, and why are the two equal?
2. Two staff members click "move out" and "transfer to 103" for the same resident at the same moment. Walk
   through what each transaction does, and the end state, in both orders.
3. Why can't an outer CTE named `unit_occupancies` affect `public.occupancy_window`, when it could affect the
   round-3 EXISTS version?
4. What would break if we removed `key_share=True` from the lock in `_prepare`?
5. How would you extend this to "a household member also sees packages named to the unit's tenant, but only
   during their own occupancy"?

<details><summary>Answers</summary>

1. `SELECT now()` returns the transaction's start time, 3 seconds ago. `transfer_occupancy` resolves `at`
   once in `_prepare` and passes the same value to `end_occupancy` and `start_occupancy`. Even if it
   didn't, `now()` returns the same value for the whole transaction. So the windows are back to back,
   with no gap and no overlap.
2. Whichever transaction locks the membership first runs; the other waits in `_prepare`.
   - Transfer first: it ends 101 and inserts 103, then commits. The move-out wakes up, and with a fresh
     snapshot its `UPDATE … WHERE ended_at IS NULL` finds the 103 row and ends it. Nothing is current.
   - Move-out first: it ends 101 and commits. The transfer's `end_occupancy` is a no-op, then
     `start_occupancy` inserts 103, which is current.
   - In either order, if the waiting transaction's `now()` predates the other's commit time, its time check
     can raise `OccupancyTimeError` instead, and the caller retries.
   - Without the lock, the move-out's `UPDATE` would miss the inserted row and the person would stay
     current: the D3 bug, tested by `test_move_out_racing_a_transfer_ends_the_new_occupancy`.
3. The function's SQL-standard body was parsed and bound to `public.unit_occupancies` once, at `CREATE
   FUNCTION`. A CTE in the caller's query is part of the caller's name scope, which the body never sees;
   only the three argument values cross over. The EXISTS version was part of the caller's statement, so an
   unqualified `unit_occupancies` inside it resolved to the outer CTE first.
4. The lock would become `FOR UPDATE`, which conflicts with the `FOR KEY SHARE` lock Postgres takes for FK
   checks. While a transfer for a membership was uncommitted, inserting a `membership_roles` row (or any
   other row referencing that membership) would block.
   `test_the_membership_lock_leaves_fk_checks_on_the_membership_unblocked` would hit its 2-second
   `lock_timeout` and fail. Serialization would still work, because both modes conflict with themselves.
5. Keep the window as the gate. In P5-01's `visible_packages`, add an OR branch: "the package names a
   recipient who occupied this unit at `received_at`, the viewer is `household` there, and
   `occupancy_window(viewer, Package.unit_id, Package.received_at)` is true". Express it by calling the
   function, not a new subquery (D5). If the relationship needs to be part of the test, add a new
   function, for example `occupancy_window_as(membership, unit, at, relationship)`, in a new migration with
   the same attributes, plus attribute and boundary tests. Write it down in an ADR, since it changes
   ADR-0010's visibility rule.

</details>
