"""A refresh that waits on the per-user idle-deadline lock (P4-02b, inbox B-6 option A) must not
revive a session that expired while it waited (review round 4, R4-F1).

On real connections, in a scratch database of its own, like the other concurrency tests.
"""

import asyncio
from uuid import UUID

import pytest
from sqlalchemy import delete, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth import service as auth
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from tests.conftest import FrozenClock
from tests.factories import make_building, make_membership, make_user
from tests.notifications.test_concurrency import migrate


async def _change_roles(
    held: AsyncSession, change: str, user_id: UUID, membership_id: UUID
) -> None:
    """A role change as option A makes it: the lock, the change, then `apply_role_change`."""
    await auth.lock_idle_deadlines(held, user_id)
    if change == "remove-staff-role":
        await held.execute(
            delete(MembershipRole).where(
                MembershipRole.membership_id == membership_id,
                MembershipRole.role == Role.SECURITY,
            )
        )
    elif change == "suspend-membership":
        await held.execute(
            update(BuildingMembership)
            .where(BuildingMembership.id == membership_id)
            .values(status=MembershipStatus.SUSPENDED)
        )
    else:  # grant-staff: the accept's direction
        await held.execute(
            update(BuildingMembership)
            .where(BuildingMembership.id == membership_id)
            .values(status=MembershipStatus.ACTIVE)
        )
    await auth.apply_role_change(held, user_id, active_session_id=None)


@pytest.mark.parametrize("change", ["remove-staff-role", "suspend-membership", "grant-staff"])
def test_refresh_waiting_on_a_role_change_cannot_revive_an_expired_session(
    scratch_database_url: str, frozen_clock: FrozenClock, change: str
) -> None:
    # The refresh resolves the session 1 s before its deadline, then waits on the lock a role
    # change holds; the deadline passes while it waits. Once it gets the lock it must judge
    # liveness by the time then, not by the time it read before waiting (R4-F1).
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                user = await make_user(db)
                token = await auth.start_session(db, user.id, user_agent=None, ip=None)
                if change == "grant-staff":
                    # Resident window (7 days); the staff membership is pending until the change.
                    member = await make_membership(
                        user,
                        await make_building(db),
                        roles=(Role.SECURITY,),
                        status=MembershipStatus.PENDING,
                    )
                    until_deadline = {"days": 7}
                else:
                    # Staff, capped to 12 hours as an accept does for another device's session.
                    member = await make_membership(
                        user, await make_building(db), roles=(Role.SECURITY,)
                    )
                    await auth.apply_role_change(db, user.id, active_session_id=None)
                    until_deadline = {"hours": 12}
                user_id, membership_id = user.id, member.id
                await db.commit()

            frozen_clock.advance(**until_deadline)
            frozen_clock.advance(seconds=-1)
            resolved = asyncio.Event()
            writer_pid: int | None = None

            async def refresh() -> None:
                nonlocal writer_pid
                async with sessions() as db:
                    writer_pid = await db.scalar(text("SELECT pg_backend_pid()"))
                    current = await auth.resolve_session(db, token)
                    assert current is not None
                    resolved.set()
                    await auth.touch_session(db, current.session)

            async with sessions() as held:
                await _change_roles(held, change, user_id, membership_id)
                task = asyncio.create_task(refresh())
                try:
                    await asyncio.wait_for(resolved.wait(), timeout=5)
                    async with sessions() as observer:
                        for _ in range(200):
                            waiting = await observer.scalar(
                                text("SELECT cardinality(pg_blocking_pids(:pid)) > 0"),
                                {"pid": writer_pid},
                            )
                            if waiting:
                                break
                            # pg_stat_activity is a snapshot per transaction.
                            await observer.rollback()
                            await asyncio.sleep(0.01)
                        else:
                            pytest.fail("the refresh did not wait on the per-user lock")
                        frozen_clock.advance(seconds=2)
                        assert await auth.resolve_session(observer, token) is None
                    await held.commit()
                    await asyncio.wait_for(task, timeout=5)
                finally:
                    if not task.done():
                        task.cancel()
                        await asyncio.gather(task, return_exceptions=True)

            async with sessions() as db:
                assert await auth.resolve_session(db, token) is None
        finally:
            await engine.dispose()

    asyncio.run(check())
