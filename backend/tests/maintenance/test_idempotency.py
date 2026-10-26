"""`POST /maintenance-requests` and its `Idempotency-Key` (P6-03b criterion 1 row 9). One request at
a time here; two at once are in `test_concurrency.py`."""

import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File
from app.units.models import Unit
from tests.helpers.tenancy import assert_problem
from tests.maintenance.conftest import make_maintenance_file
from tests.maintenance.test_api import base, common_body, counts, create, unit_body
from tests.world import World

pytestmark = pytest.mark.anyio


async def test_the_same_key_and_body_twice_gives_one_request_and_a_replay(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    photo = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    client = await as_user(world.a_resident1.user)
    body = unit_body(world.a_101, photo_file_ids=[str(photo.id)])

    first = await create(client, world, body, key="retry-key-0001")
    after_first = await counts(db)
    # Spelled differently, the same request: the canonical body hash matches.
    respelled = {**dict(reversed(list(body.items()))), "description": "  The kitchen tap drips. "}
    second = await create(client, world, respelled, key="retry-key-0001")

    assert first.status_code == 201, first.text
    assert "idempotent-replayed" not in first.headers
    assert second.status_code == 201, second.text
    assert second.headers["idempotent-replayed"] == "true"
    assert second.json() == first.json()
    assert await counts(db) == after_first


async def test_a_replay_answers_even_after_the_unit_was_deactivated(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    first = await create(client, world, unit_body(world.a_101), key="retry-key-0002")
    assert first.status_code == 201, first.text
    await db.execute(update(Unit).where(Unit.id == world.a_101.id).values(is_active=False))
    second = await create(client, world, unit_body(world.a_101), key="retry-key-0002")
    assert second.status_code == 201, second.text
    assert second.json()["id"] == first.json()["id"]


async def test_the_same_key_with_another_body_is_409(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    first = await create(client, world, unit_body(world.a_101), key="retry-key-0003")
    assert first.status_code == 201, first.text
    before = await counts(db)
    other = unit_body(world.a_101, category="electrical")
    assert_problem(
        await create(client, world, other, key="retry-key-0003"), 409, "idempotency_key_reused"
    )
    assert await counts(db) == before


async def test_another_residents_key_is_409_and_never_their_request(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # The key is unique per building, so the other resident's row holds it; it isn't visible to
    # this caller, and must not be a 500 or a replay of their request.
    first = await as_user(world.a_resident1.user)
    body = common_body()
    assert (await create(first, world, body, key="shared-key-0001")).status_code == 201
    second = await as_user(world.a_resident2.user)
    before = await counts(db)

    response = await create(second, world, body, key="shared-key-0001")

    problem = assert_problem(response, 409, "idempotency_key_reused")
    assert "Lobby" not in str(problem)
    assert await counts(db) == before


async def test_the_same_key_in_another_building_is_another_request(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    a = await as_user(world.a_resident1.user)
    b = await as_user(world.b_resident1.user)
    first = await create(a, world, common_body(), key="cross-key-0001")
    other = await create(b, world, common_body(), key="cross-key-0001", building=world.b)
    assert first.status_code == other.status_code == 201
    assert first.json()["id"] != other.json()["id"]


@pytest.mark.parametrize(
    ("key", "code"),
    [
        (None, "idempotency_key_required"),
        ("short", "invalid_idempotency_key"),
        ("has space-0001", "invalid_idempotency_key"),
        ("k" * 81, "invalid_idempotency_key"),
    ],
)
async def test_a_missing_or_malformed_key_is_400(
    as_user: Any, world: World, db: AsyncSession, key: str | None, code: str
) -> None:
    client: AsyncClient = await as_user(world.a_resident1.user)
    headers = {} if key is None else {"Idempotency-Key": key}
    before = await counts(db)
    response = await client.post(base(world), json=common_body(), headers=headers)
    assert_problem(response, 400, code)
    assert await counts(db) == before


async def test_a_replay_claims_no_photo_again(as_user: Any, world: World, db: AsyncSession) -> None:
    # The photo is attached to the first request now: a second claim would be a 422.
    photo = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    client = await as_user(world.a_resident1.user)
    body = unit_body(world.a_101, photo_file_ids=[str(photo.id)])
    first = await create(client, world, body, key="photo-key-0001")
    after_first = await counts(db)
    second = await create(client, world, body, key="photo-key-0001")
    assert second.status_code == 201, second.text
    assert second.json()["id"] == first.json()["id"]
    assert second.json()["photo_file_ids"] == [str(photo.id)]
    assert await counts(db) == after_first
    attached = await db.scalar(select(File.attached_id).where(File.id == photo.id))
    assert attached == uuid.UUID(first.json()["id"])
