"""P1-05: the `world` fixture, the factories and `assert_integrity_error`.

Criterion numbers refer to the ticket's acceptance criteria and Frame notes.
"""

import time
from datetime import datetime, timedelta
from uuid import UUID

import pytest
from sqlalchemy import Table, func, literal, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import selectinload

from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.occupancy import OccupancyTimeError, occupancy_window_clause
from app.models.base import Base
from app.units.models import Unit
from app.users.models import User
from tests.factories import make_building, make_membership, make_occupancy, make_unit, make_user
from tests.helpers.db import assert_integrity_error
from tests.world import World, build_world

pytestmark = pytest.mark.anyio

OWNER, TENANT, HOUSEHOLD = (
    OccupancyRelationship.OWNER,
    OccupancyRelationship.TENANT,
    OccupancyRelationship.HOUSEHOLD,
)
ACTIVE, PENDING, SUSPENDED = (
    MembershipStatus.ACTIVE,
    MembershipStatus.PENDING,
    MembershipStatus.SUSPENDED,
)
RESIDENT, SECURITY, MANAGEMENT, COUNCIL = (
    Role.RESIDENT,
    Role.SECURITY,
    Role.PROPERTY_MANAGEMENT,
    Role.COUNCIL,
)
EXPECTED_ROW_COUNTS = {
    "buildings": 2,
    "building_features": 6,
    "units": 4,
    "users": 12,
    "building_memberships": 12,
    "membership_roles": 13,
    "unit_occupancies": 8,
}


async def _roles(db: AsyncSession, membership_id: UUID) -> set[Role]:
    rows = await db.scalars(
        select(MembershipRole.role).where(MembershipRole.membership_id == membership_id)
    )
    return set(rows)


async def _occupancies(db: AsyncSession, membership_id: UUID) -> list[UnitOccupancy]:
    rows = await db.scalars(
        select(UnitOccupancy)
        .where(UnitOccupancy.membership_id == membership_id)
        .order_by(UnitOccupancy.started_at)
    )
    return list(rows)


async def _row_counts(db: AsyncSession) -> dict[str, int]:
    counts = {}
    for table in Base.metadata.sorted_tables:
        assert isinstance(table, Table)
        counts[table.name] = (
            await db.execute(select(func.count()).select_from(table))
        ).scalar_one()
    return counts


# --- 1: buildings, units, personas ----------------------------------------------------------------


async def test_world_has_two_buildings_with_their_units(db: AsyncSession, world: World):
    assert (world.a.slug, world.b.slug) == ("maple", "birch")
    for building, labels in ((world.a, ["101", "102", "201"]), (world.b, ["101"])):
        units = await db.scalars(
            select(Unit).where(Unit.building_id == building.id).order_by(Unit.label)
        )
        assert [(u.tower, u.label) for u in units] == [(None, label) for label in labels]
    assert [world.a_101.label, world.a_102.label, world.a_201.label] == ["101", "102", "201"]
    assert {world.a_101.building_id, world.a_102.building_id, world.a_201.building_id} == {
        world.a.id
    }
    assert (world.b_101.building_id, world.b_101.label) == (world.b.id, "101")


async def test_every_persona_has_its_status_roles_and_occupancies(db: AsyncSession, world: World):
    a, b = world.a.id, world.b.id
    a_101, a_102, a_201, b_101 = world.a_101.id, world.a_102.id, world.a_201.id, world.b_101.id
    t0, t1, t2 = world.T0, world.T1, world.T2
    no_unit: list[tuple[UUID, OccupancyRelationship, datetime, datetime | None]] = []
    expected = {
        "a_manager": (a, ACTIVE, {MANAGEMENT}, no_unit),
        "a_security": (a, ACTIVE, {SECURITY}, no_unit),
        "a_resident1": (a, ACTIVE, {RESIDENT}, [(a_101, TENANT, t2, None)]),
        "a_resident2": (a, ACTIVE, {RESIDENT}, [(a_102, OWNER, t0, None)]),
        "a_council": (a, ACTIVE, {COUNCIL, RESIDENT}, [(a_201, OWNER, t0, None)]),
        "a_pending": (a, PENDING, {RESIDENT}, no_unit),
        "a_suspended": (a, SUSPENDED, {RESIDENT}, [(a_201, HOUSEHOLD, t0, None)]),
        "a_former": (a, ACTIVE, {RESIDENT}, [(a_101, TENANT, t0, t1), (a_102, TENANT, t1, None)]),
        "b_manager": (b, ACTIVE, {MANAGEMENT}, no_unit),
        "b_resident1": (b, ACTIVE, {RESIDENT}, [(b_101, TENANT, t0, None)]),
        "multi_in_a": (a, ACTIVE, {RESIDENT}, [(a_201, HOUSEHOLD, t0, None)]),
        "multi_in_b": (b, ACTIVE, {SECURITY}, no_unit),
    }
    for name, (building_id, status, roles, occupancies) in expected.items():
        persona = getattr(world, name)
        membership = persona if isinstance(persona, BuildingMembership) else persona.membership
        await db.refresh(membership)
        assert (membership.building_id, membership.status) == (building_id, status), name
        assert await _roles(db, membership.id) == roles, name
        rows = await _occupancies(db, membership.id)
        assert [
            (o.unit_id, o.relationship, o.started_at, o.ended_at) for o in rows
        ] == occupancies, name


async def test_each_persona_is_one_user_with_memberships_only_where_stated(
    db: AsyncSession, world: World
):
    singles = {
        world.a_manager: world.a,
        world.a_security: world.a,
        world.a_resident1: world.a,
        world.a_resident2: world.a,
        world.a_council: world.a,
        world.a_pending: world.a,
        world.a_suspended: world.a,
        world.a_former: world.a,
        world.b_manager: world.b,
        world.b_resident1: world.b,
    }
    for member, building in singles.items():
        assert member.membership.user_id == member.user.id
        memberships = await db.scalars(
            select(BuildingMembership.building_id).where(
                BuildingMembership.user_id == member.user.id
            )
        )
        assert list(memberships) == [building.id], member.user.email

    multi = await db.scalars(
        select(BuildingMembership).where(BuildingMembership.user_id == world.multi.id)
    )
    assert {m.id for m in multi} == {world.multi_in_a.id, world.multi_in_b.id}
    assert (world.multi_in_a.building_id, world.multi_in_b.building_id) == (world.a.id, world.b.id)
    no_membership = await db.scalar(
        select(func.count()).where(BuildingMembership.user_id == world.no_membership.id)
    )
    assert no_membership == 0

    users = list(await db.scalars(select(User)))
    assert len({u.email for u in users}) == len(users) == 12
    assert all(u.is_active and u.password_hash is None for u in users)


async def test_both_buildings_enable_exactly_packages_notices_and_maintenance(
    db: AsyncSession, world: World
):
    rows = await db.execute(
        select(BuildingFeature.building_id, BuildingFeature.feature, BuildingFeature.enabled)
    )
    assert {tuple(row) for row in rows} == {
        (building.id, feature, True)
        for building in (world.a, world.b)
        for feature in (Feature.PACKAGES, Feature.NOTICES, Feature.MAINTENANCE)
    }


# --- 2: a former occupant and the one who moved in after -----------------------------------------


async def test_former_occupant_left_101_before_resident1_moved_in_and_transferred_to_102(
    db: AsyncSession, world: World
):
    former = await _occupancies(db, world.a_former.membership.id)
    resident1 = await _occupancies(db, world.a_resident1.membership.id)
    assert [o.unit_id for o in former] == [world.a_101.id, world.a_102.id]
    assert resident1[0].unit_id == world.a_101.id
    assert former[0].ended_at == world.T1
    assert former[0].ended_at < resident1[0].started_at == world.T2
    # A transfer: the 102 row starts at the instant the 101 row ended, and is current.
    assert (former[1].started_at, former[1].ended_at) == (world.T1, None)


# --- 8: the world supports the occupancy window (cases 3 and 5) ----------------------------------


async def _can_see(db: AsyncSession, membership_id: UUID, unit_id: UUID, at: object) -> bool:
    clause = occupancy_window_clause(membership_id, literal(unit_id), literal(at))
    return bool(await db.scalar(select(clause)))


async def test_a_record_in_101_during_the_former_occupancy_is_visible_to_the_former_only(
    db: AsyncSession, world: World
):
    at = world.T0 + timedelta(days=1)
    assert await _can_see(db, world.a_former.membership.id, world.a_101.id, at)
    for other in (world.a_resident1, world.a_resident2, world.a_council):
        assert not await _can_see(db, other.membership.id, world.a_101.id, at)


async def test_a_record_in_101_now_is_visible_to_resident1_only(db: AsyncSession, world: World):
    now = (await db.execute(select(func.now()))).scalar_one()
    assert await _can_see(db, world.a_resident1.membership.id, world.a_101.id, now)
    for other in (world.a_former, world.a_resident2, world.b_resident1):
        assert not await _can_see(db, other.membership.id, world.a_101.id, now)
    # B's 101 is another unit: its resident's window never covers A's 101, and the reverse.
    assert not await _can_see(db, world.a_resident1.membership.id, world.b_101.id, now)


# --- 3 and 6: assert_integrity_error -------------------------------------------------------------


async def test_cross_building_occupancy_fails_and_the_session_keeps_working(
    db: AsyncSession, world: World
):
    a_unit = await make_unit(db, world.a, label="301")  # flushed before the failing insert

    error = await assert_integrity_error(
        db,
        make_occupancy(world.a_manager.membership, world.b_101, started_at=world.T0),
        constraint="fk_unit_occupancies_building_id_unit_id",
    )

    assert isinstance(error, IntegrityError)
    assert await db.get(Unit, a_unit.id) is a_unit
    assert await db.scalar(select(func.count()).select_from(Unit)) == 5
    # The session can still flush new rows.
    occupancy = await make_occupancy(world.a_manager.membership, a_unit, started_at=world.T0)
    assert occupancy.building_id == world.a.id


async def test_assert_integrity_error_fails_when_nothing_is_raised(db: AsyncSession, world: World):
    with pytest.raises(pytest.fail.Exception, match="no IntegrityError"):
        await assert_integrity_error(
            db, make_unit(db, world.a, label="999"), constraint="uq_units_building_id_tower_label"
        )


async def test_assert_integrity_error_fails_on_another_constraint(db: AsyncSession, world: World):
    with pytest.raises(pytest.fail.Exception, match="uq_units_building_id_tower_label"):
        await assert_integrity_error(
            db, make_unit(db, world.a, label="101"), constraint="fk_units_building_id_buildings"
        )
    # The savepoint was rolled back: the session is usable.
    assert await db.scalar(select(func.count()).select_from(Unit)) == 4


async def test_assert_integrity_error_lets_other_errors_through(db: AsyncSession, world: World):
    async def boom() -> None:
        raise RuntimeError("not a constraint")

    with pytest.raises(RuntimeError, match="not a constraint"):
        await assert_integrity_error(db, boom(), constraint="anything")
    assert await db.scalar(select(func.count()).select_from(Unit)) == 4


# --- 7: factories go through the occupancy helpers -----------------------------------------------


async def test_make_occupancy_refuses_a_second_current_occupancy(db: AsyncSession, world: World):
    await assert_integrity_error(
        db,
        make_occupancy(world.a_resident2.membership, world.a_201, started_at=world.T2),
        constraint="uq_unit_occupancies_current_membership",
    )


async def test_make_occupancy_refuses_a_start_inside_an_earlier_occupancy(
    db: AsyncSession, world: World
):
    with pytest.raises(OccupancyTimeError):
        async with db.begin_nested():
            # a_former's 101 row runs T0..T1; a new start before T1 would overlap it.
            await make_occupancy(
                world.a_former.membership, world.a_201, started_at=world.T1 - timedelta(days=1)
            )


async def test_make_occupancy_with_ended_at_records_a_past_occupancy(db: AsyncSession):
    building = await make_building(db)
    unit = await make_unit(db, building)
    membership = await make_membership(await make_user(db), building, roles=[RESIDENT])
    started = World.T0
    occupancy = await make_occupancy(
        membership, unit, relationship=OWNER, started_at=started, ended_at=World.T1
    )
    assert (occupancy.relationship, occupancy.started_at, occupancy.ended_at) == (
        OWNER,
        started,
        World.T1,
    )


async def test_factories_fill_sensible_defaults(db: AsyncSession):
    building = await make_building(db)
    other = await make_building(db)
    assert building.slug != other.slug
    user = await make_user(db)
    membership = await make_membership(user, building)
    assert (membership.status, await _roles(db, membership.id)) == (ACTIVE, {RESIDENT})
    loaded = await db.scalar(
        select(BuildingMembership)
        .where(BuildingMembership.id == membership.id)
        .options(selectinload(BuildingMembership.user))
    )
    assert loaded is not None and loaded.user is user


# --- 4: no data leaks between tests ---------------------------------------------------------------


async def test_without_the_world_every_table_is_empty(db: AsyncSession):
    assert set((await _row_counts(db)).values()) == {0}


@pytest.mark.parametrize("run", [1, 2])
async def test_two_worlds_in_a_row_have_the_same_row_counts(
    db: AsyncSession, world: World, run: int
):
    counts = await _row_counts(db)
    assert counts == EXPECTED_ROW_COUNTS, run


async def test_building_the_world_is_fast(db: AsyncSession):
    # Criterion 5: printed, not asserted (`pytest -s tests/test_world.py -k fast`).
    started = time.perf_counter()
    await build_world(db)
    print(f"\nworld built in {(time.perf_counter() - started) * 1000:.0f} ms")
