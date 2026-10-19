# P4-01 — Units API

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 2 |
| Depends on | P2-03, P2-04 |
| Replaces old | M3-T08 |
| Status | in progress |

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
   - Framed: the match is a case-insensitive prefix on `label` with `%` and `_` taken literally
     (`search="1_"` matches no `101`). `a_manager` gets the same list (both allowed roles). Each item is
     exactly `{id, tower, label, floor, is_active, current_occupant_count}`, where the count is the unit's
     occupancies with `ended_at IS NULL` (`a_101` → 1, `a_201` → 3, `a_102` → 2). `active=true|false` and
     `tower=` filter exactly; the list is the standard keyset page (`id DESC`, `invalid_cursor` → 400).
     `a_council` (council + resident, not an allowed role) gets 403 `forbidden_role`.
2. **Given** `a_manager`, **when** creating a duplicate (tower NULL, `101`), **then** 409 `unit_exists`.
   - Framed: a new unit is 201 with the `UnitOut` body and `current_occupant_count` 0, plus one
     `unit.created` audit row (actor, building, unit id; metadata field names only). The same label
     with another tower is not a duplicate. Labels and towers are stripped; an empty label, a value over
     20 characters, a control character (NUL) or a lone surrogate is 422 and writes nothing. `floor` is an
     integer in −20…300. `a_security` gets 403 on create, update, deactivate and activate.
3. **Given** unit 101 with a current occupant, **when** deactivating, **then** 409 `unit_has_occupants`. Unit
   201, after its occupancy ended, deactivates (204), and an audit row exists.
   - Framed: a current occupancy of a membership in any status counts (a suspended member still lives
     there). Deactivating an inactive unit, or activating an active one, is 409 `invalid_transition`
     (CLAUDE.md rule 7). Activating gives 204 and a `unit.activated` row. Deactivation locks the unit row
     (`FOR UPDATE`) before checking occupants, so it can't interleave with an occupancy insert.
4. **Given** `b_manager` and a building-A unit ID in a building-B route, **then** 404.
   - Framed: 404 `unit_not_found` for PATCH, deactivate and activate, with the same body as a random id;
     the building-A unit is unchanged and no audit row is written. Unknown building, non-member,
     `a_pending` and `a_suspended` get `building_not_found` on every route (tenant rows 2, 3, 6).
5. **Given** a CSV with 300 valid rows and 2 invalid ones, **when** run with `--dry-run`, **then** the report
   is printed and no rows are written. The real run creates 300, and a rerun reports 300 unchanged.
   - Framed: the import is the service `import_units(db, building_id, rows)` (flushes, never commits, so
     P4-03 can call it in its own transaction); the CLI commits only without `--dry-run`. A row whose
     `(tower, label)` exists with another floor is `updated`; `is_active` is never changed. The report
     lists each invalid row by its line number and reason, never its values. A `(tower, label)` repeated
     in the file is invalid from its second occurrence. A missing or extra header column, an unknown
     building slug, or more than 5,000 rows is an error: exit 1, nothing written. Each created or updated
     unit gets a `unit.created`/`unit.updated` audit row with no actor and `{"source": "import"}`.
6. **Given** `search_unit_options`, **then** the result contains only `id`, `tower` and `label`, and no
   inactive units.
   - Framed: only the given building's units, case-insensitive prefix on `label` (literal `%`/`_`), at most
     `limit` (clamped to 1…50), ordered by tower (NULL first) then label.
7. **(Added)** `PATCH /units/{id}` changes only the fields sent (`floor: null` clears it; `label: null` is
   422), returns 200 with the body, and records one `unit.updated` with the changed field names. Renaming
   onto an existing `(tower, label)` is 409 `unit_exists`. A PATCH that changes nothing writes no audit row.
8. **(Added, carried from P2-04)** `record_audit` raises `ValueError` for a lone-surrogate key, rejects falsy
   non-dict metadata instead of storing `{}`, and walks repeated shared sub-objects in linear time.

## Test plan

- `tests/units/test_api.py` (the 10-case table where applicable), `tests/units/test_import.py`.
- Commands: `make test`, `make gen-api`.

## Likely files

`backend/app/units/{router,service,schemas}.py`, `backend/app/cli.py`, `backend/tests/units/*`.

## Must explain (learning checkpoint)

1. Why does the join flow get a separate, minimal unit query instead of reusing the staff list?
2. Why block deactivating an occupied unit rather than cascading?
3. What makes the CSV import safe to re-run?

## Carried from P1-04

- List routes add `problem_responses(400)` themselves to document `invalid_cursor` (OpenAPI doesn't pick
  it up from `CursorParams`).
- `paginate` reads `db.scalars(stmt)`, so `stmt` selects one entity (`select(Unit).where(...)`).
- Operation ids are `<first tag>_<function name>`: name handlers by the verb (`def list`, `def create`
  under tag `units`) to get `units_list`, not `units_list_units`.

## Carried from P2-04 (do while framing)

- The first domain caller of `record_audit`: first fix review round 3's three Low edges in
  `backend/app/audit/service.py`, test-first (PR #60):
  - a lone-surrogate key (`{"\ud800": "x"}`) passes `_check_structure` and fails at flush; it should raise
    `ValueError`, as a surrogate value already does
  - falsy non-dict metadata (`False`, `0`, `""`, `[]`) becomes `{}` through `metadata or {}`; use
    `{} if metadata is None else metadata`
  - shared sub-objects (`x = [x, x]` repeated) are walked once per path (exponential): track visited `id()`s
    or bound the total node count

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: every criterion above got a "Framed" sub-bullet (exact bodies, the
  occupant-count definition, literal `%`/`_`, input limits that Postgres would otherwise refuse at flush,
  409 `invalid_transition` for repeated transitions, 404 body equality, the CSV edge rules). Added
  criterion 7 (PATCH, which the ticket listed but didn't test) and criterion 8 (the P2-04 carry-over).
  Tenant rows: 1, 2, 3, 4, 6 on every route; 5 n/a (staff-only, no per-resident records); 7 n/a (no body
  IDs); 8 via `invalid_transition`; 9 n/a (create is not idempotent: a retry is 409 `unit_exists`, which
  is the duplicate criterion); 10 via the deactivate lock (concurrency test on real connections).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis):
  - Occupant = a current occupancy row, any membership status (autonomous; the occupancy helpers'
    `current_occupants` uses the same definition).
  - The list keeps the standard `id DESC` keyset order (convention, P1-04 `paginate`); a label-ordered
    staff list is a follow-up if the UI needs it.
  - No new index: a prefix scan over ~300 units per building is cheap (product planning size).
  - Import is partial: invalid rows are skipped and reported, valid rows are written, exit 0 (the ticket's
    criterion 5 expects 300 created from a file with 2 invalid rows).
  - `floor` bounds −20…300 (autonomous; keeps the integer column safe and catches typos).
- Split: none. Estimate ~390 non-test lines (router 80, service 190, schemas 50, CLI 55, audit fix 15).
