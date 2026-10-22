"""Two first requests with one `Idempotency-Key` at once (P5-02a criterion 2b, tenant row 10).

On real connections, as `tests/onboarding/test_concurrency.py`: a scratch database of its own,
migrated here and dropped after the test. Each race holds the competing insert open in one session
and checks that the create waits for it, then answers from what it committed or rolled back.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.notifications.models import Notification
from app.packages import service
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.packages.schemas import PackageCreate
from tests.notifications.test_concurrency import migrate
from tests.packages.conftest import persona_ctx
from tests.world import World, build_world

KEY = "race-key-0001"

type Sessions = async_sessionmaker[AsyncSession]


def _run(url: str, body: Callable[[Sessions, World], Awaitable[None]]) -> None:
    migrate(url)

    async def check() -> None:
        engine = create_async_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                await db.commit()
            await body(sessions, world)
        finally:
            await engine.dispose()

    asyncio.run(check())


def _data(world: World, carrier: str = "UPS") -> PackageCreate:
    return PackageCreate(unit_id=world.a_101.id, carrier=carrier)


async def _create(sessions: Sessions, world: World, data: PackageCreate) -> tuple[str, Any]:
    async with sessions() as db:
        try:
            result = await service.create_package(db, persona_ctx(world, "a_security"), data, KEY)
        except service.IdempotencyKeyReused:
            return "reused", None
        return ("replayed" if result.replayed else "created"), result.package.id


async def _count(sessions: Sessions, model: Any) -> int:
    async with sessions() as db:
        return await db.scalar(select(func.count()).select_from(model)) or 0


async def _hold_insert(db: AsyncSession, world: World, data: PackageCreate) -> Package:
    """Insert the package another request would, and leave its transaction open."""
    package = Package(
        building_id=world.a.id,
        unit_id=data.unit_id,
        carrier=data.carrier,
        status=PackageStatus.RECEIVED,
        received_by_membership_id=world.a_manager.membership.id,
        idempotency_key=KEY,
        request_hash=service.request_hash(data),
    )
    db.add(package)
    await db.flush()
    return package


@pytest.mark.parametrize("first_commits", [True, False], ids=["commits", "rolls-back"])
def test_a_create_waits_for_a_concurrent_insert_of_the_same_key(
    scratch_database_url: str, first_commits: bool
) -> None:
    # The second create's look-up sees nothing (the first hasn't committed); its INSERT then waits
    # on uq_packages_building_id_idempotency_key. After a commit it replays the first package, after
    # a rollback it creates its own: never an IntegrityError (500).
    async def body(sessions: Sessions, world: World) -> None:
        async with sessions() as first:
            held = await _hold_insert(first, world, _data(world))
            task = asyncio.create_task(_create(sessions, world, _data(world)))
            await asyncio.sleep(1.0)
            assert not task.done(), "the create did not wait for the open insert of its key"
            if first_commits:
                await first.commit()
            else:
                await first.rollback()
            outcome, package_id = await asyncio.wait_for(task, timeout=10)

        if first_commits:
            assert (outcome, package_id) == ("replayed", held.id)
            # The replay notifies nobody: the held insert wrote no notifications either.
            assert await _count(sessions, Notification) == 0
        else:
            assert outcome == "created"
            assert await _count(sessions, Notification) == 1
        assert await _count(sessions, Package) == 1

    _run(scratch_database_url, body)


def test_a_create_waiting_on_another_body_with_its_key_is_a_409(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        async with sessions() as first:
            await _hold_insert(first, world, _data(world, carrier="FedEx"))
            task = asyncio.create_task(_create(sessions, world, _data(world)))
            await asyncio.sleep(1.0)
            assert not task.done(), "the create did not wait for the open insert of its key"
            await first.commit()
            outcome, _ = await asyncio.wait_for(task, timeout=10)

        assert outcome == "reused"
        assert await _count(sessions, Package) == 1
        assert await _count(sessions, Notification) == 0

    _run(scratch_database_url, body)


def test_two_concurrent_creates_of_one_key_give_one_package(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        outcomes = await asyncio.gather(
            _create(sessions, world, _data(world)), _create(sessions, world, _data(world))
        )

        assert sorted(outcome for outcome, _ in outcomes) == ["created", "replayed"]
        assert outcomes[0][1] == outcomes[1][1]
        assert await _count(sessions, Package) == 1
        # a_resident1 is 101's one active occupant: one notification, not two.
        assert await _count(sessions, Notification) == 1

    _run(scratch_database_url, body)


def test_two_concurrent_creates_of_one_key_with_two_bodies_give_one_409(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        outcomes = await asyncio.gather(
            _create(sessions, world, _data(world)),
            _create(sessions, world, _data(world, carrier="FedEx")),
        )

        assert sorted(outcome for outcome, _ in outcomes) == ["created", "reused"]
        assert await _count(sessions, Package) == 1

    _run(scratch_database_url, body)
