# P1-01 — Buildings, features and units schema

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 2 |
| Depends on | P0-05 |
| Replaces old | M2-T03 (finishes branch `M2-T03_Core-Tenant-Schema_James`), M2-T10 (timezone storage part) |
| Status | in progress |

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
   **then** `IntegrityError` (the `NULLS NOT DISTINCT` unique constraint). The same holds for (`T1`, `101`)
   twice in A.
2. **Given** unit (NULL, `101`) in A, **when** (NULL, `101`) is inserted in B, or (`T2`, `101`) in A, **then**
   both succeed.
3. **Given** building A has units, **when** A is deleted, **then** `IntegrityError` (RESTRICT) and A and its
   units still exist. Deleting a building with only features succeeds and removes its `building_features`
   rows (cascade).
4. **Given** a duplicate `(building_id, feature)`, **then** `IntegrityError`. The same feature in two
   buildings succeeds.
5. **Given** an invalid slug (`Maple Tower`, `maple_tower`, `Maple`, empty) inserted through the model, or a
   feature value not in the enum inserted with raw SQL (bypassing SQLAlchemy's enum validation), **then**
   the database's check constraint rejects it (`IntegrityError` naming the constraint). `maple-tower-2`
   passes.
6. **Given** `validate_timezone("Mars/Base")` (also `""` and `"america/toronto"`), **then** `ValueError`.
   `"America/Toronto"` passes and is returned unchanged. *(added)* Setting `Building.timezone` to an invalid
   zone raises `ValueError` before any SQL runs.
7. `alembic upgrade head`, then `downgrade -1`, then `upgrade head` succeeds, and `alembic check` is clean.
   *(sharpened)* After `downgrade -1` none of the three tables exists; the test suite checks this in code, not
   only by hand.
8. *(added)* Two buildings with the same `slug`, or the same non-null `join_code`, give `IntegrityError`; two
   buildings with `join_code` NULL succeed.
9. *(added, ADR-0005)* `UNIQUE (building_id, id)` works as a composite-FK target: a probe table with
   `FOREIGN KEY (building_id, unit_id) REFERENCES units (building_id, id)` accepts a row pointing at A's unit
   with A's id, and rejects (`IntegrityError`) a row pointing at A's unit with B's id.
10. *(added)* Defaults: a building inserted with only the required fields gets `locale = 'en'`,
    `is_active = true`, `join_code` NULL; a feature row gets `enabled = true` and `config = {}` (a raw SQL
    insert without `config` gets `'{}'` from the server default); a unit gets `is_active = true`.
11. *(added, fitness)* Every `app/**/models.py` module is imported by `app/models/registry.py`, and
    `migrations/env.py` imports the registry; a new models module that isn't registered fails a test.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (towered duplicate), 3 (rows survive the failed delete), 4 (same feature in
  two buildings), 5 (more slug spellings; the enum case uses raw SQL so the DB check, not Python, is what's
  tested), 6 (more bad zones; model-level validation), 7 (downgrade checked in code); new 8 (slug and
  `join_code` uniqueness), 9 (composite-FK target, the reason for `UNIQUE (building_id, id)`), 10 (defaults),
  11 (registry fitness test).
- Tenant table (ENGINEERING_PRACTICES §7): no row applies; this ticket has no endpoint. Criterion 9 is the
  storage-level counterpart of row 7.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - `BuildingFeature` keeps `TimestampMixin` (no uuid PK: the PK is composite). Basis: autonomous, matches the
    existing stub and every other table; reversible.
  - Timezone validation runs in a SQLAlchemy `@validates("timezone")` on `Building`, calling
    `app.core.time.validate_timezone`, which caches `zoneinfo.available_timezones()`. No DB check (the ticket
    says Python). Basis: ticket + autonomous (where to hook it).
  - The enum's check constraint is named by `database_enum(Feature, name="feature")`, giving
    `ck_building_features_feature` through the naming convention. Basis: existing code (`app/models/types.py`).
  - `app/models/registry.py` (not `__init__.py`): importing `app.models` from a feature's models module must
    not import every feature (cycles). Basis: ticket offers both; autonomous choice.
- Split: none. Estimate ~200 non-test lines (three models, enum, helper, registry, migration).
