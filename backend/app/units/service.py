"""Units (P4-01): the staff list and its writes, the join flow's unit options, the CSV import.

The write use-cases commit once (CLAUDE.md rule 5). `search_unit_options` only reads and
`import_units` only flushes, so P4-05 and P4-03 call them inside their own transactions.
"""

import csv
import io
import re
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from pydantic import ValidationError
from sqlalchemy import Boolean, ColumnElement, exists, func, literal_column, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.buildings.models import Building
from app.core.errors import Conflict, NotFound
from app.core.pagination import CursorParams, Page, paginate
from app.memberships.models import UnitOccupancy
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.schemas import MAX_FLOOR, MIN_FLOOR, UnitCreate, UnitOption, UnitOut, UnitUpdate

MAX_OPTIONS = 50
MAX_IMPORT_ROWS = 5000
# 5,000 rows of three cells of at most 20 characters fit many times over (P4-01b F5).
MAX_IMPORT_BYTES = 1024 * 1024
_WHOLE_NUMBER = re.compile(r"-?[0-9]+")
_MAX_FLOOR_DIGITS = 3
_COLUMNS = ("tower", "label", "floor")
_FIELDS = list(_COLUMNS)


class UnitNotFound(NotFound):
    code = "unit_not_found"


class UnitExists(Conflict):
    code = "unit_exists"


class UnitHasOccupants(Conflict):
    code = "unit_has_occupants"


class InvalidTransition(Conflict):
    code = "invalid_transition"


def _not_found() -> UnitNotFound:
    # One body for "no such unit" and "another building's unit" (ADR-0004).
    return UnitNotFound(detail="Unit not found.")


def _exists() -> UnitExists:
    return UnitExists(detail="This building already has a unit with that tower and label.")


def _current_occupancy(building_id: UUID, unit_id: UUID) -> ColumnElement[bool]:
    return exists().where(
        UnitOccupancy.building_id == building_id,
        UnitOccupancy.unit_id == unit_id,
        UnitOccupancy.ended_at.is_(None),
    )


async def _occupant_counts(
    db: AsyncSession, building_id: UUID, unit_ids: Sequence[UUID]
) -> dict[UUID, int]:
    rows = await db.execute(
        select(UnitOccupancy.unit_id, func.count())
        .where(
            UnitOccupancy.building_id == building_id,
            UnitOccupancy.unit_id.in_(unit_ids),
            UnitOccupancy.ended_at.is_(None),
        )
        .group_by(UnitOccupancy.unit_id)
    )
    return {unit_id: count for unit_id, count in rows}


def _out(unit: Unit, occupants: int) -> UnitOut:
    return UnitOut(
        id=unit.id,
        tower=unit.tower,
        label=unit.label,
        floor=unit.floor,
        is_active=unit.is_active,
        current_occupant_count=occupants,
    )


def _label_prefix(search: str) -> ColumnElement[bool]:
    # Case-insensitive; autoescape keeps `%` and `_` literal.
    return Unit.label.istartswith(search, autoescape=True)


async def list_units(
    db: AsyncSession,
    ctx: TenantContext,
    params: CursorParams,
    *,
    search: str | None,
    tower: str | None,
    active: bool | None,
) -> Page[UnitOut]:
    stmt = select(Unit).where(Unit.building_id == ctx.building_id)
    if search:
        stmt = stmt.where(_label_prefix(search))
    if tower is not None:
        stmt = stmt.where(Unit.tower == tower)
    if active is not None:
        stmt = stmt.where(Unit.is_active.is_(active))
    page = await paginate(db, stmt, Unit.id, params, lambda unit: unit)
    counts = await _occupant_counts(db, ctx.building_id, [unit.id for unit in page.items])
    return Page[UnitOut](
        items=[_out(unit, counts.get(unit.id, 0)) for unit in page.items],
        next_cursor=page.next_cursor,
    )


async def _get_unit(
    db: AsyncSession, building_id: UUID, unit_id: UUID, *, lock: bool = False
) -> Unit:
    stmt = select(Unit).where(Unit.id == unit_id, Unit.building_id == building_id)
    if lock:
        stmt = stmt.with_for_update().execution_options(populate_existing=True)
    unit = await db.scalar(stmt)
    if unit is None:
        raise _not_found()
    return unit


async def _audit(
    db: AsyncSession, ctx: TenantContext, action: str, unit_id: UUID, fields: list[str] | None
) -> None:
    await record_audit(
        db,
        action=action,
        entity_type="unit",
        entity_id=unit_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata=None if fields is None else {"fields": fields},
    )


async def create_unit(db: AsyncSession, ctx: TenantContext, data: UnitCreate) -> UnitOut:
    # ON CONFLICT on the (building_id, tower, label) constraint, NULLS NOT DISTINCT: a duplicate,
    # also one created concurrently, is a 409, never an IntegrityError.
    unit = await db.scalar(
        insert(Unit)
        .values(building_id=ctx.building_id, tower=data.tower, label=data.label, floor=data.floor)
        .on_conflict_do_nothing(constraint="uq_units_building_id_tower_label")
        .returning(Unit)
    )
    if unit is None:
        raise _exists()
    await _audit(db, ctx, actions.UNIT_CREATED, unit.id, _FIELDS)
    await db.commit()
    return _out(unit, 0)


async def update_unit(
    db: AsyncSession, ctx: TenantContext, unit_id: UUID, data: UnitUpdate
) -> UnitOut:
    unit = await _get_unit(db, ctx.building_id, unit_id, lock=True)
    changes = {
        field: value
        for field, value in data.model_dump(exclude_unset=True).items()
        if getattr(unit, field) != value
    }
    if changes:
        for field, value in changes.items():
            setattr(unit, field, value)
        try:
            async with db.begin_nested():
                await db.flush()
        except IntegrityError:
            # Changing tower or label can break only the (building_id, tower, label) constraint.
            raise _exists() from None
        await _audit(db, ctx, actions.UNIT_UPDATED, unit.id, list(changes))
    occupants = (await _occupant_counts(db, ctx.building_id, [unit.id])).get(unit.id, 0)
    out = _out(unit, occupants)
    await db.commit()
    return out


async def deactivate_unit(db: AsyncSession, ctx: TenantContext, unit_id: UUID) -> None:
    """Deactivate an active unit nobody currently occupies.

    FOR UPDATE first: an occupancy insert holds FOR KEY SHARE on the unit (its foreign key) until it
    commits, which a plain UPDATE of `is_active` wouldn't wait for. This waits, and the occupancy
    check after it is a new statement, so (READ COMMITTED) it sees the insert once committed.
    """
    unit = await _get_unit(db, ctx.building_id, unit_id, lock=True)
    if not unit.is_active:
        raise InvalidTransition(detail="The unit is already inactive.")
    if await db.scalar(select(_current_occupancy(ctx.building_id, unit_id))):
        raise UnitHasOccupants(detail="End the unit's current occupancies first.")
    await _set_active(db, ctx, unit_id, active=False)


async def activate_unit(db: AsyncSession, ctx: TenantContext, unit_id: UUID) -> None:
    unit = await _get_unit(db, ctx.building_id, unit_id, lock=True)
    if unit.is_active:
        raise InvalidTransition(detail="The unit is already active.")
    await _set_active(db, ctx, unit_id, active=True)


async def _set_active(db: AsyncSession, ctx: TenantContext, unit_id: UUID, *, active: bool) -> None:
    # Conditional (CLAUDE.md rule 7); the row lock taken by the caller makes it match.
    changed = await db.scalar(
        update(Unit)
        .where(
            Unit.id == unit_id, Unit.building_id == ctx.building_id, Unit.is_active.is_(not active)
        )
        .values(is_active=active)
        .returning(Unit.id)
    )
    if changed is None:
        raise InvalidTransition(detail="The unit changed; reload it.")
    action = actions.UNIT_ACTIVATED if active else actions.UNIT_DEACTIVATED
    await _audit(db, ctx, action, unit_id, None)
    await db.commit()


async def search_unit_options(
    db: AsyncSession, building_id: UUID, search: str, limit: int = 20
) -> list[UnitOption]:
    """Active units of the building whose label starts with `search` (any case): `{id, tower,
    label}` only, at most `limit` (clamped to 1-50), by tower (none first) then label. Read-only."""
    rows = await db.execute(
        select(Unit.id, Unit.tower, Unit.label)
        .where(Unit.building_id == building_id, Unit.is_active, _label_prefix(search))
        .order_by(Unit.tower.asc().nulls_first(), Unit.label)
        .limit(max(1, min(limit, MAX_OPTIONS)))
    )
    return [UnitOption(id=row.id, tower=row.tower, label=row.label) for row in rows]


# The CSV import (`python -m app.cli import-units`)


class CsvError(ValueError):
    """The file as a whole can't be imported (header, size, CSV syntax)."""


class UnknownBuilding(ValueError):
    """No building has the slug."""


@dataclass(frozen=True)
class ImportRow:
    line: int
    tower: str | None
    label: str
    floor: int | None


@dataclass(frozen=True)
class InvalidRow:
    line: int
    # Never the row's values: they're untrusted terminal input.
    reason: str


@dataclass(frozen=True)
class ParsedUnits:
    rows: list[ImportRow]
    invalid: list[InvalidRow]


@dataclass(frozen=True)
class ImportReport:
    created: int
    updated: int
    unchanged: int
    invalid: list[InvalidRow]


def parse_units_csv(text: str) -> ParsedUnits:
    """Rows validated as the API validates a new unit; a `(tower, label)` repeated in the file is
    invalid from its second occurrence. `CsvError` for a header that isn't exactly
    `tower,label,floor` (any order), more than `MAX_IMPORT_ROWS` rows, or broken CSV.

    A row's line is the file line its record starts on (a quoted cell may span lines)."""
    if len(text.encode()) > MAX_IMPORT_BYTES:
        raise CsvError(f"the file is larger than {MAX_IMPORT_BYTES // 1024} KiB")
    # A cell may be as long as the file: an overlong one is an invalid row, not broken CSV (review
    # round 1). The limit is process-wide; it is only ever raised.
    csv.field_size_limit(max(csv.field_size_limit(), MAX_IMPORT_BYTES))
    # newline="": the csv module reads LF, CRLF and CR itself (CR-only was refused, review round 2).
    reader = csv.reader(io.StringIO(text.removeprefix("\ufeff"), newline=""), strict=True)
    rows: list[ImportRow] = []
    invalid: list[InvalidRow] = []
    first_line: dict[tuple[str | None, str], int] = {}
    try:
        header = next(reader, None)
        if header is None or sorted(header) != sorted(_COLUMNS):
            raise CsvError("the header must be the columns tower,label,floor")
        index = {name: header.index(name) for name in _COLUMNS}
        line = reader.line_num + 1
        for record in reader:
            start, line = line, reader.line_num + 1
            if not record:
                continue
            if len(rows) + len(invalid) == MAX_IMPORT_ROWS:
                raise CsvError(f"more than {MAX_IMPORT_ROWS} rows")
            if len(record) != len(_COLUMNS):
                invalid.append(InvalidRow(start, f"expected {len(_COLUMNS)} columns"))
                continue
            # Not `int()` alone: it also takes `1_0`, `+3` and non-ASCII digits (P4-01b F3).
            # UnitCreate checks the range.
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
            try:
                tower, label = record[index["tower"]], record[index["label"]]
                unit = UnitCreate.model_validate({"tower": tower, "label": label, "floor": floor})
            except ValidationError as exc:
                error = exc.errors()[0]
                where = ".".join(str(part) for part in error["loc"])
                invalid.append(InvalidRow(start, f"{where}: {error['msg']}"))
                continue
            key = (unit.tower, unit.label)
            if key in first_line:
                invalid.append(InvalidRow(start, f"duplicate of line {first_line[key]}"))
                continue
            first_line[key] = start
            rows.append(ImportRow(start, unit.tower, unit.label, unit.floor))
    except csv.Error:
        raise CsvError(f"line {reader.line_num}: not valid CSV") from None
    return ParsedUnits(rows, invalid)


async def building_id_for_slug(db: AsyncSession, slug: str) -> UUID:
    building_id = await db.scalar(select(Building.id).where(Building.slug == slug))
    if building_id is None:
        raise UnknownBuilding(f"no building with slug {slug!r}")
    return building_id


async def _write_row(db: AsyncSession, building_id: UUID, row: ImportRow) -> str:
    """Create the unit, or set the floor of the existing one; "created", "updated" or "unchanged".

    One statement, so no other transaction can change the unit in between: a separate INSERT and
    UPDATE lost the floor when the API renamed the unit between them (review round 1). A
    conflicting insert in flight (API or another import) makes it wait, never an IntegrityError.
    `old` in RETURNING (Postgres 18) is null for an inserted row; no row comes back when the floor
    is the same.
    """
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
        entity_type="unit",
        entity_id=unit_id,
        building_id=building_id,
        metadata={"source": "import"} if created else {"fields": ["floor"], "source": "import"},
    )
    return "created" if created else "updated"


def _write_order(row: ImportRow) -> tuple[bool, str, str]:
    # One order for every import, so two imports lock the same units in the same order and can't
    # deadlock (review round 1). No tower first.
    return (row.tower is not None, row.tower or "", row.label)


async def import_units(
    db: AsyncSession, building_id: UUID, parsed: ParsedUnits, *, dry_run: bool
) -> ImportReport:
    """Create the building's missing units and set the floor of existing ones, matched exactly by
    `(tower, label)`; `is_active` is left alone. A dry run only reads, and counts what the real run
    would. Flushes, never commits."""
    counts = {"created": 0, "updated": 0, "unchanged": 0}
    if dry_run:
        floors = {
            (unit.tower, unit.label): unit.floor
            for unit in await db.execute(
                select(Unit.tower, Unit.label, Unit.floor).where(Unit.building_id == building_id)
            )
        }
        for row in parsed.rows:
            key = (row.tower, row.label)
            if key not in floors:
                counts["created"] += 1
            elif floors[key] != row.floor:
                counts["updated"] += 1
            else:
                counts["unchanged"] += 1
    else:
        for row in sorted(parsed.rows, key=_write_order):
            counts[await _write_row(db, building_id, row)] += 1
        await db.flush()
    return ImportReport(
        counts["created"], counts["updated"], counts["unchanged"], list(parsed.invalid)
    )


def render_import_report(report: ImportReport, *, dry_run: bool) -> str:
    lines = ["dry run: nothing was written"] if dry_run else []
    lines += [
        f"created: {report.created}",
        f"updated: {report.updated}",
        f"unchanged: {report.unchanged}",
        f"invalid: {len(report.invalid)}",
    ]
    lines += [f"  line {row.line}: {row.reason}" for row in report.invalid]
    return "\n".join(lines)
