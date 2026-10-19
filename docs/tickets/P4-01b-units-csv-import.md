# P4-01b — Units CSV import (split from P4-01)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 2 |
| Depends on | P4-01a |
| Replaces old | M3-T08 (part of [P4-01](./P4-01-units-api.md)) |
| Status | in progress |

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

- Criteria added or sharpened (criterion 1 stands; these make it testable and close the cases it left open):
  - **F1 Rerun and concurrency.** The real run upserts row by row with `INSERT … ON CONFLICT DO NOTHING` on
    `uq_units_building_id_tower_label`, then a conditional `UPDATE … WHERE floor IS DISTINCT FROM … RETURNING`.
    A unit that already exists, also one created by the API while the import runs, is `updated` or
    `unchanged`, never an `IntegrityError`. Matching is exact (case-sensitive, after stripping), as the
    constraint is. Rows with the same `(tower, label)` in **another** building are never read or written.
  - **F2 Dry run.** Reads only: no unit row, no audit row, nothing flushed; it reports the counts the real
    run would report on the same data. The CLI rolls the session back after a dry run and commits only after
    a real one; any error commits nothing.
  - **F3 Floor cell.** Blank → no floor. Otherwise, after stripping, it must be ASCII `-?[0-9]+` (so `1_0`,
    `٣`, `+3`, `3.0`, `ten` are invalid with reason `floor: must be a whole number`), then `UnitCreate`
    checks the range −20…300. Tower and label go through `UnitCreate` unchanged (strip, 1–20, no control
    characters, blank tower = none).
  - **F4 Invalid row report.** Each invalid row is `line N: <field>: <reason>` or `line N: expected 3
    columns` or `line N: duplicate of line M`, where N is the file line on which the record **starts**
    (a quoted cell may span lines). No cell value appears in the report. Blank lines are skipped and are
    not rows. A row repeating an earlier valid row's `(tower, label)` after normalisation (`" A "` = `"A"`,
    blank tower = none) is the duplicate; a repeat of an *invalid* row is judged on its own.
  - **F5 Whole-file errors (exit 1, no session opened, nothing written):** header not exactly the three
    names `tower,label,floor` in any order (case-sensitive, no repeats, no extras); empty file; more than
    5,000 rows; a file over 1 MiB (**added**: `read_text` would otherwise load any size; 5,000 rows of
    three ≤ 20-character cells are well under it); not UTF-8 (a leading BOM is allowed); unreadable or
    missing path; broken CSV syntax. An unknown building slug is exit 1, nothing written.
  - **F6 Exit code.** A run with invalid rows but no whole-file error exits 0 (D3 of P4-01); the report
    still lists them. A header-only file reports all zeros and exits 0.
  - **F7 Audit.** One row per unit written, in the import's transaction, `actor_user_id` null, the unit's
    building: `unit.created` with `{"source": "import"}`; `unit.updated` with
    `{"fields": ["floor"], "source": "import"}` (the API's `fields` convention). Unchanged rows and dry runs
    write none. `is_active` is never changed (an inactive unit whose floor changes is `updated`, stays
    inactive).
- Tenant table (`ENGINEERING_PRACTICES.md` §7): the import is an operator CLI, not an endpoint, so rows 1–8
  (HTTP roles, 401/403/404) don't apply. Row 9 (retry) is F1's rerun = all `unchanged`, no duplicate row.
  Row 10 (concurrency) is F1's `ON CONFLICT`. Building isolation (the spirit of rows 3 and 7) is the F1
  other-building test.
- Criteria loosened: none.
- Decisions taken (with basis):
  - Partial import, exit 0 with invalid rows listed (ticket, D3 recorded in P4-01).
  - Upsert by `ON CONFLICT` rather than read-then-insert (autonomous; the existing `create_unit` pattern,
    which turns a concurrent duplicate into a conflict, never an `IntegrityError`).
  - 1 MiB file cap and ASCII-only floor digits (autonomous; simplest reversible guard, constants in
    `app/units/service.py`).
  - The unknown-slug message echoes the slug, as the `audit` command's `UnknownFilterValue` does (convention).
- Split: none. Estimate ~220 non-test lines (`4c015f0` measured ~210 for the same scope).
