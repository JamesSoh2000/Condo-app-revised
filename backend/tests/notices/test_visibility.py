"""P6-01a criteria 6, 6a and 7: who `visible_notices(ctx)` shows which notice to.

Expiry is read by the database clock, `now()`: the test's transaction start, constant in a test.
"""

import uuid
from dataclasses import dataclass
from datetime import datetime, timedelta

import pytest
from sqlalchemy import Select, func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.memberships.enums import Role
from app.notices.models import Notice
from app.notices.queries import visible_notices
from tests.notices.conftest import archived, make_notice, persona_ctx, published
from tests.packages.conftest import ctx_for
from tests.world import World

pytestmark = pytest.mark.anyio

# Before a_resident1 moved into 101 (World.T2): notices aren't unit-addressed (criterion 7).
LONG_AGO = World.T0 + timedelta(days=1)


@dataclass
class Notices:
    draft: Notice
    live: Notice  # published, no expiry
    expired: Notice  # published, expired a second ago
    expiring: Notice  # published, expires in a day
    archived: Notice
    in_b: Notice  # published in B


@pytest.fixture
async def notices(db: AsyncSession, world: World) -> Notices:
    now: datetime = await db.scalar(select(func.now()))
    manager = world.a_manager.membership
    return Notices(
        draft=await make_notice(db, manager),
        live=await make_notice(db, manager, **published(manager, LONG_AGO)),
        expired=await make_notice(
            db, manager, **published(manager, LONG_AGO, expires_at=now - timedelta(seconds=1))
        ),
        expiring=await make_notice(
            db, manager, **published(manager, LONG_AGO, expires_at=now + timedelta(days=1))
        ),
        archived=await make_notice(
            db,
            manager,
            published_at=LONG_AGO,
            published_by_membership_id=manager.id,
            **archived(manager, LONG_AGO + timedelta(days=1)),
        ),
        in_b=await make_notice(
            db, world.b_manager.membership, **published(world.b_manager.membership, LONG_AGO)
        ),
    )


async def seen(db: AsyncSession, query: Select[Notice]) -> set[uuid.UUID]:
    return {notice.id for notice in await db.scalars(query)}


MEMBERS_SEE = {"live", "expiring"}
EXPECTED = {
    "a_manager": {"draft", "live", "expired", "expiring", "archived"},
    "a_security": MEMBERS_SEE,
    "a_resident1": MEMBERS_SEE,  # moved in after every notice was published
    "a_resident2": MEMBERS_SEE,
    "a_council": MEMBERS_SEE,
    "a_former": MEMBERS_SEE,
    "multi_in_a": MEMBERS_SEE,
    "b_manager": {"in_b"},
    "b_resident1": {"in_b"},
}


def ids(notices: Notices, names: set[str]) -> set[uuid.UUID]:
    return {getattr(notices, name).id for name in names}


@pytest.mark.parametrize("persona", sorted(EXPECTED))
async def test_visibility_by_persona(
    db: AsyncSession, world: World, notices: Notices, persona: str
):
    got = await seen(db, visible_notices(persona_ctx(world, persona)))

    assert got == ids(notices, EXPECTED[persona])


async def test_a_manager_who_is_also_a_resident_sees_every_notice(
    db: AsyncSession, world: World, notices: Notices
):
    ctx = ctx_for(world.a_council, Role.RESIDENT, Role.PROPERTY_MANAGEMENT)

    assert await seen(db, visible_notices(ctx)) == ids(notices, EXPECTED["a_manager"])


async def test_a_member_with_no_role_sees_no_more_than_published(
    db: AsyncSession, world: World, notices: Notices
):
    ctx = ctx_for(world.a_resident1)

    assert await seen(db, visible_notices(ctx)) == ids(notices, MEMBERS_SEE)


async def test_a_notice_expiring_exactly_now_is_hidden(db: AsyncSession, world: World):
    now: datetime = await db.scalar(select(func.now()))
    manager = world.a_manager.membership
    at_now = await make_notice(db, manager, **published(manager, LONG_AGO, expires_at=now))

    resident = await seen(db, visible_notices(persona_ctx(world, "a_resident1")))
    managers = await seen(db, visible_notices(persona_ctx(world, "a_manager")))

    assert at_now.id not in resident
    assert at_now.id in managers


async def test_the_query_never_leaves_the_contexts_building(
    db: AsyncSession, world: World, notices: Notices
):
    # The same membership's context pointed at B (as a forged context would be) sees B's only.
    ctx = persona_ctx(world, "a_manager")
    forged = type(ctx)(
        user_id=ctx.user_id,
        building_id=world.b.id,
        membership_id=ctx.membership_id,
        roles=ctx.roles,
        features=ctx.features,
    )

    assert await seen(db, visible_notices(forged)) == ids(notices, {"in_b"})
