"""Units (P4-01): the staff list and its writes, the join flow's unit options, the CSV import.

The write use-cases commit once (CLAUDE.md rule 5). `search_unit_options` only reads and
`import_units` only flushes, so P4-05 and P4-03 call them inside their own transactions.
"""

import csv
import io
from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID, uuid7

from pydantic import ValidationError
from sqlalchemy import ColumnElement, exists, func, select, update
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
from app.units.schemas import UnitCreate, UnitOption, UnitOut, UnitUpdate

MAX_OPTIONS = 50
MAX_IMPORT_ROWS = 5000
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
    `tower,label,floor` (any order), more than `MAX_IMPORT_ROWS` rows, or broken CSV."""
    reader = csv.reader(io.StringIO(text.removeprefix("﻿")))
    rows: list[ImportRow] = []
    invalid: list[InvalidRow] = []
    first_line: dict[tuple[str | None, str], int] = {}
    try:
        header = next(reader, None)
        if header is None or sorted(header) != sorted(_COLUMNS):
            raise CsvError("the header must be the columns tower,label,floor")
        index = {name: header.index(name) for name in _COLUMNS}
        for record in reader:
            if not record:
                continue
            if len(rows) + len(invalid) == MAX_IMPORT_ROWS:
                raise CsvError(f"more than {MAX_IMPORT_ROWS} rows")
            line = reader.line_num
            if len(record) != len(_COLUMNS):
                invalid.append(InvalidRow(line, f"expected {len(_COLUMNS)} columns"))
                continue
            values: dict[str, str | None] = {name: record[i] for name, i in index.items()}
            values["floor"] = (values["floor"] or "").strip() or None
            try:
                unit = UnitCreate.model_validate(values)
            except ValidationError as exc:
                error = exc.errors()[0]
                where = ".".join(str(part) for part in error["loc"])
                invalid.append(InvalidRow(line, f"{where}: {error['msg']}"))
                continue
            key = (unit.tower, unit.label)
            if key in first_line:
                invalid.append(InvalidRow(line, f"duplicate of line {first_line[key]}"))
                continue
            first_line[key] = line
            rows.append(ImportRow(line, unit.tower, unit.label, unit.floor))
    except csv.Error:
        raise CsvError(f"line {reader.line_num}: not valid CSV") from None
    return ParsedUnits(rows, invalid)


async def building_id_for_slug(db: AsyncSession, slug: str) -> UUID:
    building_id = await db.scalar(select(Building.id).where(Building.slug == slug))
    if building_id is None:
        raise UnknownBuilding(f"no building with slug {slug!r}")
    return building_id


async def import_units(
    db: AsyncSession, building_id: UUID, parsed: ParsedUnits, *, dry_run: bool
) -> ImportReport:
    """Create the building's missing units and set the floor of existing ones, matched by
    `(tower, label)`; `is_active` is left alone. A dry run only reads. Flushes, never commits."""
    existing = {
        (unit.tower, unit.label): unit
        for unit in await db.scalars(select(Unit).where(Unit.building_id == building_id))
    }
    created = updated = unchanged = 0
    metadata: dict[str, object]
    for row in parsed.rows:
        unit = existing.get((row.tower, row.label))
        if unit is not None and unit.floor == row.floor:
            unchanged += 1
            continue
        if unit is None:
            created += 1
            action, metadata = actions.UNIT_CREATED, {"source": "import"}
            unit = Unit(id=uuid7(), building_id=building_id, tower=row.tower, label=row.label)
            if not dry_run:
                db.add(unit)
        else:
            updated += 1
            action, metadata = actions.UNIT_UPDATED, {"fields": ["floor"], "source": "import"}
        if dry_run:
            continue
        unit.floor = row.floor
        await record_audit(
            db,
            action=action,
            entity_type="unit",
            entity_id=unit.id,
            building_id=building_id,
            metadata=metadata,
        )
    await db.flush()
    return ImportReport(created, updated, unchanged, list(parsed.invalid))


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
