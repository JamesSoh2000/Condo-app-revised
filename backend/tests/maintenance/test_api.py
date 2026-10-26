"""The maintenance routes (P6-03b): create, list and get, with the tenant table
(ENGINEERING_PRACTICES §7). Idempotency is in `test_idempotency.py`, notifications in
`test_notify.py`, atomicity in `test_atomicity.py`, races in `test_concurrency.py`."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import delete, func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.files.models import File, FileStatus
from app.jobs.models import Job
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import MaintenanceRequest, MaintenanceRequestPhoto
from app.notifications.models import Notification
from app.units.models import Unit
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.maintenance.conftest import make_maintenance_file, make_maintenance_request
from tests.packages.conftest import make_photo
from tests.world import World

pytestmark = pytest.mark.anyio

ROW_MODELS = (MaintenanceRequest, MaintenanceRequestPhoto, Notification, Job, AuditEvent)


def base(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/maintenance-requests"


def unit_body(unit: Unit, **overrides: Any) -> dict[str, Any]:
    return {
        "location": "unit",
        "unit_id": str(unit.id),
        "category": "plumbing",
        "description": "The kitchen tap drips.",
        **overrides,
    }


def common_body(**overrides: Any) -> dict[str, Any]:
    return {
        "location": "common_area",
        "common_area": "Lobby",
        "category": "electrical",
        "description": "A light is out.",
        **overrides,
    }


async def create(
    client: AsyncClient,
    world: World,
    body: dict[str, Any],
    *,
    key: str | None = None,
    building: Any = None,
) -> Response:
    headers = {"Idempotency-Key": key or f"key-{uuid.uuid4()}"}
    return await client.post(base(world, building), json=body, headers=headers)


async def counts(db: AsyncSession) -> tuple[int, ...]:
    return tuple(
        [await db.scalar(select(func.count()).select_from(model)) or 0 for model in ROW_MODELS]
    )


async def attached(db: AsyncSession, file_id: uuid.UUID) -> uuid.UUID | None:
    return await db.scalar(
        select(File.attached_id).where(File.id == file_id).execution_options(populate_existing=True)
    )


# --- create -------------------------------------------------------------------------------------


async def test_resident_files_a_request_for_their_unit(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    photos = [
        await make_maintenance_file(db, world.a.id, world.a_resident1.user.id) for _ in range(2)
    ]
    response = await create(
        client,
        world,
        unit_body(
            world.a_101,
            description="  Tap drips.\n\tUnder the sink too.  ",
            photo_file_ids=[str(photos[1].id), str(photos[0].id)],
        ),
    )

    assert response.status_code == 201, response.text
    body = response.json()
    row = await db.scalar(select(MaintenanceRequest).where(MaintenanceRequest.id == body["id"]))
    assert row is not None
    assert body == {
        "id": str(row.id),
        "requester_membership_id": str(world.a_resident1.membership.id),
        "location": "unit",
        "unit_id": str(world.a_101.id),
        "common_area": None,
        "category": "plumbing",
        "description": "Tap drips.\n\tUnder the sink too.",
        "status": "submitted",
        "submitted_at": row.submitted_at.isoformat().replace("+00:00", "Z"),
        "started_at": None,
        "on_hold_at": None,
        "resolved_at": None,
        "cancelled_at": None,
        "photo_file_ids": [str(photos[1].id), str(photos[0].id)],
        "unit_tower": None,
        "unit_label": "101",
        "requester_name": None,
    }
    positions = (
        await db.execute(
            select(MaintenanceRequestPhoto.file_id, MaintenanceRequestPhoto.position)
            .where(MaintenanceRequestPhoto.request_id == row.id)
            .order_by(MaintenanceRequestPhoto.position)
        )
    ).all()
    assert positions == [(photos[1].id, 0), (photos[0].id, 1)]
    for photo in photos:
        assert await attached(db, photo.id) == row.id
    # The database clock: the transaction's now() (ADR-0016).
    assert row.submitted_at == await db.scalar(select(func.now()))


async def test_submitted_at_is_the_transactions_now(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # ADR-0016's one clock (review round 1, F1): the request runs in the test's transaction.
    started = await db.scalar(select(func.now()))
    client = await as_user(world.a_resident1.user)
    response = await create(client, world, unit_body(world.a_101))
    assert response.status_code == 201, response.text
    row = await db.scalar(
        select(MaintenanceRequest.submitted_at).where(
            MaintenanceRequest.id == response.json()["id"]
        )
    )
    assert started is not None
    assert row == started


async def test_any_resident_files_a_common_area_request(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    response = await create(client, world, common_body(common_area="  Garage level 2 "))
    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["location"], body["unit_id"], body["common_area"]) == (
        "common_area",
        None,
        "Garage level 2",
    )
    assert (body["unit_label"], body["unit_tower"], body["photo_file_ids"]) == (None, None, [])


async def test_resident_without_a_current_unit_may_file_only_for_a_common_area(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # a_resident1 moves out: no current occupancy.
    from app.memberships.occupancy import end_occupancy

    await end_occupancy(db, building_id=world.a.id, membership_id=world.a_resident1.membership.id)
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    refused = await create(client, world, unit_body(world.a_101))
    assert_problem(refused, 422, "unit_not_occupied")
    assert await counts(db) == before
    assert (await create(client, world, common_body())).status_code == 201


@pytest.mark.parametrize(
    ("persona", "unit", "status"),
    [
        ("a_resident1", "a_101", 201),
        ("a_resident1", "a_102", 422),
        ("a_resident1", "a_201", 422),
        ("a_former", "a_101", 422),  # a past occupancy
        ("a_former", "a_102", 201),
        ("a_resident2", "a_102", 201),
        ("a_council", "a_201", 201),  # council + resident: files as a resident
    ],
)
async def test_resident_files_only_for_the_unit_they_live_in_now(
    as_user: Any, world: World, db: AsyncSession, persona: str, unit: str, status: int
) -> None:
    client = await as_user(getattr(world, persona).user)
    before = await counts(db)
    response = await create(client, world, unit_body(getattr(world, unit)))
    if status == 201:
        assert response.status_code == 201, response.text
        assert response.json()["requester_membership_id"] == str(
            getattr(world, persona).membership.id
        )
    else:
        assert_problem(response, 422, "unit_not_occupied")
        assert await counts(db) == before


async def test_multi_files_for_their_a_unit_from_a(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.multi)
    response = await create(client, world, unit_body(world.a_201))
    assert response.status_code == 201, response.text
    assert response.json()["requester_membership_id"] == str(world.multi_in_a.id)
    # In B, multi is security: no filing there.
    await assert_forbidden_role(client, "POST", base(world, world.b), json=common_body())


async def test_a_deactivated_unit_is_refused(as_user: Any, world: World, db: AsyncSession) -> None:
    await db.execute(update(Unit).where(Unit.id == world.a_101.id).values(is_active=False))
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    assert_problem(await create(client, world, unit_body(world.a_101)), 409, "unit_inactive")
    assert await counts(db) == before


async def test_another_buildings_unit_or_none_is_unit_not_found(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    other = assert_problem(
        await create(client, world, unit_body(world.b_101)), 404, "unit_not_found"
    )
    missing = assert_problem(
        await create(client, world, unit_body(world.b_101, unit_id=str(uuid.uuid4()))),
        404,
        "unit_not_found",
    )
    assert without_request_id(other) == without_request_id(missing)
    assert await counts(db) == before


async def test_another_buildings_photo_is_file_not_found_and_writes_nothing(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    b_file = await make_maintenance_file(db, world.b.id, world.a_resident1.user.id)
    a_file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    response = await create(
        client,
        world,
        unit_body(world.a_101, photo_file_ids=[str(a_file.id), str(b_file.id)]),
    )
    assert_problem(response, 404, "file_not_found")
    assert await counts(db) == before
    # The first photo's claim rolled back with the rest.
    assert await attached(db, a_file.id) is None


@pytest.mark.parametrize("case", ["package_photo", "pending", "other_uploader", "attached"])
async def test_a_photo_the_caller_may_not_attach_is_invalid_file(
    as_user: Any, world: World, db: AsyncSession, case: str
) -> None:
    owner = world.a_resident1.user.id
    if case == "package_photo":
        file = await make_photo(db, world.a.id, owner)
    else:
        uploader = world.a_resident2.user.id if case == "other_uploader" else owner
        file = await make_maintenance_file(db, world.a.id, uploader)
        if case == "pending":
            file.status = FileStatus.PENDING
            file.s3_version_id = None
        if case == "attached":
            earlier = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
            file.attached_type, file.attached_id = "maintenance_request", earlier.id
        await db.flush()
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    response = await create(client, world, unit_body(world.a_101, photo_file_ids=[str(file.id)]))
    assert_problem(response, 422, "invalid_file")
    assert await counts(db) == before


async def test_photo_limits_are_checked_by_the_schema(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    files = [
        await make_maintenance_file(db, world.a.id, world.a_resident1.user.id) for _ in range(6)
    ]
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    six = [str(file.id) for file in files]
    assert_problem(
        await create(client, world, unit_body(world.a_101, photo_file_ids=six)),
        422,
        "validation_error",
    )
    twice = [str(files[0].id), str(files[0].id)]
    assert_problem(
        await create(client, world, unit_body(world.a_101, photo_file_ids=twice)),
        422,
        "validation_error",
    )
    assert await counts(db) == before
    five = await create(client, world, unit_body(world.a_101, photo_file_ids=six[:5]))
    assert five.status_code == 201, five.text
    assert five.json()["photo_file_ids"] == six[:5]


async def test_photos_download_for_everyone_who_sees_the_request(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    resident = await as_user(world.a_resident1.user)
    created = await create(resident, world, unit_body(world.a_101, photo_file_ids=[str(file.id)]))
    assert created.status_code == 201, created.text
    url = f"/api/buildings/{world.a.id}/files/{file.id}/download-url"
    for persona in ("a_resident1", "a_manager", "a_security"):
        client = await as_user(getattr(world, persona).user)
        assert (await client.get(url)).status_code == 200, persona
    for persona in ("a_resident2", "a_former"):
        client = await as_user(getattr(world, persona).user)
        assert_problem(await client.get(url), 404, "file_not_found")


@pytest.mark.parametrize(
    "body",
    [
        {"location": "unit", "category": "plumbing", "description": "x"},
        {
            "location": "unit",
            "unit_id": "UNIT",
            "common_area": "Lobby",
            "category": "plumbing",
            "description": "x",
        },
        {"location": "common_area", "category": "plumbing", "description": "x"},
        {
            "location": "common_area",
            "common_area": "  ",
            "category": "plumbing",
            "description": "x",
        },
        {
            "location": "common_area",
            "unit_id": "UNIT",
            "common_area": "Lobby",
            "category": "plumbing",
            "description": "x",
        },
        {"location": "roof", "common_area": "Roof", "category": "plumbing", "description": "x"},
    ],
)
async def test_location_shape_is_checked_by_the_schema(
    as_user: Any, world: World, db: AsyncSession, body: dict[str, Any]
) -> None:
    body = {k: (str(world.a_101.id) if v == "UNIT" else v) for k, v in body.items()}
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    assert_problem(await create(client, world, body), 422, "validation_error")
    assert await counts(db) == before


@pytest.mark.parametrize(
    "overrides",
    [
        {"description": ""},
        {"description": " \n\t "},
        {"description": "a\x00b"},
        {"description": "a\x07b"},
        {"description": "a\x1bb"},
        {"description": "x" * 2001},
        {"category": "roofing"},
        {"category": None},
        {"unexpected": 1},
        {"common_area": "Lobby\n", "location": "common_area", "unit_id": None},
        {"common_area": "L" * 121, "location": "common_area", "unit_id": None},
        {"photo_file_ids": ["not-a-uuid"]},
    ],
)
async def test_bad_input_is_422(
    as_user: Any, world: World, db: AsyncSession, overrides: dict[str, Any]
) -> None:
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    assert_problem(
        await create(client, world, unit_body(world.a_101, **overrides)), 422, "validation_error"
    )
    assert await counts(db) == before


async def test_a_lone_surrogate_in_the_description_is_422(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    raw = (
        f'{{"location":"unit","unit_id":"{world.a_101.id}",'
        '"category":"plumbing","description":"a\\ud800b"}'
    )
    response = await client.post(
        base(world),
        content=raw,
        headers={"Idempotency-Key": "key-surrogate-1", "Content-Type": "application/json"},
    )
    assert_problem(response, 422, "validation_error")


async def test_description_keeps_its_longest_value(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    longest = "é" * 2000
    response = await create(client, world, unit_body(world.a_101, description=longest))
    assert response.status_code == 201, response.text
    assert response.json()["description"] == longest


async def test_create_audit_holds_ids_and_field_values_only(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    client = await as_user(world.a_resident1.user)
    lockbox = "Code 4321 for the lockbox"
    response = await create(
        client,
        world,
        unit_body(world.a_101, description=lockbox, photo_file_ids=[str(file.id)]),
    )
    assert response.status_code == 201, response.text
    event = await db.scalar(
        select(AuditEvent).where(AuditEvent.entity_id == uuid.UUID(response.json()["id"]))
    )
    assert event is not None
    assert (event.action, event.entity_type, event.actor_user_id, event.building_id) == (
        "maintenance.submitted",
        "maintenance_request",
        world.a_resident1.user.id,
        world.a.id,
    )
    assert event.metadata_ == {
        "unit_id": str(world.a_101.id),
        "category": "plumbing",
        "photo_file_ids": [str(file.id)],
    }
    assert lockbox not in str(event.metadata_)


# --- the tenant table on create -----------------------------------------------------------------


async def test_signed_out_is_401_on_every_route(client: AsyncClient, world: World) -> None:
    some = f"{base(world)}/{uuid.uuid4()}"
    for method, url in [("POST", base(world)), ("GET", base(world)), ("GET", some)]:
        assert_problem(await client.request(method, url, json={}), 401, "not_authenticated")


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_outsiders_get_building_not_found_on_every_route(
    as_user: Any, world: World, db: AsyncSession, persona: str
) -> None:
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    client = await as_user(getattr(world, persona).user)
    before = await counts(db)
    one = f"{base(world)}/{request.id}"
    for method, url in [("POST", base(world)), ("GET", base(world)), ("GET", one)]:
        await assert_cross_building_404(client, method, url, json=unit_body(world.a_101))
    assert await counts(db) == before


@pytest.mark.parametrize("persona", ["a_manager", "a_security"])
async def test_staff_may_not_file(
    as_user: Any, world: World, db: AsyncSession, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    before = await counts(db)
    await assert_forbidden_role(client, "POST", base(world), json=common_body())
    assert await counts(db) == before


async def test_feature_off_is_403_on_every_route_and_writes_nothing(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
        .values(enabled=False)
    )
    before = await counts(db)
    for persona in ("a_resident1", "a_manager"):
        client = await as_user(getattr(world, persona).user)
        one = f"{base(world)}/{request.id}"
        for method, url in [("GET", base(world)), ("GET", one)]:
            assert_problem(await client.request(method, url), 403, "feature_disabled")
        assert_problem(await create(client, world, unit_body(world.a_101)), 403, "feature_disabled")
    assert await counts(db) == before
    status = await db.scalar(
        select(MaintenanceRequest.status)
        .where(MaintenanceRequest.id == request.id)
        .execution_options(populate_existing=True)
    )
    assert status == MaintenanceStatus.SUBMITTED


# --- list and get -------------------------------------------------------------------------------


async def _ids(client: AsyncClient, url: str) -> list[str]:
    response = await client.get(url)
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


async def test_each_persona_lists_and_reads_what_visible_maintenance_grants(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    before_t1 = World.T0 + timedelta(days=1)
    # 101 in a_former's time; 101 now (a_resident1); 102 now (a_resident2's, in a_former's
    # co-occupancy); a common-area one of a_resident2's; one in B.
    old_101 = await make_maintenance_request(
        db, world.a_former.membership, world.a_101, submitted_at=before_t1
    )
    new_101 = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    now_102 = await make_maintenance_request(db, world.a_resident2.membership, world.a_102)
    common = await make_maintenance_request(db, world.a_resident2.membership, None)
    mine_201 = await make_maintenance_request(db, world.a_council.membership, world.a_201)
    await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    every = [mine_201, common, now_102, new_101, old_101]

    expected = {
        "a_manager": every,
        "a_security": every,
        "a_resident1": [new_101],
        "a_resident2": [common, now_102],
        "a_former": [now_102, old_101],
        "a_council": [mine_201],
    }
    for persona, requests in expected.items():
        client = await as_user(getattr(world, persona).user)
        assert await _ids(client, base(world)) == [str(r.id) for r in requests], persona
        for request in every:
            response = await client.get(f"{base(world)}/{request.id}")
            if request in requests:
                assert response.status_code == 200, (persona, response.text)
            else:
                assert_problem(response, 404, "maintenance_request_not_found")

    # multi_in_a lives in 201 as household from T0, so sees the council's 201 request.
    multi = await as_user(world.multi)
    assert await _ids(multi, base(world)) == [str(mine_201.id)]
    # b_manager sees B's only, never A's.
    b = await as_user(world.b_manager.user)
    assert len(await _ids(b, base(world, world.b))) == 1


async def test_council_alone_lists_an_empty_page(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    from app.memberships.enums import Role
    from app.memberships.models import MembershipRole

    await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    await db.execute(
        delete(MembershipRole).where(
            MembershipRole.membership_id == world.a_council.membership.id,
            MembershipRole.role == Role.RESIDENT,
        )
    )
    client = await as_user(world.a_council.user)
    assert await _ids(client, base(world)) == []


async def test_another_residents_request_is_the_same_404_as_none(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    client = await as_user(world.a_resident2.user)
    code = "maintenance_request_not_found"
    hidden = await assert_not_visible(client, "GET", f"{base(world)}/{request.id}", code=code)
    missing = await assert_not_visible(client, "GET", f"{base(world)}/{uuid.uuid4()}", code=code)
    assert without_request_id(hidden) == without_request_id(missing)
    manager = await as_user(world.a_manager.user)
    await assert_not_visible(manager, "GET", f"{base(world)}/{b_request.id}", code=code)


async def test_status_filter_takes_one_status(as_user: Any, world: World, db: AsyncSession) -> None:
    submitted = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    started = await make_maintenance_request(
        db,
        world.a_resident1.membership,
        world.a_101,
        status=MaintenanceStatus.IN_PROGRESS,
        acted_by=world.a_manager.membership,
    )
    client = await as_user(world.a_manager.user)
    assert await _ids(client, f"{base(world)}?status=submitted") == [str(submitted.id)]
    assert await _ids(client, f"{base(world)}?status=in_progress") == [str(started.id)]
    assert await _ids(client, f"{base(world)}?status=cancelled") == []
    assert_problem(await client.get(f"{base(world)}?status=open"), 422, "validation_error")


async def test_cursor_pages_without_skipping_or_repeating_on_equal_times(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    at = World.T2 + timedelta(days=3)
    made = [
        await make_maintenance_request(
            db, world.a_resident1.membership, world.a_101, submitted_at=at
        )
        for _ in range(5)
    ]
    client = await as_user(world.a_manager.user)
    seen: list[str] = []
    url = f"{base(world)}?limit=2"
    while True:
        response = await client.get(url)
        assert response.status_code == 200, response.text
        page = response.json()
        seen += [item["id"] for item in page["items"]]
        if page["next_cursor"] is None:
            break
        url = f"{base(world)}?limit=2&cursor={page['next_cursor']}"
    assert seen == [str(r.id) for r in sorted(made, key=lambda r: r.id, reverse=True)]


async def test_requester_name_is_shown_to_staff_only(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await make_maintenance_request(db, world.a_resident2.membership, world.a_102)
    url = f"{base(world)}/{request.id}"
    for persona, name in [
        ("a_manager", world.a_resident2.user.full_name),
        ("a_security", world.a_resident2.user.full_name),
        ("a_resident2", None),
        ("a_former", None),  # a co-occupant's request
    ]:
        client = await as_user(getattr(world, persona).user)
        response = await client.get(url)
        assert response.status_code == 200, response.text
        assert response.json()["requester_name"] == name, persona
        items = (await client.get(base(world))).json()["items"]
        [item] = [i for i in items if i["id"] == str(request.id)]
        assert item["requester_name"] == name, persona


async def test_list_reads_photos_in_order_with_a_bounded_number_of_statements(
    as_user: Any, world: World, db: AsyncSession, statements: list[str]
) -> None:
    from tests.maintenance.conftest import make_maintenance_photo

    for _ in range(4):
        request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
        for position in range(3):
            file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
            await make_maintenance_photo(db, request, file.id, position)
    client = await as_user(world.a_manager.user)
    statements.clear()
    response = await client.get(base(world))
    assert response.status_code == 200
    assert all(len(item["photo_file_ids"]) == 3 for item in response.json()["items"])
    selects = [s for s in statements if s.lstrip().upper().startswith("SELECT")]
    # Session and tenant context, the page, then units, names, photos, phone: never one per row.
    assert len(selects) <= 10, selects
