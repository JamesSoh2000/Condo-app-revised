"""The package routes (P5-02a): create, list, get, summary, and the tenant table
(ENGINEERING_PRACTICES §7). Idempotency is in `test_idempotency.py`, races in
`test_create_concurrency.py`, the occupants route in `tests/units/test_occupants.py`."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any
from zoneinfo import ZoneInfo

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.email.templates import render_email
from app.files.models import File
from app.jobs.models import Job
from app.memberships.models import BuildingMembership
from app.notifications.models import Notification
from app.packages import service
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.packages.schemas import PackageCreate
from app.units.models import Unit
from app.users.models import User
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.packages.conftest import make_package, make_photo
from tests.world import World

pytestmark = pytest.mark.anyio

ROW_MODELS = (Package, Notification, Job, AuditEvent)


def _base(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/packages"


def _key() -> str:
    return f"key-{uuid.uuid4()}"


async def _create(
    client: AsyncClient, world: World, body: dict[str, Any], *, key: str | None = None
) -> Response:
    return await client.post(_base(world), json=body, headers={"Idempotency-Key": key or _key()})


async def _counts(db: AsyncSession) -> tuple[int, ...]:
    return tuple(
        [await db.scalar(select(func.count()).select_from(model)) or 0 for model in ROW_MODELS]
    )


async def _notified(db: AsyncSession, package_id: uuid.UUID) -> list[uuid.UUID]:
    rows = await db.scalars(
        select(Notification.recipient_user_id)
        .where(Notification.entity_id == package_id)
        .order_by(Notification.recipient_user_id)
    )
    return list(rows)


async def _emails(db: AsyncSession, package_id: uuid.UUID) -> list[Job]:
    rows = await db.scalars(
        select(Job)
        .where(Job.kind == "email.send", Job.dedupe_key.like(f"package.arrived:{package_id}:%"))
        .order_by(Job.dedupe_key)
    )
    return list(rows)


_TIMES = ("received_at", "picked_up_at", "returned_at")


def _out(package: Package, unit: Unit, recipient_name: str | None = None) -> dict[str, Any]:
    """What the API returns to the desk for `package`, with its times as datetimes (compare with
    `_parsed`). `unit` is the package's unit, `recipient_name` its recipient's (P5-03a)."""
    return {
        "id": str(package.id),
        "unit_id": str(package.unit_id),
        "recipient_membership_id": (
            None
            if package.recipient_membership_id is None
            else str(package.recipient_membership_id)
        ),
        "carrier": package.carrier,
        "description": package.description,
        "tracking_last4": package.tracking_last4,
        "photo_file_id": None if package.photo_file_id is None else str(package.photo_file_id),
        "status": package.status.value,
        "received_at": package.received_at,
        "received_by_membership_id": str(package.received_by_membership_id),
        "picked_up_at": package.picked_up_at,
        "returned_at": package.returned_at,
        "unit_tower": unit.tower,
        "unit_label": unit.label,
        "recipient_name": recipient_name,
    }


def _parsed(body: dict[str, Any]) -> dict[str, Any]:
    """A package body with its times parsed, so the comparison doesn't depend on their spelling."""
    return body | {
        key: None if body[key] is None else datetime.fromisoformat(body[key]) for key in _TIMES
    }


async def _package(db: AsyncSession, package_id: str) -> Package:
    package = await db.scalar(
        select(Package)
        .where(Package.id == uuid.UUID(package_id))
        .execution_options(populate_existing=True)
    )
    assert package is not None
    return package


# --- Create: the happy paths (row 1), criteria 7 and 8 --------------------------------------------


@pytest.mark.parametrize("persona", ["a_security", "a_manager"])
async def test_staff_log_a_package_and_get_it_back(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    member = getattr(world, persona)
    client = await as_user(member.user)
    photo = await make_photo(db, world.a.id, world.a_security.user.id)

    response = await _create(
        client,
        world,
        {
            "unit_id": str(world.a_101.id),
            "recipient_membership_id": str(world.a_resident1.membership.id),
            "carrier": "  UPS ",
            "description": "Large box",
            "tracking_last4": "1Z9X",
            "photo_file_id": str(photo.id),
        },
    )

    assert response.status_code == 201, response.text
    assert "idempotent-replayed" not in response.headers
    body = response.json()
    package = await _package(db, body["id"])
    assert package.carrier == "UPS"
    assert package.status is PackageStatus.RECEIVED
    assert package.received_by_membership_id == member.membership.id
    assert package.recipient_membership_id == world.a_resident1.membership.id
    assert package.photo_file_id == photo.id
    assert package.request_hash == service.request_hash(
        PackageCreate.model_validate(
            {
                "unit_id": world.a_101.id,
                "recipient_membership_id": world.a_resident1.membership.id,
                "carrier": "UPS",
                "description": "Large box",
                "tracking_last4": "1Z9X",
                "photo_file_id": photo.id,
            }
        )
    )
    assert _parsed(body) == _out(package, world.a_101, "a resident1")
    # The P5-01 carry: the photo is claimed for this package, so the photo hook grants it.
    file = await db.scalar(
        select(File).where(File.id == photo.id).execution_options(populate_existing=True)
    )
    assert file is not None
    assert (file.attached_type, file.attached_id) == ("package", package.id)

    got = await client.get(f"{_base(world)}/{package.id}")
    assert got.status_code == 200, got.text
    assert got.json() == body


async def test_a_named_recipient_gets_the_only_notification_and_email(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)
    # 201 has three current occupants; the package names one of them.
    response = await _create(
        client,
        world,
        {
            "unit_id": str(world.a_201.id),
            "recipient_membership_id": str(world.a_council.membership.id),
            "carrier": "FedEx",
        },
    )

    assert response.status_code == 201, response.text
    package_id = uuid.UUID(response.json()["id"])
    assert await _notified(db, package_id) == [world.a_council.user.id]
    assert [job.payload["to"] for job in await _emails(db, package_id)] == [
        world.a_council.user.email
    ]


async def test_without_a_recipient_only_active_current_occupants_are_notified(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Criterion 4a and the P1-03 carry: a_suspended lives in 201 but is suspended.
    client = await as_user(world.a_security.user)

    response = await _create(client, world, {"unit_id": str(world.a_201.id), "carrier": "DHL"})

    assert response.status_code == 201, response.text
    package_id = uuid.UUID(response.json()["id"])
    expected = sorted([world.a_council.user.id, world.multi.id])
    assert await _notified(db, package_id) == expected
    emailed = {job.payload["to"] for job in await _emails(db, package_id)}
    assert emailed == {world.a_council.user.email, world.multi.email}
    assert world.a_suspended.user.id not in await _notified(db, package_id)


async def test_a_unit_package_notifies_current_occupants_not_former_ones(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Criterion 4: a_former lived in 101 until T1.
    client = await as_user(world.a_security.user)

    response = await _create(client, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"})

    assert response.status_code == 201, response.text
    package_id = uuid.UUID(response.json()["id"])
    assert await _notified(db, package_id) == [world.a_resident1.user.id]
    assert [job.payload["to"] for job in await _emails(db, package_id)] == [
        world.a_resident1.user.email
    ]


async def test_a_unit_with_no_current_occupant_gets_a_package_and_no_notification(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    empty = Unit(building_id=world.a.id, label="909")
    db.add(empty)
    await db.flush()
    client = await as_user(world.a_security.user)

    response = await _create(client, world, {"unit_id": str(empty.id), "carrier": "UPS"})

    assert response.status_code == 201, response.text
    package_id = uuid.UUID(response.json()["id"])
    assert await _notified(db, package_id) == []
    assert await _emails(db, package_id) == []


async def test_the_notification_links_the_package_and_emails_with_package_arrived(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Criterion 7.
    client = await as_user(world.a_security.user)

    response = await _create(
        client, world, {"unit_id": str(world.a_101.id), "carrier": "Purolator"}
    )

    assert response.status_code == 201, response.text
    package = await _package(db, response.json()["id"])
    notification = await db.scalar(select(Notification).where(Notification.entity_id == package.id))
    assert notification is not None
    assert notification.kind == "package.arrived"
    assert notification.link == f"/packages/{package.id}"
    assert notification.entity_type == "package"
    assert "Purolator" in notification.body
    [job] = await _emails(db, package.id)
    assert job.payload["template"] == "package_arrived"
    context = job.payload["context"]
    local = package.received_at.astimezone(ZoneInfo("America/Toronto"))
    assert context["carrier"] == "Purolator"
    assert context["received_at"] == local.strftime("%Y-%m-%d %H:%M %Z")
    assert context["building_name"] == "Maple Court"
    assert context["link"] == f"/packages/{package.id}"

    email = render_email("package_arrived", context, "en")
    for part in (email.text, email.html):
        assert "Purolator" in part
        assert local.strftime("%Y-%m-%d %H:%M %Z") in part
        assert "Pickup desk hours" in part
        assert f"/packages/{package.id}" in part
    assert email.subject == "A package is waiting at the desk"


async def test_the_received_time_is_shown_in_the_buildings_timezone(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await db.execute(
        update(Building).where(Building.id == world.a.id).values(timezone="Asia/Tokyo")
    )
    client = await as_user(world.a_security.user)

    response = await _create(client, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"})

    package = await _package(db, response.json()["id"])
    [job] = await _emails(db, package.id)
    tokyo = package.received_at.astimezone(ZoneInfo("Asia/Tokyo"))
    assert job.payload["context"]["received_at"] == tokyo.strftime("%Y-%m-%d %H:%M %Z")


async def test_creating_a_package_records_package_received(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Criterion 8: IDs only.
    client = await as_user(world.a_security.user)
    photo = await make_photo(db, world.a.id, world.a_security.user.id)

    response = await _create(
        client,
        world,
        {
            "unit_id": str(world.a_101.id),
            "recipient_membership_id": str(world.a_resident1.membership.id),
            "carrier": "UPS",
            "description": "Fragile glassware",
            "photo_file_id": str(photo.id),
        },
    )

    package_id = uuid.UUID(response.json()["id"])
    [event] = await db.scalars(select(AuditEvent).where(AuditEvent.action == "package.received"))
    assert event.entity_type == "package"
    assert event.entity_id == package_id
    assert event.building_id == world.a.id
    assert event.actor_user_id == world.a_security.user.id
    assert event.metadata_ == {
        "unit_id": str(world.a_101.id),
        "recipient_membership_id": str(world.a_resident1.membership.id),
        "photo_file_id": str(photo.id),
    }


async def test_a_failure_after_the_insert_leaves_nothing(
    db: AsyncSession, as_user: Any, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Criterion 3: the package is inserted, the photo claimed, then notify fails.
    client = await as_user(world.a_security.user)
    photo = await make_photo(db, world.a.id, world.a_security.user.id)
    before = await _counts(db)

    async def failing_notify(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(service, "notify", failing_notify)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await _create(
            client,
            world,
            {"unit_id": str(world.a_101.id), "carrier": "UPS", "photo_file_id": str(photo.id)},
        )

    assert await _counts(db) == before
    file = await db.scalar(
        select(File).where(File.id == photo.id).execution_options(populate_existing=True)
    )
    assert file is not None
    assert file.attached_id is None


async def test_a_failure_in_the_audit_after_notify_leaves_nothing(
    db: AsyncSession, as_user: Any, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Criterion 3, the last write: the notifications and email jobs are already added.
    client = await as_user(world.a_security.user)
    before = await _counts(db)

    async def failing_audit(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(service, "record_audit", failing_audit)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await _create(client, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"})

    assert await _counts(db) == before


# --- Create: the tenant table (rows 2-4, 6, 7) and criterion 1b -----------------------------------


async def test_create_without_a_session_is_401(client: AsyncClient, world: World) -> None:
    response = await _create(client, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"})

    assert_problem(response, 401, "not_authenticated")


@pytest.mark.parametrize("persona", ["a_resident1", "a_council"])
async def test_residents_may_not_create_a_package(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    before = await _counts(db)

    await assert_forbidden_role(
        client, "POST", _base(world), json={"unit_id": str(world.a_101.id), "carrier": "UPS"}
    )

    assert await _counts(db) == before


async def test_multi_may_not_create_in_the_building_where_it_is_a_resident(
    as_user: Any, world: World
) -> None:
    # multi is security in B, resident in A: the role comes from A's membership.
    client = await as_user(world.multi)

    await assert_forbidden_role(
        client, "POST", _base(world), json={"unit_id": str(world.a_101.id), "carrier": "UPS"}
    )


@pytest.mark.parametrize("persona", ["b_manager", "b_resident1", "a_pending", "a_suspended"])
async def test_non_members_get_404_on_create(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    before = await _counts(db)

    await assert_cross_building_404(
        client, "POST", _base(world), json={"unit_id": str(world.a_101.id), "carrier": "UPS"}
    )

    assert await _counts(db) == before


async def _refused(
    db: AsyncSession,
    client: AsyncClient,
    world: World,
    body: dict[str, Any],
    status: int,
    code: str,
) -> dict[str, Any]:
    before = await _counts(db)
    response = await _create(client, world, body)
    problem = assert_problem(response, status, code)
    assert await _counts(db) == before
    return problem


async def test_a_unit_of_another_building_looks_like_an_unknown_unit(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)

    other = await _refused(
        db, client, world, {"unit_id": str(world.b_101.id), "carrier": "UPS"}, 404, "unit_not_found"
    )
    unknown = await _refused(
        db, client, world, {"unit_id": str(uuid.uuid4()), "carrier": "UPS"}, 404, "unit_not_found"
    )

    assert without_request_id(other) == without_request_id(unknown)


async def test_an_inactive_unit_is_refused(db: AsyncSession, as_user: Any, world: World) -> None:
    inactive = Unit(building_id=world.a.id, label="808", is_active=False)
    db.add(inactive)
    await db.flush()
    client = await as_user(world.a_security.user)

    await _refused(
        db, client, world, {"unit_id": str(inactive.id), "carrier": "UPS"}, 409, "unit_inactive"
    )


@pytest.mark.parametrize(
    ("unit", "recipient"),
    [
        ("a_101", "unknown"),
        ("a_101", "b_resident1"),  # another building's membership
        ("a_101", "a_resident2"),  # lives in 102
        ("a_101", "a_former"),  # lived in 101 until T1
        ("a_101", "a_pending"),  # no occupancy
        ("a_201", "a_suspended"),  # lives in 201, suspended
    ],
)
async def test_a_recipient_who_is_not_an_active_current_occupant_is_refused(
    db: AsyncSession, as_user: Any, world: World, unit: str, recipient: str
) -> None:
    client = await as_user(world.a_security.user)
    recipient_id = (
        uuid.uuid4() if recipient == "unknown" else getattr(world, recipient).membership.id
    )

    problem = await _refused(
        db,
        client,
        world,
        {
            "unit_id": str(getattr(world, unit).id),
            "recipient_membership_id": str(recipient_id),
            "carrier": "UPS",
        },
        422,
        "invalid_recipient",
    )

    assert problem["detail"] == "The recipient must currently live in this unit."


async def test_a_photo_of_another_building_looks_like_an_unknown_photo(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)
    b_photo = await make_photo(db, world.b.id, world.b_manager.user.id)
    unit = str(world.a_101.id)

    other = await _refused(
        db,
        client,
        world,
        {"unit_id": unit, "carrier": "UPS", "photo_file_id": str(b_photo.id)},
        404,
        "file_not_found",
    )
    unknown = await _refused(
        db,
        client,
        world,
        {"unit_id": unit, "carrier": "UPS", "photo_file_id": str(uuid.uuid4())},
        404,
        "file_not_found",
    )

    assert without_request_id(other) == without_request_id(unknown)
    refreshed = await db.scalar(
        select(File).where(File.id == b_photo.id).execution_options(populate_existing=True)
    )
    assert refreshed is not None
    assert refreshed.attached_id is None


async def test_a_photo_already_attached_to_another_package_is_refused(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)
    photo = await make_photo(db, world.a.id, world.a_security.user.id)
    first = await _create(
        client,
        world,
        {"unit_id": str(world.a_101.id), "carrier": "UPS", "photo_file_id": str(photo.id)},
    )
    assert first.status_code == 201, first.text

    await _refused(
        db,
        client,
        world,
        {"unit_id": str(world.a_102.id), "carrier": "UPS", "photo_file_id": str(photo.id)},
        422,
        "invalid_file",
    )


# --- Create: input Postgres would refuse (criterion 11) -------------------------------------------


@pytest.mark.parametrize(
    "change",
    [
        {"carrier": ""},
        {"carrier": "   "},
        {"carrier": "U" * 51},
        {"carrier": "UP\x00S"},
        {"carrier": "UPS\n"},
        {"carrier": "\tUPS"},
        {"description": "D" * 201},
        {"description": "a\x00b"},
        {"description": "line one\nline two"},
        {"tracking_last4": "123"},
        {"tracking_last4": "12345"},
        {"tracking_last4": "12-4"},
        {"tracking_last4": "١٢٣٤"},  # Arabic-Indic digits: not ASCII
        {"unit_id": "not-a-uuid"},
        {"surprise": "field"},
    ],
    ids=lambda change: repr(change)[:40],
)
async def test_invalid_input_is_a_422_and_writes_nothing(
    db: AsyncSession, as_user: Any, world: World, change: dict[str, Any]
) -> None:
    client = await as_user(world.a_security.user)
    before = await _counts(db)

    response = await _create(
        client, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"} | change
    )

    assert_problem(response, 422, "validation_error")
    assert await _counts(db) == before


async def test_a_lone_surrogate_in_the_body_is_refused(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)
    before = await _counts(db)
    # Written by hand: json.dumps would refuse to encode the lone surrogate.
    raw = (
        f'{{"unit_id": "{world.a_101.id}", "carrier": "UPS", "description": "a\\ud800b"}}'.encode()
    )

    response = await client.post(
        _base(world),
        content=raw,
        headers={"Idempotency-Key": _key(), "Content-Type": "application/json"},
    )

    assert response.status_code == 422, response.text
    assert await _counts(db) == before


async def test_a_blank_description_is_stored_as_none(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_security.user)

    response = await _create(
        client, world, {"unit_id": str(world.a_101.id), "carrier": "UPS", "description": "  "}
    )

    assert response.status_code == 201, response.text
    assert response.json()["description"] is None


# --- Feature disabled (criterion 5) ---------------------------------------------------------------


async def test_every_package_route_is_403_when_the_feature_is_off(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await make_package(db, world.a_101, world.a_security.membership)
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id, BuildingFeature.feature == Feature.PACKAGES
        )
        .values(enabled=False)
    )
    staff = await as_user(world.a_security.user)
    resident = await as_user(world.a_resident1.user)
    before = await _counts(db)

    for client in (staff, resident):
        for method, url in [
            ("GET", _base(world)),
            ("GET", f"{_base(world)}/summary"),
            ("GET", f"{_base(world)}/{package.id}"),
            ("GET", f"/api/buildings/{world.a.id}/units/{world.a_101.id}/occupants"),
        ]:
            assert_problem(await client.request(method, url), 403, "feature_disabled")
    created = await _create(staff, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"})
    assert_problem(created, 403, "feature_disabled")
    assert await _counts(db) == before


# --- Get (rows 1-3, 5, 6) -------------------------------------------------------------------------


@pytest.mark.parametrize("persona", ["a_security", "a_manager", "a_resident1"])
async def test_who_may_see_a_unit_package_gets_it(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    package = await make_package(db, world.a_101, world.a_security.membership)
    client = await as_user(getattr(world, persona).user)

    response = await client.get(f"{_base(world)}/{package.id}")

    assert response.status_code == 200, response.text
    assert _parsed(response.json()) == _out(package, world.a_101)


async def test_a_named_recipient_sees_their_package_at_another_unit(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await make_package(
        db,
        world.a_102,
        world.a_security.membership,
        recipient_membership_id=world.a_resident1.membership.id,
    )
    client = await as_user(world.a_resident1.user)

    response = await client.get(f"{_base(world)}/{package.id}")

    assert response.status_code == 200, response.text


@pytest.mark.parametrize("persona", ["a_resident2", "a_former", "a_council"])
async def test_others_get_404_on_a_residents_package(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    # a_former left 101 at T1; this package is received now. Council alone sees no packages.
    package = await make_package(db, world.a_101, world.a_security.membership)
    client = await as_user(getattr(world, persona).user)

    hidden = await assert_not_visible(
        client, "GET", f"{_base(world)}/{package.id}", code="package_not_found"
    )
    missing = await assert_not_visible(
        client, "GET", f"{_base(world)}/{uuid.uuid4()}", code="package_not_found"
    )

    assert without_request_id(hidden) == without_request_id(missing)


async def test_a_former_occupant_still_sees_a_package_from_their_time(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await make_package(
        db, world.a_101, world.a_security.membership, received_at=World.T0 + timedelta(days=1)
    )
    former = await as_user(world.a_former.user)
    current = await as_user(world.a_resident1.user)

    assert (await former.get(f"{_base(world)}/{package.id}")).status_code == 200
    await assert_not_visible(
        current, "GET", f"{_base(world)}/{package.id}", code="package_not_found"
    )


async def test_another_buildings_package_is_404_through_this_building(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    package = await make_package(db, world.b_101, world.b_manager.membership)
    client = await as_user(world.a_security.user)

    await assert_cross_building_404(
        client, "GET", f"{_base(world)}/{package.id}", code="package_not_found"
    )


@pytest.mark.parametrize("persona", ["b_manager", "b_resident1", "a_pending", "a_suspended"])
async def test_non_members_get_404_on_every_read(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    package = await make_package(db, world.a_101, world.a_security.membership)
    client = await as_user(getattr(world, persona).user)

    for url in (_base(world), f"{_base(world)}/summary", f"{_base(world)}/{package.id}"):
        await assert_cross_building_404(client, "GET", url)


async def test_reads_without_a_session_are_401(
    db: AsyncSession, client: AsyncClient, world: World
) -> None:
    package = await make_package(db, world.a_101, world.a_security.membership)

    for url in (_base(world), f"{_base(world)}/summary", f"{_base(world)}/{package.id}"):
        assert_problem(await client.get(url), 401, "not_authenticated")


# --- List (criterion 9) ---------------------------------------------------------------------------


async def _picked_up(db: AsyncSession, unit: Unit, world: World) -> Package:
    return await make_package(
        db,
        unit,
        world.a_security.membership,
        status=PackageStatus.PICKED_UP,
        picked_up_at=datetime.now(UTC) + timedelta(seconds=1),
        picked_up_by_name="Neighbour",
        handed_out_by_membership_id=world.a_security.membership.id,
    )


def _ids(response: Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


async def test_staff_list_the_buildings_packages_newest_first(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    first = await make_package(db, world.a_101, world.a_security.membership)
    second = await make_package(db, world.a_102, world.a_security.membership)
    third = await _picked_up(db, world.a_201, world)
    await make_package(db, world.b_101, world.b_manager.membership)
    client = await as_user(world.a_manager.user)

    response = await client.get(_base(world))

    assert _ids(response) == [str(third.id), str(second.id), str(first.id)]
    assert _parsed(response.json()["items"][0]) == _out(third, world.a_201)
    assert response.json()["next_cursor"] is None


async def test_the_list_filters_by_status_and_unit(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    waiting_101 = await make_package(db, world.a_101, world.a_security.membership)
    waiting_102 = await make_package(db, world.a_102, world.a_security.membership)
    collected_101 = await _picked_up(db, world.a_101, world)
    client = await as_user(world.a_security.user)

    assert _ids(await client.get(_base(world), params={"status": "received"})) == [
        str(waiting_102.id),
        str(waiting_101.id),
    ]
    assert _ids(await client.get(_base(world), params={"status": "picked_up"})) == [
        str(collected_101.id)
    ]
    assert _ids(await client.get(_base(world), params={"unit_id": str(world.a_101.id)})) == [
        str(collected_101.id),
        str(waiting_101.id),
    ]
    assert _ids(
        await client.get(
            _base(world), params={"status": "received", "unit_id": str(world.a_101.id)}
        )
    ) == [str(waiting_101.id)]


async def _returned(db: AsyncSession, unit: Unit, received_by: BuildingMembership) -> Package:
    return await make_package(
        db,
        unit,
        received_by,
        status=PackageStatus.RETURNED,
        returned_at=datetime.now(UTC) + timedelta(seconds=1),
        return_reason="Damaged",
    )


async def test_the_list_filters_by_several_statuses(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    """P5-04 criterion 10: the resident page's History is `?status=picked_up&status=returned`."""
    await make_package(db, world.a_101, world.a_security.membership)
    collected_101 = await _picked_up(db, world.a_101, world)
    returned_101 = await _returned(db, world.a_101, world.a_security.membership)
    # Another unit's, not resident1's; and building B's.
    returned_102 = await _returned(db, world.a_102, world.a_security.membership)
    await _returned(db, world.b_101, world.b_manager.membership)
    history = [("status", "picked_up"), ("status", "returned")]
    staff = await as_user(world.a_security.user)
    resident = await as_user(world.a_resident1.user)

    assert _ids(await staff.get(_base(world), params=history)) == [
        str(returned_102.id),
        str(returned_101.id),
        str(collected_101.id),
    ]
    assert _ids(await resident.get(_base(world), params=history)) == [
        str(returned_101.id),
        str(collected_101.id),
    ]
    assert _ids(await resident.get(_base(world), params={"status": "returned"})) == [
        str(returned_101.id)
    ]
    assert_problem(
        await resident.get(_base(world), params=[("status", "returned"), ("status", "lost")]),
        422,
        "validation_error",
    )


async def test_a_unit_of_another_building_lists_nothing(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await make_package(db, world.b_101, world.b_manager.membership)
    client = await as_user(world.a_security.user)

    response = await client.get(_base(world), params={"unit_id": str(world.b_101.id)})

    assert response.json() == {"items": [], "next_cursor": None}


@pytest.mark.parametrize("params", [{"status": "lost"}, {"unit_id": "101"}])
async def test_an_invalid_filter_is_a_422(
    as_user: Any, world: World, params: dict[str, str]
) -> None:
    client = await as_user(world.a_security.user)

    assert_problem(await client.get(_base(world), params=params), 422, "validation_error")


async def test_the_list_pages_with_the_cursor(db: AsyncSession, as_user: Any, world: World) -> None:
    packages = [await make_package(db, world.a_101, world.a_security.membership) for _ in range(3)]
    client = await as_user(world.a_security.user)

    first = await client.get(_base(world), params={"limit": 2})
    second = await client.get(
        _base(world), params={"limit": 2, "cursor": first.json()["next_cursor"]}
    )

    assert _ids(first) == [str(packages[2].id), str(packages[1].id)]
    assert _ids(second) == [str(packages[0].id)]
    assert second.json()["next_cursor"] is None


async def test_a_resident_lists_only_the_packages_they_may_see(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    mine = await make_package(db, world.a_101, world.a_security.membership)
    named = await make_package(
        db,
        world.a_201,
        world.a_security.membership,
        recipient_membership_id=world.a_resident1.membership.id,
    )
    await make_package(db, world.a_102, world.a_security.membership)
    await make_package(
        db, world.a_101, world.a_security.membership, received_at=World.T0 + timedelta(days=1)
    )
    client = await as_user(world.a_resident1.user)

    assert _ids(await client.get(_base(world))) == [str(named.id), str(mine.id)]


async def test_council_alone_lists_no_packages(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # a_council is also a resident of 201, so a 201 package is theirs: use 101.
    await make_package(db, world.a_101, world.a_security.membership)
    client = await as_user(world.a_council.user)

    assert _ids(await client.get(_base(world))) == []


# --- Summary (criterion 6) ------------------------------------------------------------------------


async def test_the_summary_counts_the_residents_visible_waiting_packages(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await make_package(db, world.a_101, world.a_security.membership)
    await make_package(
        db,
        world.a_201,
        world.a_security.membership,
        recipient_membership_id=world.a_resident1.membership.id,
    )
    await _picked_up(db, world.a_101, world)  # visible, not waiting
    await make_package(db, world.a_102, world.a_security.membership)  # not visible
    await make_package(
        db, world.a_101, world.a_security.membership, received_at=World.T0 + timedelta(days=1)
    )  # a_former's time
    await make_package(db, world.b_101, world.b_manager.membership)  # building B
    resident = await as_user(world.a_resident1.user)
    staff = await as_user(world.a_security.user)

    assert (await resident.get(f"{_base(world)}/summary")).json() == {"waiting": 2}
    # Staff see every waiting package of A: 101, 201, 102 and a_former's.
    assert (await staff.get(f"{_base(world)}/summary")).json() == {"waiting": 4}


async def test_the_summary_is_zero_when_nothing_waits(as_user: Any, world: World) -> None:
    client = await as_user(world.a_resident2.user)

    response = await client.get(f"{_base(world)}/summary")

    assert response.status_code == 200, response.text
    assert response.json() == {"waiting": 0}


async def test_a_user_with_an_unsendable_address_still_gets_the_in_app_notification(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await db.execute(
        update(User).where(User.id == world.a_resident1.user.id).values(is_active=False)
    )
    client = await as_user(world.a_security.user)

    response = await _create(client, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"})

    package_id = uuid.UUID(response.json()["id"])
    assert await _notified(db, package_id) == [world.a_resident1.user.id]
    assert await _emails(db, package_id) == []
