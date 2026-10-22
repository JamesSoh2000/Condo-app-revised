"""`GET /units/{unit_id}/occupants` (P5-02a criterion 10): who the desk may name as a package's
recipient, and the tenant table (ENGINEERING_PRACTICES §7)."""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy.ext.asyncio import AsyncSession

from app.memberships.occupancy import end_occupancy
from app.units.models import Unit
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)
from tests.world import World

pytestmark = pytest.mark.anyio


def _url(world: World, unit_id: Any, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/units/{unit_id}/occupants"


@pytest.mark.parametrize("persona", ["a_security", "a_manager"])
async def test_staff_list_a_units_active_current_occupants_earliest_first(
    as_user: Any, world: World, persona: str
) -> None:
    # 201: a_council (owner), a_suspended (household, suspended) and multi (household), all from T0.
    client = await as_user(getattr(world, persona).user)

    response = await client.get(_url(world, world.a_201.id))

    assert response.status_code == 200, response.text
    expected = sorted(
        [
            (world.a_council.membership.id, "a council", "owner"),
            (world.multi_in_a.id, world.multi.full_name, "household"),
        ],
        key=lambda row: row[0],
    )
    assert response.json() == [
        {"membership_id": str(membership_id), "full_name": name, "relationship": relationship}
        for membership_id, name, relationship in expected
    ]


async def test_former_occupants_are_not_listed(as_user: Any, world: World) -> None:
    # a_former lived in 101 until T1.
    client = await as_user(world.a_security.user)

    response = await client.get(_url(world, world.a_101.id))

    assert response.json() == [
        {
            "membership_id": str(world.a_resident1.membership.id),
            "full_name": "a resident1",
            "relationship": "tenant",
        }
    ]


async def test_a_moved_out_occupant_is_no_longer_listed(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await end_occupancy(db, building_id=world.a.id, membership_id=world.a_resident1.membership.id)
    client = await as_user(world.a_security.user)

    response = await client.get(_url(world, world.a_101.id))

    assert response.status_code == 200, response.text
    assert response.json() == []


async def test_an_inactive_unit_lists_its_occupants_too(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Deactivation needs an empty unit, so this is an empty list, not a 404.
    inactive = Unit(building_id=world.a.id, label="707", is_active=False)
    db.add(inactive)
    await db.flush()
    client = await as_user(world.a_security.user)

    response = await client.get(_url(world, inactive.id))

    assert response.status_code == 200, response.text
    assert response.json() == []


async def test_a_unit_of_another_building_looks_like_an_unknown_unit(
    as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)

    other = await assert_cross_building_404(
        client, "GET", _url(world, world.b_101.id), code="unit_not_found"
    )
    unknown = await assert_cross_building_404(
        client, "GET", _url(world, uuid.uuid4()), code="unit_not_found"
    )

    assert without_request_id(other) == without_request_id(unknown)


@pytest.mark.parametrize("persona", ["a_resident1", "a_council"])
async def test_residents_may_not_list_occupants(as_user: Any, world: World, persona: str) -> None:
    client = await as_user(getattr(world, persona).user)

    await assert_forbidden_role(client, "GET", _url(world, world.a_101.id))


@pytest.mark.parametrize("persona", ["b_manager", "b_resident1", "a_pending", "a_suspended"])
async def test_non_members_get_404(as_user: Any, world: World, persona: str) -> None:
    client = await as_user(getattr(world, persona).user)

    await assert_cross_building_404(client, "GET", _url(world, world.a_101.id))


async def test_without_a_session_it_is_401(client: AsyncClient, world: World) -> None:
    assert_problem(await client.get(_url(world, world.a_101.id)), 401, "not_authenticated")
