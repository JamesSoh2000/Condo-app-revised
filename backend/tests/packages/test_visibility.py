"""P5-01 criteria 4, 5, 7, 8, 9 and 11: who `visible_packages(ctx)` shows which package to.

Windows are half-open (ADR-0010): an occupancy covers `started_at <= T < ended_at`.
"""

import uuid
from dataclasses import dataclass
from datetime import timedelta

import pytest
from sqlalchemy import Select, select, text
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import aliased

from app.memberships.enums import Role
from app.memberships.models import UnitOccupancy
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.packages.queries import visible_packages
from app.tenancy.context import TenantContext
from tests.packages.conftest import ctx_for, ctx_of, make_package, persona_ctx
from tests.world import World

pytestmark = pytest.mark.anyio

DURING_FORMERS_101 = World.T0 + timedelta(days=1)  # a_former in 101, a_resident2 in 102
AFTER_RESIDENT1_MOVED_IN = World.T2 + timedelta(days=1)


@dataclass
class Packages:
    p0: Package  # 101, during a_former's occupancy
    p1: Package  # 101, after a_resident1 moved in
    p2: Package  # 102, before a_former moved there
    pb: Package  # B-101, during b_resident1's occupancy


@pytest.fixture
async def packages(db: AsyncSession, world: World) -> Packages:
    security = world.a_security.membership
    return Packages(
        p0=await make_package(db, world.a_101, security, received_at=DURING_FORMERS_101),
        p1=await make_package(db, world.a_101, security, received_at=AFTER_RESIDENT1_MOVED_IN),
        p2=await make_package(db, world.a_102, security, received_at=DURING_FORMERS_101),
        pb=await make_package(
            db, world.b_101, world.b_manager.membership, received_at=DURING_FORMERS_101
        ),
    )


async def seen(db: AsyncSession, query: Select[Package]) -> set[uuid.UUID]:
    return {package.id for package in await db.scalars(query)}


# Criterion 4 (and 11: the union for council + resident; b_* for row 3 of the tenant table).
EXPECTED = {
    "a_resident1": {"p1"},
    "a_former": {"p0"},  # history follows the person, not the unit
    "a_resident2": {"p2"},
    "a_security": {"p0", "p1", "p2"},
    "a_manager": {"p0", "p1", "p2"},
    "a_council": set(),  # council grants nothing; its resident role covers 201 only
    "b_resident1": {"pb"},  # none of building A's
    "b_manager": {"pb"},
}


def ids(packages: Packages, names: set[str]) -> set[uuid.UUID]:
    return {getattr(packages, name).id for name in names}


@pytest.mark.parametrize("persona", sorted(EXPECTED))
async def test_visibility_by_persona(
    db: AsyncSession, world: World, packages: Packages, persona: str
):
    got = await seen(db, visible_packages(persona_ctx(world, persona)))

    assert got == ids(packages, EXPECTED[persona])


# --- criterion 5: the named recipient ------------------------------------------------------------


async def test_named_recipient_sees_a_package_received_before_their_occupancy(
    db: AsyncSession, world: World
):
    named = await make_package(
        db,
        world.a_101,
        world.a_security.membership,
        received_at=DURING_FORMERS_101,  # before T2, when a_resident1 moved in
        recipient_membership_id=world.a_resident1.membership.id,
    )

    assert named.id in await seen(db, visible_packages(persona_ctx(world, "a_resident1")))
    # The window still applies to everyone else: a_former lived in 101 then, a_resident2 didn't.
    assert named.id in await seen(db, visible_packages(persona_ctx(world, "a_former")))
    assert named.id not in await seen(db, visible_packages(persona_ctx(world, "a_resident2")))


async def test_named_recipient_sees_it_for_a_unit_they_never_lived_in(
    db: AsyncSession, world: World
):
    named = await make_package(
        db,
        world.a_102,
        world.a_security.membership,
        received_at=AFTER_RESIDENT1_MOVED_IN,
        recipient_membership_id=world.a_resident1.membership.id,
    )

    assert named.id in await seen(db, visible_packages(persona_ctx(world, "a_resident1")))


async def test_naming_a_recipient_hides_nothing_from_the_units_occupant(
    db: AsyncSession, world: World
):
    named = await make_package(
        db,
        world.a_102,
        world.a_security.membership,
        received_at=AFTER_RESIDENT1_MOVED_IN,
        recipient_membership_id=world.a_resident1.membership.id,
    )

    # a_resident2 owns 102 throughout: the unit's occupants still see it (the union of the two).
    assert named.id in await seen(db, visible_packages(persona_ctx(world, "a_resident2")))


# --- criterion 7: one user, two buildings --------------------------------------------------------


async def test_multi_sees_only_its_own_buildings_packages_with_each_membership(
    db: AsyncSession, world: World, packages: Packages
):
    in_201 = await make_package(
        db, world.a_201, world.a_security.membership, received_at=DURING_FORMERS_101
    )

    as_resident_in_a = ctx_of(world.multi_in_a, Role.RESIDENT)
    as_security_in_b = ctx_of(world.multi_in_b, Role.SECURITY)

    assert await seen(db, visible_packages(as_resident_in_a)) == {in_201.id}
    assert await seen(db, visible_packages(as_security_in_b)) == {packages.pb.id}


async def test_a_context_never_reaches_another_buildings_packages(
    db: AsyncSession, world: World, packages: Packages
):
    # `multi` is security in B; given a staff role in A's context, it still sees A's packages only.
    all_of_a = await seen(db, visible_packages(ctx_of(world.multi_in_a, Role.SECURITY)))

    assert all_of_a == ids(packages, {"p0", "p1", "p2"})


# --- criterion 8: the window's edges -------------------------------------------------------------


async def test_a_package_received_at_the_instant_a_former_left_is_not_theirs(
    db: AsyncSession, world: World
):
    at_t1 = await make_package(db, world.a_101, world.a_security.membership, received_at=World.T1)

    assert at_t1.id not in await seen(db, visible_packages(persona_ctx(world, "a_former")))
    assert at_t1.id not in await seen(db, visible_packages(persona_ctx(world, "a_resident1")))
    assert at_t1.id in await seen(db, visible_packages(persona_ctx(world, "a_security")))


async def test_a_package_received_at_the_instant_resident1_moved_in_is_theirs(
    db: AsyncSession, world: World
):
    at_t2 = await make_package(db, world.a_101, world.a_security.membership, received_at=World.T2)

    assert at_t2.id in await seen(db, visible_packages(persona_ctx(world, "a_resident1")))
    assert at_t2.id not in await seen(db, visible_packages(persona_ctx(world, "a_former")))


# --- criterion 9 (carried from P1-03) ------------------------------------------------------------


@pytest.mark.parametrize("persona", sorted(EXPECTED))
async def test_visibility_unchanged_in_toronto_time(
    db: AsyncSession, world: World, packages: Packages, persona: str
):
    utc = await seen(db, visible_packages(persona_ctx(world, persona)))
    await db.execute(text("SET LOCAL TimeZone = 'America/Toronto'"))

    assert await seen(db, visible_packages(persona_ctx(world, persona))) == utc


async def test_an_hour_before_a_move_stays_on_its_side_in_toronto_time(
    db: AsyncSession, world: World
):
    # P1-03 review round 5, L2: a naive record time is read in the session's zone, 4 hours behind
    # UTC in July here, so a record an hour before a move would land 3 hours after it.
    security = world.a_security.membership
    formers_last_hour = await make_package(
        db, world.a_101, security, received_at=World.T1 - timedelta(hours=1)
    )
    before_resident1 = await make_package(
        db, world.a_101, security, received_at=World.T2 - timedelta(hours=1)
    )
    await db.execute(text("SET LOCAL TimeZone = 'America/Toronto'"))

    former = await seen(db, visible_packages(persona_ctx(world, "a_former")))
    resident1 = await seen(db, visible_packages(persona_ctx(world, "a_resident1")))

    assert formers_last_hour.id in former
    assert before_resident1.id not in resident1


def test_the_query_selects_packages_by_building_and_the_contexts_membership():
    ctx = TenantContext(
        user_id=uuid.uuid4(),
        building_id=uuid.uuid4(),
        membership_id=uuid.uuid4(),
        roles=frozenset({Role.RESIDENT}),
        features=frozenset(),
    )

    query = visible_packages(ctx)
    params = query.compile().params

    assert query.get_final_froms() == [Package.__table__]
    assert ctx.building_id in params.values()
    assert ctx.membership_id in params.values()
    # Only the context's values are bound: nothing else a caller could have passed in.
    assert set(params.values()) == {ctx.building_id, ctx.membership_id}
    assert "public.occupancy_window(" in str(query)


async def test_the_query_composes_with_an_alias_and_an_occupancy_join(
    db: AsyncSession, world: World, packages: Packages
):
    ctx = persona_ctx(world, "a_resident1")
    expected = ids(packages, EXPECTED["a_resident1"])

    # The visible set as a subquery behind an alias.
    as_alias = aliased(Package, visible_packages(ctx).subquery())
    # Outer-joined to unit_occupancies, whose columns could shadow the record's in a careless one.
    visible = visible_packages(ctx).subquery()
    joined = (
        select(visible.c.id)
        .select_from(visible.outerjoin(UnitOccupancy, UnitOccupancy.unit_id == visible.c.unit_id))
        .distinct()
    )
    # Correlated from an outer query over an aliased packages table.
    outer = aliased(Package)
    correlated = select(outer.id).where(
        visible_packages(ctx).where(Package.id == outer.id).exists()
    )
    # Narrowed further, as list endpoints will.
    narrowed = visible_packages(ctx).where(Package.status == PackageStatus.RECEIVED)

    assert set(await db.scalars(select(as_alias.id))) == expected
    assert set(await db.scalars(joined)) == expected
    assert set(await db.scalars(correlated)) == expected
    assert await seen(db, narrowed) == expected


# --- criterion 11: roles that grant nothing, and the union -------------------------------------


@pytest.mark.parametrize("roles", [(), (Role.COUNCIL,)], ids=["no roles", "council only"])
async def test_a_context_without_a_granting_role_sees_nothing(
    db: AsyncSession, world: World, packages: Packages, roles: tuple[Role, ...]
):
    # a_council lives in 201; give it a 201 package so only the role can hide it.
    await make_package(db, world.a_201, world.a_security.membership, received_at=DURING_FORMERS_101)

    assert await seen(db, visible_packages(ctx_for(world.a_council, *roles))) == set()


async def test_a_resident_who_is_also_security_sees_every_package(
    db: AsyncSession, world: World, packages: Packages
):
    ctx = ctx_for(world.a_resident1, Role.RESIDENT, Role.SECURITY)

    assert await seen(db, visible_packages(ctx)) == ids(packages, {"p0", "p1", "p2"})


async def test_council_and_resident_sees_their_units_packages(
    db: AsyncSession, world: World, packages: Packages
):
    in_201 = await make_package(
        db, world.a_201, world.a_security.membership, received_at=DURING_FORMERS_101
    )

    assert await seen(db, visible_packages(persona_ctx(world, "a_council"))) == {in_201.id}
