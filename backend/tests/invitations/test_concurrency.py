"""Two managers invite the same email at once (P4-02a criterion 5, tenant row 10): one invitation.

On real connections: the test harness runs on one, so this uses a scratch database of its own
(`scratch_database_url`), migrated here and dropped after the test.
"""

import asyncio

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.invitations import service
from app.invitations.models import Invitation
from app.invitations.schemas import InvitationCreate
from app.memberships.enums import Role
from app.tenancy.context import TenantContext
from tests.notifications.test_concurrency import migrate
from tests.world import build_world


def test_concurrent_creates_for_one_email_make_one_invitation(scratch_database_url: str) -> None:
    # Without the building-row lock, both transactions would check for a pending invitation before
    # either committed, see none, and both insert.
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
            data = InvitationCreate(email="guard@example.test", roles=[Role.SECURITY])

            async with sessions() as first:
                # The first create runs up to its commit, which is held back: its transaction stays
                # open with the building lock and the new row, until the second create is waiting.
                commit = first.commit

                async def hold() -> None:
                    pass

                first.commit = hold  # type: ignore[method-assign]
                await service.create_invitation(first, ctx, data)
                first.commit = commit  # type: ignore[method-assign]

                async def second() -> str:
                    async with sessions() as db:
                        try:
                            await service.create_invitation(db, ctx, data)
                        except service.InvitationPending:
                            return "invitation_pending"
                        return "created"

                task = asyncio.create_task(second())
                await asyncio.sleep(0.5)
                assert not task.done(), "the second create did not wait for the first"
                await first.commit()
                outcome = await asyncio.wait_for(task, timeout=10)

            async with sessions() as db:
                count = await db.scalar(
                    select(func.count()).where(Invitation.email == "guard@example.test")
                )
            assert (outcome, count) == ("invitation_pending", 1)
        finally:
            await engine.dispose()

    asyncio.run(check())
