"""The test world: two buildings with every role and occupancy situation tenant tests need.

`tests/README.md` maps the personas to the 10-case table (docs/ENGINEERING_PRACTICES.md §7).
"""

from dataclasses import dataclass
from datetime import UTC, datetime
from typing import ClassVar

from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings.enums import Feature
from app.buildings.models import Building
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership
from app.units.models import Unit
from app.users.models import User
from tests.factories import make_building, make_membership, make_occupancy, make_unit, make_user

FEATURES = (Feature.PACKAGES, Feature.NOTICES, Feature.MAINTENANCE)
OWNER, TENANT, HOUSEHOLD = (
    OccupancyRelationship.OWNER,
    OccupancyRelationship.TENANT,
    OccupancyRelationship.HOUSEHOLD,
)


@dataclass(frozen=True)
class Member:
    """A user and their membership in one building."""

    user: User
    membership: BuildingMembership


@dataclass(frozen=True)
class World:
    # Fixed instants in the past (the occupancy helpers refuse future ones). Stamp a record with
    # T0 + 1 day to put it in a_former's time in A-101; with now() to put it in a_resident1's.
    T0: ClassVar[datetime] = datetime(2025, 1, 1, tzinfo=UTC)
    T1: ClassVar[datetime] = datetime(2025, 7, 1, tzinfo=UTC)  # a_former moves from 101 to 102
    T2: ClassVar[datetime] = datetime(2025, 7, 15, tzinfo=UTC)  # a_resident1 moves into 101

    a: Building  # "maple"
    b: Building  # "birch"
    a_101: Unit
    a_102: Unit
    a_201: Unit
    b_101: Unit

    a_manager: Member  # property_management
    a_security: Member  # security
    a_resident1: Member  # tenant in 101 from T2
    a_resident2: Member  # owner in 102
    a_council: Member  # council + resident, owner in 201
    a_pending: Member  # pending resident, no occupancy
    a_suspended: Member  # suspended resident, household in 201
    a_former: Member  # tenant in 101 until T1, then tenant in 102
    b_manager: Member
    b_resident1: Member  # tenant in B-101

    multi: User  # resident (household in A-201) in A, security in B
    multi_in_a: BuildingMembership
    multi_in_b: BuildingMembership
    no_membership: User


async def _member(
    db: AsyncSession,
    building: Building,
    name: str,
    roles: tuple[Role, ...],
    status: MembershipStatus = MembershipStatus.ACTIVE,
) -> Member:
    user = await make_user(db, email=f"{name}@example.com", full_name=name.replace("_", " "))
    return Member(user, await make_membership(user, building, roles=roles, status=status))


async def build_world(db: AsyncSession) -> World:
    t0, t1, t2 = World.T0, World.T1, World.T2
    a = await make_building(db, slug="maple", name="Maple Court", features=FEATURES)
    b = await make_building(db, slug="birch", name="Birch House", features=FEATURES)
    a_101, a_102, a_201 = [await make_unit(db, a, label=label) for label in ("101", "102", "201")]
    b_101 = await make_unit(db, b, label="101")

    resident = (Role.RESIDENT,)
    a_manager = await _member(db, a, "a_manager", (Role.PROPERTY_MANAGEMENT,))
    a_security = await _member(db, a, "a_security", (Role.SECURITY,))
    a_resident1 = await _member(db, a, "a_resident1", resident)
    a_resident2 = await _member(db, a, "a_resident2", resident)
    a_council = await _member(db, a, "a_council", (Role.COUNCIL, Role.RESIDENT))
    a_pending = await _member(db, a, "a_pending", resident, MembershipStatus.PENDING)
    a_suspended = await _member(db, a, "a_suspended", resident, MembershipStatus.SUSPENDED)
    a_former = await _member(db, a, "a_former", resident)
    b_manager = await _member(db, b, "b_manager", (Role.PROPERTY_MANAGEMENT,))
    b_resident1 = await _member(db, b, "b_resident1", resident)

    multi = await make_user(db, email="multi@example.com", full_name="multi")
    multi_in_a = await make_membership(multi, a, roles=resident)
    multi_in_b = await make_membership(multi, b, roles=(Role.SECURITY,))
    no_membership = await make_user(db, email="no_membership@example.com", full_name="nobody")

    # a_former's history first: 101 until T1, then 102 from T1 (a transfer), then 101 is re-let.
    await make_occupancy(a_former.membership, a_101, started_at=t0, ended_at=t1)
    await make_occupancy(a_former.membership, a_102, started_at=t1)
    await make_occupancy(a_resident1.membership, a_101, started_at=t2)
    await make_occupancy(a_resident2.membership, a_102, relationship=OWNER, started_at=t0)
    await make_occupancy(a_council.membership, a_201, relationship=OWNER, started_at=t0)
    await make_occupancy(a_suspended.membership, a_201, relationship=HOUSEHOLD, started_at=t0)
    await make_occupancy(multi_in_a, a_201, relationship=HOUSEHOLD, started_at=t0)
    await make_occupancy(b_resident1.membership, b_101, started_at=t0)

    return World(
        a=a,
        b=b,
        a_101=a_101,
        a_102=a_102,
        a_201=a_201,
        b_101=b_101,
        a_manager=a_manager,
        a_security=a_security,
        a_resident1=a_resident1,
        a_resident2=a_resident2,
        a_council=a_council,
        a_pending=a_pending,
        a_suspended=a_suspended,
        a_former=a_former,
        b_manager=b_manager,
        b_resident1=b_resident1,
        multi=multi,
        multi_in_a=multi_in_a,
        multi_in_b=multi_in_b,
        no_membership=no_membership,
    )
