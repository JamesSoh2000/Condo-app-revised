"""GET /api/auth/me (P2-02 criteria 1-4, 7, 9-11)."""

import pytest
from sqlalchemy import event

from app.auth import service
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from tests.factories import make_building, make_membership, make_occupancy, make_unit, make_user
from tests.helpers.auth import login_as
from tests.world import World

pytestmark = pytest.mark.anyio

ME = "/api/auth/me"


async def _me(client, db, user) -> dict:
    await login_as(db, client, user)
    response = await client.get(ME)
    assert response.status_code == 200, response.text
    return response.json()


def _by_slug(body: dict) -> dict[str, dict]:
    return {m["building"]["slug"]: m for m in body["memberships"]}


# Criterion 1


async def test_user_without_memberships_gets_their_profile_and_no_memberships(client, db, world):
    body = await _me(client, db, world.no_membership)

    assert body == {
        "user": {
            "id": str(world.no_membership.id),
            "email": "no_membership@example.com",
            "full_name": "nobody",
            "phone": None,
            "locale": "en",
        },
        "memberships": [],
    }


# Criterion 2


async def test_pending_member_sees_the_pending_membership_without_occupancy(client, db, world):
    body = await _me(client, db, world.a_pending.user)

    assert body["memberships"] == [
        {
            "membership_id": str(world.a_pending.membership.id),
            "status": "pending",
            "roles": ["resident"],
            "building": {
                "id": str(world.a.id),
                "name": "Maple Court",
                "slug": "maple",
                "timezone": "America/Toronto",
                "locale": "en",
            },
            "occupancy": None,
        }
    ]


# Criterion 3


async def test_multi_building_user_gets_each_buildings_own_roles_and_occupancy(client, db, world):
    body = await _me(client, db, world.multi)

    assert len(body["memberships"]) == 2
    memberships = _by_slug(body)
    assert memberships["maple"]["membership_id"] == str(world.multi_in_a.id)
    assert memberships["maple"]["roles"] == ["resident"]
    assert memberships["maple"]["occupancy"] == {
        "unit_id": str(world.a_201.id),
        "unit_label": "201",
        "tower": None,
        "relationship": "household",
    }
    assert memberships["birch"]["membership_id"] == str(world.multi_in_b.id)
    assert memberships["birch"]["roles"] == ["security"]
    assert memberships["birch"]["occupancy"] is None


async def test_memberships_are_ordered_by_building_name_and_roles_sorted(client, db, world):
    multi = (await _me(client, db, world.multi))["memberships"]
    council = (await _me(client, db, world.a_council.user))["memberships"]

    assert [m["building"]["name"] for m in multi] == ["Birch House", "Maple Court"]
    assert council[0]["roles"] == ["council", "resident"]


# Criterion 4


async def test_resident_sees_their_current_unit(client, db, world):
    [membership] = (await _me(client, db, world.a_resident1.user))["memberships"]

    assert membership["status"] == "active"
    assert membership["occupancy"] == {
        "unit_id": str(world.a_101.id),
        "unit_label": "101",
        "tower": None,
        "relationship": "tenant",
    }


async def test_former_occupant_sees_only_the_unit_they_live_in_now(client, db, world):
    [membership] = (await _me(client, db, world.a_former.user))["memberships"]

    assert membership["occupancy"] == {
        "unit_id": str(world.a_102.id),
        "unit_label": "102",
        "tower": None,
        "relationship": "tenant",
    }


async def test_occupancy_carries_the_units_tower(client, db):
    building = await make_building(db)
    unit = await make_unit(db, building, tower="East", label="1203")
    user = await make_user(db)
    membership = await make_membership(user, building)
    await make_occupancy(membership, unit, relationship=OccupancyRelationship.OWNER)

    [shown] = (await _me(client, db, user))["memberships"]

    assert shown["occupancy"] == {
        "unit_id": str(unit.id),
        "unit_label": "1203",
        "tower": "East",
        "relationship": "owner",
    }


# Criterion 7


async def test_me_without_a_cookie_is_not_authenticated(client):
    response = await client.get(ME)

    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "not_authenticated"


# Criterion 9


async def test_suspended_member_sees_the_status_and_their_unit(client, db, world):
    [membership] = (await _me(client, db, world.a_suspended.user))["memberships"]

    assert membership["status"] == "suspended"
    assert membership["roles"] == ["resident"]
    assert membership["occupancy"]["unit_id"] == str(world.a_201.id)
    assert membership["occupancy"]["relationship"] == "household"


async def test_denied_memberships_are_shown_and_deactivated_ones_are_not(client, db, world):
    user = await make_user(db)
    denied = await make_membership(user, world.a, status=MembershipStatus.DENIED)
    await make_membership(user, world.b, status=MembershipStatus.DEACTIVATED)

    body = await _me(client, db, user)

    assert [(m["membership_id"], m["status"]) for m in body["memberships"]] == [
        (str(denied.id), "denied")
    ]


async def test_memberships_in_an_inactive_building_are_not_shown(client, db, world):
    closed = await make_building(db, name="Aaa Closed", is_active=False)
    await make_membership(world.multi, closed)

    body = await _me(client, db, world.multi)

    assert {m["building"]["slug"] for m in body["memberships"]} == {"maple", "birch"}


async def test_every_status_but_deactivated_is_shown(client, db):
    user = await make_user(db)
    expected = set()
    for status in MembershipStatus:
        await make_membership(user, await make_building(db), status=status)
        if status is not MembershipStatus.DEACTIVATED:
            expected.add(status.value)

    body = await _me(client, db, user)

    assert sorted(m["status"] for m in body["memberships"]) == sorted(expected)


# Criterion 10


async def test_me_takes_at_most_two_statements_however_many_memberships(db):
    user = await make_user(db)
    for _ in range(3):
        building = await make_building(db)
        membership = await make_membership(user, building, roles=(Role.RESIDENT, Role.COUNCIL))
        await make_occupancy(membership, await make_unit(db, building), started_at=World.T0)
    connection = (await db.connection()).sync_connection
    assert connection is not None
    statements: list[str] = []

    def count(_conn, _cursor, statement, *_args) -> None:
        statements.append(statement)

    event.listen(connection, "before_cursor_execute", count)
    try:
        me = await service.get_me(db, user)
    finally:
        event.remove(connection, "before_cursor_execute", count)

    assert len(me.memberships) == 3
    assert all(m.occupancy is not None and len(m.roles) == 2 for m in me.memberships)
    assert len(statements) <= 2, statements


# Criterion 11


async def test_member_who_moved_out_has_no_occupancy(client, db, world):
    user = await make_user(db)
    membership = await make_membership(user, world.a)
    await make_occupancy(membership, world.a_201, started_at=World.T0, ended_at=World.T1)

    [shown] = (await _me(client, db, user))["memberships"]

    assert shown["occupancy"] is None
