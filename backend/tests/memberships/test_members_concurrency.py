"""Races in membership administration (P4-06a criteria 3, 14, 15, 17; tenant row 10): two managers
demoting or suspending each other, a manager acting after losing their authority, two suspensions of
one member, and a session write meeting a role change.

On real connections, as `tests/onboarding/test_decisions_concurrency.py` (whose `_run` builds the world
in a scratch database). The first write is held open (its commit is deferred); the second must wait for
it on the building lock, then act on what it committed.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

from app.audit.models import AuditEvent
from app.auth import service as auth
from app.core.errors import DomainError
from app.memberships import service
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.memberships.schemas import MemberRolesIn, MemberSuspendIn
from app.tenancy.context import TenantContext
from tests.conftest import FrozenClock
from tests.factories import make_membership, make_user
from tests.onboarding.test_concurrency import _run
from tests.world import Member, World

type Sessions = async_sessionmaker[AsyncSession]
type Write = Callable[[AsyncSession], Awaitable[Any]]

REASON = MemberSuspendIn(reason="Unpaid fees")


def _ctx(world: World, member: Member) -> TenantContext:
    return TenantContext(
        user_id=member.user.id,
        building_id=world.a.id,
        membership_id=member.membership.id,
        roles=frozenset({Role.PROPERTY_MANAGEMENT}),
        features=frozenset(),
    )


async def _second_manager(sessions: Sessions, world: World) -> Member:
    async with sessions() as db:
        user = await make_user(db, full_name="second manager")
        membership = await make_membership(user, world.a, roles=(Role.PROPERTY_MANAGEMENT,))
        await db.commit()
        return Member(user, membership)


def _demote(ctx: TenantContext, target: UUID) -> Write:
    async def write(db: AsyncSession) -> Any:
        return await service.change_roles(
            db, ctx, target, MemberRolesIn(add=[], remove=[Role.PROPERTY_MANAGEMENT])
        )

    return write


def _suspend(ctx: TenantContext, target: UUID) -> Write:
    async def write(db: AsyncSession) -> Any:
        return await service.suspend_member(db, ctx, target, REASON)

    return write


async def _outcome(write: Write, db: AsyncSession) -> str:
    try:
        await write(db)
    except DomainError as exc:
        await db.rollback()
        return exc.code
    return "ok"


async def _held_then(sessions: Sessions, first: Write, second: Write) -> tuple[str, str]:
    """Run `first` with its commit held, start `second` and check that it waits, then commit
    `first` and return both outcomes."""
    async with sessions() as held:
        commit = held.commit

        async def hold() -> None:
            pass

        held.commit = hold  # type: ignore[method-assign]
        first_outcome = await _outcome(first, held)
        held.commit = commit  # type: ignore[method-assign]

        async def run_second() -> str:
            async with sessions() as db:
                return await _outcome(second, db)

        task = asyncio.create_task(run_second())
        await asyncio.sleep(0.5)
        assert not task.done(), "the second write did not wait for the first"
        await held.commit()
        second_outcome = await asyncio.wait_for(task, timeout=10)
    return first_outcome, second_outcome


async def _scalar(sessions: Sessions, stmt: Any) -> Any:
    async with sessions() as db:
        return await db.scalar(stmt)


async def _active_managers(sessions: Sessions, world: World) -> int:
    count: int = await _scalar(
        sessions,
        select(func.count())
        .select_from(BuildingMembership)
        .join(MembershipRole, MembershipRole.membership_id == BuildingMembership.id)
        .where(
            BuildingMembership.building_id == world.a.id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            MembershipRole.role == Role.PROPERTY_MANAGEMENT,
        ),
    )
    return count


@pytest.mark.parametrize("action", [_demote, _suspend], ids=["demote", "suspend"])
def test_managers_acting_on_each_other_leave_one_manager(
    scratch_database_url: str, action: Callable[[TenantContext, UUID], Write]
) -> None:
    # Criterion 3. Without the building lock, each would count the other still active and both
    # succeed, leaving none.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        first = world.a_manager

        outcomes = await _held_then(
            sessions,
            action(_ctx(world, first), second.membership.id),
            action(_ctx(world, second), first.membership.id),
        )

        assert outcomes == ("ok", "last_manager")
        assert await _active_managers(sessions, world) == 1

    _run(scratch_database_url, body)


def test_concurrent_managers_without_holding_still_leave_one(scratch_database_url: str) -> None:
    # Criterion 3 as two plain concurrent requests: whichever order the database picks.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        first = world.a_manager

        async def run(write: Write) -> str:
            async with sessions() as db:
                return await _outcome(write, db)

        outcomes = await asyncio.gather(
            run(_demote(_ctx(world, first), second.membership.id)),
            run(_demote(_ctx(world, second), first.membership.id)),
        )

        assert sorted(outcomes) == ["last_manager", "ok"]
        assert await _active_managers(sessions, world) == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize(
    ("demotion", "expected"),
    [(_demote, "forbidden_role"), (_suspend, "building_not_found")],
    ids=["role-removed", "suspended"],
)
def test_stale_manager_is_refused_after_the_lock(
    scratch_database_url: str,
    demotion: Callable[[TenantContext, UUID], Write],
    expected: str,
) -> None:
    # Criterion 15: the second manager's context was read before the wait; after it, they are no
    # longer a manager (or no longer active), so their suspension of a resident must not land.
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id

        outcomes = await _held_then(
            sessions,
            demotion(_ctx(world, world.a_manager), second.membership.id),
            _suspend(_ctx(world, second), target),
        )

        assert outcomes == ("ok", expected)
        status = await _scalar(
            sessions, select(BuildingMembership.status).where(BuildingMembership.id == target)
        )
        assert status == MembershipStatus.ACTIVE
        suspended_events = await _scalar(
            sessions,
            select(func.count()).where(
                AuditEvent.action == "membership.suspended", AuditEvent.entity_id == target
            ),
        )
        assert suspended_events == 0

    _run(scratch_database_url, body)


def test_concurrent_suspends_give_one_winner(scratch_database_url: str) -> None:
    # Criterion 17 (tenant row 10).
    async def body(sessions: Sessions, world: World) -> None:
        second = await _second_manager(sessions, world)
        target = world.a_resident1.membership.id

        outcomes = await _held_then(
            sessions,
            _suspend(_ctx(world, world.a_manager), target),
            _suspend(_ctx(world, second), target),
        )

        assert outcomes == ("ok", "invalid_transition")
        events = await _scalar(
            sessions,
            select(func.count()).where(
                AuditEvent.action == "membership.suspended", AuditEvent.entity_id == target
            ),
        )
        assert events == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first", ["writer", "change"])
@pytest.mark.parametrize("writer", ["refresh", "new-session"])
def test_session_writes_and_a_staff_role_change_take_turns(
    scratch_database_url: str, frozen_clock: FrozenClock, writer: str, first: str
) -> None:
    # Criterion 14, as `tests/invitations/test_concurrency.py::
    # test_session_writes_and_a_staff_accept_take_turns`: a resident is logged in; one of their
    # sessions is refreshed (or a new login starts) while a manager gives them `security`. Each waits
    # for the other on the per-user lock, so whichever writes second sees the first's result; either
    # way the written session ends after 13 idle hours (ADR-0003).
    async def body(sessions: Sessions, world: World) -> None:
        user_id = world.a_resident1.user.id
        async with sessions() as db:
            other = await auth.start_session(db, user_id, user_agent=None, ip=None)
            await db.commit()
        frozen_clock.advance(minutes=6)

        async def write(db: AsyncSession) -> str:
            if writer == "refresh":
                current = await auth.resolve_session(db, other)
                assert current is not None
                await auth.touch_session(db, current.session)
                return other
            created = await auth.start_logged_in_session(db, user_id, user_agent=None, ip=None)
            await db.commit()
            return created

        async def change(db: AsyncSession) -> str:
            out = await service.change_roles(
                db,
                _ctx(world, world.a_manager),
                world.a_resident1.membership.id,
                MemberRolesIn(add=[Role.SECURITY], remove=[]),
            )
            assert out.roles == [Role.RESIDENT, Role.SECURITY]
            return other

        hold_first, run_second = (write, change) if first == "writer" else (change, write)
        async with sessions() as held:
            commit = held.commit

            async def hold() -> None:
                pass

            held.commit = hold  # type: ignore[method-assign]
            first_result = await hold_first(held)
            held.commit = commit  # type: ignore[method-assign]

            async def second() -> str:
                async with sessions() as db:
                    return await run_second(db)

            task = asyncio.create_task(second())
            await asyncio.sleep(0.5)
            assert not task.done(), "the second write did not wait for the first"
            await held.commit()
            second_result = await asyncio.wait_for(task, timeout=10)

        written = first_result if first == "writer" else second_result
        frozen_clock.advance(hours=13)
        async with sessions() as db:
            assert await auth.resolve_session(db, written) is None

    _run(scratch_database_url, body)
