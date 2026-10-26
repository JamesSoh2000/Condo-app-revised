"""P6-03a criteria 7 and 8: who `visible_maintenance(ctx)` shows which request to.

Windows are half-open (ADR-0010): an occupancy covers `started_at <= T < ended_at`.
"""

import uuid
from datetime import timedelta

import pytest
from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession

from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import MaintenanceRequest
from app.maintenance.queries import visible_maintenance
from app.memberships.enums import Role
from tests.maintenance.conftest import make_maintenance_request
from tests.packages.conftest import ctx_for, ctx_of, persona_ctx
from tests.world import World

pytestmark = pytest.mark.anyio

DURING_FORMERS_101 = World.T0 + timedelta(days=1)  # a_former in 101
BETWEEN = World.T1 + timedelta(days=1)  # 101 empty; a_former in 102
AFTER = World.T2 + timedelta(days=1)  # a_resident1 in 101; a_former and a_resident2 in 102


async def seen(db: AsyncSession, query: Select[MaintenanceRequest]) -> set[uuid.UUID]:
    return {request.id for request in await db.scalars(query)}


@pytest.fixture
async def requests(db: AsyncSession, world: World) -> dict[str, uuid.UUID]:
    """Criterion 7's requests, all submitted after T2, by name."""
    manager = world.a_manager.membership
    r1, r2 = world.a_resident1.membership, world.a_resident2.membership
    made = {
        f"r1_{status}": await make_maintenance_request(
            db, r1, world.a_101, submitted_at=AFTER, status=status, acted_by=manager
        )
        for status in MaintenanceStatus
    }
    made["r2_unit"] = await make_maintenance_request(db, r2, world.a_102, submitted_at=AFTER)
    made["r2_common"] = await make_maintenance_request(db, r2, None, submitted_at=AFTER)
    # The council member's own request is for a common area: one for 201 would also be seen by
    # 201's other occupants (multi_in_a), which criterion 7 doesn't ask about.
    made["council_common"] = await make_maintenance_request(
        db, world.a_council.membership, None, submitted_at=AFTER
    )
    made["b"] = await make_maintenance_request(
        db, world.b_resident1.membership, world.b_101, submitted_at=AFTER
    )
    return {name: request.id for name, request in made.items()}


R1 = {f"r1_{status}" for status in MaintenanceStatus}
ALL_A = R1 | {"r2_unit", "r2_common", "council_common"}
EXPECTED: dict[str, set[str]] = {
    "a_manager": ALL_A,
    "a_security": ALL_A,
    "a_resident1": R1,  # their own; 101 is theirs anyway
    "a_resident2": {"r2_unit", "r2_common"},
    # 102's co-occupant since T1 sees what was filed for 102 in that time, not a_resident2's
    # common-area request (no unit), nor 101's after they left it.
    "a_former": {"r2_unit"},
    "a_council": {"council_common"},  # council grants nothing; 201 has no request
    "b_manager": {"b"},
    "b_resident1": {"b"},
}


@pytest.mark.parametrize("persona", sorted(EXPECTED))
async def test_visibility_by_persona(
    db: AsyncSession, world: World, requests: dict[str, uuid.UUID], persona: str
):
    got = await seen(db, visible_maintenance(persona_ctx(world, persona)))

    assert got == {requests[name] for name in EXPECTED[persona]}


async def test_a_household_member_of_another_unit_sees_none(
    db: AsyncSession, world: World, requests: dict[str, uuid.UUID]
):
    got = await seen(db, visible_maintenance(ctx_of(world.multi_in_a, Role.RESIDENT)))

    assert got == set()


async def test_council_alone_sees_no_request(
    db: AsyncSession, world: World, requests: dict[str, uuid.UUID]
):
    got = await seen(db, visible_maintenance(ctx_for(world.a_council, Role.COUNCIL)))

    assert got == set()


async def test_a_context_with_no_role_sees_no_request(
    db: AsyncSession, world: World, requests: dict[str, uuid.UUID]
):
    got = await seen(db, visible_maintenance(ctx_for(world.a_resident1)))

    assert got == set()


async def test_the_query_never_leaves_the_contexts_building(
    db: AsyncSession, world: World, requests: dict[str, uuid.UUID]
):
    # A (forged) context for building B with A's manager membership still sees only B's rows.
    ctx = ctx_for(world.a_manager, Role.PROPERTY_MANAGEMENT)
    forged = ctx_of(world.b_manager.membership, Role.PROPERTY_MANAGEMENT)

    assert await seen(db, visible_maintenance(forged)) == {requests["b"]}
    assert requests["b"] not in await seen(db, visible_maintenance(ctx))


# --- criterion 8: the occupancy window ------------------------------------------------------------


async def _for_101(db: AsyncSession, world: World, at) -> uuid.UUID:
    """A request for 101 filed by a_resident2 (who never lived there), submitted at `at`."""
    request = await make_maintenance_request(
        db, world.a_resident2.membership, world.a_101, submitted_at=at
    )
    return request.id


async def test_each_occupant_sees_101s_requests_from_their_own_time(db: AsyncSession, world: World):
    before = await _for_101(db, world, DURING_FORMERS_101)
    between = await _for_101(db, world, BETWEEN)
    after = await _for_101(db, world, AFTER)

    assert await seen(db, visible_maintenance(persona_ctx(world, "a_former"))) == {before}
    assert await seen(db, visible_maintenance(persona_ctx(world, "a_resident1"))) == {after}
    assert {before, between, after} <= await seen(
        db, visible_maintenance(persona_ctx(world, "a_resident2"))
    )


@pytest.mark.parametrize(
    ("at", "former_sees", "resident1_sees"),
    [
        pytest.param(World.T0, True, False, id="at a_former's start"),
        pytest.param(World.T1 - timedelta(microseconds=1), True, False, id="just before T1"),
        pytest.param(World.T1, False, False, id="at a_former's end"),
        pytest.param(World.T2 - timedelta(microseconds=1), False, False, id="just before T2"),
        pytest.param(World.T2, False, True, id="at a_resident1's start"),
    ],
)
async def test_a_window_includes_its_start_and_excludes_its_end(
    db: AsyncSession, world: World, at, former_sees: bool, resident1_sees: bool
):
    request = await _for_101(db, world, at)

    former = await seen(db, visible_maintenance(persona_ctx(world, "a_former")))
    resident1 = await seen(db, visible_maintenance(persona_ctx(world, "a_resident1")))

    assert (request in former, request in resident1) == (former_sees, resident1_sees)


async def test_a_requester_sees_their_own_requests_whatever_the_unit(
    db: AsyncSession, world: World
):
    # a_former files for 101 after leaving it; a_resident1 files for 102, never theirs.
    former_own = await make_maintenance_request(
        db, world.a_former.membership, world.a_101, submitted_at=AFTER
    )
    resident1_own = await make_maintenance_request(
        db, world.a_resident1.membership, world.a_102, submitted_at=AFTER
    )

    assert former_own.id in await seen(db, visible_maintenance(persona_ctx(world, "a_former")))
    assert resident1_own.id in await seen(
        db, visible_maintenance(persona_ctx(world, "a_resident1"))
    )
    # a_resident1's 102 request is in 102's current window, so its occupants see it too.
    assert resident1_own.id in await seen(
        db, visible_maintenance(persona_ctx(world, "a_resident2"))
    )
