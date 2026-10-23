"""`POST /packages` and its `Idempotency-Key` (P5-02a criteria 2 and 2a; tenant row 9).

One request at a time here; two at once are in `test_create_concurrency.py`.
"""

import hashlib
import uuid
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.files.models import File
from app.jobs.models import Job
from app.notifications.models import Notification
from app.packages.models import Package
from app.packages.schemas import PackageCreate
from app.packages.service import request_hash
from app.units.models import Unit
from tests.helpers.tenancy import assert_problem
from tests.packages.conftest import make_photo
from tests.world import World

pytestmark = pytest.mark.anyio


def _base(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/packages"


async def _post(
    client: AsyncClient, world: World, body: Any, key: str | bytes | None, building: Any = None
) -> Response:
    headers: dict[str, Any] = {} if key is None else {"Idempotency-Key": key}
    return await client.post(_base(world, building), json=body, headers=headers)


async def _counts(db: AsyncSession) -> tuple[int, ...]:
    return tuple(
        [
            await db.scalar(select(func.count()).select_from(model)) or 0
            for model in (Package, Notification, Job, AuditEvent)
        ]
    )


@pytest.fixture
async def security(as_user: Any, world: World) -> AsyncClient:
    client: AsyncClient = await as_user(world.a_security.user)
    return client


async def test_the_same_key_and_body_twice_gives_one_package_and_a_replay(
    db: AsyncSession, security: AsyncClient, world: World
) -> None:
    # Criterion 2: one package, one notification set, one email-job set.
    photo = await make_photo(db, world.a.id, world.a_security.user.id)
    body = {"unit_id": str(world.a_201.id), "carrier": "UPS", "photo_file_id": str(photo.id)}

    first = await _post(security, world, body, "retry-key-0001")
    after_first = await _counts(db)
    second = await _post(security, world, body, "retry-key-0001")

    assert first.status_code == 201, first.text
    assert "idempotent-replayed" not in first.headers
    assert second.status_code == 201, second.text
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json() == first.json()
    assert await _counts(db) == after_first
    package_id = uuid.UUID(first.json()["id"])
    # Two active occupants of 201 (a_council, multi): two rows and two emails, once.
    assert await db.scalar(select(func.count()).where(Notification.entity_id == package_id)) == 2
    assert (
        await db.scalar(
            select(func.count()).where(Job.dedupe_key.like(f"package.arrived:{package_id}:%"))
        )
        == 2
    )


async def test_a_replay_answers_with_the_package_as_it_is_now(
    db: AsyncSession, security: AsyncClient, world: World
) -> None:
    body = {"unit_id": str(world.a_101.id), "carrier": "UPS"}
    first = await _post(security, world, body, "retry-key-0002")
    package_id = uuid.UUID(first.json()["id"])
    # The unit is deactivated since (a manager moved everyone out): the retry still replays.
    await db.execute(update(Unit).where(Unit.id == world.a_101.id).values(is_active=False))

    second = await _post(security, world, body, "retry-key-0002")

    assert second.status_code == 201, second.text
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json()["id"] == str(package_id)


async def test_the_hash_ignores_key_order_spacing_and_explicit_nulls(
    db: AsyncSession, security: AsyncClient, world: World
) -> None:
    first = await _post(
        security, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"}, "retry-key-0003"
    )
    before = await _counts(db)

    second = await security.post(
        _base(world),
        content=(
            f'{{ "description" : null, "carrier": "  UPS ",\n "unit_id": "{world.a_101.id}" }}'
        ).encode(),
        headers={"Idempotency-Key": "retry-key-0003", "Content-Type": "application/json"},
    )

    assert second.status_code == 201, second.text
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json()["id"] == first.json()["id"]
    assert await _counts(db) == before


def test_the_hash_is_sha256_of_the_sorted_validated_body() -> None:
    unit_id = uuid.uuid4()
    data = PackageCreate.model_validate({"unit_id": str(unit_id), "carrier": " UPS "})
    expected = (
        '{"carrier":"UPS","description":null,"photo_file_id":null,'
        f'"recipient_membership_id":null,"tracking_last4":null,"unit_id":"{unit_id}"}}'
    )
    assert request_hash(data) == hashlib.sha256(expected.encode()).hexdigest()
    assert len(request_hash(data)) == 64


@pytest.mark.parametrize(
    "change",
    [
        {"carrier": "FedEx"},
        {"description": "Another box"},
        {"tracking_last4": "1234"},
        {"recipient_membership_id": "resident1"},
        {"unit_id": "a_102"},
    ],
    ids=lambda change: next(iter(change)),
)
async def test_the_same_key_with_another_body_is_a_409(
    db: AsyncSession, security: AsyncClient, world: World, change: dict[str, str]
) -> None:
    body = {"unit_id": str(world.a_101.id), "carrier": "UPS"}
    first = await _post(security, world, body, "reused-key-01")
    assert first.status_code == 201, first.text
    before = await _counts(db)
    other = body | change
    if change.get("recipient_membership_id") == "resident1":
        other["recipient_membership_id"] = str(world.a_resident1.membership.id)
    if change.get("unit_id") == "a_102":
        other["unit_id"] = str(world.a_102.id)

    response = await _post(security, world, other, "reused-key-01")

    problem = assert_problem(response, 409, "idempotency_key_reused")
    assert "idempotent-replayed" not in response.headers
    assert problem["detail"] == "This Idempotency-Key was used with a different request."
    assert await _counts(db) == before


async def test_a_replay_with_a_photo_does_not_claim_it_again(
    db: AsyncSession, security: AsyncClient, world: World
) -> None:
    photo = await make_photo(db, world.a.id, world.a_security.user.id)
    body = {"unit_id": str(world.a_101.id), "carrier": "UPS", "photo_file_id": str(photo.id)}
    first = await _post(security, world, body, "photo-key-001")

    second = await _post(security, world, body, "photo-key-001")

    assert second.status_code == 201, second.text
    assert second.json()["photo_file_id"] == str(photo.id)
    file = await db.scalar(
        select(File).where(File.id == photo.id).execution_options(populate_existing=True)
    )
    assert file is not None
    assert file.attached_id == uuid.UUID(first.json()["id"])


async def test_another_staff_member_retrying_the_key_gets_the_replay(
    as_user: Any, security: AsyncClient, world: World
) -> None:
    # The key belongs to the building's desk, not to one person.
    body = {"unit_id": str(world.a_101.id), "carrier": "UPS"}
    first = await _post(security, world, body, "desk-key-0001")
    manager = await as_user(world.a_manager.user)

    second = await _post(manager, world, body, "desk-key-0001")

    assert second.status_code == 201, second.text
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json()["id"] == first.json()["id"]


async def test_the_same_key_in_another_building_is_another_package(
    db: AsyncSession, as_user: Any, security: AsyncClient, world: World
) -> None:
    first = await _post(
        security, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"}, "shared-key-01"
    )
    b_manager = await as_user(world.b_manager.user)

    other = await _post(
        b_manager,
        world,
        {"unit_id": str(world.b_101.id), "carrier": "UPS"},
        "shared-key-01",
        building=world.b,
    )

    assert other.status_code == 201, other.text
    assert "idempotent-replayed" not in other.headers
    assert other.json()["id"] != first.json()["id"]


async def test_a_refused_first_request_does_not_burn_the_key(
    db: AsyncSession, security: AsyncClient, world: World
) -> None:
    refused = await _post(
        security, world, {"unit_id": str(world.b_101.id), "carrier": "UPS"}, "burn-key-0001"
    )
    assert_problem(refused, 404, "unit_not_found")

    accepted = await _post(
        security, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"}, "burn-key-0001"
    )

    assert accepted.status_code == 201, accepted.text
    assert "idempotent-replayed" not in accepted.headers


async def test_a_missing_key_is_a_400(
    db: AsyncSession, security: AsyncClient, world: World
) -> None:
    before = await _counts(db)

    response = await _post(
        security, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"}, None
    )

    problem = assert_problem(response, 400, "idempotency_key_required")
    assert problem["detail"] == "Send an Idempotency-Key header (8-80 characters)."
    assert await _counts(db) == before


@pytest.mark.parametrize(
    "key",
    [
        "",
        "short12",  # 7
        "k" * 81,
        "has space1",
        "tab\there1",
        b"caf\xe9-key-1",  # Latin-1 é: not ASCII
    ],
    ids=["empty", "seven", "eighty-one", "space", "tab", "latin-1"],
)
async def test_a_malformed_key_is_a_400(
    db: AsyncSession, security: AsyncClient, world: World, key: str | bytes
) -> None:
    before = await _counts(db)

    response = await _post(security, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"}, key)

    assert_problem(response, 400, "invalid_idempotency_key")
    assert await _counts(db) == before


@pytest.mark.parametrize("key", ["k" * 8, "k" * 80, "!~#$%&'*+-.^_`|"])
async def test_keys_of_8_to_80_visible_ascii_characters_are_accepted(
    db: AsyncSession, security: AsyncClient, world: World, key: str
) -> None:
    response = await _post(security, world, {"unit_id": str(world.a_101.id), "carrier": "UPS"}, key)

    assert response.status_code == 201, response.text
    package = await db.scalar(select(Package).where(Package.id == uuid.UUID(response.json()["id"])))
    assert package is not None
    assert package.idempotency_key == key
