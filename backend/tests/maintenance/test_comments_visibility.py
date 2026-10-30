"""P6-03d criteria 2 and 5: who `visible_maintenance_comments(ctx)` shows which comment to.

The internal filter narrows `visible_maintenance`: a comment is seen only with its request, and an
internal one only by staff (D1). Comments follow their request (D4): whoever sees the request sees
its public comments, those written after they moved out too.
"""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from app.maintenance.models import MaintenanceComment
from app.maintenance.queries import visible_maintenance_comments
from app.memberships.enums import Role
from tests.maintenance.conftest import make_maintenance_comment, make_maintenance_request
from tests.packages.conftest import ctx_for, ctx_of, persona_ctx
from tests.world import World

pytestmark = pytest.mark.anyio

DURING_FORMERS_101 = World.T0 + timedelta(days=1)  # a_former in 101
AFTER = World.T2 + timedelta(days=1)  # a_resident1 in 101


async def seen(db: AsyncSession, query: Select[MaintenanceComment]) -> set[uuid.UUID]:
    return {comment.id for comment in await db.scalars(query)}


@pytest.fixture
async def comments(db: AsyncSession, world: World) -> dict[str, uuid.UUID]:
    """a_resident1's request with one public and one internal comment, and one of B's."""
    manager = world.a_manager.membership
    request = await make_maintenance_request(
        db, world.a_resident1.membership, world.a_101, submitted_at=AFTER
    )
    b_request = await make_maintenance_request(
        db, world.b_resident1.membership, world.b_101, submitted_at=AFTER
    )
    made = {
        "public": await make_maintenance_comment(db, request, manager),
        "internal": await make_maintenance_comment(db, request, manager, internal=True),
        "reply": await make_maintenance_comment(db, request, world.a_resident1.membership),
        "b": await make_maintenance_comment(db, b_request, world.b_manager.membership),
    }
    return {name: comment.id for name, comment in made.items()}


EXPECTED: dict[str, set[str]] = {
    "a_manager": {"public", "internal", "reply"},
    "a_security": {"public", "internal", "reply"},
    "a_resident1": {"public", "reply"},
    # 102 and 201: the request is a_resident1's, for 101, so these see none of its comments.
    "a_resident2": set(),
    "a_council": set(),
    "a_former": set(),
    "b_manager": {"b"},
}


@pytest.mark.parametrize("persona", sorted(EXPECTED))
async def test_each_persona_sees_the_comments_of_the_requests_they_see(
    db: AsyncSession, world: World, comments: dict[str, uuid.UUID], persona: str
) -> None:
    got = await seen(db, visible_maintenance_comments(persona_ctx(world, persona)))

    assert got == {comments[name] for name in EXPECTED[persona]}


async def test_a_council_only_context_sees_no_comment(
    db: AsyncSession, world: World, comments: dict[str, uuid.UUID]
) -> None:
    assert await seen(db, visible_maintenance_comments(ctx_for(world.a_council, Role.COUNCIL))) == (
        set()
    )


async def test_a_resident_who_is_also_staff_sees_the_internal_comment(
    db: AsyncSession, world: World, comments: dict[str, uuid.UUID]
) -> None:
    # A multi-role caller gets the union, as `visible_maintenance`.
    ctx = ctx_of(world.a_resident1.membership, Role.RESIDENT, Role.SECURITY)

    assert await seen(db, visible_maintenance_comments(ctx)) == {
        comments["public"],
        comments["internal"],
        comments["reply"],
    }


async def test_an_internal_comment_on_a_request_a_resident_cannot_see_stays_hidden(
    db: AsyncSession, world: World
) -> None:
    # The flag never grants: a public comment on a request the caller can't see is invisible too.
    request = await make_maintenance_request(
        db, world.a_resident2.membership, world.a_102, submitted_at=AFTER
    )
    await make_maintenance_comment(db, request, world.a_manager.membership)
    await make_maintenance_comment(db, request, world.a_manager.membership, internal=True)

    assert await seen(db, visible_maintenance_comments(persona_ctx(world, "a_resident1"))) == set()


async def test_a_moved_out_resident_sees_comments_on_both_sides_of_their_move(
    db: AsyncSession, world: World
) -> None:
    # Criterion 5 (D4): a 101 request from a_former's time there, commented before and after they
    # moved to 102 at T1. a_former sees both; a_resident1 (101 from T2) sees neither.
    request = await make_maintenance_request(
        db, world.a_resident2.membership, world.a_101, submitted_at=DURING_FORMERS_101
    )
    manager = world.a_manager.membership
    before = await make_maintenance_comment(
        db, request, manager, created_at=World.T1 - timedelta(days=1)
    )
    after = await make_maintenance_comment(
        db, request, manager, created_at=World.T1 + timedelta(days=1)
    )
    internal = await make_maintenance_comment(
        db, request, manager, internal=True, created_at=World.T1 + timedelta(days=2)
    )

    assert await seen(db, visible_maintenance_comments(persona_ctx(world, "a_former"))) == {
        before.id,
        after.id,
    }
    assert await seen(db, visible_maintenance_comments(persona_ctx(world, "a_resident1"))) == set()
    assert await seen(db, visible_maintenance_comments(persona_ctx(world, "a_manager"))) == {
        before.id,
        after.id,
        internal.id,
    }
