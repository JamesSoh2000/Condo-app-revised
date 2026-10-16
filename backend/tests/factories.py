"""Async test factories: plain functions with sensible defaults and keyword overrides.

Each one flushes, so the row has its id and server defaults, and never commits. The ones that take
an existing object (`make_membership`, `make_occupancy`) use that object's session.
"""

from collections.abc import Iterable
from datetime import datetime
from itertools import count
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession, async_object_session

from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.occupancy import end_occupancy, start_occupancy
from app.units.models import Unit
from app.users.models import User

# Unique defaults across the whole test session; every test's rows are rolled back anyway.
_seq = count(1)


def _session_of(obj: object) -> AsyncSession:
    db = async_object_session(obj)
    if db is None:
        raise ValueError(f"{obj!r} is not in a session; create it with a factory first")
    return db


async def _add[T](db: AsyncSession, obj: T) -> T:
    db.add(obj)
    await db.flush()
    return obj


async def make_building(
    db: AsyncSession, *, features: Iterable[Feature] = (), **overrides: Any
) -> Building:
    n = next(_seq)
    values: dict[str, Any] = {
        "slug": f"building-{n}",
        "name": f"Building {n}",
        "address": f"{n} Main Street",
        "timezone": "America/Toronto",
    }
    building = await _add(db, Building(**(values | overrides)))
    db.add_all(BuildingFeature(building_id=building.id, feature=f) for f in features)
    await db.flush()
    return building


async def make_unit(db: AsyncSession, building: Building, **overrides: Any) -> Unit:
    values: dict[str, Any] = {"label": str(100 + next(_seq))}
    return await _add(db, Unit(building_id=building.id, **(values | overrides)))


async def make_user(db: AsyncSession, **overrides: Any) -> User:
    n = next(_seq)
    values: dict[str, Any] = {"email": f"user{n}@example.com", "full_name": f"User {n}"}
    return await _add(db, User(**(values | overrides)))


async def make_membership(
    user: User,
    building: Building,
    *,
    roles: Iterable[Role] = (Role.RESIDENT,),
    status: MembershipStatus = MembershipStatus.ACTIVE,
    **overrides: Any,
) -> BuildingMembership:
    membership = BuildingMembership(
        building_id=building.id, user_id=user.id, status=status, **overrides
    )
    # The relationship copies the membership's building_id and id into each role.
    membership.roles = [MembershipRole(role=role) for role in roles]
    return await _add(_session_of(user), membership)


async def make_occupancy(
    membership: BuildingMembership,
    unit: Unit,
    *,
    relationship: OccupancyRelationship = OccupancyRelationship.TENANT,
    started_at: datetime | None = None,
    ended_at: datetime | None = None,
) -> UnitOccupancy:
    """Start (and, with `ended_at`, end) an occupancy through `app.memberships.occupancy`.

    The helpers refuse what the schema can't: overlapping history and future times (ADR-0016).
    `started_at=None` means the transaction's `now()`.
    """
    db = _session_of(membership)
    occupancy = await start_occupancy(
        db,
        building_id=membership.building_id,
        membership_id=membership.id,
        unit_id=unit.id,
        relationship=relationship,
        at=started_at,
    )
    if ended_at is not None:
        ended = await end_occupancy(
            db, building_id=membership.building_id, membership_id=membership.id, at=ended_at
        )
        assert ended is occupancy
    return occupancy
