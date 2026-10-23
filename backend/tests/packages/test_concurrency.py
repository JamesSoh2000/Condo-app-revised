"""Pickup and return races (P5-02b criteria 2, 3 and 13, tenant row 10).

On real connections, as `test_create_concurrency.py`: a scratch database of its own, migrated here
and dropped after the test, and one session per request.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.audit.models import AuditEvent
from app.memberships.enums import MembershipStatus
from app.memberships.models import BuildingMembership
from app.memberships.occupancy import end_occupancy
from app.notifications.models import Notification
from app.packages import service
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.packages.schemas import PackagePickup, PackageReturn
from app.packages.state import InvalidTransition
from tests.notifications.test_concurrency import migrate
from tests.packages.conftest import make_package, persona_ctx
from tests.world import World, build_world

type Sessions = async_sessionmaker[AsyncSession]


def _run(url: str, body: Callable[[Sessions, World, Package], Awaitable[None]]) -> None:
    migrate(url)

    async def check() -> None:
        engine = create_async_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                package = await make_package(db, world.a_101, world.a_security.membership)
                await db.commit()
            await body(sessions, world, package)
        finally:
            await engine.dispose()

    asyncio.run(check())


async def _act(sessions: Sessions, world: World, package: Package, action: str) -> str:
    """Run `action` in a session of its own as security; its outcome as a word."""
    async with sessions() as db:
        ctx = persona_ctx(world, "a_security")
        try:
            if action == "pickup":
                data = PackagePickup(picked_up_by_membership_id=world.a_resident1.membership.id)
                await service.pickup_package(db, ctx, package.id, data)
            else:
                await service.return_package(db, ctx, package.id, PackageReturn(reason="Damaged"))
        except InvalidTransition:
            return "409"
        except service.InvalidPickupMember:
            return "422"
        return "200"


async def _count(sessions: Sessions, model: Any, *where: Any) -> int:
    async with sessions() as db:
        return await db.scalar(select(func.count()).select_from(model).where(*where)) or 0


async def _status(sessions: Sessions, package: Package) -> PackageStatus | None:
    async with sessions() as db:
        return await db.scalar(select(Package.status).where(Package.id == package.id))


def test_two_concurrent_pickups_have_one_winner(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World, package: Package) -> None:
        outcomes = await asyncio.gather(
            _act(sessions, world, package, "pickup"), _act(sessions, world, package, "pickup")
        )

        assert sorted(outcomes) == ["200", "409"]
        assert await _status(sessions, package) == PackageStatus.PICKED_UP
        assert await _count(sessions, AuditEvent, AuditEvent.action == "package.picked_up") == 1
        assert await _count(sessions, Notification, Notification.entity_id == package.id) == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first", ["pickup", "return"])
def test_a_concurrent_pickup_and_return_have_one_winner(
    scratch_database_url: str, first: str
) -> None:
    async def body(sessions: Sessions, world: World, package: Package) -> None:
        second = "return" if first == "pickup" else "pickup"
        outcomes = await asyncio.gather(
            _act(sessions, world, package, first), _act(sessions, world, package, second)
        )

        assert sorted(outcomes) == ["200", "409"]
        winner = first if outcomes[0] == "200" else second
        expected = PackageStatus.PICKED_UP if winner == "pickup" else PackageStatus.RETURNED
        assert await _status(sessions, package) == expected
        assert await _count(sessions, AuditEvent, AuditEvent.entity_id == package.id) == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first_commits", [True, False], ids=["commits", "rolls-back"])
def test_a_pickup_waits_for_a_held_transition_and_loses_after_its_commit(
    scratch_database_url: str, first_commits: bool
) -> None:
    # The conditional UPDATE waits on the row another transaction changed; after its commit it
    # re-checks `status IN ('received')` on the committed row and matches nothing (409), after its
    # rollback it wins.
    async def body(sessions: Sessions, world: World, package: Package) -> None:
        async with sessions() as first:
            await first.execute(
                update(Package)
                .where(Package.id == package.id)
                .values(
                    status=PackageStatus.RETURNED,
                    returned_at=func.clock_timestamp(),
                    return_reason="Damaged",
                )
            )
            task = asyncio.create_task(_act(sessions, world, package, "pickup"))
            await asyncio.sleep(1.0)
            assert not task.done(), "the pickup did not wait for the open transition"
            if first_commits:
                await first.commit()
            else:
                await first.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == ("409" if first_commits else "200")
        expected = PackageStatus.RETURNED if first_commits else PackageStatus.PICKED_UP
        assert await _status(sessions, package) == expected

    _run(scratch_database_url, body)


@pytest.mark.parametrize("change", ["deactivate", "move-out"])
@pytest.mark.parametrize("first_commits", [True, False], ids=["commits", "rolls-back"])
def test_a_pickup_waits_for_a_change_of_its_member(
    scratch_database_url: str, change: str, first_commits: bool
) -> None:
    # Criterion 13: membership status and occupancy writes lock the membership row (FOR NO KEY
    # UPDATE, app.memberships); the pickup's check waits for them and reads what they committed.
    async def body(sessions: Sessions, world: World, package: Package) -> None:
        member = world.a_resident1.membership
        async with sessions() as first:
            if change == "deactivate":
                await first.execute(
                    update(BuildingMembership)
                    .where(BuildingMembership.id == member.id)
                    .values(status=MembershipStatus.DEACTIVATED)
                )
            else:
                ended = await end_occupancy(first, building_id=world.a.id, membership_id=member.id)
                assert ended is not None
            task = asyncio.create_task(_act(sessions, world, package, "pickup"))
            await asyncio.sleep(1.0)
            assert not task.done(), "the pickup did not wait for the member's open change"
            if first_commits:
                await first.commit()
            else:
                await first.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == ("422" if first_commits else "200")
        expected = PackageStatus.RECEIVED if first_commits else PackageStatus.PICKED_UP
        assert await _status(sessions, package) == expected

    _run(scratch_database_url, body)
