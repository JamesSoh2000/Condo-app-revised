"""The status-event read (P6-04c criterion 5b), with the tenant table (ENGINEERING_PRACTICES §7).
The events are made by the manager actions themselves (P6-03c), so each row is one a real move
wrote."""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import delete, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.maintenance.models import MaintenanceRequest
from app.memberships.enums import Role
from app.memberships.models import MembershipRole
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.maintenance.conftest import make_maintenance_request
from tests.maintenance.test_api import base
from tests.maintenance.test_comments_api import all_pages
from tests.world import World

pytestmark = pytest.mark.anyio

# start, hold, resume, resolve, reopen: every kind of move, each from the status the last left.
MOVES = ("start", "hold", "start", "resolve", "reopen")
STEPS = [
    ("submitted", "in_progress"),
    ("in_progress", "on_hold"),
    ("on_hold", "in_progress"),
    ("in_progress", "resolved"),
    ("resolved", "in_progress"),
]


def events_url(world: World, request_id: Any, building: Any = None) -> str:
    return f"{base(world, building)}/{request_id}/status-events"


async def moved(as_user: Any, world: World, request: MaintenanceRequest) -> None:
    manager = await as_user(world.a_manager.user)
    for verb in MOVES:
        response = await manager.post(f"{base(world)}/{request.id}/{verb}")
        assert response.status_code == 200, response.text


@pytest.fixture
async def request_101(db: AsyncSession, world: World) -> MaintenanceRequest:
    return await make_maintenance_request(db, world.a_resident1.membership, world.a_101)


@pytest.mark.parametrize("persona", ["a_resident1", "a_manager", "a_security"])
async def test_members_who_see_the_request_list_its_moves_oldest_first(
    as_user: Any, world: World, request_101: Any, persona: str
) -> None:
    await moved(as_user, world, request_101)
    client = await as_user(getattr(world, persona).user)

    response = await client.get(events_url(world, request_101.id))

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert response.json()["next_cursor"] is None
    assert [(item["from_status"], item["status"]) for item in items] == STEPS
    assert set(items[0]) == {"id", "request_id", "from_status", "status", "at"}
    assert all(item["request_id"] == str(request_101.id) for item in items)
    assert [item["at"] for item in items] == sorted(item["at"] for item in items)


async def test_a_request_with_no_move_has_no_event(
    as_user: Any, world: World, request_101: Any
) -> None:
    client = await as_user(world.a_resident1.user)
    response = await client.get(events_url(world, request_101.id))
    assert response.json() == {"items": [], "next_cursor": None}


async def test_a_co_occupant_who_sees_the_request_lists_its_moves(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # 201's request by a_council: multi_in_a lives in 201 too and sees it (P6-03a).
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)
    await moved(as_user, world, request)
    client = await as_user(world.multi)

    response = await client.get(events_url(world, request.id))

    assert response.status_code == 200, response.text
    assert len(response.json()["items"]) == len(STEPS)


async def test_pages_follow_one_another_with_no_gap(
    as_user: Any, world: World, request_101: Any
) -> None:
    await moved(as_user, world, request_101)
    client = await as_user(world.a_resident1.user)
    whole = (await client.get(events_url(world, request_101.id))).json()["items"]

    for limit in (1, 2, 3):
        pages = await all_pages(client, events_url(world, request_101.id), limit)
        assert all(len(page) == limit for page in pages[:-1]), (limit, pages)
        assert [item for page in pages for item in page] == whole


async def test_only_the_requests_own_moves_are_listed(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    other = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    await moved(as_user, world, other)
    client = await as_user(world.a_resident1.user)

    response = await client.get(events_url(world, request_101.id))

    assert response.json()["items"] == []


async def test_the_council_member_lists_their_own_requests_moves_only(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    own = await make_maintenance_request(db, world.a_council.membership, None)
    other = await make_maintenance_request(db, world.a_resident2.membership, None)
    client = await as_user(world.a_council.user)

    assert (await client.get(events_url(world, own.id))).status_code == 200
    await assert_not_visible(
        client, "GET", events_url(world, other.id), code="maintenance_request_not_found"
    )


async def test_another_residents_request_is_the_same_404_as_a_random_id(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    await moved(as_user, world, request_101)
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    client = await as_user(world.a_resident2.user)

    bodies = [
        without_request_id(
            await assert_not_visible(
                client, "GET", events_url(world, request_id), code="maintenance_request_not_found"
            )
        )
        for request_id in (request_101.id, uuid.uuid4(), b_request.id)
    ]
    assert bodies[0] == bodies[1] == bodies[2]


async def test_a_b_request_on_as_url_is_404_for_as_manager(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    client = await as_user(world.a_manager.user)

    await assert_cross_building_404(
        client, "GET", events_url(world, b_request.id), code="maintenance_request_not_found"
    )


async def test_signed_out_is_401(client: AsyncClient, world: World, request_101: Any) -> None:
    assert_problem(await client.get(events_url(world, request_101.id)), 401, "not_authenticated")


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_outsiders_get_building_not_found(
    as_user: Any, world: World, request_101: Any, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    await assert_cross_building_404(client, "GET", events_url(world, request_101.id))


async def test_feature_off_is_403(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
        .values(enabled=False)
    )
    for persona in ("a_resident1", "a_manager"):
        client = await as_user(getattr(world, persona).user)
        assert_problem(await client.get(events_url(world, request_101.id)), 403, "feature_disabled")


async def test_a_malformed_cursor_is_400(as_user: Any, world: World, request_101: Any) -> None:
    client = await as_user(world.a_resident1.user)
    response = await client.get(events_url(world, request_101.id), params={"cursor": "x"})
    assert response.status_code == 400, response.text


async def test_a_council_only_member_sees_no_requests_moves(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # Review round 2: a_council is also a resident. Council alone sees no request (P6-03a), so
    # not even the moves of one it filed while a resident.
    own = await make_maintenance_request(db, world.a_council.membership, None)
    await db.execute(
        delete(MembershipRole).where(
            MembershipRole.membership_id == world.a_council.membership.id,
            MembershipRole.role == Role.RESIDENT,
        )
    )
    client = await as_user(world.a_council.user)

    await assert_not_visible(
        client, "GET", events_url(world, own.id), code="maintenance_request_not_found"
    )
