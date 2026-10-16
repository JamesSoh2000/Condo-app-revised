# P1-03 — Unit occupancies schema

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 1 |
| Depends on | P1-02 |
| Replaces old | M2-T05 (minimum), M2-T12, M2-T06 (pattern part) |
| Status | in progress |

## Goal

Residents are linked to units through dated occupancy periods with an owner/tenant/household relationship.
Helpers start, end and transfer occupancies, and a reusable "occupancy window" filter exists for later
visibility rules.

## Why

Unit turnover is the most likely privacy bug in this product. A new tenant must never see the previous
tenant's packages. History plus a window filter prevents it by design
([ADR-0010](../adr/0010-unit-occupancy-relationship.md)).

## Scope

- In:
  - **`unit_occupancies`** (`app/memberships/models.py`):
    - `building_id`, `unit_id`, `membership_id`
    - `relationship` via `database_enum(OccupancyRelationship)`: `owner`, `tenant`, `household`
    - `started_at` timestamptz not null, default `now()`
    - `ended_at` timestamptz null
    - **Composite FKs** `(building_id, unit_id) → units(building_id, id)` and
      `(building_id, membership_id) → building_memberships(building_id, id)`
    - Check `ended_at IS NULL OR ended_at >= started_at`
    - **Partial unique index** `(membership_id) WHERE ended_at IS NULL` (one current unit per resident)
    - Index `(building_id, unit_id, ended_at)`
  - **Helpers** in `app/memberships/occupancy.py`. They never commit:
    - `start_occupancy(db, *, building_id, membership_id, unit_id, relationship, at=None)`
    - `end_occupancy(db, *, building_id, membership_id, at=None)` (no-op if none is current)
    - `transfer_occupancy(db, *, building_id, membership_id, new_unit_id, relationship, at=None)` (end +
      start, same transaction)
    - `current_occupants(db, building_id, unit_id) -> list[membership_id]`
    - `occupancy_window_clause(membership_id, record_unit_col, record_time_col)` returns a SQLAlchemy
      boolean expression that is true when the record's unit was occupied by the membership at the
      record's timestamp. P5-01 uses it. *(changed in review round 4, James's decision: it calls the
      database function `occupancy_window(membership, unit, at)` instead of building an `exists()` clause;
      see the Frame notes)*
- Out:
  - vehicles, emergency contacts, household-member accounts, documents (pilot options)
  - non-resident owners holding several units (relax the index later, per ADR-0010)

## Interfaces

Table and helpers above. Enum `OccupancyRelationship`.

## Acceptance criteria

Times are half-open windows: an occupancy covers `started_at <= T < ended_at` (`ended_at` NULL = still
open). *(sharpened)*

1. **Given** membership M has a current occupancy, **when** a second current occupancy for M is inserted,
   **then** `IntegrityError` (`uq_unit_occupancies_current_membership`). *(sharpened)* Holds for a raw SQL
   insert and for `start_occupancy`; a second current occupancy of the *same* unit is rejected too.
2. **Given** M's occupancy is ended, **when** a new current one is started, **then** it succeeds, and history
   keeps both rows.
3. **Given** M in building A and a unit in building B, **when** an occupancy is inserted, **then**
   `IntegrityError`. *(sharpened)* Both directions are rejected by the composite FKs, with raw SQL:
   `building_id = A` with a B unit (`fk_unit_occupancies_building_id_unit_id`), and `building_id = B` with an
   A membership (`fk_unit_occupancies_building_id_membership_id`); `building_id = A` with an A unit and an A
   membership succeeds (positive control). `start_occupancy` with a B unit gives the same `IntegrityError`.
4. **Given** `ended_at < started_at`, **then** the check constraint rejects it
   (`ck_unit_occupancies_ended_after_started`). *(sharpened)* `ended_at = started_at` is allowed; a
   `relationship` outside the enum (raw SQL) is rejected by `ck_unit_occupancies_relationship`, and the
   check lists exactly the enum's values.
5. **Given** two different memberships, **when** both start current occupancies of unit 101, **then** both
   succeed. *(sharpened)* `current_occupants(db, A, unit_101)` returns both membership ids, ordered by
   `started_at`, and no ended occupancy; for a building that doesn't own the unit it returns `[]`.
6. **Given** `transfer_occupancy` raises midway (simulated), **then** neither the end nor the start persists.
   *(sharpened)* The setup is committed first; the failure comes once after the end ran, both from a
   patched `start_occupancy` and from a real constraint error (new unit in another building); after the
   caller's `rollback()` the old occupancy is still current and no new row exists. The helpers never call
   `commit()`.
7. **Given** a record for unit 101 created at T:
   - **when** the former occupant's window ended before T, **then** `occupancy_window_clause` is false
   - **when** the current occupant's window started before T, **then** it is true
   - **when** a new occupant started after T, **then** it is false
   - *(added)* boundaries: T = `started_at` is true; T = `ended_at` is false (at a transfer instant the
     record belongs to the new window only)
   - *(added)* another membership's occupancy of 101, or M's occupancy of another unit, is false; a record
     with a NULL unit or NULL time is false (fails closed)
   - *(added)* the clause correlates with an outer table: selecting from a table of records returns exactly
     the rows inside the window
   - *(added in review rounds 2–4)* the answer doesn't depend on how the caller's query names things: an
     outer `unit_occupancies` query or alias passing its own columns, aliases of any name (unquoted
     upper case included), unqualified columns (`column()`, `literal_column()`, a textual FROM), an outer
     CTE or a temporary table named `unit_occupancies`
8. *(added)* `end_occupancy` sets `ended_at` (default: the transaction's `now()`) on M's current occupancy
   and returns it; with no current occupancy it is a no-op returning `None`. `transfer_occupancy` ends the
   old row and starts the new one at the **same** instant, so the windows neither overlap nor leave a gap.
9. *(added, missed case)* A person's history can't overlap itself: `start_occupancy` with an `at` earlier
   than the `ended_at` of one of M's earlier occupancies raises `OccupancyTimeError` and writes nothing;
   `end_occupancy` with an `at` before the current row's `started_at` raises `OccupancyTimeError` and leaves
   the row current. A naive (timezone-less) `at` raises `ValueError`.
10. *(added)* History is kept: deleting a unit or a membership that has occupancies gives `IntegrityError`
    (RESTRICT); moving such a unit or membership to another building gives `IntegrityError` (composite FK).
11. *(added, tenant table row 10)* Occupancy writes for M serialize: with a first `transfer_occupancy` for M
    uncommitted, a second one in another transaction waits for it, then applies on top of it. M ends with
    exactly one current occupancy (the second's unit) and three back-to-back rows. A move-out
    (`end_occupancy`) racing a transfer the same way ends the transferred-to row, leaving none current.
12. *(added)* `alembic upgrade` to this revision, `downgrade` to P1-02's (`2b2e5bcaf6b4`), then
    `upgrade head`, with revision ids pinned; after the downgrade `unit_occupancies` is gone; `alembic check`
    is clean. A new unit, membership and their occupancy can be flushed together in one `flush()`.

## Test plan

- `tests/test_schema_occupancy.py` (criteria 1–5, 10, 12)
- `tests/test_occupancy_helpers.py` (criteria 6–9, 11; the window clause against literal values and a
  temporary table of records)
- Commands: `make test`

## Likely files

`backend/app/memberships/models.py`, `backend/app/memberships/occupancy.py`,
`backend/app/memberships/enums.py`, `backend/migrations/versions/<new>.py`, `backend/tests/test_*occupancy*.py`.

## Must explain (learning checkpoint)

1. Describe the unit-turnover privacy bug, and how `started_at`/`ended_at` plus the window clause prevent it.
2. How does a partial unique index enforce "one current unit", and why can't a normal unique constraint?
3. Why timestamps (`started_at`) rather than dates for the window?
4. Why do the helpers never commit?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (raw SQL and helper; same unit), 3 (both directions, named constraints,
  positive control, helper), 4 (equal times allowed; relationship check), 5 (`current_occupants`), 6 (how
  "midway" is simulated: patched and real failure, committed setup), 7 (half-open boundaries, other
  membership/unit, NULLs fail closed, correlation with an outer table); new 8 (end/transfer behaviour),
  9 (no overlapping history, time order, naive `at`), 10 (RESTRICT and moving rows), 11 (concurrent
  transfers), 12 (migration round-trip, flush order).
- Tenant table (ENGINEERING_PRACTICES §7): no endpoint. Row 7's storage-level counterpart is criterion 3,
  row 5's is criterion 7 (another membership's occupancy grants nothing), row 10's is criterion 11.
- Criteria loosened (with reason; also listed in the inbox): none.
- Changed during implementation: criterion 11 first said "exactly one commits; the other gets
  `IntegrityError`". Writing it showed that, without a lock, a move-out racing a transfer silently misses
  the row the transfer inserted. The helpers now lock the membership row, so concurrent writes serialize and
  both succeed in order; criterion 11 asserts that, plus the move-out race. Not a loosening: the invariant
  (one current row, no overlap) is unchanged, and a case was added. Basis: autonomous; ADR-0016.
- Changed in review (round 4, James in session): `occupancy_window_clause` returns a call to the database
  function `occupancy_window` rather than an `exists()` clause. Rounds 2, 3 and 4 each found a query shape
  that made the EXISTS always true (a new occupant seeing the former occupant's records), each one through
  a name in the caller's query resolving to the clause's own table; a function gets its arguments as
  values. Criterion 7 gained the shapes as cases. Not a loosening: the contract (true exactly inside the
  window) is the same, and P5-01's call is unchanged. Basis: James's decision; ADR-0016.
- Interface sharpened: `end_occupancy` and `transfer_occupancy` also take `building_id` (keyword), like
  `start_occupancy` and `current_occupants`, so every helper query is scoped to one building (CLAUDE.md
  rule 1). Basis: autonomous; it narrows what a caller can touch. P4-06 is the first caller.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Windows are half-open, `started_at <= T < ended_at`. A transfer ends and starts at one instant, and a
    record at that instant belongs to the new occupant only. Basis: autonomous (ADR-0010 wants an exact
    window); lasting, so ADR-0016 and the inbox.
  - `at=None` means the database's `now()` (transaction start), not the app's clock: records default to
    `now()` too, so the two are compared on one clock, and end + start in one transaction share it. Basis:
    autonomous; ADR-0016.
  - `start_occupancy` refuses to overlap M's own history (criterion 9) with a Python check, not a database
    exclusion constraint: that needs the `btree_gist` extension (new database infrastructure, CLAUDE.md
    rule 13). The partial unique index still guarantees one current row. Basis: autonomous; ADR-0016.
  - Each write helper first locks the membership row (`FOR NO KEY UPDATE`), so writes for one membership
    serialize (criterion 11). Basis: autonomous; ADR-0016.
  - The helpers raise `OccupancyTimeError` (a `ValueError`) for times out of order; P1-04's
    `app/core/errors.py` doesn't exist yet, so services map it when they call the helpers. Basis: default
    (reversible).
  - FKs from `unit_occupancies` to units, memberships and buildings are `ON DELETE RESTRICT` (occupancies
    are history; ADR-0010), `ON UPDATE` NO ACTION. Basis: the existing pattern (P1-01/P1-02).
  - ORM relationships `unit` and `membership` (`lazy="raise"`, many-to-one) exist so a flush inserts the
    unit and membership first (the P1-02 pattern). Both write `building_id`, so each declares `overlaps`.
  - An extra index `(membership_id, unit_id, started_at)` serves the window clause (it filters by
    membership and unit) and the RESTRICT check on memberships; the ticket's `(building_id, unit_id,
    ended_at)` serves `current_occupants`. Basis: autonomous.
  - The helpers don't look at membership status, unit `is_active`, roles or audit: the services that call
    them (P4-02, P4-05, P4-06) do. ADR-0010's "end_occupancy also deactivates the membership" is P4-06's
    move-out service, not this helper. `current_occupants` returns current occupancies of any membership
    status; callers that notify or hand over packages filter active members. Basis: ticket scope.
  - The window clause takes no `building_id`: a unit id belongs to one building, and the composite FKs
    make an occupancy's unit and membership share it. Basis: ADR-0005.
- Split: none. Estimate ~330 non-test lines (enum, model, helpers, migration, ADR).
