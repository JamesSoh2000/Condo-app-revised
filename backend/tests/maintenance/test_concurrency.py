"""Maintenance races (P6-03b criterion 1 row 9, criterion 2's move-out).

On real connections, as `tests/packages/test_concurrency.py`: a scratch database of its own,
migrated here and dropped after the test, and one session per request.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.maintenance import service
from app.maintenance.enums import MaintenanceLocation
from app.maintenance.models import MaintenanceRequest
from app.maintenance.schemas import MaintenanceRequestCreate
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


async def _count(sessions: Sessions, model: Any, *where: Any) -> int:
    async with sessions() as db:
        return await db.scalar(select(func.count()).select_from(model).where(*where)) or 0


async def _waits(task: asyncio.Task[str]) -> None:
    await asyncio.sleep(1.0)
    assert not task.done(), "the second session did not wait for the first's lock"


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


# Review round 1 (Codex): F1 the turnover clock, F2 the replay between two key reads, F3 the
# photo order.


async def _pause_after_check(
    monkeypatch: pytest.MonkeyPatch,
) -> tuple[asyncio.Event, asyncio.Event]:
    """Hold every create between its occupancy check and its insert."""
    checked, release = asyncio.Event(), asyncio.Event()
    check_unit = service._check_unit

    async def paused(*args: Any, **kwargs: Any) -> str:
        result = await check_unit(*args, **kwargs)
        checked.set()
        await release.wait()
        return result

    monkeypatch.setattr(service, "_check_unit", paused)
    return checked, release


def test_an_incoming_household_does_not_inherit_the_outgoing_ones_request(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # R1 F1: a create holds the requester's membership; a transfer moving them out of 101 and one
    # moving a_resident2 in both start meanwhile and wait. Stamped on the create's transaction start
    # (ADR-0016's one clock), the request falls in the outgoing occupancy only.
    from app.maintenance.queries import visible_maintenance
    from app.memberships.enums import OccupancyRelationship
    from app.memberships.models import UnitOccupancy
    from app.memberships.schemas import MemberTransferIn
    from app.memberships.service import transfer_member

    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        checked, release = await _pause_after_check(monkeypatch)
        manager = persona_ctx(world, "a_manager")
        async with sessions() as creator, sessions() as old, sessions() as new:
            creating = asyncio.create_task(
                service.create_request(
                    creator, persona_ctx(world, "a_resident1"), _data(world), KEY
                )
            )
            await asyncio.wait_for(checked.wait(), 10)
            leaving = asyncio.create_task(
                transfer_member(
                    old,
                    manager,
                    world.a_resident1.membership.id,
                    MemberTransferIn(
                        unit_id=world.a_102.id, relationship=OccupancyRelationship.TENANT
                    ),
                )
            )
            await asyncio.sleep(0.5)
            assert not leaving.done(), "the move-out did not wait for the create's lock"
            arriving = asyncio.create_task(
                transfer_member(
                    new,
                    manager,
                    world.a_resident2.membership.id,
                    MemberTransferIn(
                        unit_id=world.a_101.id, relationship=OccupancyRelationship.TENANT
                    ),
                )
            )
            await asyncio.sleep(0.5)
            release.set()
            created = await asyncio.wait_for(creating, 10)
            await asyncio.wait_for(leaving, 10)
            await asyncio.wait_for(arriving, 10)

        async with sessions() as db:
            ended = await db.scalar(
                select(UnitOccupancy.ended_at).where(
                    UnitOccupancy.membership_id == world.a_resident1.membership.id,
                    UnitOccupancy.unit_id == world.a_101.id,
                )
            )
            assert ended is not None and created.request.submitted_at < ended
            seen = await db.scalar(
                visible_maintenance(persona_ctx(world, "a_resident2")).where(
                    MaintenanceRequest.id == created.request.id
                )
            )
            assert seen is None

    _run(scratch_database_url, body)


def test_a_move_out_starting_during_a_create_ends_after_the_request(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # R1 F1's neighbour, the plain move-out (deactivate's path): it reads its clock while the create
    # is between check and insert, waits, then ends the occupancy after the request's time.
    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        checked, release = await _pause_after_check(monkeypatch)
        async with sessions() as creator, sessions() as mover:
            creating = asyncio.create_task(
                service.create_request(
                    creator, persona_ctx(world, "a_resident1"), _data(world), KEY
                )
            )
            await asyncio.wait_for(checked.wait(), 10)

            async def move_out() -> None:
                await end_occupancy(
                    mover, building_id=world.a.id, membership_id=world.a_resident1.membership.id
                )
                await mover.commit()

            moving = asyncio.create_task(move_out())
            await _waits(moving)  # type: ignore[arg-type]
            release.set()
            created = await asyncio.wait_for(creating, 10)
            await asyncio.wait_for(moving, 10)

        async with sessions() as db:
            from app.memberships.models import UnitOccupancy

            ended = await db.scalar(
                select(UnitOccupancy.ended_at).where(
                    UnitOccupancy.membership_id == world.a_resident1.membership.id,
                    UnitOccupancy.unit_id == world.a_101.id,
                )
            )
        assert ended is not None and created.request.submitted_at < ended

    _run(scratch_database_url, body)


def test_a_move_in_committed_after_the_create_began_is_occupancy_changed(
    scratch_database_url: str,
) -> None:
    # R1 F1's other side: a_resident2 is moved into 101 after the create's transaction began. Its
    # `now()` would put the request before the occupancy, in 101's previous occupant's time; the
    # create answers 409 `occupancy_changed` (retry) instead, writing nothing.
    from app.memberships.enums import OccupancyRelationship
    from app.memberships.occupancy import transfer_occupancy
    from app.memberships.service import OccupancyChanged

    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        async with sessions() as creator:
            await creator.execute(select(func.now()))  # the transaction starts here
            await asyncio.sleep(0.05)
            async with sessions() as mover:
                await transfer_occupancy(
                    mover,
                    building_id=world.a.id,
                    membership_id=world.a_resident2.membership.id,
                    new_unit_id=world.a_101.id,
                    relationship=OccupancyRelationship.TENANT,
                )
                await mover.commit()
            with pytest.raises(OccupancyChanged):
                await service.create_request(
                    creator, persona_ctx(world, "a_resident2"), _data(world), KEY
                )
        assert await _count(sessions, MaintenanceRequest) == 1  # the fixture's

    _run(scratch_database_url, body)


def test_a_retry_whose_original_commits_between_the_two_key_reads_replays(
    scratch_database_url: str,
) -> None:
    # R1 F2: the first read (the caller's own) misses the uncommitted original; it commits; the
    # second read (anyone's) then finds the key. Same caller, key and body: a replay, not a 409.
    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        ctx, data = persona_ctx(world, "a_resident1"), _data(world)
        async with sessions() as first, sessions() as retry:
            at_commit, release = asyncio.Event(), asyncio.Event()
            commit = first.commit

            async def hold_commit() -> None:
                at_commit.set()
                await release.wait()
                await commit()

            first.commit = hold_commit  # type: ignore[method-assign]
            creating = asyncio.create_task(service.create_request(first, ctx, data, KEY))
            await asyncio.wait_for(at_commit.wait(), 10)
            scalar, reads = retry.scalar, 0

            async def commit_after_first_read(*args: Any, **kwargs: Any) -> Any:
                nonlocal reads
                result = await scalar(*args, **kwargs)
                reads += 1
                if reads == 1:
                    assert result is None  # the original isn't committed yet
                    release.set()
                    await asyncio.wait_for(creating, 10)
                return result

            retry.scalar = commit_after_first_read  # type: ignore[method-assign]
            result = await service.create_request(retry, ctx, data, KEY)
        assert result.replayed

    _run(scratch_database_url, body)


def test_two_creates_claiming_the_same_photos_in_opposite_orders_give_one_422(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # R1 F3: [A, B] and [B, A] at once, each paused after its first claim. Claimed in opposite
    # orders they deadlock (a 500); claimed in one order, one waits and gets 422 `invalid_file`.
    from app.files.service import InvalidFile
    from tests.maintenance.conftest import make_maintenance_file

    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        async with sessions() as db:
            photos = [
                await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
                for _ in range(2)
            ]
            await db.commit()
        from app.files.service import claim_file as claim

        seen = set()

        async def pause_after_first_claim(*args: Any, **kwargs: Any) -> Any:
            result = await claim(*args, **kwargs)
            task = asyncio.current_task()
            if task not in seen:
                seen.add(task)
                await asyncio.sleep(0.5)
            return result

        monkeypatch.setattr(service, "claim_file", pause_after_first_claim)

        async def create(ids: list[Any], key: str) -> str:
            async with sessions() as db:
                data = _data(world).model_copy(update={"photo_file_ids": ids})
                try:
                    await service.create_request(db, persona_ctx(world, "a_resident1"), data, key)
                except InvalidFile:
                    return "422"
                return "created"

        outcomes = await asyncio.wait_for(
            asyncio.gather(
                create([p.id for p in photos], "photo-order-0001"),
                create([p.id for p in reversed(photos)], "photo-order-0002"),
            ),
            15,
        )
        assert sorted(outcomes) == ["422", "created"]

    _run(scratch_database_url, body)


def test_photos_keep_the_order_sent_whatever_the_claim_order(scratch_database_url: str) -> None:
    # R1 F3's neighbour: claiming in id order must not reorder the photo rows.
    from tests.maintenance.conftest import make_maintenance_file

    async def body(sessions: Sessions, world: World, _request: MaintenanceRequest) -> None:
        async with sessions() as db:
            photos = [
                await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
                for _ in range(3)
            ]
            await db.commit()
        ids = sorted((p.id for p in photos), reverse=True)
        async with sessions() as db:
            data = _data(world).model_copy(update={"photo_file_ids": ids})
            created = await service.create_request(db, persona_ctx(world, "a_resident1"), data, KEY)
        assert created.request.photo_file_ids == ids

    _run(scratch_database_url, body)
