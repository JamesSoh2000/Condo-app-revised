"""Start, end and transfer unit occupancies; the occupancy-window filter (ADR-0010, ADR-0016).

An occupancy covers `started_at <= T < ended_at`, half-open, and is current while `ended_at` is
NULL. A transfer ends the old row and starts the new one at the same instant, so a record stamped
then belongs to the new window only.

`at=None` means the database's `now()`, the start of the current transaction. Records default to
`now()` too, so both sides of the window come from one clock, and an end and a start in one
transaction share it. A future `at` is refused. A past `at` is for seeds, tests and backfills, and
it decides what a person may see: a start backdated into a previous occupant's time shows the
newcomer that occupant's records. Never take `at` from a client.

These are building blocks for services: they flush but never commit (CLAUDE.md rule 5), and they
don't check membership status, roles or `Unit.is_active`, or record audit events. The services that
call them (P4-02, P4-05, P4-06) do.
"""

from datetime import datetime
from uuid import UUID

from sqlalchemy import SQLColumnExpression, exists, func, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased
from sqlalchemy.sql import coercions, roles
from sqlalchemy.sql.expression import Exists
from sqlalchemy.sql.util import find_tables

from app.memberships.enums import OccupancyRelationship
from app.memberships.models import BuildingMembership, UnitOccupancy

# The name of `occupancy_window_clause`'s own `unit_occupancies` alias; no argument may use it.
WINDOW_ALIAS = "occupancy_window"


class OccupancyTimeError(ValueError):
    """The time would make a membership's occupancies overlap, or end one before it started."""


async def _prepare(
    db: AsyncSession, building_id: UUID, membership_id: UUID, at: datetime | None
) -> datetime:
    """Resolve `at`, flush, and lock the membership for the rest of the transaction."""
    if at is not None and at.utcoffset() is None:
        raise ValueError("at must be timezone-aware")
    now = (await db.execute(select(func.now()))).scalar_one()
    if at is None:
        at = now
    elif at > now:
        # A future start would be listed as current before its window opens.
        raise OccupancyTimeError("`at` is in the future")
    # The session doesn't autoflush: the checks below must also see the caller's pending rows.
    await db.flush()
    # Occupancy writes for one membership run one at a time: a concurrent start, end or transfer
    # waits here until this transaction ends, then (READ COMMITTED: each statement takes a fresh
    # snapshot) sees what it committed. NO KEY UPDATE leaves FK checks on the membership unblocked.
    await db.execute(
        select(BuildingMembership.id)
        .where(
            BuildingMembership.id == membership_id,
            BuildingMembership.building_id == building_id,
        )
        .with_for_update(key_share=True)
    )
    return at


async def start_occupancy(
    db: AsyncSession,
    *,
    building_id: UUID,
    membership_id: UUID,
    unit_id: UUID,
    relationship: OccupancyRelationship,
    at: datetime | None = None,
) -> UnitOccupancy:
    """Start a current occupancy of `unit_id` for the membership, from `at`.

    Raises `IntegrityError` if the membership already has a current occupancy, or if the unit or the
    membership isn't in `building_id`; `OccupancyTimeError` if one of the membership's earlier
    occupancies ends after `at` (a person's history can't overlap).
    """
    at = await _prepare(db, building_id, membership_id, at)
    overlapping = await db.scalar(
        select(UnitOccupancy.id)
        .where(
            UnitOccupancy.building_id == building_id,
            UnitOccupancy.membership_id == membership_id,
            UnitOccupancy.ended_at > at,
        )
        .limit(1)
    )
    if overlapping is not None:
        raise OccupancyTimeError("an earlier occupancy of this membership ends after `at`")

    occupancy = UnitOccupancy(
        building_id=building_id,
        unit_id=unit_id,
        membership_id=membership_id,
        relationship=relationship,
        started_at=at,
        ended_at=None,
    )
    db.add(occupancy)
    await db.flush()
    return occupancy


async def end_occupancy(
    db: AsyncSession, *, building_id: UUID, membership_id: UUID, at: datetime | None = None
) -> UnitOccupancy | None:
    """End the membership's current occupancy at `at` and return it; `None` if there is none.

    Raises `OccupancyTimeError` if the current occupancy started after `at`.
    """
    at = await _prepare(db, building_id, membership_id, at)
    current = (
        UnitOccupancy.building_id == building_id,
        UnitOccupancy.membership_id == membership_id,
        UnitOccupancy.ended_at.is_(None),
    )
    ended = await db.scalar(
        update(UnitOccupancy)
        .where(*current, UnitOccupancy.started_at <= at)
        .values(ended_at=at)
        .returning(UnitOccupancy)
    )
    if ended is None and await db.scalar(select(exists().where(*current))):
        raise OccupancyTimeError("the current occupancy starts after `at`")
    return ended


async def transfer_occupancy(
    db: AsyncSession,
    *,
    building_id: UUID,
    membership_id: UUID,
    new_unit_id: UUID,
    relationship: OccupancyRelationship,
    at: datetime | None = None,
) -> UnitOccupancy:
    """End the membership's current occupancy (if any) and start one of `new_unit_id`, both at `at`.

    Atomic only as part of the caller's transaction: on any error the caller rolls back both.
    """
    at = await _prepare(db, building_id, membership_id, at)
    await end_occupancy(db, building_id=building_id, membership_id=membership_id, at=at)
    return await start_occupancy(
        db,
        building_id=building_id,
        membership_id=membership_id,
        unit_id=new_unit_id,
        relationship=relationship,
        at=at,
    )


async def current_occupants(db: AsyncSession, building_id: UUID, unit_id: UUID) -> list[UUID]:
    """Membership ids with a current occupancy of the unit, earliest start first.

    Any membership status: callers that act on people (notify, hand over a package) keep the
    active ones.
    """
    rows = await db.scalars(
        select(UnitOccupancy.membership_id)
        .where(
            UnitOccupancy.building_id == building_id,
            UnitOccupancy.unit_id == unit_id,
            UnitOccupancy.ended_at.is_(None),
        )
        .order_by(UnitOccupancy.started_at, UnitOccupancy.membership_id)
    )
    return list(rows)


def occupancy_window_clause(
    membership_id: UUID | SQLColumnExpression[UUID],
    record_unit_col: SQLColumnExpression[UUID],
    record_time_col: SQLColumnExpression[datetime],
) -> Exists:
    """True when the membership occupied the record's unit at the record's time.

    For unit-addressed records: `select(Package).where(occupancy_window_clause(ctx.membership_id,
    Package.unit_id, Package.received_at))` correlates with the outer table. A NULL unit, time or
    membership makes it false. No building filter is needed: a unit id belongs to one building, and
    the composite FKs keep an occupancy's unit and membership in it (ADR-0005).
    """
    for argument in (membership_id, record_unit_col, record_time_col):
        if WINDOW_ALIAS in _qualifiers(argument):
            raise ValueError(f"an argument's table or alias is named {WINDOW_ALIAS!r}; rename it")
    # Its own alias, referenced only inside the EXISTS. An argument may be a column of an outer
    # `unit_occupancies` query; it must stay a reference to that outer row, which only fails if its
    # qualifier is this alias's name (refused above). A fixed name keeps the SQL, and its cache key,
    # the same on every call.
    occupancy = aliased(UnitOccupancy, name=WINDOW_ALIAS)
    return (
        exists()
        .where(
            occupancy.membership_id == membership_id,
            occupancy.unit_id == record_unit_col,
            occupancy.started_at <= record_time_col,
            or_(occupancy.ended_at.is_(None), occupancy.ended_at > record_time_col),
        )
        # Every other table correlates with the outer query; the alias is always the subquery's own.
        .correlate_except(occupancy)
    )


def _qualifiers(argument: object) -> set[str]:
    """Names of the tables, aliases and subqueries an argument's columns are qualified with."""
    if isinstance(argument, UUID) or argument is None:
        return set()
    element = coercions.expect(roles.ExpressionElementRole, argument)
    return {
        name
        for table in find_tables(
            element, check_columns=True, include_aliases=True, include_selects=True
        )
        if (name := getattr(table, "name", None)) is not None
    }
