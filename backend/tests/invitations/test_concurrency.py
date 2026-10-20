"""Two managers make an invitation pending for the same email at once (P4-02a criterion 5, tenant
row 10): by two creates, or a create and a resend of an expired invitation (review round 1). One
pending invitation results; the second request waits for the first and gets 409. And two accepts
racing (P4-02b criterion 10): on one token, or on one new email through two buildings' invitations.

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
from app.core.security import generate_token, hash_token
from app.invitations import service
from app.invitations.models import Invitation
from app.invitations.schemas import InvitationAccept, InvitationCreate, InvitationStatus
from app.memberships.enums import Role
from app.memberships.models import BuildingMembership
from app.rate_limits.service import RateLimiter
from app.tenancy.context import TenantContext
from app.users.models import User
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


# P4-02b criterion 10: accepts racing on one token, and on one new email.

NEW_PERSON = InvitationAccept(
    full_name="Gina Guard",
    password="correct horse battery staple",  # noqa: S106 (a test password)
)


async def _pending(db: AsyncSession, building_id: UUID, created_by: UUID) -> str:
    token = generate_token()
    db.add(
        Invitation(
            building_id=building_id,
            email=EMAIL,
            roles=[Role.SECURITY.value],
            token_hash=hash_token(token),
            expires_at=clock.now() + timedelta(days=7),
            created_by_user_id=created_by,
        )
    )
    await db.commit()
    return token


@pytest.mark.parametrize("same_token", [True, False], ids=["one-token", "two-buildings"])
def test_racing_accepts_have_one_winner(scratch_database_url: str, same_token: bool) -> None:
    # One token: the second accept waits on the invitation row, then its claim matches nothing.
    # Two buildings' invitations for one new email: the second waits on the email's unique index,
    # then finds the account taken and needs a login, instead of a 500.
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        limiter = RateLimiter(sessions)
        try:
            async with sessions() as db:
                world = await build_world(db)
                await db.commit()
            async with sessions() as db:
                first_token = await _pending(db, world.a.id, world.a_manager.user.id)
                second_token = (
                    first_token
                    if same_token
                    else await _pending(db, world.b.id, world.b_manager.user.id)
                )

            async def accept(db: AsyncSession, token: str) -> object:
                return await service.accept_invitation(
                    db, limiter, token, NEW_PERSON, session_token=None, user_agent=None, ip=None
                )

            async with sessions() as held:
                commit = held.commit

                async def hold() -> None:
                    pass

                held.commit = hold  # type: ignore[method-assign]
                await accept(held, first_token)
                held.commit = commit  # type: ignore[method-assign]

                async def run_second() -> str:
                    async with sessions() as db:
                        try:
                            await accept(db, second_token)
                        except service.InvitationInvalid:
                            return "invitation_invalid"
                        except service.LoginRequired:
                            return "login_required"
                        return "accepted"

                task = asyncio.create_task(run_second())
                await asyncio.sleep(0.5)
                assert not task.done(), "the second accept did not wait for the first"
                await held.commit()
                outcome = await asyncio.wait_for(task, timeout=10)

            async with sessions() as db:
                users = await db.scalar(select(func.count()).where(User.email == EMAIL))
                accepted = await db.scalar(
                    select(func.count()).where(Invitation.accepted_at.is_not(None))
                )
                memberships = await db.scalar(
                    select(func.count())
                    .select_from(BuildingMembership)
                    .join(User, User.id == BuildingMembership.user_id)
                    .where(User.email == EMAIL)
                )
            expected = "invitation_invalid" if same_token else "login_required"
            assert (outcome, users, accepted, memberships) == (expected, 1, 1, 1)
        finally:
            await engine.dispose()

    asyncio.run(check())
