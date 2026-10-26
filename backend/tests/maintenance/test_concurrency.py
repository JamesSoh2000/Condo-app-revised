"""Maintenance races (P6-03b criterion 1 rows 9 and 10, criterion 2's move-out, criterion 6's
start).

On real connections, as `tests/packages/test_concurrency.py`: a scratch database of its own,
migrated here and dropped after the test, and one session per request.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.audit.models import AuditEvent
from app.maintenance import service
from app.maintenance.enums import MaintenanceLocation, MaintenanceStatus
from app.maintenance.models import MaintenanceRequest
from app.maintenance.schemas import MaintenanceRequestCreate
from app.maintenance.state import InvalidTransition
from app.memberships.occupancy import end_occupancy
from app.notifications.models import Notification
from app.packages.service import IdempotencyKeyReused
from tests.maintenance.conftest import make_maintenance_request
from tests.notifications.test_concurrency import migrate
from tests.packages.conftest import persona_ctx
from tests.world import World, build_world

type Sessions = async_sessionmaker[AsyncSession]

KEY = "race-key-0001"


def _run(url: str, body: Callable[[Sessions, World, MaintenanceRequest], Awaitable[None]]) -> None:
    migrate(url)

    async def check() -> None:
        engine = create_async_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                request = await make_maintenance_request(
                    db, world.a_resident1.membership, world.a_101
                )
                await db.commit()
            await body(sessions, world, request)
        finally:
            await engine.dispose()

    asyncio.run(check())


def _data(world: World, description: str = "The kitchen tap drips.") -> MaintenanceRequestCreate:
    return MaintenanceRequestCreate(
        location=MaintenanceLocation.UNIT,
        unit_id=world.a_101.id,
        category="plumbing",
        description=description,
    )


async def _create(sessions: Sessions, world: World, data: MaintenanceRequestCreate) -> str:
    async with sessions() as db:
        try:
            result = await service.create_request(db, persona_ctx(world, "a_resident1"), data, KEY)
        except IdempotencyKeyReused:
            return "reused"
        except service.UnitNotOccupied:
            return "422"
        return "replayed" if result.replayed else "created"


async def _cancel(sessions: Sessions, world: World, request: MaintenanceRequest) -> str:
    async with sessions() as db:
        try:
            await service.cancel_request(db, persona_ctx(world, "a_resident1"), request.id)
        except InvalidTransition:
            return "409"
        return "200"


async def _count(sessions: Sessions, model: Any, *where: Any) -> int:
    async with sessions() as db:
        return await db.scalar(select(func.count()).select_from(model).where(*where)) or 0


async def _waits(task: asyncio.Task[str]) -> None:
    await asyncio.sleep(1.0)
    assert not task.done(), "the second session did not wait for the first's lock"


def test_two_concurrent_cancels_have_one_winner(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World, request: MaintenanceRequest) -> None:
        outcomes = await asyncio.gather(
            _cancel(sessions, world, request), _cancel(sessions, world, request)
        )

        assert sorted(outcomes) == ["200", "409"]
        assert await _count(sessions, AuditEvent, AuditEvent.action == "maintenance.cancelled") == 1
        cancelled = MaintenanceRequest.status == MaintenanceStatus.CANCELLED
        assert await _count(sessions, MaintenanceRequest, cancelled) == 1

    _run(scratch_database_url, body)


def test_a_cancel_waiting_on_a_start_gets_409(scratch_database_url: str) -> None:
    # P6-03c's start, as a raw conditional UPDATE in a second session held open.
    async def body(sessions: Sessions, world: World, request: MaintenanceRequest) -> None:
        async with sessions() as manager:
            await manager.execute(
                update(MaintenanceRequest)
                .where(
                    MaintenanceRequest.id == request.id,
                    MaintenanceRequest.status == MaintenanceStatus.SUBMITTED,
                )
                .values(
                    status=MaintenanceStatus.IN_PROGRESS,
                    started_at=func.clock_timestamp(),
                    started_by_membership_id=world.a_manager.membership.id,
                )
            )
            task = asyncio.create_task(_cancel(sessions, world, request))
            await _waits(task)
            await manager.commit()
            assert await asyncio.wait_for(task, timeout=10) == "409"

        started = MaintenanceRequest.status == MaintenanceStatus.IN_PROGRESS
        assert await _count(sessions, MaintenanceRequest, started) == 1
        assert await _count(sessions, AuditEvent, AuditEvent.action == "maintenance.cancelled") == 0

    _run(scratch_database_url, body)


@pytest.mark.parametrize("move_out_commits", [True, False], ids=["commits", "rolls-back"])
def test_a_create_waits_for_a_move_out_in_flight(
    scratch_database_url: str, move_out_commits: bool
) -> None:
    # The move-out locks the membership (FOR NO KEY UPDATE) and ends the occupancy; the create's
    # FOR SHARE on the membership waits, then reads the occupancy the move-out left.
    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        async with sessions() as mover:
            await end_occupancy(
                mover, building_id=world.a.id, membership_id=world.a_resident1.membership.id
            )
            await mover.flush()
            task = asyncio.create_task(_create(sessions, world, _data(world)))
            await _waits(task)
            if move_out_commits:
                await mover.commit()
            else:
                await mover.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == ("422" if move_out_commits else "created")
        assert await _count(sessions, MaintenanceRequest) == (1 if move_out_commits else 2)

    _run(scratch_database_url, body)


def test_a_move_out_waits_for_a_create_in_flight(scratch_database_url: str) -> None:
    # The other order: the create holds the membership FOR SHARE until it commits, so the request
    # is stamped inside the occupancy it checked.
    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        ctx = persona_ctx(world, "a_resident1")
        async with sessions() as creator:
            original = creator.commit

            async def held_commit() -> None:
                # Stop just before the commit: the lock is still held.
                gate.set()
                await release.wait()
                await original()

            gate, release = asyncio.Event(), asyncio.Event()
            creator.commit = held_commit  # type: ignore[method-assign]
            creating = asyncio.create_task(service.create_request(creator, ctx, _data(world), KEY))
            await asyncio.wait_for(gate.wait(), timeout=10)

            async def move_out() -> None:
                async with sessions() as mover:
                    await end_occupancy(
                        mover,
                        building_id=world.a.id,
                        membership_id=world.a_resident1.membership.id,
                    )
                    await mover.commit()

            moving = asyncio.create_task(move_out())
            await asyncio.sleep(1.0)
            assert not moving.done(), "the move-out did not wait for the create's lock"
            release.set()
            created = await asyncio.wait_for(creating, timeout=10)
            await asyncio.wait_for(moving, timeout=10)

        async with sessions() as db:
            from app.memberships.models import UnitOccupancy

            ended = await db.scalar(
                select(UnitOccupancy.ended_at).where(
                    UnitOccupancy.membership_id == world.a_resident1.membership.id,
                    UnitOccupancy.unit_id == world.a_101.id,
                )
            )
        assert ended is not None
        assert created.request.submitted_at < ended

    _run(scratch_database_url, body)


def test_two_concurrent_creates_of_one_key_give_one_request(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        outcomes = await asyncio.gather(
            _create(sessions, world, _data(world)), _create(sessions, world, _data(world))
        )

        assert sorted(outcomes) == ["created", "replayed"]
        assert await _count(sessions, MaintenanceRequest) == 2  # the fixture's and one
        assert await _count(sessions, Notification) == 1  # a_manager, once

    _run(scratch_database_url, body)


def test_two_concurrent_creates_of_one_key_with_two_bodies_give_one_409(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        outcomes = await asyncio.gather(
            _create(sessions, world, _data(world)),
            _create(sessions, world, _data(world, description="Another fault.")),
        )

        assert sorted(outcomes) == ["created", "reused"]
        assert await _count(sessions, MaintenanceRequest) == 2

    _run(scratch_database_url, body)
