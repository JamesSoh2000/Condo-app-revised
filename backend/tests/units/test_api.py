"""The units routes (P4-01 criteria 1-4 and 7) and the tenant table (ENGINEERING_PRACTICES §7)."""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.memberships.occupancy import end_occupancy
from app.units.models import Unit
from tests.factories import make_unit
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)
from tests.world import World

pytestmark = pytest.mark.anyio


def _units(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/units"


async def _audit(db: AsyncSession, action: str) -> list[AuditEvent]:
    return list(
        await db.scalars(
            select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)
        )
    )


async def _unit_count(db: AsyncSession, building_id: uuid.UUID) -> int:
    return await db.scalar(select(func.count()).where(Unit.building_id == building_id)) or 0


def _labels(body: dict[str, Any]) -> list[str]:
    return sorted(item["label"] for item in body["items"])


# Criterion 1: list and search


async def test_security_search_lists_prefix_matches_in_own_building_only(as_user, db, world):
    await make_unit(db, world.a, label="1001")
    await make_unit(db, world.a, label="A10")  # contains "10", not a prefix
    await make_unit(db, world.b, label="1002")
    client = await as_user(world.a_security.user)

    r = await client.get(_units(world), params={"search": "10"})

    assert r.status_code == 200, r.text
    assert _labels(r.json()) == ["1001", "101", "102"]


async def test_search_is_case_insensitive(as_user, db, world):
    await make_unit(db, world.a, label="PH1")
    client = await as_user(world.a_security.user)

    r = await client.get(_units(world), params={"search": "ph"})

    assert _labels(r.json()) == ["PH1"]


async def test_manager_gets_the_same_list(as_user, world):
    security = await as_user(world.a_security.user)
    expected = (await security.get(_units(world))).json()
    manager = await as_user(world.a_manager.user)

    r = await manager.get(_units(world))

    assert r.status_code == 200
    assert r.json() == expected


async def test_list_item_body_and_occupant_counts(as_user, world):
    client = await as_user(world.a_manager.user)

    r = await client.get(_units(world))

    by_label = {item["label"]: item for item in r.json()["items"]}
    assert by_label["101"] == {
        "id": str(world.a_101.id),
        "tower": None,
        "label": "101",
        "floor": None,
        "is_active": True,
        "current_occupant_count": 1,
    }
    # 102: a_resident2 and a_former; 201: a_council, a_suspended (counted: suspended still lives
    # there) and multi.
    assert by_label["102"]["current_occupant_count"] == 2
    assert by_label["201"]["current_occupant_count"] == 3
    assert r.json()["next_cursor"] is None


@pytest.mark.parametrize("search", ["1_1", "1%", "%"])
async def test_search_treats_percent_and_underscore_literally(as_user, world, search):
    client = await as_user(world.a_security.user)

    r = await client.get(_units(world), params={"search": search})

    assert r.status_code == 200
    assert r.json()["items"] == []


async def test_list_filters_by_active_and_tower(as_user, db, world):
    await make_unit(db, world.a, tower="B", label="101", floor=1)
    await make_unit(db, world.a, tower="B", label="9", is_active=False)
    client = await as_user(world.a_manager.user)

    inactive = (await client.get(_units(world), params={"active": "false"})).json()
    tower_b = (await client.get(_units(world), params={"tower": "B"})).json()
    active_b = (await client.get(_units(world), params={"tower": "B", "active": "true"})).json()

    assert [(i["tower"], i["label"]) for i in inactive["items"]] == [("B", "9")]
    assert _labels(tower_b) == ["101", "9"]
    assert _labels(active_b) == ["101"]


async def test_list_pages_with_a_cursor(as_user, world):
    client = await as_user(world.a_manager.user)

    first = (await client.get(_units(world), params={"limit": 2})).json()
    second = (
        await client.get(_units(world), params={"limit": 2, "cursor": first["next_cursor"]})
    ).json()

    assert len(first["items"]) == 2
    assert first["next_cursor"] is not None
    assert [i["id"] for i in first["items"] + second["items"]] == sorted(
        [str(u.id) for u in (world.a_101, world.a_102, world.a_201)], reverse=True
    )
    assert second["next_cursor"] is None


async def test_list_rejects_a_bad_cursor(as_user, world):
    client = await as_user(world.a_manager.user)

    r = await client.get(_units(world), params={"cursor": "not-a-cursor-at-all-xx"})

    assert_problem(r, 400, "invalid_cursor")


@pytest.mark.parametrize("persona", ["a_resident1", "a_council"])
async def test_resident_and_council_get_403_on_list(as_user, world, persona):
    client = await as_user(getattr(world, persona).user)
    await assert_forbidden_role(client, "GET", _units(world))


# Criterion 2: create


async def test_manager_creates_a_unit_with_audit_row(as_user, db, world):
    client = await as_user(world.a_manager.user)

    r = await client.post(_units(world), json={"tower": " B ", "label": " 1205 ", "floor": 12})

    assert r.status_code == 201, r.text
    body = r.json()
    assert body == {
        "id": body["id"],
        "tower": "B",
        "label": "1205",
        "floor": 12,
        "is_active": True,
        "current_occupant_count": 0,
    }
    unit = await db.get(Unit, uuid.UUID(body["id"]))
    assert unit is not None
    assert (unit.building_id, unit.tower, unit.label) == (world.a.id, "B", "1205")
    [event] = await _audit(db, "unit.created")
    assert (event.building_id, event.actor_user_id, event.entity_type, event.entity_id) == (
        world.a.id,
        world.a_manager.user.id,
        "unit",
        unit.id,
    )
    assert event.metadata_ == {"fields": ["tower", "label", "floor"]}


async def test_blank_tower_means_no_tower(as_user, world):
    client = await as_user(world.a_manager.user)

    r = await client.post(_units(world), json={"tower": "  ", "label": "999"})

    assert r.status_code == 201
    assert r.json()["tower"] is None


async def test_duplicate_null_tower_label_is_409_unit_exists(as_user, db, world):
    client = await as_user(world.a_manager.user)
    before = await _unit_count(db, world.a.id)

    r = await client.post(_units(world), json={"label": "101"})

    assert_problem(r, 409, "unit_exists")
    assert await _unit_count(db, world.a.id) == before
    assert await _audit(db, "unit.created") == []


async def test_same_label_in_another_tower_or_building_is_not_a_duplicate(as_user, world):
    a_client = await as_user(world.a_manager.user)
    b_client = await as_user(world.b_manager.user)

    in_tower = await a_client.post(_units(world), json={"tower": "B", "label": "101"})
    in_b = await b_client.post(_units(world, world.b), json={"label": "102"})

    assert in_tower.status_code == 201
    assert in_b.status_code == 201


@pytest.mark.parametrize(
    "payload",
    [
        {"label": ""},
        {"label": "   "},
        {"label": "x" * 21},
        {"label": "1\x0001"},
        # Raw JSON: httpx can't encode a lone surrogate, but a client can send the escape.
        '{"label": "1\\ud80001"}',
        {"label": "10\n1"},
        {"tower": "t" * 21, "label": "1"},
        {"tower": "a\x00", "label": "1"},
        {"label": "1", "floor": 301},
        {"label": "1", "floor": -21},
        {"label": "1", "floor": 2**31},
        {"label": "1", "floor": 1.5},
        {"label": "1", "is_active": False},
        {"tower": "A"},
    ],
)
async def test_create_rejects_invalid_input_and_writes_nothing(as_user, db, world, payload):
    client = await as_user(world.a_manager.user)
    before = await _unit_count(db, world.a.id)

    if isinstance(payload, str):
        headers = {"Content-Type": "application/json"}
        r = await client.post(_units(world), content=payload, headers=headers)
    else:
        r = await client.post(_units(world), json=payload)

    assert_problem(r, 422, "validation_error")
    assert await _unit_count(db, world.a.id) == before


async def test_security_gets_403_on_every_write(as_user, world):
    client = await as_user(world.a_security.user)
    unit = _units(world) + f"/{world.a_102.id}"

    await assert_forbidden_role(client, "POST", _units(world), json={"label": "9"})
    await assert_forbidden_role(client, "PATCH", unit, json={"floor": 1})
    await assert_forbidden_role(client, "POST", unit + "/deactivate")
    await assert_forbidden_role(client, "POST", unit + "/activate")


# Criterion 3: deactivate and activate


async def test_deactivating_an_occupied_unit_is_409(as_user, db, world):
    client = await as_user(world.a_manager.user)

    r = await client.post(_units(world) + f"/{world.a_101.id}/deactivate")

    assert_problem(r, 409, "unit_has_occupants")
    await db.refresh(world.a_101)
    assert world.a_101.is_active is True
    assert await _audit(db, "unit.deactivated") == []


async def test_a_suspended_occupant_also_blocks_deactivation(as_user, db, world):
    for member in (world.a_council.membership, world.multi_in_a):
        await end_occupancy(db, building_id=world.a.id, membership_id=member.id)
    client = await as_user(world.a_manager.user)

    r = await client.post(_units(world) + f"/{world.a_201.id}/deactivate")

    assert_problem(r, 409, "unit_has_occupants")


async def test_unit_deactivates_after_its_occupancies_end(as_user, db, world):
    for member in (world.a_council.membership, world.a_suspended.membership, world.multi_in_a):
        await end_occupancy(db, building_id=world.a.id, membership_id=member.id)
    client = await as_user(world.a_manager.user)

    r = await client.post(_units(world) + f"/{world.a_201.id}/deactivate")

    assert r.status_code == 204, r.text
    await db.refresh(world.a_201)
    assert world.a_201.is_active is False
    [event] = await _audit(db, "unit.deactivated")
    assert (event.building_id, event.actor_user_id, event.entity_id) == (
        world.a.id,
        world.a_manager.user.id,
        world.a_201.id,
    )
    listed = (await client.get(_units(world), params={"active": "false"})).json()
    assert [i["id"] for i in listed["items"]] == [str(world.a_201.id)]


async def test_activate_restores_a_unit_with_audit_row(as_user, db, world):
    unit = await make_unit(db, world.a, label="9", is_active=False)
    client = await as_user(world.a_manager.user)

    r = await client.post(_units(world) + f"/{unit.id}/activate")

    assert r.status_code == 204, r.text
    await db.refresh(unit)
    assert unit.is_active is True
    [event] = await _audit(db, "unit.activated")
    assert event.entity_id == unit.id


async def test_repeated_transitions_are_409_invalid_transition(as_user, db, world):
    inactive = await make_unit(db, world.a, label="9", is_active=False)
    client = await as_user(world.a_manager.user)

    deactivate = await client.post(_units(world) + f"/{inactive.id}/deactivate")
    activate = await client.post(_units(world) + f"/{world.a_102.id}/activate")

    assert_problem(deactivate, 409, "invalid_transition")
    assert_problem(activate, 409, "invalid_transition")
    assert await _audit(db, "unit.deactivated") == []
    assert await _audit(db, "unit.activated") == []


# Criterion 7: PATCH


async def test_patch_changes_only_sent_fields_and_audits_names(as_user, db, world):
    unit = await make_unit(db, world.a, tower="A", label="5", floor=5)
    client = await as_user(world.a_manager.user)

    r = await client.patch(_units(world) + f"/{unit.id}", json={"label": "6", "floor": None})

    assert r.status_code == 200, r.text
    assert r.json() == {
        "id": str(unit.id),
        "tower": "A",
        "label": "6",
        "floor": None,
        "is_active": True,
        "current_occupant_count": 0,
    }
    [event] = await _audit(db, "unit.updated")
    assert event.entity_id == unit.id
    assert event.metadata_ == {"fields": ["label", "floor"]}


async def test_patch_reports_the_occupant_count(as_user, world):
    client = await as_user(world.a_manager.user)

    r = await client.patch(_units(world) + f"/{world.a_201.id}", json={"floor": 2})

    assert r.json()["current_occupant_count"] == 3


async def test_patch_rename_onto_existing_is_409(as_user, db, world):
    client = await as_user(world.a_manager.user)

    r = await client.patch(_units(world) + f"/{world.a_102.id}", json={"label": "101"})

    assert_problem(r, 409, "unit_exists")
    await db.refresh(world.a_102)
    assert world.a_102.label == "102"
    assert await _audit(db, "unit.updated") == []


async def test_noop_patch_writes_no_audit_row(as_user, db, world):
    client = await as_user(world.a_manager.user)

    same = await client.patch(_units(world) + f"/{world.a_102.id}", json={"label": "102"})
    empty = await client.patch(_units(world) + f"/{world.a_102.id}", json={})

    assert same.status_code == 200
    assert empty.status_code == 200
    assert await _audit(db, "unit.updated") == []


@pytest.mark.parametrize(
    "payload", [{"label": None}, {"label": ""}, {"floor": 999}, {"is_active": False}]
)
async def test_patch_rejects_invalid_input(as_user, db, world, payload):
    client = await as_user(world.a_manager.user)

    r = await client.patch(_units(world) + f"/{world.a_102.id}", json=payload)

    assert_problem(r, 422, "validation_error")
    await db.refresh(world.a_102)
    assert (world.a_102.label, world.a_102.is_active) == ("102", True)


# Criterion 4 and tenant rows 2, 3 and 6


def _write_requests(base: str, unit_id: uuid.UUID) -> list[tuple[str, str, Any]]:
    return [
        ("PATCH", f"{base}/{unit_id}", {"label": "X1"}),
        ("POST", f"{base}/{unit_id}/deactivate", None),
        ("POST", f"{base}/{unit_id}/activate", None),
    ]


async def test_other_buildings_unit_is_404_on_every_write(as_user, db, world):
    client = await as_user(world.b_manager.user)
    base = _units(world, world.b)

    for method, url, payload in _write_requests(base, world.a_102.id):
        hidden = assert_problem(
            await client.request(method, url, json=payload), 404, "unit_not_found"
        )
        missing_url = url.replace(str(world.a_102.id), str(uuid.uuid4()))
        missing = assert_problem(
            await client.request(method, missing_url, json=payload), 404, "unit_not_found"
        )
        assert without_request_id(hidden) == without_request_id(missing)

    await db.refresh(world.a_102)
    assert (world.a_102.label, world.a_102.is_active) == ("102", True)
    assert await db.scalar(select(func.count()).select_from(AuditEvent)) == 0


async def test_occupied_unit_of_another_building_is_404_not_409(as_user, world):
    # The occupancy check must not run before the building filter: 409 would confirm the unit.
    client = await as_user(world.b_manager.user)

    r = await client.post(_units(world, world.b) + f"/{world.a_101.id}/deactivate")

    assert_problem(r, 404, "unit_not_found")


async def test_unauthenticated_gets_401(client, world):
    for method, url, payload in [
        ("GET", _units(world), None),
        ("POST", _units(world), {"label": "9"}),
        *_write_requests(_units(world), world.a_102.id),
    ]:
        assert_problem(await client.request(method, url, json=payload), 401, "not_authenticated")


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended", "multi"])
async def test_non_members_get_404_and_other_buildings_roles_get_403(as_user, world, persona):
    # multi is security in B, a resident in A: B's role must not open A's list.
    user = world.multi if persona == "multi" else getattr(world, persona).user
    client = await as_user(user)

    for method, url, payload in [
        ("GET", _units(world), None),
        ("POST", _units(world), {"label": "9"}),
        *_write_requests(_units(world), world.a_102.id),
    ]:
        if persona == "multi":
            await assert_forbidden_role(client, method, url, json=payload)
        else:
            await assert_cross_building_404(client, method, url, json=payload)


async def test_multi_lists_building_b_with_its_security_role(as_user, world):
    client: AsyncClient = await as_user(world.multi)

    r = await client.get(_units(world, world.b))

    assert r.status_code == 200
    assert [i["id"] for i in r.json()["items"]] == [str(world.b_101.id)]


@pytest.mark.parametrize(
    "params", [{"search": "1\x00"}, {"tower": "\x00"}, {"search": "x" * 21}, {"tower": "\t"}]
)
async def test_list_rejects_query_values_postgres_cannot_take(as_user, world, params):
    # NUL would fail in Postgres as a DBAPIError (a 500), not a 422 (CLAUDE.md lesson).
    client = await as_user(world.a_security.user)

    r = await client.get(_units(world), params=params)

    assert_problem(r, 422, "validation_error")
