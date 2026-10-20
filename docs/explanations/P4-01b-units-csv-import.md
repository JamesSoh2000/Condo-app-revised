# Explanation — P4-01b Units CSV import

> **PR:** #85 · **Source revision:** `c1e0c84`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 85 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `c1e0c84` the diff (`git diff origin/main...HEAD`: `backend/app/cli.py`,
> `backend/app/units/service.py`, both test files, the ticket), the whole import section of
> `backend/app/units/service.py` and `import_units_command` / `run_in_session` in `backend/app/cli.py`, the
> assertions of every test cited below, and the PR body (plan, D1–D2, the three review rounds). Ran
> `pytest tests/units` (151 passed) and the CLI journey on `make up` (dry run, real run, rerun, a floor
> change, audit and `updated_at` queries; transcript in the PR, "Stack run at the final head"). Differences
> from the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C (an operator command run).

## 1. What was built and why

An operator command, `python -m app.cli import-units --building SLUG --csv PATH [--dry-run]`, loads a
building's units from a `tower,label,floor` CSV. Each row creates a unit, or updates the floor of the unit
with the same `(tower, label)`. Invalid rows are skipped and listed by line number; the valid rows are still
written. A dry run prints the same report and writes nothing. Pilot onboarding needs ~300 units loaded
safely, and P4-03's `bootstrap-building --units-csv` will call the same service inside its own transaction,
so the service only flushes; the CLI decides whether to commit.

The two decisions that matter most: the import is **partial** (D1), and each row is written by **one atomic
upsert** in a fixed key order (D2). D2 is the result of review round 1, which broke the first two designs.

## 2. Decisions

### D1. Partial import: invalid rows skipped and reported, valid rows written, exit 0

- **Problem or constraint:** criterion 1 expects "the real run creates 300" from a file that also has 2
  invalid rows.
- **Chosen:** `parse_units_csv` sorts rows into `rows` and `invalid`; `import_units` writes only `rows`; the
  CLI exits 0 and prints each invalid line and its reason.
- **Alternatives rejected:** all-or-nothing: contradicts criterion 1.
- **Tradeoffs and accepted limitations:** a script can't tell from the exit code that rows were skipped; it
  has to read the report.
- **Basis:** ticket ("Carried from P4-01", D3 recorded in PR #84).
- **Source:** recorded (ticket; PR #85 D1).

### D2. One atomic upsert per row, rows written in a fixed key order

- **Problem or constraint:** the starting code (`4c015f0`) read the building's units once, then added the
  missing ones, so a unit created by the API in between made the run fail with an `IntegrityError`. The
  plan's replacement, `INSERT … ON CONFLICT DO NOTHING` followed by a separate conditional `UPDATE`, left a
  gap between the two statements. Review round 1 showed that an API rename of the unit in that gap made the
  run report `unchanged` and never write the floor (High), and that two imports writing the same units in
  opposite orders deadlocked (Medium).
- **Chosen:** `backend/app/units/service.py::_write_row` issues one
  `INSERT … ON CONFLICT (uq_units_building_id_tower_label) DO UPDATE SET floor = excluded.floor,
  updated_at = now() WHERE units.floor IS DISTINCT FROM excluded.floor RETURNING id, old.id IS NULL`.
  Postgres decides insert-or-update atomically on the conflicting row and holds its lock. In
  `RETURNING`, `old` (new in Postgres 18) is null for an inserted row, so `old.id IS NULL` means "created".
  No row back means the floor was already equal ("unchanged"). `import_units` writes the rows sorted by
  `backend/app/units/service.py::_write_order`, so any two imports lock units in the same order.
- **Alternatives rejected** (all recorded in PR D2): read-then-insert (the `IntegrityError`);
  `DO NOTHING` + `UPDATE` (the rename gap); retrying that pair when the key moves (more code for what one
  statement does); `RETURNING (xmax = 0)` (relies on undocumented system-column behaviour, where `old` is
  documented); catching `IntegrityError` and failing the run; retrying the transaction on deadlock (sorting
  removes the cycle instead).
- **Tradeoffs and accepted limitations:** requires Postgres 18 (dev, CI and prod-like run 18). One
  statement per row, so up to 5,000 round trips. The dry run classifies rows with a separate read, so a test
  asserts the two agree. The write order isn't the file order; only the report's line numbers refer to the
  file. The upsert is Core SQL, so ORM objects already loaded in the session don't see the new floor
  (round 3, accepted, §7).
- **Basis:** existing convention (`backend/app/units/service.py::create_unit` uses `ON CONFLICT` so a
  concurrent duplicate is never an `IntegrityError`); review round 1 findings 1 and 4; autonomous.
- **Source:** recorded (PR #85 D2, "Independent review" round 1).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Floor cell must be ASCII `-?[0-9]+`, then `UnitCreate` (strict) checks the range | `int(cell)` | `int` accepts `1_0`, `+3`, `٣` | ticket ("the parser converts the cell to `int`"), autonomous on the pattern | PR table |
| Over 3 significant digits → `floor: must be between -20 and 300`, before `int()`; leading zeros dropped first | `int()` then `UnitCreate` | `int()` raises `ValueError` past 4,300 digits, which aborted the run | review round 1 (R1-2) | PR table |
| Files over 1 MiB refused, by the CLI (bounded read) and by the parser; csv's field limit raised to 1 MiB | no cap; csv's default 128 KiB field limit | `read_text` would load any size; P4-03 calls the parser directly; one cell over 128 KiB made the whole file "not valid CSV" | autonomous; review round 1 (R1-3) | PR table |
| `csv.reader(strict=True)` over `StringIO(newline="")` | lenient reader; default newline handling | lenient read an unterminated quote to end of file as one cell; default newline refused CR-only files | autonomous; review round 2 (R2-1) | PR "Changes against the starting code", round 2 |
| Line number = where the record starts | `reader.line_num` (where it ends) | a quoted multi-line cell would point past the row | autonomous | PR table |
| `unit.updated` metadata `{"fields": ["floor"], "source": "import"}`; `unit.created` `{"source": "import"}`; no actor | `{"source": "import"}` for both | the API's `unit.updated` carries `fields` | convention | PR table, Frame F7 |
| Unknown slug error echoes the slug (`repr`) | omit it | the `audit` command's `UnknownFilterValue` does the same | convention | PR table |

**Framing changes:** criterion 1 kept as written; the Frame notes added F1–F7 (rerun and concurrency, dry
run, floor cell rules, report format, whole-file errors including a new 1 MiB cap, exit code, audit). None
loosened.

**Plan versus final code:** the Plan's `_write_row` was "INSERT … DO NOTHING, else a conditional UPDATE";
the final code is the single `DO UPDATE` statement plus the sorted write order (D2, round 1). The Plan put
the 1 MiB cap only in the CLI; it is now also in `parse_units_csv` (round 1). Overlong floors get their own
reason, which Frame F3 didn't list (round 1). `updated_at` is set by the upsert (round 2). Otherwise the
files, interfaces and criterion → test map match the Plan, with more tests than it listed.

## 3. How it is implemented

### Overview

- `backend/app/cli.py::import_units_command`: reads at most 1 MiB + 1 byte, decodes UTF-8, parses, all
  before opening a database session; then resolves the slug and runs the import in one session.
- `backend/app/cli.py::run_in_session`: commits after the work, or rolls back when `commit=False` (dry run).
  An exception commits nothing.
- `backend/app/units/service.py::parse_units_csv`: pure function, text → `ParsedUnits(rows, invalid)`, or
  `CsvError` for a whole-file problem.
- `backend/app/units/service.py::import_units`: dry run = one read and a count; real run = one
  `_write_row` per row in `_write_order`, then `flush`. Never commits.
- `backend/app/units/service.py::render_import_report`: the printed report.

### Walkthrough (variant C: one real run)

1. **Trigger.** `make cli args="import-units --building birch --csv .stackrun/units.csv"` (runs
   `python -m app.cli …` in the app container, where `backend/` is mounted at `/app`).
2. **Read.** `import_units_command` opens the file in binary mode and reads `MAX_IMPORT_BYTES + 1` bytes. More
   than 1 MiB → `error: the file is larger than 1024 KiB`, exit 1. A missing file → `error: can't read …`,
   non-UTF-8 → `error: the file is not UTF-8 text`, exit 1. No session has been opened yet.
3. **Parse.** `parse_units_csv` strips a BOM and reads with `csv.reader(strict=True)`. The header must be
   exactly the three names in any order, or it raises `CsvError`. For each record it keeps the line the record
   **starts** on; skips blank records; raises `CsvError` past 5,000 rows; then checks the column count, the
   floor cell (pattern, digit cap, conversion) and `UnitCreate` (tower/label strip, 1–20 characters, no
   control characters, blank tower = none, floor −20…300). A `(tower, label)` already seen among valid rows
   is `duplicate of line N`. Broken CSV raises `CsvError("line N: not valid CSV")`.
4. **Resolve.** Inside `run_in_session`, `building_id_for_slug` → `UnknownBuilding`, exit 1, nothing
   committed.
5. **Write.** `import_units(…, dry_run=False)` writes the rows in key order, one statement each (SQL below),
   with an audit row for each create or update in the same transaction, then flushes.
6. **Commit and print.** `run_in_session(work, commit=True)` commits once; the CLI prints the report:

```
created: 300
updated: 0
unchanged: 0
invalid: 2
  line 12: label: String should have at least 1 character
  line 52: floor: must be a whole number
```

   A rerun prints `unchanged: 300`; a dry run prints `dry run: nothing was written` first and rolls back
   (stack transcript at `c1e0c84` in the PR: units 308 → 308 after the dry run, → 608 after the real run,
   608 after the rerun).
7. **Recover.** The import is safe to re-run: rows already there with the same floor are `unchanged` and
   write nothing (§9 Q1). A failure partway commits nothing, so rerun after fixing the cause.

<details><summary>Deeper: the SQL one real-run row sends</summary>

Compiled from `_write_row` with SQLAlchemy's asyncpg dialect at `c1e0c84` (line breaks added). `is_active`
and `id` are the model's Python-side defaults (`true`, a new uuid7); on a conflict neither is touched:

```sql
INSERT INTO units (building_id, tower, label, floor, is_active, id)
VALUES ($1::UUID, $2::VARCHAR, $3::VARCHAR, $4::INTEGER, $5::BOOLEAN, $6::UUID)
ON CONFLICT ON CONSTRAINT uq_units_building_id_tower_label
DO UPDATE SET floor = excluded.floor, updated_at = now()
WHERE units.floor IS DISTINCT FROM excluded.floor
RETURNING units.id, old.id IS NULL
```

The constraint is `UNIQUE NULLS NOT DISTINCT (building_id, tower, label)` (P4-01a), so a tower-less unit
conflicts with a tower-less unit of the same label.
</details>

### Data model changes

None. No table, column or migration; the import uses P4-01a's `units` table and unique constraint.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/units/service.py` | parser, upsert, import, report | +213 / −6 |
| `backend/app/cli.py` | `import-units`; `run_in_session(commit=)` | +58 / −3 |
| `backend/tests/units/test_import.py` | parser, service and CLI tests | +521 |
| `backend/tests/units/test_concurrency.py` | four real-connection race tests for the import | +260 / −4 |
| `docs/tickets/P4-01b-units-csv-import.md` | Frame notes, status | +44 / −5 |

`backend/app/units/service.py::_write_row`

```python
    stmt = insert(Unit).values(
        building_id=building_id, tower=row.tower, label=row.label, floor=row.floor
    )
    written = (
        await db.execute(
            stmt.on_conflict_do_update(
                constraint="uq_units_building_id_tower_label",
                # updated_at by hand: the mixin's `onupdate` is ORM-only (review round 2).
                set_={"floor": stmt.excluded.floor, "updated_at": func.now()},
                where=Unit.floor.is_distinct_from(stmt.excluded.floor),
            ).returning(Unit.id, literal_column("old.id IS NULL", Boolean))
        )
    ).one_or_none()
    if written is None:
        return "unchanged"
    unit_id, created = written
    await record_audit(
        db,
        action=actions.UNIT_CREATED if created else actions.UNIT_UPDATED,
        # ...
        metadata={"source": "import"} if created else {"fields": ["floor"], "source": "import"},
    )
    return "created" if created else "updated"
```

- One statement decides created / updated / unchanged and writes, so nothing can change the unit between a
  check and a write (D2).
- Without the `where=`, every existing row would be rewritten and reported `updated` with an audit row, so a
  rerun would never report `unchanged`. Without `updated_at` in `set_`, the timestamp stays stale
  (`test_floor_update_advances_updated_at`).

`backend/app/units/service.py::import_units` (the two paths)

```python
    if dry_run:
        floors = {
            (unit.tower, unit.label): unit.floor
            for unit in await db.execute(
                select(Unit.tower, Unit.label, Unit.floor).where(Unit.building_id == building_id)
            )
        }
        for row in parsed.rows:
            # ... created / updated / unchanged by lookup
    else:
        for row in sorted(parsed.rows, key=_write_order):
            counts[await _write_row(db, building_id, row)] += 1
        await db.flush()
```

- The dry run only reads, so it can't write by accident; both paths filter by `building_id`.
- Remove the `sorted(…)` and two concurrent imports with opposite orders deadlock (mutation probe in the PR:
  `test_concurrent_imports_in_opposite_orders_both_finish` fails).

`backend/app/units/service.py::parse_units_csv` (the floor cell)

```python
            cell = record[index["floor"]].strip()
            if cell and _WHOLE_NUMBER.fullmatch(cell) is None:
                invalid.append(InvalidRow(start, "floor: must be a whole number"))
                continue
            digits = cell.lstrip("-").lstrip("0")
            if len(digits) > _MAX_FLOOR_DIGITS:
                # Before `int()`, which raises ValueError past 4,300 digits (review round 1).
                reason = f"floor: must be between {MIN_FLOOR} and {MAX_FLOOR}"
                invalid.append(InvalidRow(start, reason))
                continue
            floor = (-1 if cell.startswith("-") else 1) * int(digits or "0") if cell else None
```

- `UnitCreate.floor` is strict (P4-01a round 1), so the cell must become an `int` first. `_WHOLE_NUMBER` is
  `-?[0-9]+`: ASCII only, no `+`, no `_`.
- `int()` counts leading zeros toward its 4,300-digit limit, so the zeros are dropped before converting:
  `"0"*5000 + "7"` is floor 7 (`test_floor_cell_whole_numbers_are_accepted[zeros-5000]`).

`backend/app/cli.py::import_units_command` (the read)

```python
        with Path(csv_path).open("rb") as file:
            data = file.read(MAX_IMPORT_BYTES + 1)
        if len(data) > MAX_IMPORT_BYTES:
            raise CsvError(f"the file is larger than {MAX_IMPORT_BYTES // 1024} KiB")
        parsed = parse_units_csv(data.decode("utf-8"))
```

- A bounded read: a huge file (or `/dev/zero`) is never loaded whole. All of this happens before
  `run_in_session`, so a bad file never opens a database session (`test_cli_bad_file_exits_1_before_any_session`
  replaces the session factory with one that fails the test).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Dry run writes | Reads only; CLI rolls back | `backend/tests/units/test_import.py::test_dry_run_reports_and_writes_nothing` (no new/dirty objects, unit set unchanged, no audit rows); `backend/tests/units/test_import.py::test_cli_dry_run_rolls_back` |
| Dry-run counts differ from the real run | Same data → same counts | `backend/tests/units/test_import.py::test_dry_run_counts_match_the_real_run` (2/1/1 both) |
| Rerun duplicates units | `unchanged`, no write | `backend/tests/units/test_import.py::test_real_run_creates_then_rerun_is_unchanged` (300 then 300 unchanged, 303 units, 300 audit rows) |
| Another building's unit with the same key | Never read or written | `backend/tests/units/test_import.py::test_import_writes_only_its_own_building` |
| Case differences | Different units (the constraint is case-sensitive) | `backend/tests/units/test_import.py::test_label_match_is_case_sensitive` |
| Inactive unit | Floor updated, stays inactive; audit metadata | `backend/tests/units/test_import.py::test_floor_change_is_updated_and_activity_is_left_alone` |
| API creates the same unit concurrently (commit / rollback) | Import waits, then updates / creates | `backend/tests/units/test_concurrency.py::test_import_waits_for_a_concurrent_api_create_of_the_same_unit` |
| API renames the unit right after the import's statement | Import's write already done; rename waits | `backend/tests/units/test_concurrency.py::test_import_is_not_lost_when_the_api_renames_the_unit_between_statements` |
| API renames first, holding the row | Import waits, then creates `(A,x)`; `z` keeps its floor | `backend/tests/units/test_concurrency.py::test_import_waits_for_a_concurrent_rename_then_creates_the_unit` |
| Two imports in opposite orders | Both finish | `backend/tests/units/test_concurrency.py::test_concurrent_imports_in_opposite_orders_both_finish` |
| Floor cell forms | `-3`, ` 7 `, `007`, blank accepted; `1_0`, `+3`, `٣`, `3.0`, `1e2`, `true`… refused | `backend/tests/units/test_import.py::test_floor_cell_whole_numbers_are_accepted`, `backend/tests/units/test_import.py::test_floor_cell_must_be_an_ascii_whole_number` |
| 4,301-digit floor; 10-digit; `-1000` | One invalid row, the rest imported | `backend/tests/units/test_import.py::test_overlong_floor_is_one_invalid_row_not_a_file_error` |
| Cell over 128 KiB (tower, label, floor) | One invalid row | `backend/tests/units/test_import.py::test_overlong_cell_is_one_invalid_row_not_a_file_error` |
| Text over 1 MiB given to the parser | `CsvError` | `backend/tests/units/test_import.py::test_text_over_1_mib_is_refused_by_the_parser_too` |
| LF / CRLF / CR files, multi-line quoted cell | All read; lines 2, 3, 5 | `backend/tests/units/test_import.py::test_every_csv_line_ending_is_read` |
| Line numbers with a multi-line record and a blank line | Start line reported | `backend/tests/units/test_import.py::test_line_is_where_a_multiline_record_starts` |
| Duplicates (`" A "` = `"A"`, blank tower = none); repeat of an invalid row | Second valid occurrence invalid; repeat of an invalid row judged alone | `backend/tests/units/test_import.py::test_duplicates_are_found_after_normalising`, `backend/tests/units/test_import.py::test_duplicate_row_in_file_is_invalid_from_its_second_occurrence`, `backend/tests/units/test_import.py::test_repeat_of_an_invalid_row_is_judged_on_its_own` |
| Report leaks a value | Reasons only | `backend/tests/units/test_import.py::test_report_lists_counts_and_invalid_lines` (asserts `"bad" not in text`), `backend/tests/units/test_import.py::test_invalid_rows_are_reported_by_line_and_reason_without_values` |
| Header wrong, empty, 5,001 rows; blank lines | `CsvError`; blank lines not counted | `backend/tests/units/test_import.py::test_header_errors_refuse_the_whole_file`, `backend/tests/units/test_import.py::test_too_many_rows_refuse_the_whole_file`, `backend/tests/units/test_import.py::test_blank_lines_are_not_rows` |
| Service commits | It never does | `backend/tests/units/test_import.py::test_import_flushes_but_never_commits` (commit replaced with a failure; a mutation adding `db.commit()` failed it) |
| Stale `updated_at` | Advanced on update, kept on unchanged | `backend/tests/units/test_import.py::test_floor_update_advances_updated_at`, `backend/tests/units/test_import.py::test_unchanged_row_keeps_updated_at` |
| Bad file / unknown building / invalid rows | Exit 1 before a session / exit 1 uncommitted / exit 0 committed | `backend/tests/units/test_import.py::test_cli_bad_file_exits_1_before_any_session` (header, not-UTF-8, empty, broken CSV, over 1 MiB), `backend/tests/units/test_import.py::test_cli_missing_file_exits_1`, `backend/tests/units/test_import.py::test_cli_unknown_building_exits_1_without_committing`, `backend/tests/units/test_import.py::test_cli_invalid_rows_still_exit_0` |
| Unreadable (not missing) file | Same `OSError` branch as missing | No test (round 3 note) |
| Database error midway through a real run | Session not committed; earlier rows and audits roll back | No real-database test (§7) |

Acceptance criteria → tests: criterion 1 dry run → `test_dry_run_reports_and_writes_nothing` and the
stack transcript; real run 300 / rerun 300 unchanged → `test_real_run_creates_then_rerun_is_unchanged`
and the stack transcript; F1–F7 → the rows above (PR "Acceptance criteria → evidence" maps each).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | fresh Codex `gpt-6.1-sol` (high) | `b8daa42` | BLOCK | High: rename between INSERT and UPDATE drops the floor. Medium: 4,301-digit floor aborts the run. Medium: cell over 128 KiB is a whole-file error. Medium: opposite-order imports deadlock | All fixed in `811d399` (tests `a58c59a`) |
| 2 | fresh Codex `gpt-6.1-sol` (high) | `811d399` | MERGE | Medium: CR-only CSV refused. Low: `updated_at` stale after an import update | Both fixed in `c1e0c84` (tests `a84a2b4`) |
| 3 | fresh Codex `gpt-6.1-sol` (high) | `c1e0c84` | MERGE | Low: ORM `Unit` loaded earlier in the session keeps its old floor | Accepted (§7) |

By James's instruction for this run, every round used a fresh Codex `gpt-6.1-sol` at high effort and no
Claude reviewer.

- **R1-1 (High).** Failure: `(A,x,1)` exists; import `(A,x,5)`; the API renames `x` → `z` after the
  import's `INSERT … DO NOTHING` returned nothing and before its `UPDATE`: the run said `unchanged: 1`, the
  database held only `(A,z,1)`. Evidence: `test_import_is_not_lost_when_the_api_renames_the_unit_between_statements`
  failed before `811d399`, passes after. Produced D2.
- **R1-2.** `int()` raised `ValueError` on a 4,301-digit cell, which escaped `parse_units_csv`; no report,
  nothing imported. Evidence: `test_overlong_floor_is_one_invalid_row_not_a_file_error` failed, passes; the
  neighbour `zeros-5000` case came from checking that `int()` counts leading zeros.
- **R1-3.** A 131,073-character label in a file under 1 MiB hit csv's field limit: `CsvError: not valid CSV`.
  Evidence: `test_overlong_cell_is_one_invalid_row_not_a_file_error` (3 columns) failed, passes.
- **R1-4.** `[x,y]` and `[y,x]` concurrently: `deadlock detected`. Evidence:
  `test_concurrent_imports_in_opposite_orders_both_finish` failed, passes. It first passed vacuously (its
  hook watched only `execute`, the old code wrote with `scalar`), and was fixed to hook both before the fix.
- **R2-1.** `tower,label,floor\rA,101,1\r` → `line 1: not valid CSV`. Evidence:
  `test_every_csv_line_ending_is_read[cr]` failed, passes.
- **R2-2.** Updated row kept `updated_at = 2020-01-01`. Evidence: `test_floor_update_advances_updated_at`
  failed, passes.

Mutation probes (PR): removing `ON CONFLICT`, lax floor parsing, the 1 MiB cap, start-line tracking,
strict CSV, the sort, leading-zero stripping, the field-limit raise, `newline=""` and `updated_at` each made
at least one named test fail.

## 7. Not verified, accepted risks and follow-ups

- **R3-1 (Low, accepted).** `import_units` writes with Core statements, so a `Unit` the caller loaded earlier
  in the same session keeps its old floor in the identity map. The CLI is unaffected (fresh session, no units
  loaded). P4-03 must not reuse units loaded before the import, or must use `populate_existing` /
  `expire_all()`. Tracked: PR follow-ups; a carry note will be added to P4-03 in the bookkeeping commit after this explanation.
- **No real-database test of a failure midway** (say a database error on row 200) rolling back earlier
  units and audit rows. The behaviour follows from `run_in_session` not reaching `commit` on an exception,
  and the CLI wiring is tested with a fake session only. Tracked only here and in the PR.
- **No test of an existing but unreadable file** (permissions); it shares the missing-file `OSError` branch.
- **Postgres 18 requirement** (`RETURNING old`). Dev, CI and prod-like run 18; D-01's RDS must too. Tracked:
  PR follow-ups; a line will be added to the inbox and D-01 in the bookkeeping commit.
- **Performance** for 5,000 rows (≤ 5,000 statements) was not measured; the 300-row stack run finished in
  seconds (not timed precisely).
- The dry run's counts are a snapshot: a concurrent change between the dry run and the real run can change
  the real run's counts. Expected, not tested.

## 8. How to change this safely

- **Add a CSV column** (say `notes`): add it to `_COLUMNS`, to the `UnitCreate` call in `parse_units_csv`,
  to `ImportRow`, to the `insert(...).values` and `set_` / `where=` in `_write_row`, and to the dry run's
  comparison in `import_units`. `test_header_errors_refuse_the_whole_file` and
  `test_dry_run_counts_match_the_real_run` will tell you if the header or the two paths drift.
- **Change the matching key**: it must stay the unique constraint `_write_row` names, or `ON CONFLICT` can't
  use it; `test_label_match_is_case_sensitive` pins today's exact matching.
- Keep `import_units` free of `commit` (`test_import_flushes_but_never_commits`), and keep the sort
  (`test_concurrent_imports_in_opposite_orders_both_finish`).

## 9. Must explain, then quiz

**1. What makes the CSV import safe to re-run?** Each row is written by
`backend/app/units/service.py::_write_row`, an upsert on the `(building_id, tower, label)` unique
constraint whose `DO UPDATE` runs only `WHERE units.floor IS DISTINCT FROM excluded.floor`. A rerun of the
same file finds every unit with the same floor: no row is written, no audit row is added, and the report
says `unchanged` (`test_real_run_creates_then_rerun_is_unchanged`; stack: 608 units before and after the
rerun). Duplicates inside one file are refused from their second occurrence, so one run never writes a key
twice. A failed run commits nothing, so rerunning after a fix starts from a clean state. Concurrent writers
(the API, another import) are resolved by the same statement, so a rerun never meets an `IntegrityError`
(the concurrency tests in §5).

**2. Why is the import a service that never commits, with the CLI deciding?** The ticket requires it:
P4-03's `bootstrap-building` will create a building and its units in one transaction, so it must call
`import_units` without that call committing halfway (ticket "Interfaces"; `CLAUDE.md` rule 5 says only the
use-case commits, once). Here the use-case is the CLI command: `backend/app/cli.py::run_in_session` commits
after a real run and rolls back after a dry run, so `--dry-run` is "the same work, rolled back" plus a read-only
path in `import_units`. `test_import_flushes_but_never_commits` keeps the service honest.

Quiz:

1. Why does the import write rows sorted by `_write_order` instead of in file order?
2. A unit `(A, 7)` exists at floor 7. What does the import report, and what does it write, for the row
   `A,7,7`? For `A,7,8`?
3. Why is `0000…0007` (5,000 zeros) accepted but `1000000000` refused with "must be between"?
4. What would break if `where=Unit.floor.is_distinct_from(stmt.excluded.floor)` were removed?
5. How would you extend the import to also set `is_active` from a fourth column?

<details><summary>Answers</summary>

1. Two concurrent imports lock units as they write them. In opposite orders, each holds one the other needs:
   a deadlock (review round 1). One global order means the second import waits for the first instead.
2. `A,7,7`: `unchanged`, no write, no audit row, `updated_at` kept (`test_unchanged_row_keeps_updated_at`).
   `A,7,8`: `updated`, floor 8, `updated_at = now()`, a `unit.updated` audit row with
   `{"fields": ["floor"], "source": "import"}`.
3. Leading zeros are stripped before the digit cap and before `int()`, so the value is 7. `1000000000` has
   10 significant digits, over the cap of 3, so it is refused before `int()` (no floor that long is in
   range, and `int()` fails past 4,300 digits).
4. Every existing row would be rewritten: a rerun would report all rows `updated`, write an audit row for
   each and advance every `updated_at`, so the import would no longer be idempotent in its report or audit.
5. Add `is_active` to `_COLUMNS`, parse it strictly (like the floor cell), add it to `ImportRow`, to `set_`
   and to the `where=` (distinct floor **or** distinct `is_active`), and decide the audit metadata `fields`
   per change. Mind P4-01a's rule that a unit with current occupants can't be deactivated: the upsert would
   bypass `deactivate_unit`'s lock and check, so this needs its own design, likely an ADR-level decision.

</details>
