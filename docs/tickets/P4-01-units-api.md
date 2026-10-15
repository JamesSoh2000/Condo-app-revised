# P4-01 — Units API

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 2 |
| Depends on | P2-03, P2-04 |
| Replaces old | M3-T08 |
| Status | todo |

## Goal

Staff can search and manage a building's units. Operators can import units from CSV. A minimal unit-option
query exists for the resident join flow.

## Why

Onboarding, packages and maintenance all reference units. Pilot onboarding needs a fast, safe way to load
300 units.

## Scope

- In:
  - **Building-router endpoints:**
    - `GET /units?search=&tower=&active=&cursor=` (security, property_management): `{id, tower, label, floor,
      is_active, current_occupant_count}`. Search is a case-insensitive prefix on `label`.
    - `POST /units` (property_management) `{tower?, label, floor?}`: 201, or 409 `unit_exists`.
    - `PATCH /units/{id}` (property_management): `tower`, `label`, `floor`.
    - `POST /units/{id}/deactivate` and `POST /units/{id}/activate` (property_management). Deactivating a
      unit with current occupants gives 409 `unit_has_occupants`.
  - **Service `search_unit_options(db, building_id, search, limit=20)`:** returns only `{id, tower, label}`
    for active units. P4-05 uses it for the join flow. No occupant data.
  - **Audit:** `unit.created`, `unit.updated`, `unit.deactivated`, `unit.activated`.
  - **CLI `import-units --building SLUG --csv PATH [--dry-run]`:**
    - CSV columns `tower,label,floor`
    - upserts by `(tower,label)`
    - reports created / updated / unchanged / invalid rows
    - the dry run writes nothing
- Out:
  - unit occupants listing (P5-02a adds `/units/{id}/occupants`)
  - the join endpoints (P4-05)

## Interfaces

`units_list`, `units_create`, `units_update`, `units_deactivate`, `units_activate`, `search_unit_options()`,
CLI `import-units`.

## Acceptance criteria

1. **Given** `a_security`, **when** searching `"10"`, **then** units starting with `10` in building A only.
   `a_resident1` gets 403 on the list.
2. **Given** `a_manager`, **when** creating a duplicate (tower NULL, `101`), **then** 409 `unit_exists`.
3. **Given** unit 101 with a current occupant, **when** deactivating, **then** 409 `unit_has_occupants`. Unit
   201, after its occupancy ended, deactivates (204), and an audit row exists.
4. **Given** `b_manager` and a building-A unit ID in a building-B route, **then** 404.
5. **Given** a CSV with 300 valid rows and 2 invalid ones, **when** run with `--dry-run`, **then** the report
   is printed and no rows are written. The real run creates 300, and a rerun reports 300 unchanged.
6. **Given** `search_unit_options`, **then** the result contains only `id`, `tower` and `label`, and no
   inactive units.

## Test plan

- `tests/units/test_api.py` (the 10-case table where applicable), `tests/units/test_import.py`.
- Commands: `make test`, `make gen-api`.

## Likely files

`backend/app/units/{router,service,schemas}.py`, `backend/app/cli.py`, `backend/tests/units/*`.

## Must explain (learning checkpoint)

1. Why does the join flow get a separate, minimal unit query instead of reusing the staff list?
2. Why block deactivating an occupied unit rather than cascading?
3. What makes the CSV import safe to re-run?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
