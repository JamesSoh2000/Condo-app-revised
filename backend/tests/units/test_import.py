"""The CSV unit import (P4-01b; Frame notes F1-F7).

`parse_units_csv` and `import_units` run in the test's transaction. A CLI command runs its own event
loop, which can't share the test's connection (tests/test_cli_seed.py), so the CLI tests check
the parsing, the refusals and the commit/rollback wiring with a fake session; the command itself is
run on the stack in the PR.
"""

import asyncio
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from typer.testing import CliRunner

from app import cli
from app.audit.models import AuditEvent
from app.units import service
from app.units.models import Unit
from app.units.service import (
    MAX_IMPORT_BYTES,
    MAX_IMPORT_ROWS,
    CsvError,
    import_units,
    parse_units_csv,
    render_import_report,
)
from tests.factories import make_unit

pytestmark = pytest.mark.anyio

HEADER = "tower,label,floor\n"


def _csv_300_valid_2_invalid() -> str:
    rows = [f"{t},{n},{n // 100}" for t in ("A", "B", "C") for n in range(1001, 1101)]
    rows.insert(10, "A,,3")  # line 12: no label
    rows.insert(50, "A,1001x,ten")  # line 52: floor isn't an integer
    return HEADER + "\n".join(rows) + "\n"


async def _units(db: AsyncSession, building_id: Any) -> dict[tuple[str | None, str], Unit]:
    rows = await db.scalars(select(Unit).where(Unit.building_id == building_id))
    return {(u.tower, u.label): u for u in rows}


async def _audit_count(db: AsyncSession, action: str) -> int:
    stmt = select(func.count()).where(AuditEvent.action == action)
    return await db.scalar(stmt) or 0


async def test_dry_run_reports_and_writes_nothing(db, world):
    parsed = parse_units_csv(_csv_300_valid_2_invalid())
    before = await _units(db, world.a.id)

    report = await import_units(db, world.a.id, parsed, dry_run=True)

    assert (report.created, report.updated, report.unchanged) == (300, 0, 0)
    assert [(r.line, r.reason) for r in report.invalid] == [
        (12, "label: String should have at least 1 character"),
        (52, "floor: must be a whole number"),
    ]
    assert not db.new
    assert not db.dirty
    assert await _units(db, world.a.id) == before
    assert await _audit_count(db, "unit.created") == 0


async def test_real_run_creates_then_rerun_is_unchanged(db, world):
    parsed = parse_units_csv(_csv_300_valid_2_invalid())

    first = await import_units(db, world.a.id, parsed, dry_run=False)
    await db.flush()
    second = await import_units(db, world.a.id, parsed, dry_run=False)

    assert (first.created, first.updated, first.unchanged, len(first.invalid)) == (300, 0, 0, 2)
    assert (second.created, second.updated, second.unchanged, len(second.invalid)) == (0, 0, 300, 2)
    units = await _units(db, world.a.id)
    assert len(units) == 303  # the world's 101, 102, 201 and the 300
    assert units[("B", "1050")].floor == 10
    assert units[("B", "1050")].is_active is True
    assert await _audit_count(db, "unit.created") == 300
    event = await db.scalar(select(AuditEvent).where(AuditEvent.action == "unit.created").limit(1))
    assert event is not None
    assert (event.building_id, event.actor_user_id, event.entity_type) == (world.a.id, None, "unit")
    assert event.metadata_ == {"source": "import"}


async def test_import_writes_only_its_own_building(db, world):
    parsed = parse_units_csv(HEADER + ",101,1\n,555,5\n")

    report = await import_units(db, world.b.id, parsed, dry_run=False)

    # B already has 101 (no floor): updated to floor 1; A's 101 is untouched.
    assert (report.created, report.updated, report.unchanged) == (1, 1, 0)
    assert world.a_101.floor is None
    assert (await _units(db, world.b.id))[(None, "101")].floor == 1
    assert (None, "555") not in await _units(db, world.a.id)


async def test_floor_change_is_updated_and_activity_is_left_alone(db, world):
    unit = await make_unit(db, world.a, tower="A", label="7", floor=7, is_active=False)

    report = await import_units(
        db, world.a.id, parse_units_csv(HEADER + "A,7,8\n,101,\n"), dry_run=False
    )

    assert (report.created, report.updated, report.unchanged) == (0, 1, 1)
    await db.refresh(unit)
    assert (unit.floor, unit.is_active) == (8, False)
    event = await db.scalar(select(AuditEvent).where(AuditEvent.action == "unit.updated"))
    assert event is not None
    assert (event.entity_id, event.metadata_) == (
        unit.id,
        {"fields": ["floor"], "source": "import"},
    )


async def test_dry_run_counts_match_the_real_run(db, world):
    await make_unit(db, world.a, tower="A", label="1", floor=1)
    await make_unit(db, world.a, tower="A", label="2", floor=2)
    parsed = parse_units_csv(HEADER + "A,1,1\nA,2,5\nA,3,3\n,4,\n")

    dry = await import_units(db, world.a.id, parsed, dry_run=True)
    real = await import_units(db, world.a.id, parsed, dry_run=False)

    assert (dry.created, dry.updated, dry.unchanged) == (2, 1, 1)
    assert (real.created, real.updated, real.unchanged) == (2, 1, 1)


async def test_label_match_is_case_sensitive(db, world):
    await make_unit(db, world.a, tower="a", label="ph", floor=9)

    report = await import_units(db, world.a.id, parse_units_csv(HEADER + "A,PH,9\n"), dry_run=False)

    assert (report.created, report.updated, report.unchanged) == (1, 0, 0)
    assert {("a", "ph"), ("A", "PH")} <= set(await _units(db, world.a.id))


async def test_header_only_reports_zeros(db, world):
    report = await import_units(db, world.a.id, parse_units_csv(HEADER), dry_run=False)

    assert (report.created, report.updated, report.unchanged, report.invalid) == (0, 0, 0, [])


@pytest.mark.parametrize(
    ("cell", "floor"),
    [
        ("-3", -3),
        (" 7 ", 7),
        ("0", 0),
        ("", None),
        ("  ", None),
        ("007", 7),
        ("-000", 0),
        # Leading zeros don't count towards int()'s 4,300-digit limit (review round 1 neighbour).
        ("0" * 5000 + "7", 7),
        ("-" + "0" * 5000 + "20", -20),
    ],
    ids=[
        "neg",
        "spaces",
        "zero",
        "blank",
        "blank-spaces",
        "zeros",
        "neg-zero",
        "zeros-5000",
        "neg-zeros",
    ],
)
def test_floor_cell_whole_numbers_are_accepted(cell, floor):
    parsed = parse_units_csv(HEADER + f"A,1,{cell}\n")

    assert [(r.label, r.floor) for r in parsed.rows] == [("1", floor)]


@pytest.mark.parametrize("cell", ["1_0", "+3", "\u0663", "3.0", "ten", "- 3", "1e2", "true"])
def test_floor_cell_must_be_an_ascii_whole_number(cell):
    parsed = parse_units_csv(HEADER + f"A,1,{cell}\n")

    assert parsed.rows == []
    assert [(r.line, r.reason) for r in parsed.invalid] == [(2, "floor: must be a whole number")]


@pytest.mark.parametrize("cell", ["9" * 4301, "-" + "9" * 4301, "1" + "0" * 9, "-1000"])
def test_overlong_floor_is_one_invalid_row_not_a_file_error(cell):
    # Review round 1 (Codex): `int()` raised ValueError past 4,300 digits and aborted the import.
    parsed = parse_units_csv(HEADER + f"A,good,3\nA,bad,{cell}\n")

    assert [(r.label, r.floor) for r in parsed.rows] == [("good", 3)]
    assert [(r.line, r.reason) for r in parsed.invalid] == [
        (3, "floor: must be between -20 and 300")
    ]


@pytest.mark.parametrize("column", ["tower", "label", "floor"])
def test_overlong_cell_is_one_invalid_row_not_a_file_error(column):
    # Review round 1 (Codex): a cell over csv's default field limit (128 KiB) made the whole
    # file "not valid CSV" although it fits in the 1 MiB cap.
    cells = {"tower": "A", "label": "big", "floor": "4"}
    # csv's default limit; the parser raises it process-wide, so don't read it back here.
    cells[column] = "7" * (128 * 1024 + 1)
    text = HEADER + "A,good,3\n" + ",".join(cells.values()) + "\n"
    assert len(text.encode()) < MAX_IMPORT_BYTES

    parsed = parse_units_csv(text)

    assert [r.label for r in parsed.rows] == ["good"]
    assert [r.line for r in parsed.invalid] == [3]
    assert parsed.invalid[0].reason.startswith(f"{column}: ")


def test_text_over_1_mib_is_refused_by_the_parser_too():
    # P4-03 calls parse_units_csv without the CLI's read cap.
    with pytest.raises(CsvError, match="larger than"):
        parse_units_csv(HEADER + ("A," + "x" * 250 + ",\n") * 4500)


def test_line_is_where_a_multiline_record_starts():
    parsed = parse_units_csv(HEADER + 'A,"x\ny",1\n\nA,ok,\nA,,1\n')

    assert [(r.line, r.reason) for r in parsed.invalid] == [
        (2, "label: must not contain control characters"),
        (6, "label: String should have at least 1 character"),
    ]
    assert [(r.line, r.label) for r in parsed.rows] == [(5, "ok")]


def test_repeat_of_an_invalid_row_is_judged_on_its_own():
    parsed = parse_units_csv(HEADER + "A,1,ten\nA,1,2\n")

    assert [(r.line, r.tower, r.label, r.floor) for r in parsed.rows] == [(3, "A", "1", 2)]
    assert [r.line for r in parsed.invalid] == [2]


def test_duplicates_are_found_after_normalising():
    parsed = parse_units_csv(HEADER + " A , 1 ,\nA,1,\n ,2,\n,2,\n")

    assert [(r.line, r.reason) for r in parsed.invalid] == [
        (3, "duplicate of line 2"),
        (5, "duplicate of line 4"),
    ]


def test_blank_lines_are_not_rows():
    rows = "".join(f",{n},\n\n" for n in range(MAX_IMPORT_ROWS))

    assert len(parse_units_csv(HEADER + rows).rows) == MAX_IMPORT_ROWS


def test_blank_tower_and_floor_are_null_and_values_are_stripped():
    parsed = parse_units_csv(HEADER + " , 101 , \nT1,PH, 3 \n")

    assert [(r.line, r.tower, r.label, r.floor) for r in parsed.rows] == [
        (2, None, "101", None),
        (3, "T1", "PH", 3),
    ]


def test_header_order_is_free_and_a_bom_is_ignored():
    parsed = parse_units_csv("﻿label,floor,tower\n101,1,A\n")

    assert [(r.tower, r.label, r.floor) for r in parsed.rows] == [("A", "101", 1)]


def test_duplicate_row_in_file_is_invalid_from_its_second_occurrence():
    parsed = parse_units_csv(HEADER + "A,1,1\n,1,1\nA,1,2\n")

    assert [(r.tower, r.label) for r in parsed.rows] == [("A", "1"), (None, "1")]
    assert [(r.line, r.reason) for r in parsed.invalid] == [(4, "duplicate of line 2")]


@pytest.mark.parametrize(
    ("row", "reason"),
    [
        ("A,1,1,extra", "expected 3 columns"),
        ("A,1", "expected 3 columns"),
        ("A," + "x" * 21 + ",1", "label: String should have at most 20 characters"),
        ("A,1\x002,1", "label: must not contain control characters"),
        ("A,1,301", "floor: Input should be less than or equal to 300"),
    ],
)
def test_invalid_rows_are_reported_by_line_and_reason_without_values(row, reason):
    parsed = parse_units_csv(HEADER + row + "\n")

    assert parsed.rows == []
    assert [(r.line, r.reason) for r in parsed.invalid] == [(2, reason)]


@pytest.mark.parametrize(
    "text",
    [
        "",
        "tower,label\nA,1\n",
        "tower,label,floor,notes\nA,1,1,x\n",
        "tower,label,label\nA,1,1\n",
        "Tower,Label,Floor\nA,1,1\n",
    ],
)
def test_header_errors_refuse_the_whole_file(text):
    with pytest.raises(CsvError):
        parse_units_csv(text)


def test_too_many_rows_refuse_the_whole_file():
    rows = "".join(f",{n},\n" for n in range(MAX_IMPORT_ROWS + 1))
    with pytest.raises(CsvError):
        parse_units_csv(HEADER + rows)


def test_report_lists_counts_and_invalid_lines():
    parsed = parse_units_csv(HEADER + ",1,\nbad,,\n")
    report = service.ImportReport(created=1, updated=0, unchanged=0, invalid=parsed.invalid)

    text = render_import_report(report, dry_run=True)

    assert text.splitlines() == [
        "dry run: nothing was written",
        "created: 1",
        "updated: 0",
        "unchanged: 0",
        "invalid: 1",
        "  line 3: label: String should have at least 1 character",
    ]
    assert "bad" not in text


# The CLI wiring (fake session; the stack run is in the PR)


class FakeSession:
    def __init__(self) -> None:
        self.committed = False
        self.rolled_back = False

    async def __aenter__(self) -> FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


@pytest.fixture
def fake_session(monkeypatch: pytest.MonkeyPatch) -> FakeSession:
    session = FakeSession()
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: session)

    async def no_dispose() -> None:
        return None

    monkeypatch.setattr(cli, "dispose_database_engine", no_dispose)
    return session


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    recorded: list[dict[str, Any]] = []

    async def fake_building_id(db: Any, slug: str) -> Any:
        if slug != "maple":
            raise service.UnknownBuilding(f"no building with slug {slug!r}")
        return "building-id"

    async def fake_import(db: Any, building_id: Any, parsed: Any, *, dry_run: bool) -> Any:
        recorded.append({"building_id": building_id, "rows": len(parsed.rows), "dry_run": dry_run})
        return service.ImportReport(created=len(parsed.rows), updated=0, unchanged=0, invalid=[])

    monkeypatch.setattr(cli, "building_id_for_slug", fake_building_id)
    monkeypatch.setattr(cli, "import_units", fake_import)
    return recorded


def _run(*args: str) -> Any:
    return CliRunner().invoke(cli.app, ["import-units", *args])


def _csv(tmp_path: Path, text: str) -> str:
    path = tmp_path / "units.csv"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_cli_real_run_commits_and_prints_the_report(tmp_path, fake_session, calls):
    result = _run("--building", "maple", "--csv", _csv(tmp_path, HEADER + ",1,\n,2,\n"))

    assert result.exit_code == 0, result.output
    assert calls == [{"building_id": "building-id", "rows": 2, "dry_run": False}]
    assert fake_session.committed
    assert "created: 2" in result.output


def test_cli_dry_run_rolls_back(tmp_path, fake_session, calls):
    result = _run("--building", "maple", "--csv", _csv(tmp_path, HEADER + ",1,\n"), "--dry-run")

    assert result.exit_code == 0, result.output
    assert calls == [{"building_id": "building-id", "rows": 1, "dry_run": True}]
    assert not fake_session.committed
    assert fake_session.rolled_back
    assert result.output.startswith("dry run: nothing was written")


def test_cli_unknown_building_exits_1_without_committing(tmp_path, fake_session, calls):
    result = _run("--building", "nope", "--csv", _csv(tmp_path, HEADER + ",1,\n"))

    assert result.exit_code == 1
    assert calls == []
    assert not fake_session.committed


@pytest.mark.parametrize(
    "content",
    [
        b"tower,label\n,1\n",
        b"tower,label,floor\n\xff\xfe,1,\n",
        b"",
        b'tower,label,floor\nA,"1,\n',
        # Over 1 MiB in fewer than 5,000 rows of short-enough cells: only the size cap refuses it.
        b"tower,label,floor\n" + (b"A," + b"x" * 250 + b",\n") * 4500,
    ],
    ids=["header", "not-utf8", "empty", "broken-csv", "over-1mib"],
)
def test_cli_bad_file_exits_1_before_any_session(tmp_path, monkeypatch, content):
    path = tmp_path / "units.csv"
    path.write_bytes(content)
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: pytest.fail("opened a session"))

    result = _run("--building", "maple", "--csv", str(path))

    assert result.exit_code == 1
    assert "error:" in result.output


def test_cli_invalid_rows_still_exit_0(tmp_path, fake_session, calls):
    result = _run("--building", "maple", "--csv", _csv(tmp_path, HEADER + ",1,\n,,\n"))

    assert result.exit_code == 0, result.output
    assert fake_session.committed
    assert calls == [{"building_id": "building-id", "rows": 1, "dry_run": False}]


def test_cli_missing_file_exits_1(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: pytest.fail("opened a session"))

    result = _run("--building", "maple", "--csv", str(tmp_path / "missing.csv"))

    assert result.exit_code == 1


async def test_building_id_for_slug(db, world):
    assert await service.building_id_for_slug(db, "maple") == world.a.id
    with pytest.raises(service.UnknownBuilding):
        await service.building_id_for_slug(db, "nope")


def test_run_in_session_without_commit_rolls_back(fake_session):
    async def work(db: Any) -> None:
        await asyncio.sleep(0)

    cli.run_in_session(work, commit=False)

    assert not fake_session.committed
    assert fake_session.rolled_back
