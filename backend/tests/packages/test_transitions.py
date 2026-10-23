"""Pickup and return (P5-02b): the desk's two transitions, who may collect, the notification, and
the tenant table (ENGINEERING_PRACTICES §7). Races on real connections are in
`test_concurrency.py`."""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.jobs.models import Job
from app.memberships.models import BuildingMembership
from app.notifications.models import Notification
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.units.models import Unit
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)
from tests.packages.conftest import make_package
from tests.world import Member, World

pytestmark = pytest.mark.anyio

ROW_MODELS = (Notification, Job, AuditEvent)
ACTIONS = ("pickup", "return")


def _url(world: World, package_id: uuid.UUID, action: str, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/packages/{package_id}/{action}"


def _body(world: World, action: str) -> dict[str, Any]:
    """A valid body for `action` on a package of A-101."""
    if action == "pickup":
        return {"picked_up_by_membership_id": str(world.a_resident1.membership.id)}
    return {"reason": "Refused by the recipient"}


async def _post(
    client: AsyncClient, world: World, package: Package, action: str, body: Any = None
) -> Response:
    return await client.post(
        _url(world, package.id, action), json=_body(world, action) if body is None else body
    )


async def _counts(db: AsyncSession) -> tuple[int, ...]:
    return tuple(
        [await db.scalar(select(func.count()).select_from(model)) or 0 for model in ROW_MODELS]
    )


async def _state(db: AsyncSession, package: Package) -> tuple[Any, ...]:
    row = (
        await db.execute(
            select(
                Package.status,
                Package.picked_up_at,
                Package.picked_up_by_membership_id,
                Package.picked_up_by_name,
                Package.handed_out_by_membership_id,
                Package.returned_at,
                Package.return_reason,
            ).where(Package.id == package.id)
        )
    ).one()
    return tuple(row)


async def _received(db: AsyncSession, world: World, unit: Unit | None = None, **kw: Any) -> Package:
    return await make_package(db, unit or world.a_101, world.a_security.membership, **kw)


async def _assert_unchanged(
    db: AsyncSession, package: Package, before_state: tuple[Any, ...], before: tuple[int, ...]
) -> None:
    assert await _state(db, package) == before_state
    assert await _counts(db) == before


async def _refused(
    db: AsyncSession,
    client: AsyncClient,
    world: World,
    package: Package,
    action: str,
    body: Any,
    status: int,
    code: str,
) -> dict[str, Any]:
    """`action` with `body` is refused with `status`/`code` and changes nothing."""
    before, before_state = await _counts(db), await _state(db, package)
    result = assert_problem(await _post(client, world, package, action, body), status, code)
    await _assert_unchanged(db, package, before_state, before)
    return result


async def _set_status(db: AsyncSession, package: Package, status: PackageStatus) -> None:
    values: dict[str, Any] = {"status": status}
    if status == PackageStatus.PICKED_UP:
        values |= {
            "picked_up_at": func.clock_timestamp(),
            "picked_up_by_name": "Neighbour",
            "handed_out_by_membership_id": package.received_by_membership_id,
        }
    else:
        values |= {"returned_at": func.clock_timestamp(), "return_reason": "Damaged"}
    await db.execute(update(Package).where(Package.id == package.id).values(**values))


# --- Criterion 7: the happy paths -----------------------------------------------------------------


@pytest.mark.parametrize("desk", ["a_security", "a_manager"])
async def test_desk_picks_up_a_package(
    db: AsyncSession, as_user: Any, world: World, desk: str
) -> None:
    package = await _received(db, world)
    member: Member = getattr(world, desk)
    client = await as_user(member.user)

    response = await _post(client, world, package, "pickup")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["id"] == str(package.id)
    assert body["status"] == "picked_up"
    assert body["picked_up_at"] is not None
    assert body["returned_at"] is None
    status, picked_up_at, by_member, by_name, handed_out_by, returned_at, reason = await _state(
        db, package
    )
    assert status == PackageStatus.PICKED_UP
    assert picked_up_at is not None and picked_up_at >= package.received_at
    assert (by_member, by_name) == (world.a_resident1.membership.id, None)
    assert handed_out_by == member.membership.id
    assert (returned_at, reason) == (None, None)
    [event] = await db.scalars(select(AuditEvent).where(AuditEvent.action == "package.picked_up"))
    assert (event.entity_type, event.entity_id) == ("package", package.id)
    assert (event.building_id, event.actor_user_id) == (world.a.id, member.user.id)
    assert event.metadata_ == {
        "unit_id": str(world.a_101.id),
        "picked_up_by_membership_id": str(world.a_resident1.membership.id),
        "picked_up_by": "member",
    }


async def test_pickup_by_a_typed_name_stores_it_stripped(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await _received(db, world)
    client = await as_user(world.a_security.user)

    response = await _post(client, world, package, "pickup", {"picked_up_by_name": "  Jo Smith "})

    assert response.status_code == 200, response.text
    _, _, by_member, by_name, *_ = await _state(db, package)
    assert (by_member, by_name) == (None, "Jo Smith")
    [event] = await db.scalars(select(AuditEvent).where(AuditEvent.action == "package.picked_up"))
    # IDs and field names only (CLAUDE.md rule 10): the typed name isn't in the audit.
    assert event.metadata_ == {
        "unit_id": str(world.a_101.id),
        "picked_up_by_membership_id": None,
        "picked_up_by": "name",
    }


@pytest.mark.parametrize("desk", ["a_security", "a_manager"])
async def test_desk_returns_a_package(
    db: AsyncSession, as_user: Any, world: World, desk: str
) -> None:
    package = await _received(db, world)
    member: Member = getattr(world, desk)
    client = await as_user(member.user)
    before = await _counts(db)

    response = await _post(client, world, package, "return", {"reason": "  Wrong building  "})

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["picked_up_at"]) == ("returned", None)
    assert body["returned_at"] is not None
    status, picked_up_at, by_member, by_name, handed_out_by, returned_at, reason = await _state(
        db, package
    )
    assert status == PackageStatus.RETURNED
    assert (picked_up_at, by_member, by_name, handed_out_by) == (None, None, None, None)
    assert returned_at is not None and returned_at >= package.received_at
    assert reason == "Wrong building"
    [event] = await db.scalars(select(AuditEvent).where(AuditEvent.action == "package.returned"))
    assert (event.entity_id, event.actor_user_id) == (package.id, member.user.id)
    assert event.metadata_ == {"unit_id": str(world.a_101.id)}
    # Criterion 11: a return notifies nobody (one audit row more, nothing else).
    notifications, jobs, audits = before
    assert await _counts(db) == (notifications, jobs, audits + 1)


# --- Criteria 8 and 4: who may collect ------------------------------------------------------------


@pytest.mark.parametrize(
    ("unit", "member"),
    [
        ("a_101", "a_resident2"),  # criterion 4: an occupant of another unit (102)
        ("a_101", "a_former"),  # lived in 101 until T1, now in 102
        ("a_101", "a_pending"),  # pending, no occupancy
        ("a_201", "a_suspended"),  # a current occupant of 201, suspended
        ("a_101", "b_resident1"),  # building B (tenant row 7)
    ],
)
async def test_pickup_member_who_may_not_collect_is_422(
    db: AsyncSession, as_user: Any, world: World, unit: str, member: str
) -> None:
    package = await _received(db, world, getattr(world, unit))
    client = await as_user(world.a_security.user)
    membership_id = str(getattr(world, member).membership.id)

    await _refused(
        db,
        client,
        world,
        package,
        "pickup",
        {"picked_up_by_membership_id": membership_id},
        422,
        "invalid_pickup_member",
    )


async def test_unknown_and_other_building_members_get_the_same_422(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await _received(db, world)
    client = await as_user(world.a_security.user)

    unknown = await _refused(
        db,
        client,
        world,
        package,
        "pickup",
        {"picked_up_by_membership_id": str(uuid.uuid4())},
        422,
        "invalid_pickup_member",
    )
    other = await _refused(
        db,
        client,
        world,
        package,
        "pickup",
        {"picked_up_by_membership_id": str(world.b_resident1.membership.id)},
        422,
        "invalid_pickup_member",
    )
    assert without_request_id(unknown) == without_request_id(other)


@pytest.mark.parametrize(
    ("unit", "member"),
    [("a_101", "a_resident1"), ("a_201", "a_council"), ("a_201", "multi_in_a")],
)
async def test_current_active_occupants_may_collect(
    db: AsyncSession, as_user: Any, world: World, unit: str, member: str
) -> None:
    package = await _received(db, world, getattr(world, unit))
    client = await as_user(world.a_security.user)
    found = getattr(world, member)
    membership: BuildingMembership = found if member == "multi_in_a" else found.membership

    response = await _post(
        client, world, package, "pickup", {"picked_up_by_membership_id": str(membership.id)}
    )

    assert response.status_code == 200, response.text
    assert (await _state(db, package))[2] == membership.id


async def test_the_named_recipient_may_collect_after_moving_within_the_building(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # a_former now lives in 102, but the 101 package names them.
    package = await _received(db, world, recipient_membership_id=world.a_former.membership.id)
    client = await as_user(world.a_security.user)

    response = await _post(
        client,
        world,
        package,
        "pickup",
        {"picked_up_by_membership_id": str(world.a_former.membership.id)},
    )

    assert response.status_code == 200, response.text


async def test_a_suspended_named_recipient_may_not_collect(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await _received(
        db, world, world.a_201, recipient_membership_id=world.a_suspended.membership.id
    )
    client = await as_user(world.a_security.user)

    await _refused(
        db,
        client,
        world,
        package,
        "pickup",
        {"picked_up_by_membership_id": str(world.a_suspended.membership.id)},
        422,
        "invalid_pickup_member",
    )


# --- Criteria 5 and 9: the bodies -----------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {},  # criterion 5
        {"picked_up_by_membership_id": None, "picked_up_by_name": None},
        "both",
        {"picked_up_by_name": ""},
        {"picked_up_by_name": "   "},
        {"picked_up_by_name": "Jo\nSmith"},
        {"picked_up_by_name": "Jo Smith\t"},
        {"picked_up_by_name": "J" * 121},
        {"picked_up_by_name": "Jo", "note": "extra"},
        {"picked_up_by_membership_id": "not-a-uuid"},
    ],
)
async def test_pickup_body_is_validated(
    db: AsyncSession, as_user: Any, world: World, body: Any
) -> None:
    package = await _received(db, world)
    client = await as_user(world.a_security.user)
    if body == "both":
        body = {
            "picked_up_by_membership_id": str(world.a_resident1.membership.id),
            "picked_up_by_name": "Jo Smith",
        }

    await _refused(db, client, world, package, "pickup", body, 422, "validation_error")


async def test_a_name_of_120_characters_is_accepted(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await _received(db, world)
    client = await as_user(world.a_security.user)

    response = await _post(client, world, package, "pickup", {"picked_up_by_name": "J" * 120})

    assert response.status_code == 200, response.text


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"reason": None},
        {"reason": ""},
        {"reason": " 　 "},
        {"reason": "Damaged\x00"},
        {"reason": "R" * 301},
        {"reason": "Damaged", "extra": 1},
    ],
)
async def test_return_reason_is_validated(
    db: AsyncSession, as_user: Any, world: World, body: Any
) -> None:
    package = await _received(db, world)
    client = await as_user(world.a_security.user)

    await _refused(db, client, world, package, "return", body, 422, "validation_error")


# --- Criteria 1, 10, 12: states and order ---------------------------------------------------------


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("current", [PackageStatus.PICKED_UP, PackageStatus.RETURNED])
async def test_a_package_that_is_not_received_is_409(
    db: AsyncSession, as_user: Any, world: World, action: str, current: PackageStatus
) -> None:
    package = await _received(db, world)
    await _set_status(db, package, current)
    client = await as_user(world.a_security.user)

    await _refused(db, client, world, package, action, None, 409, "invalid_transition")


@pytest.mark.parametrize(("first", "second"), [(a, b) for a in ACTIONS for b in ACTIONS])
async def test_a_second_transition_is_409_and_changes_nothing(
    db: AsyncSession, as_user: Any, world: World, first: str, second: str
) -> None:
    package = await _received(db, world)
    client = await as_user(world.a_security.user)
    assert (await _post(client, world, package, first)).status_code == 200

    await _refused(db, client, world, package, second, None, 409, "invalid_transition")


async def test_the_state_is_checked_before_the_pickup_member(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await _received(db, world)
    await _set_status(db, package, PackageStatus.PICKED_UP)
    client = await as_user(world.a_security.user)

    await _refused(
        db,
        client,
        world,
        package,
        "pickup",
        {"picked_up_by_membership_id": str(world.b_resident1.membership.id)},
        409,
        "invalid_transition",
    )


@pytest.mark.parametrize("action", ACTIONS)
async def test_another_buildings_package_and_none_are_the_same_404(
    db: AsyncSession, as_user: Any, world: World, action: str
) -> None:
    theirs = await make_package(db, world.b_101, world.b_manager.membership)
    client = await as_user(world.a_security.user)
    before = await _counts(db)

    other = await assert_cross_building_404(
        client,
        "POST",
        _url(world, theirs.id, action),
        json=_body(world, action) if action == "return" else {"picked_up_by_name": "Jo"},
        code="package_not_found",
    )
    missing = await assert_cross_building_404(
        client,
        "POST",
        _url(world, uuid.uuid7(), action),
        json=_body(world, action) if action == "return" else {"picked_up_by_name": "Jo"},
        code="package_not_found",
    )

    assert without_request_id(other) == without_request_id(missing)
    assert (await _state(db, theirs))[0] == PackageStatus.RECEIVED
    assert await _counts(db) == before


# --- Criteria 1, 6, 15: the tenant table ----------------------------------------------------------


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("persona", ["a_resident1", "a_council"])
async def test_residents_may_not_transition_a_package(
    db: AsyncSession, as_user: Any, world: World, action: str, persona: str
) -> None:
    package = await _received(db, world)
    client = await as_user(getattr(world, persona).user)
    before, before_state = await _counts(db), await _state(db, package)

    await assert_forbidden_role(
        client, "POST", _url(world, package.id, action), json=_body(world, action)
    )

    await _assert_unchanged(db, package, before_state, before)


@pytest.mark.parametrize("action", ACTIONS)
async def test_multi_may_not_transition_in_the_building_where_it_is_a_resident(
    db: AsyncSession, as_user: Any, world: World, action: str
) -> None:
    package = await _received(db, world)
    client = await as_user(world.multi)

    await assert_forbidden_role(
        client, "POST", _url(world, package.id, action), json=_body(world, action)
    )


@pytest.mark.parametrize("action", ACTIONS)
@pytest.mark.parametrize("persona", ["b_manager", "b_resident1", "a_pending", "a_suspended"])
async def test_non_members_get_404(
    db: AsyncSession, as_user: Any, world: World, action: str, persona: str
) -> None:
    package = await _received(db, world)
    client = await as_user(getattr(world, persona).user)
    before, before_state = await _counts(db), await _state(db, package)

    await assert_cross_building_404(
        client, "POST", _url(world, package.id, action), json=_body(world, action)
    )

    await _assert_unchanged(db, package, before_state, before)


@pytest.mark.parametrize("action", ACTIONS)
async def test_transitions_without_a_session_are_401(
    db: AsyncSession, client: AsyncClient, world: World, action: str
) -> None:
    package = await _received(db, world)

    assert_problem(await _post(client, world, package, action), 401, "not_authenticated")


@pytest.mark.parametrize("action", ACTIONS)
async def test_transitions_are_403_when_packages_are_disabled(
    db: AsyncSession, as_user: Any, world: World, action: str
) -> None:
    package = await _received(db, world)
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id, BuildingFeature.feature == Feature.PACKAGES
        )
        .values(enabled=False)
    )
    client = await as_user(world.a_security.user)

    await _refused(db, client, world, package, action, None, 403, "feature_disabled")


# --- Criterion 11: the pickup notification --------------------------------------------------------


async def _notified(db: AsyncSession, package: Package) -> list[tuple[uuid.UUID, str]]:
    rows = await db.execute(
        select(Notification.recipient_user_id, Notification.kind)
        .where(Notification.entity_id == package.id)
        .order_by(Notification.recipient_user_id)
    )
    return [tuple(row) for row in rows]  # type: ignore[misc]


async def _emails(db: AsyncSession) -> int:
    return await db.scalar(select(func.count()).where(Job.kind == "email.send")) or 0


async def test_pickup_notifies_the_named_recipient_in_app_only(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Named for a_resident1; a_former (now 102) collects it by name, a_resident1 is told.
    package = await _received(db, world, recipient_membership_id=world.a_resident1.membership.id)
    client = await as_user(world.a_security.user)
    emails = await _emails(db)

    response = await _post(client, world, package, "pickup", {"picked_up_by_name": "Neighbour"})

    assert response.status_code == 200, response.text
    assert await _notified(db, package) == [(world.a_resident1.user.id, "package.picked_up")]
    [notification] = await db.scalars(
        select(Notification).where(Notification.entity_id == package.id)
    )
    assert notification.link == f"/packages/{package.id}"
    assert notification.entity_type == "package"
    assert await _emails(db) == emails


async def test_pickup_of_a_unit_package_notifies_its_current_active_occupants(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # 201: a_council and multi (active), a_suspended (suspended, not told).
    package = await _received(db, world, world.a_201)
    client = await as_user(world.a_security.user)

    response = await _post(client, world, package, "pickup", {"picked_up_by_name": "Courier"})

    assert response.status_code == 200, response.text
    assert await _notified(db, package) == sorted(
        [(world.a_council.user.id, "package.picked_up"), (world.multi.id, "package.picked_up")]
    )


async def test_pickup_of_an_inactive_recipients_package_notifies_nobody(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await _received(
        db, world, world.a_201, recipient_membership_id=world.a_suspended.membership.id
    )
    client = await as_user(world.a_security.user)

    response = await _post(client, world, package, "pickup", {"picked_up_by_name": "Courier"})

    assert response.status_code == 200, response.text
    assert await _notified(db, package) == []


# --- Criterion 14: a create replay after the pickup ----------------------------------------------


async def test_a_create_replay_after_pickup_shows_picked_up(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)
    create = {"unit_id": str(world.a_101.id), "carrier": "UPS"}
    headers = {"Idempotency-Key": "replay-after-pickup"}
    created = await client.post(
        f"/api/buildings/{world.a.id}/packages", json=create, headers=headers
    )
    assert created.status_code == 201, created.text
    package_id = uuid.UUID(created.json()["id"])
    picked = await client.post(_url(world, package_id, "pickup"), json={"picked_up_by_name": "Jo"})
    assert picked.status_code == 200, picked.text

    replay = await client.post(
        f"/api/buildings/{world.a.id}/packages", json=create, headers=headers
    )

    assert replay.status_code == 201, replay.text
    assert replay.headers["Idempotent-Replayed"] == "true"
    assert replay.json()["id"] == str(package_id)
    assert replay.json()["status"] == "picked_up"
    assert replay.json()["picked_up_at"] == picked.json()["picked_up_at"]
