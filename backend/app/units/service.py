"""Units (P4-01a): the staff list and its writes, and the join flow's unit options.

The write use-cases commit once (CLAUDE.md rule 5). `search_unit_options` only reads, so P4-05 calls
it inside its own transaction.
"""

from collections.abc import Sequence
from uuid import UUID

from sqlalchemy import ColumnElement, exists, func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.core.errors import Conflict, NotFound
from app.core.pagination import CursorParams, Page, paginate
from app.memberships.models import UnitOccupancy
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.schemas import UnitCreate, UnitOption, UnitOut, UnitUpdate

MAX_OPTIONS = 50
_FIELDS = ["tower", "label", "floor"]


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
