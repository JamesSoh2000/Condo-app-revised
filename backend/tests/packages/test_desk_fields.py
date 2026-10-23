"""The desk's read fields (P5-03a): every `PackageOut` names its unit, the desk alone sees the
recipient's name, and the list filters by carrier, at a fixed number of statements per page. The
tenant rows these touch are here too (ENGINEERING_PRACTICES §7); the rest are in `test_api.py`."""

import uuid
from collections.abc import Iterator
from contextlib import contextmanager
from datetime import UTC, datetime
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import event, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncSession

from app.memberships.enums import MembershipStatus
from app.memberships.models import BuildingMembership, UnitOccupancy
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.units.models import Unit
from app.users.models import User
from tests.factories import make_membership, make_occupancy, make_unit, make_user
from tests.helpers.tenancy import assert_cross_building_404, assert_problem
from tests.packages.conftest import make_package
from tests.world import World

pytestmark = pytest.mark.anyio

FIELDS = ("unit_tower", "unit_label", "recipient_name")


def _base(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/packages"


def _fields(body: dict[str, Any]) -> tuple[Any, ...]:
    return tuple(body[name] for name in FIELDS)


def _items(response: Response) -> list[dict[str, Any]]:
    assert response.status_code == 200, response.text
    items: list[dict[str, Any]] = response.json()["items"]
    return items


def _ids(response: Response) -> list[str]:
    return [item["id"] for item in _items(response)]


async def _get(client: AsyncClient, world: World, package: Package) -> dict[str, Any]:
    response = await client.get(f"{_base(world)}/{package.id}")
    assert response.status_code == 200, response.text
    body: dict[str, Any] = response.json()
    return body


async def _for_resident1(db: AsyncSession, world: World, unit: Unit | None = None) -> Package:
    return await make_package(
        db,
        unit or world.a_101,
        world.a_security.membership,
        recipient_membership_id=world.a_resident1.membership.id,
    )


# --- Criterion 1: the unit, on every endpoint that returns a package (row 9 too) -----------------


async def test_every_package_endpoint_names_the_unit(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await db.execute(update(Unit).where(Unit.id == world.a_101.id).values(tower="East"))
    client = await as_user(world.a_security.user)
    expected = ("East", "101", "a resident1")
    body = {
        "unit_id": str(world.a_101.id),
        "recipient_membership_id": str(world.a_resident1.membership.id),
        "carrier": "UPS",
    }
    key = f"key-{uuid.uuid4()}"

    created = await client.post(_base(world), json=body, headers={"Idempotency-Key": key})
    replayed = await client.post(_base(world), json=body, headers={"Idempotency-Key": key})

    assert created.status_code == 201, created.text
    assert replayed.status_code == 201, replayed.text
    assert replayed.headers["idempotent-replayed"] == "true"
    assert _fields(created.json()) == _fields(replayed.json()) == expected
    package_id = created.json()["id"]
    assert [_fields(item) for item in _items(await client.get(_base(world)))] == [expected]
    got = await client.get(f"{_base(world)}/{package_id}")
    assert _fields(got.json()) == expected

    # Factory packages: one logged through the API a moment ago can fail the received-before-
    # picked-up check when the host's clock and the database's differ.
    to_pick_up, to_return = await _for_resident1(db, world), await _for_resident1(db, world)
    picked_up = await client.post(
        f"{_base(world)}/{to_pick_up.id}/pickup", json={"picked_up_by_name": "Neighbour"}
    )
    returned = await client.post(
        f"{_base(world)}/{to_return.id}/return", json={"reason": "Refused"}
    )
    assert picked_up.status_code == 200, picked_up.text
    assert returned.status_code == 200, returned.text
    assert _fields(picked_up.json()) == _fields(returned.json()) == expected


async def test_a_deactivated_or_renamed_unit_shows_its_current_name(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await make_package(db, world.a_102, world.a_security.membership)
    client = await as_user(world.a_security.user)
    assert _fields(await _get(client, world, package))[:2] == (None, "102")

    await db.execute(
        update(Unit)
        .where(Unit.id == world.a_102.id)
        .values(tower="North", label="102B", is_active=False)
    )

    assert _fields(await _get(client, world, package))[:2] == ("North", "102B")
    assert _fields(_items(await client.get(_base(world)))[0])[:2] == ("North", "102B")


# --- Criterion 2: the recipient's name, for the desk only (rows 1 and 5) -------------------------


@pytest.mark.parametrize("persona", ["a_security", "a_manager"])
async def test_the_desk_sees_the_recipients_current_name(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    for_resident1 = await _for_resident1(db, world)
    for_suspended = await make_package(
        db,
        world.a_201,
        world.a_security.membership,
        recipient_membership_id=world.a_suspended.membership.id,
    )
    client = await as_user(getattr(world, persona).user)
    assert (await _get(client, world, for_suspended))["recipient_name"] == "a suspended"

    # The recipient moves out (membership deactivated, occupancy ended) and changes their name.
    await db.execute(
        update(UnitOccupancy)
        .where(UnitOccupancy.membership_id == world.a_resident1.membership.id)
        .values(ended_at=World.T2.replace(year=2026))
    )
    await db.execute(
        update(BuildingMembership)
        .where(BuildingMembership.id == world.a_resident1.membership.id)
        .values(status=MembershipStatus.DEACTIVATED)
    )
    await db.execute(
        update(User).where(User.id == world.a_resident1.user.id).values(full_name="Ana Lima")
    )

    assert (await _get(client, world, for_resident1))["recipient_name"] == "Ana Lima"
    names = {item["id"]: item["recipient_name"] for item in _items(await client.get(_base(world)))}
    assert names == {str(for_resident1.id): "Ana Lima", str(for_suspended.id): "a suspended"}


async def test_a_unit_package_has_no_recipient_name(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await make_package(db, world.a_101, world.a_security.membership)
    client = await as_user(world.a_security.user)

    assert _fields(await _get(client, world, package)) == (None, "101", None)


async def test_residents_never_see_a_recipient_name(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # 201 is home to a_council (council + resident) and a_suspended: a_council sees this package,
    # addressed to a co-occupant, and one addressed to themselves.
    for_co_occupant = await make_package(
        db,
        world.a_201,
        world.a_security.membership,
        recipient_membership_id=world.a_suspended.membership.id,
    )
    for_council = await make_package(
        db,
        world.a_201,
        world.a_security.membership,
        recipient_membership_id=world.a_council.membership.id,
    )
    own = await _for_resident1(db, world)

    resident = await as_user(world.a_resident1.user)
    council = await as_user(world.a_council.user)

    assert _fields(await _get(resident, world, own)) == (None, "101", None)
    assert [_fields(item) for item in _items(await resident.get(_base(world)))] == [
        (None, "101", None)
    ]
    for package in (for_co_occupant, for_council):
        assert _fields(await _get(council, world, package)) == (None, "201", None)
    assert [_fields(item) for item in _items(await council.get(_base(world)))] == [
        (None, "201", None),
        (None, "201", None),
    ]


async def test_recipient_names_follow_the_role_in_this_building(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # multi is a resident (household in A-201) in A and security in B.
    in_a = await make_package(
        db, world.a_201, world.a_security.membership, recipient_membership_id=world.multi_in_a.id
    )
    in_b = await make_package(
        db,
        world.b_101,
        world.b_manager.membership,
        recipient_membership_id=world.b_resident1.membership.id,
    )
    client = await as_user(world.multi)

    assert (await _get(client, world, in_a))["recipient_name"] is None
    got_b = await client.get(f"{_base(world, world.b)}/{in_b.id}")
    assert got_b.json()["recipient_name"] == "b resident1"
    assert [item["recipient_name"] for item in _items(await client.get(_base(world, world.b)))] == [
        "b resident1"
    ]


# --- Criterion 3: the carrier filter -------------------------------------------------------------


async def test_the_list_filters_by_carrier_ignoring_case(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    upper = await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    lower = await make_package(db, world.a_102, world.a_security.membership, carrier="ups")
    await make_package(db, world.a_101, world.a_security.membership, carrier="UPS Store")
    await make_package(db, world.a_101, world.a_security.membership, carrier="FedEx")
    client = await as_user(world.a_security.user)

    for carrier in ("UPS", "ups", "  uPs "):
        assert _ids(await client.get(_base(world), params={"carrier": carrier})) == [
            str(lower.id),
            str(upper.id),
        ]


async def test_postgres_lowercases_the_carrier(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Postgres and Python lower-case some letters differently ("İ"); both sides go through
    # Postgres, so a carrier always matches its own spelling.
    package = await make_package(
        db, world.a_101, world.a_security.membership, carrier="İstanbul Kargo"
    )
    client = await as_user(world.a_security.user)

    for carrier in ("İstanbul Kargo", "İSTANBUL KARGO"):
        assert _ids(await client.get(_base(world), params={"carrier": carrier})) == [
            str(package.id)
        ]


async def test_the_carrier_filter_combines_with_status_and_unit(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    match = await make_package(db, world.a_101, world.a_security.membership, carrier="DHL")
    await make_package(db, world.a_102, world.a_security.membership, carrier="DHL")
    await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    await make_package(
        db,
        world.a_101,
        world.a_security.membership,
        carrier="DHL",
        status=PackageStatus.RETURNED,
        returned_at=datetime.now(UTC),
        return_reason="Refused",
    )
    client = await as_user(world.a_security.user)

    params = {"carrier": "dhl", "status": "received", "unit_id": str(world.a_101.id)}
    assert _ids(await client.get(_base(world), params=params)) == [str(match.id)]


async def test_the_cursor_pages_through_the_filtered_list(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    dhl = []
    for _ in range(3):
        dhl.append(await make_package(db, world.a_101, world.a_security.membership, carrier="DHL"))
        await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    client = await as_user(world.a_security.user)

    first = await client.get(_base(world), params={"carrier": "DHL", "limit": 2})
    second = await client.get(
        _base(world), params={"carrier": "DHL", "limit": 2, "cursor": first.json()["next_cursor"]}
    )

    assert _ids(first) == [str(dhl[2].id), str(dhl[1].id)]
    assert _ids(second) == [str(dhl[0].id)]
    assert second.json()["next_cursor"] is None


async def test_no_carrier_match_is_an_empty_page(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    client = await as_user(world.a_security.user)

    response = await client.get(_base(world), params={"carrier": "Purolator"})

    assert response.json() == {"items": [], "next_cursor": None}


@pytest.mark.parametrize(
    "query",
    [
        "carrier=",
        "carrier=%20%20",
        f"carrier={'x' * 51}",
        "carrier=UPS%00",
        "carrier=UPS%09",
        "carrier=%09UPS",
        "carrier=UPS%0A",
    ],
)
async def test_an_invalid_carrier_filter_is_a_422(
    db: AsyncSession, as_user: Any, world: World, query: str
) -> None:
    await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    client = await as_user(world.a_security.user)

    assert_problem(await client.get(f"{_base(world)}?{query}"), 422, "validation_error")


async def test_an_undecodable_carrier_escape_is_not_a_server_error(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # A lone surrogate's UTF-8 bytes: the query string is decoded with replacement characters.
    await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    client = await as_user(world.a_security.user)

    response = await client.get(f"{_base(world)}?carrier=%ED%A0%80")

    assert response.json() == {"items": [], "next_cursor": None}


async def test_a_carrier_of_50_characters_is_accepted(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await make_package(db, world.a_101, world.a_security.membership, carrier="x" * 50)
    client = await as_user(world.a_security.user)

    assert _ids(await client.get(_base(world), params={"carrier": "X" * 50})) == [str(package.id)]


# --- Criterion 4: the tenant rows the carrier filter touches -------------------------------------


async def test_the_carrier_filter_without_a_session_is_401(
    client: AsyncClient, world: World
) -> None:
    response = await client.get(_base(world), params={"carrier": "UPS"})

    assert_problem(response, 401, "not_authenticated")


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_non_members_and_suspended_members_get_404_with_a_carrier_filter(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    await make_package(db, world.a_201, world.a_security.membership, carrier="UPS")
    client = await as_user(getattr(world, persona).user)

    await assert_cross_building_404(client, "GET", f"{_base(world)}?carrier=UPS")


async def test_a_residents_carrier_filter_lists_only_their_packages(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    own = await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    await make_package(db, world.a_102, world.a_security.membership, carrier="UPS")
    await make_package(db, world.b_101, world.b_manager.membership, carrier="UPS")
    client = await as_user(world.a_resident1.user)

    assert _ids(await client.get(_base(world), params={"carrier": "UPS"})) == [str(own.id)]


async def test_council_alone_lists_nothing_with_a_carrier_filter(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # a_council is also a resident of 201, so a 201 package is theirs: use 101.
    await make_package(db, world.a_101, world.a_security.membership, carrier="UPS")
    client = await as_user(world.a_council.user)

    assert _ids(await client.get(_base(world), params={"carrier": "UPS"})) == []


# --- Criterion 5: no statement per row -----------------------------------------------------------


@contextmanager
def _counting(connection: AsyncConnection) -> Iterator[list[str]]:
    statements: list[str] = []

    def record(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        statements.append(statement)

    event.listen(connection.sync_connection, "before_cursor_execute", record)
    try:
        yield statements
    finally:
        event.remove(connection.sync_connection, "before_cursor_execute", record)


async def _named_packages(db: AsyncSession, world: World, count: int) -> None:
    """`count` packages, each at a unit of its own for a recipient of its own."""
    for n in range(count):
        unit = await make_unit(db, world.a, tower=f"T{n}")
        user = await make_user(db, full_name=f"Recipient {n}")
        membership = await make_membership(user, world.a)
        await make_occupancy(membership, unit, started_at=World.T0)
        await make_package(
            db, unit, world.a_security.membership, recipient_membership_id=membership.id
        )


@pytest.mark.parametrize("persona", ["a_security", "a_resident1"])
async def test_a_page_of_25_runs_as_many_statements_as_a_page_of_1(
    db: AsyncSession, db_connection: AsyncConnection, as_user: Any, world: World, persona: str
) -> None:
    await _named_packages(db, world, 25)
    # a_resident1 sees only packages naming them or of 101: name them in all 25.
    if persona == "a_resident1":
        await db.execute(
            update(Package).values(recipient_membership_id=world.a_resident1.membership.id)
        )
    client = await as_user(getattr(world, persona).user)

    with _counting(db_connection) as one:
        page_of_1 = await client.get(_base(world), params={"limit": 1})
    with _counting(db_connection) as many:
        page_of_25 = await client.get(_base(world), params={"limit": 25})

    assert len(_items(page_of_1)) == 1
    assert len(_items(page_of_25)) == 25
    assert len({item["unit_tower"] for item in _items(page_of_25)}) == 25
    if persona == "a_security":
        assert len({item["recipient_name"] for item in _items(page_of_25)}) == 25
    assert len(many) == len(one), many


async def test_a_resident_runs_no_name_lookup(
    db: AsyncSession, db_connection: AsyncConnection, as_user: Any, world: World
) -> None:
    await _for_resident1(db, world)
    resident = await as_user(world.a_resident1.user)
    security = await as_user(world.a_security.user)

    with _counting(db_connection) as by_resident:
        await resident.get(_base(world))
    with _counting(db_connection) as by_security:
        await security.get(_base(world))

    # The same request and page; the desk's has the one name lookup more.
    assert len(by_security) == len(by_resident) + 1, (by_resident, by_security)
