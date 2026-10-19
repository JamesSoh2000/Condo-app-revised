# P4-01b — Units CSV import (split from P4-01)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 2 |
| Depends on | P4-01a |
| Replaces old | M3-T08 (part of [P4-01](./P4-01-units-api.md)) |
| Status | todo |

## Goal

Operators can import a building's units from CSV.

## Why

Pilot onboarding needs a fast, safe way to load 300 units. P4-03's `bootstrap-building --units-csv` builds on
it.

## Scope

- In:
  - **CLI `import-units --building SLUG --csv PATH [--dry-run]`:**
    - CSV columns `tower,label,floor`
    - upserts by `(tower,label)`
    - reports created / updated / unchanged / invalid rows
    - the dry run writes nothing
  - Audit: `unit.created` / `unit.updated` for each unit the import writes.
- Out: the units API and `search_unit_options` (P4-01a).

## Interfaces

CLI `import-units`; `app.units.service.parse_units_csv`, `import_units(db, building_id, parsed, *, dry_run)`
(flushes, never commits, so P4-03 can call it in its own transaction).

## Acceptance criteria

1. **Given** a CSV with 300 valid rows and 2 invalid ones, **when** run with `--dry-run`, **then** the report
   is printed and no rows are written. The real run creates 300, and a rerun reports 300 unchanged.
   - Framed (in P4-01): the import is the service `import_units(db, building_id, rows)` (flushes, never
     commits, so P4-03 can call it in its own transaction); the CLI commits only without `--dry-run`. A row
     whose `(tower, label)` exists with another floor is `updated`; `is_active` is never changed. The report
     lists each invalid row by its line number and reason, never its values. A `(tower, label)` repeated in
     the file is invalid from its second occurrence. A missing or extra header column, an unknown building
     slug, or more than 5,000 rows is an error: exit 1, nothing written. Each created or updated unit gets a
     `unit.created`/`unit.updated` audit row with no actor and `{"source": "import"}`.
   - Rows are validated with P4-01a's `UnitCreate` (same limits as the API). Its `floor` is strict since
     P4-01a review round 1 (`true` and `"3"` are refused), so the parser converts the cell to `int` first
     and reports a non-integer cell itself; the `4c015f0` code passed the string and needs that change.

## Test plan

- `tests/units/test_import.py`. Commands: `make test`; the CLI run on the stack (`make cli args="import-units …"`).

## Likely files

`backend/app/units/service.py`, `backend/app/cli.py`, `backend/tests/units/test_import.py`.

## Must explain (learning checkpoint)

1. What makes the CSV import safe to re-run?
2. Why is the import a service that never commits, with the CLI deciding whether to commit?

## Carried from P4-01

- Split after implementation (P4-01 measured 613 non-test lines). A complete implementation of this ticket,
  with its tests, passing `make check` and run on the stack, is commit `4c015f0` in P4-01a's PR history
  (PR #84; `git fetch origin pull/84/head`): `app/units/service.py` from "The CSV import", the
  `import-units` command and `run_in_session(commit=)` in `app/cli.py`, and `tests/units/test_import.py`.
  It has had no independent review. Start from it, but frame and review it as new work.
- Decision recorded in P4-01 (D3 in its PR): the import is partial. Invalid rows are skipped and reported,
  valid rows are written, exit 0. All-or-nothing was rejected because criterion 1 expects 300 created from
  a file that also has 2 invalid rows.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
