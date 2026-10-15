# P1-03 — Unit occupancies schema

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 1 |
| Depends on | P1-02 |
| Replaces old | M2-T05 (minimum), M2-T12, M2-T06 (pattern part) |
| Status | todo |

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
    - `end_occupancy(db, *, membership_id, at=None)` (no-op if none is current)
    - `transfer_occupancy(db, *, membership_id, new_unit_id, relationship, at=None)` (end + start, same
      transaction)
    - `current_occupants(db, building_id, unit_id) -> list[membership_id]`
    - `occupancy_window_clause(membership_id, record_unit_col, record_time_col)` returns a SQLAlchemy
      `exists()` clause that is true when the record's unit was occupied by the membership at the record's
      timestamp. P5-01 uses it.
- Out:
  - vehicles, emergency contacts, household-member accounts, documents (pilot options)
  - non-resident owners holding several units (relax the index later, per ADR-0010)

## Interfaces

Table and helpers above. Enum `OccupancyRelationship`.

## Acceptance criteria

1. **Given** membership M has a current occupancy, **when** a second current occupancy for M is inserted,
   **then** `IntegrityError`.
2. **Given** M's occupancy is ended, **when** a new current one is started, **then** it succeeds, and history
   keeps both rows.
3. **Given** M in building A and a unit in building B, **when** an occupancy is inserted, **then**
   `IntegrityError`.
4. **Given** `ended_at < started_at`, **then** the check constraint rejects it.
5. **Given** two different memberships, **when** both start current occupancies of unit 101, **then** both
   succeed.
6. **Given** `transfer_occupancy` raises midway (simulated), **then** neither the end nor the start persists.
7. **Given** a record for unit 101 created at T:
   - **when** the former occupant's window ended before T, **then** `occupancy_window_clause` is false
   - **when** the current occupant's window started before T, **then** it is true
   - **when** a new occupant started after T, **then** it is false

## Test plan

- `tests/test_schema_occupancy.py` (criteria 1–5)
- `tests/test_occupancy_helpers.py` (criteria 6–7, using a throwaway table or a temporary SQL select with
  literal values for the window clause)
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

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
