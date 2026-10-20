"""Two managers make an invitation pending for the same email at once (P4-02a criterion 5, tenant
row 10): by two creates, or a create and a resend of an expired invitation (review round 1). One
pending invitation results; the second request waits for the first and gets 409.

On real connections: the test harness runs on one, so this uses a scratch database of its own
(`scratch_database_url`), migrated here and dropped after the test.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta
from uuid import UUID

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core import clock
from app.invitations import service
from app.invitations.models import Invitation
from app.invitations.schemas import InvitationCreate, InvitationStatus
from app.memberships.enums import Role
from app.tenancy.context import TenantContext
from tests.notifications.test_concurrency import migrate
from tests.world import build_world

EMAIL = "guard@example.test"

type Action = Callable[[AsyncSession, TenantContext, UUID], Awaitable[object]]


async def _create(db: AsyncSession, ctx: TenantContext, _: UUID) -> object:
    return await service.create_invitation(
        db, ctx, InvitationCreate(email=EMAIL, roles=[Role.SECURITY])
    )


async def _resend(db: AsyncSession, ctx: TenantContext, expired_id: UUID) -> object:
    return await service.resend_invitation(db, ctx, expired_id)


@pytest.mark.parametrize(
    ("first", "second"),
    [(_create, _create), (_create, _resend), (_resend, _create)],
    ids=["create-create", "create-resend", "resend-create"],
)
def test_concurrent_writes_for_one_email_leave_one_pending_invitation(
    scratch_database_url: str, first: Action, second: Action
) -> None:
    # Without the building-row lock, both transactions would check for a pending invitation before
    # either committed, see none, and both make one pending.
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                await db.commit()
            ctx = TenantContext(
                user_id=world.a_manager.user.id,
                building_id=world.a.id,
                membership_id=world.a_manager.membership.id,
                roles=frozenset({Role.PROPERTY_MANAGEMENT}),
                features=frozenset(),
            )
            # An expired invitation for the email, for the resends to revive.
            async with sessions() as db:
                expired = await service.create_invitation(
                    db, ctx, InvitationCreate(email=EMAIL, roles=[Role.COUNCIL])
                )
            async with sessions() as db:
                await db.execute(
                    update(Invitation)
                    .where(Invitation.id == expired.id)
                    .values(expires_at=clock.now() - timedelta(seconds=1))
                )
                await db.commit()

            async with sessions() as held:
                # The first write runs up to its commit, which is held back: its transaction stays
                # open with the building lock and its pending row until the second is waiting.
                commit = held.commit

                async def hold() -> None:
                    pass

                held.commit = hold  # type: ignore[method-assign]
                await first(held, ctx, expired.id)
                held.commit = commit  # type: ignore[method-assign]

                async def run_second() -> str:
                    async with sessions() as db:
                        try:
                            await second(db, ctx, expired.id)
                        except service.InvitationPending:
                            return "invitation_pending"
                        return "done"

                task = asyncio.create_task(run_second())
                await asyncio.sleep(0.5)
                assert not task.done(), "the second write did not wait for the first"
                await held.commit()
                outcome = await asyncio.wait_for(task, timeout=10)

            async with sessions() as db:
                pending = await db.scalar(
                    select(func.count()).where(
                        Invitation.email == EMAIL,
                        service.status_clause(InvitationStatus.PENDING, clock.now()),
                    )
                )
            assert (outcome, pending) == ("invitation_pending", 1)
        finally:
            await engine.dispose()

    asyncio.run(check())
