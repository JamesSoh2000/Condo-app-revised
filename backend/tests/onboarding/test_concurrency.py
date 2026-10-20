"""Races in the join flow (P4-05a criteria 2 and 11, tenant row 10): two signups for one email, two
first submissions by one user, and a submission meeting a unit's deactivation.

On real connections, as `tests/units/test_concurrency.py`: a scratch database of its own, migrated
here and dropped after the test. Each race holds the competing write open in one session and checks
that the use case waits for it, then acts on what it committed or rolled back.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth import service as auth_service
from app.auth.service import EmailInUse
from app.buildings.models import Building
from app.core.security import hash_password
from app.memberships.enums import MembershipStatus, OccupancyRelationship
from app.memberships.models import BuildingMembership
from app.onboarding import service
from app.onboarding.models import OnboardingRequest
from app.onboarding.schemas import JoinRequestCreate
from app.rate_limits.service import RateLimiter
from app.units.models import Unit
from app.units.service import UnitNotFound
from app.users.models import User
from tests.factories import make_user
from tests.notifications.test_concurrency import migrate
from tests.world import World, build_world

CODE = "MAPLE-23456"
PASSWORD = "correct horse battery staple"  # noqa: S105 (a test password)

type Sessions = async_sessionmaker[AsyncSession]


def _run(url: str, body: Callable[[Sessions, World], Awaitable[None]]) -> None:
    migrate(url)

    async def check() -> None:
        engine = create_async_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                await db.execute(
                    update(Building).where(Building.id == world.a.id).values(join_code=CODE)
                )
                await db.commit()
            await body(sessions, world)
        finally:
            await engine.dispose()

    asyncio.run(check())


async def _signup(sessions: Sessions, email: str) -> str:
    async with sessions() as db:
        try:
            await auth_service.signup(
                db,
                RateLimiter(sessions),
                email=email,
                full_name="Rosa",
                password=PASSWORD,
                user_agent=None,
                ip=None,
            )
        except EmailInUse:
            return "email_in_use"
        return "created"


async def _submit(sessions: Sessions, user_id: Any, unit_id: Any) -> str:
    async with sessions() as db:
        try:
            result = await service.submit_request(
                db,
                user_id,
                CODE,
                JoinRequestCreate(unit_id=unit_id, relationship=OccupancyRelationship.TENANT),
            )
        except UnitNotFound:
            return "unit_not_found"
        return "created" if result.created else "existing"


async def _count(sessions: Sessions, model: Any, *where: Any) -> int:
    async with sessions() as db:
        return await db.scalar(select(func.count()).select_from(model).where(*where)) or 0


@pytest.mark.parametrize("first_commits", [True, False], ids=["commits", "rolls-back"])
def test_signup_waits_for_a_concurrent_signup_of_the_same_email(
    scratch_database_url: str, first_commits: bool
) -> None:
    # The second signup's read sees no account (the first hasn't committed); its INSERT then waits
    # on uq_users_lower_email. After a commit it is 409, after a rollback it creates the account:
    # never an IntegrityError (500).
    async def body(sessions: Sessions, world: World) -> None:
        async with sessions() as first:
            await first.execute(
                insert(User).values(
                    email="rosa@example.test", full_name="First", password_hash=hash_password("x")
                )
            )
            task = asyncio.create_task(_signup(sessions, "rosa@example.test"))
            await asyncio.sleep(1.0)
            assert not task.done(), "signup did not wait for the open insert of the same email"
            if first_commits:
                await first.commit()
            else:
                await first.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == ("email_in_use" if first_commits else "created")
        assert await _count(sessions, User, func.lower(User.email) == "rosa@example.test") == 1

    _run(scratch_database_url, body)


def test_two_concurrent_signups_give_one_account(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        outcomes = await asyncio.gather(
            _signup(sessions, "rosa@example.test"), _signup(sessions, "ROSA@example.test")
        )

        assert sorted(outcomes) == ["created", "email_in_use"]
        assert await _count(sessions, User, func.lower(User.email) == "rosa@example.test") == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first_commits", [True, False], ids=["commits", "rolls-back"])
def test_a_first_submission_waits_for_a_concurrent_one(
    scratch_database_url: str, first_commits: bool
) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        async with sessions() as db:
            user = await make_user(db)
            await db.commit()
        async with sessions() as first:
            membership_id = await first.scalar(
                insert(BuildingMembership)
                .values(building_id=world.a.id, user_id=user.id, status=MembershipStatus.PENDING)
                .returning(BuildingMembership.id)
            )
            await first.execute(
                insert(OnboardingRequest).values(
                    building_id=world.a.id,
                    membership_id=membership_id,
                    unit_id=world.a_101.id,
                    relationship=OccupancyRelationship.OWNER,
                )
            )
            task = asyncio.create_task(_submit(sessions, user.id, world.a_102.id))
            await asyncio.sleep(1.0)
            assert not task.done(), "the submission did not wait for the open membership insert"
            if first_commits:
                await first.commit()
            else:
                await first.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == ("existing" if first_commits else "created")
        assert (
            await _count(sessions, BuildingMembership, BuildingMembership.user_id == user.id) == 1
        )
        assert await _count(sessions, OnboardingRequest) == 1

    _run(scratch_database_url, body)


def test_two_first_submissions_by_one_user_give_one_request(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World) -> None:
        async with sessions() as db:
            user = await make_user(db)
            await db.commit()

        outcomes = await asyncio.gather(
            _submit(sessions, user.id, world.a_101.id), _submit(sessions, user.id, world.a_102.id)
        )

        assert sorted(outcomes) == ["created", "existing"]
        assert (
            await _count(sessions, BuildingMembership, BuildingMembership.user_id == user.id) == 1
        )
        assert await _count(sessions, OnboardingRequest) == 1

    _run(scratch_database_url, body)


@pytest.mark.parametrize("deactivation_commits", [True, False], ids=["commits", "rolls-back"])
def test_submission_waits_for_a_unit_deactivation(
    scratch_database_url: str, deactivation_commits: bool
) -> None:
    # The P4-01a carry: `deactivate_unit` locks the unit FOR UPDATE, then sets is_active. The
    # submission's FOR KEY SHARE read waits for it, then re-checks is_active on the committed row.
    async def body(sessions: Sessions, world: World) -> None:
        async with sessions() as db:
            user = await make_user(db)
            await db.commit()
        async with sessions() as deactivating:
            await deactivating.execute(
                select(Unit.id).where(Unit.id == world.a_101.id).with_for_update()
            )
            await deactivating.execute(
                update(Unit).where(Unit.id == world.a_101.id).values(is_active=False)
            )
            task = asyncio.create_task(_submit(sessions, user.id, world.a_101.id))
            await asyncio.sleep(1.0)
            assert not task.done(), "the submission did not wait for the unit's deactivation"
            if deactivation_commits:
                await deactivating.commit()
            else:
                await deactivating.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == ("unit_not_found" if deactivation_commits else "created")
        assert await _count(sessions, OnboardingRequest) == (0 if deactivation_commits else 1)

    _run(scratch_database_url, body)
