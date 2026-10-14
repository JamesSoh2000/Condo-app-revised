# P1-01 — Buildings, features and units schema

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 2 |
| Depends on | P0-05 |
| Replaces old | M2-T03 (finishes branch `M2-T03_Core-Tenant-Schema_James`), M2-T10 (timezone storage part) |
| Status | todo |

## Goal

`buildings`, `building_features` and `units` exist, with constraints that make duplicate units and
cross-building references impossible.

## Why

These are the roots of every tenant-owned table. The `(building_id, id)` unique key on `units` is what later
composite FKs point at ([ADR-0005](../adr/0005-tenant-integrity-in-the-database.md)).

## Scope

- In:
  - **`Building`** (`app/buildings/models.py`), using the existing `UUIDPrimaryKeyMixin` and `TimestampMixin`:
    - `slug` String(63), unique, check `slug ~ '^[a-z0-9-]+$'`
    - `name` String(200), `address` Text
    - `timezone` String(64), validated in Python against `zoneinfo.available_timezones()`
    - `locale` String(10), default `'en'`
    - `join_code` String(16), unique, nullable (null disables self-join)
    - `is_active` bool, default true
  - **`BuildingFeature`:**
    - composite PK `(building_id, feature)`
    - `feature` via `database_enum(Feature)`, where `Feature` is (`packages`, `notices`, `maintenance`,
      `amenities`, `moves`, `visitors`, `reports`, `financials`)
    - `enabled` bool, default true
    - `config` JSONB, `server_default '{}'`
    - FK `building_id` ON DELETE CASCADE
  - **`Unit`** (`app/units/models.py`):
    - `building_id` FK ON DELETE RESTRICT
    - `tower` String(20) nullable, `label` String(20), `floor` Integer nullable, `is_active`
    - `UniqueConstraint("building_id", "id")`
    - `UniqueConstraint("building_id", "tower", "label", postgresql_nulls_not_distinct=True)`. If autogenerate
      doesn't render this, hand-edit the migration (`NULLS NOT DISTINCT`).
  - **`app/models/registry.py`** (or `app/models/__init__.py`) imports all model modules. `migrations/env.py`
    imports only that, so new models can't be forgotten.
  - A `validate_timezone(tz: str) -> str` helper in `app/core/time.py`.
  - The migration: read it and fix by hand. Downgrade implemented.
- Out:
  - Metropolis business fields (`registration_number`/NEQ, `fiscal_year_start`), deferred to the financials
    epic
  - APIs (P4-01)
  - the old amenity-style `BuildingFeature` columns (booking modes, etc.), which belong to the amenities epic

## Interfaces

Tables `buildings`, `building_features`, `units` as above. Enum `Feature` in `app/buildings/enums.py`.

## Acceptance criteria

1. **Given** building A has unit (tower NULL, label `101`), **when** another (NULL, `101`) is inserted for A,
   **then** `IntegrityError`.
2. **Given** unit (NULL, `101`) in A, **when** (NULL, `101`) is inserted in B, or (`T2`, `101`) in A, **then**
   both succeed.
3. **Given** building A has units, **when** A is deleted, **then** `IntegrityError` (RESTRICT). Deleting a
   building with only features cascades the features.
4. **Given** a duplicate `(building_id, feature)`, **then** `IntegrityError`.
5. **Given** an invalid slug (`Maple Tower`) or a feature value not in the enum, **then** the check
   constraint rejects it.
6. **Given** `validate_timezone("Mars/Base")`, **then** `ValueError`. `"America/Toronto"` passes.
7. `alembic upgrade head`, then `downgrade -1`, then `upgrade head` succeeds, and `alembic check` is clean.

## Test plan

- `tests/test_schema_buildings_units.py`, one test per criterion, using the `db` fixture with raw model inserts.
- Commands: `make test`; `cd backend && uv run alembic check`.

## Likely files

`backend/app/buildings/models.py`, `backend/app/buildings/enums.py`, `backend/app/units/models.py`,
`backend/app/models/registry.py`, `backend/app/core/time.py`, `backend/migrations/env.py`,
`backend/migrations/versions/<new>.py`, `backend/tests/test_schema_buildings_units.py`.

## Must explain (learning checkpoint)

1. Why does `UNIQUE (building_id, tower, label)` allow duplicates when `tower` is NULL, unless you add
   `NULLS NOT DISTINCT`?
2. What is `UNIQUE (building_id, id)` for, when `id` is already unique?
3. Why `RESTRICT` for units but `CASCADE` for features?
4. Why are enums stored as non-native (check-constrained strings) in this project? (See `app/models/types.py`.)

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
