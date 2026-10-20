"""Password reset races (P4-04 criterion 8): two confirms of one token, two requests for one email,
a confirm whose token expires while it waits, and a login racing a reset.

On real connections, in a scratch database of its own, like the other concurrency tests. A first
transaction does its work and holds its commit; the second is started, shown to wait on a lock, and
then the first commits (or rolls back).
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.auth import service
from app.auth.models import AuthSession, PasswordResetToken
from app.core.security import hash_password, verify_password
from app.jobs.models import Job
from app.rate_limits.service import RateLimiter
from app.users.models import User
from tests.conftest import FrozenClock
from tests.factories import make_user
from tests.notifications.test_concurrency import migrate

EMAIL = "forgetful@example.test"
OLD_PASSWORD = "the-old-password-2026"  # noqa: S105 (test value)
FIRST = "the-first-new-password"  # noqa: S105 (test value)
SECOND = "the-second-new-password"  # noqa: S105 (test value)


async def _wait_for_a_lock(sessions: async_sessionmaker[AsyncSession]) -> None:
    async with sessions() as observer:
        for _ in range(300):
            waiting = await observer.scalar(
                text(
                    "SELECT count(*) FROM pg_stat_activity WHERE"
                    " wait_event_type = 'Lock' AND datname = current_database()"
                )
            )
            if waiting:
                return
            # pg_stat_activity is a snapshot per transaction.
            await observer.rollback()
            await asyncio.sleep(0.01)
    pytest.fail("the second transaction never waited on a lock")


async def _held(
    sessions: async_sessionmaker[AsyncSession], work: Callable[[AsyncSession], Awaitable[object]]
) -> AsyncSession:
    """Open a session, run `work` in it with its commit turned into a no-op, and return it with
    the transaction still open."""
    held = sessions()
    commit = held.commit

    async def hold() -> None:
        pass

    held.commit = hold  # type: ignore[method-assign]
    await work(held)
    held.commit = commit  # type: ignore[method-assign]
    return held


def _run(scratch_database_url: str, check: Callable[..., Awaitable[None]]) -> None:
    migrate(scratch_database_url)

    async def main() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                user = await make_user(
                    db, email=EMAIL, password_hash=hash_password(OLD_PASSWORD)
                )
                await db.commit()
            await check(sessions, RateLimiter(sessions), user.id)
        finally:
            await engine.dispose()

    asyncio.run(main())


async def _request(db: AsyncSession, limiter: RateLimiter) -> None:
    await service.request_password_reset(db, limiter, email=EMAIL, ip=None)


async def _token(sessions: async_sessionmaker[AsyncSession]) -> str:
    async with sessions() as db:
        link = await db.scalar(
            select(Job.payload["context"]["link"].astext).order_by(Job.id.desc()).limit(1)
        )
    assert link is not None
    return link.rsplit("/", 1)[1]


def test_racing_confirms_of_one_token_have_one_winner(scratch_database_url: str) -> None:
    async def check(sessions, limiter, user_id) -> None:
        async with sessions() as db:
            await _request(db, limiter)
        token = await _token(sessions)

        async def confirm(db: AsyncSession, password: str) -> None:
            await service.confirm_password_reset(
                db, limiter, token=token, new_password=password, ip=None
            )

        held = await _held(sessions, lambda db: confirm(db, FIRST))

        async def second() -> str:
            async with sessions() as db:
                try:
                    await confirm(db, SECOND)
                except service.ResetTokenInvalid:
                    return "reset_token_invalid"
                return "reset"

        task = asyncio.create_task(second())
        await _wait_for_a_lock(sessions)
        await held.commit()
        await held.close()
        assert await asyncio.wait_for(task, timeout=10) == "reset_token_invalid"

        async with sessions() as db:
            stored = await db.scalar(select(User.password_hash).where(User.id == user_id))
            used = await db.scalar(
                select(func.count()).where(PasswordResetToken.used_at.is_not(None))
            )
        assert stored is not None and verify_password(FIRST, stored)
        assert used == 1

    _run(scratch_database_url, check)


def test_racing_requests_leave_one_live_token(scratch_database_url: str) -> None:
    # The second request waits on the user row, then revokes the first's token: never two live
    # tokens, and never a 500 from the one-live-token index.
    async def check(sessions, limiter, user_id) -> None:
        held = await _held(sessions, lambda db: _request(db, limiter))

        async def second() -> None:
            async with sessions() as db:
                await _request(db, limiter)

        task = asyncio.create_task(second())
        await _wait_for_a_lock(sessions)
        await held.commit()
        await held.close()
        await asyncio.wait_for(task, timeout=10)

        async with sessions() as db:
            rows = (
                await db.execute(
                    select(PasswordResetToken.used_at, PasswordResetToken.revoked_at).order_by(
                        PasswordResetToken.id
                    )
                )
            ).all()
        assert [(used is None, revoked is None) for used, revoked in rows] == [
            (True, False),
            (True, True),
        ]

    _run(scratch_database_url, check)


def test_token_that_expires_while_the_confirm_waits_is_refused(
    scratch_database_url: str, frozen_clock: FrozenClock
) -> None:
    # Another write holds the user's row (a login starting a session). The confirm read the token
    # live, hashed the password, then waits; the hour passes meanwhile. Expiry is final: it must
    # judge the token by the clock after the wait (CLAUDE.md lesson, P4-02b).
    async def check(sessions, limiter, user_id) -> None:
        async with sessions() as db:
            await _request(db, limiter)
            await db.execute(
                update(PasswordResetToken).values(
                    expires_at=frozen_clock() + timedelta(seconds=1)
                )
            )
            await db.commit()
        token = await _token(sessions)
        held = sessions()
        await service.lock_idle_deadlines(held, user_id)

        async def confirm() -> str:
            async with sessions() as db:
                try:
                    await service.confirm_password_reset(
                        db, limiter, token=token, new_password=FIRST, ip=None
                    )
                except service.ResetTokenInvalid:
                    return "reset_token_invalid"
                return "reset"

        task = asyncio.create_task(confirm())
        try:
            await _wait_for_a_lock(sessions)
            frozen_clock.advance(seconds=2)
        finally:
            await held.rollback()
            await held.close()
        assert await asyncio.wait_for(task, timeout=10) == "reset_token_invalid"

        async with sessions() as db:
            stored = await db.scalar(select(User.password_hash).where(User.id == user_id))
        assert stored is not None and verify_password(OLD_PASSWORD, stored)

    _run(scratch_database_url, check)


def test_login_checked_against_the_old_password_starts_no_session_after_a_reset(
    scratch_database_url: str,
) -> None:
    # The login verified the old password before the reset committed, then waits on the user row
    # the reset holds. Once the reset commits, the login must refuse: a session started then would
    # outlive the reset that was meant to end them all.
    async def check(sessions, limiter, user_id) -> None:
        async with sessions() as db:
            await _request(db, limiter)
        token = await _token(sessions)

        async def confirm(db: AsyncSession) -> None:
            await service.confirm_password_reset(
                db, limiter, token=token, new_password=FIRST, ip=None
            )

        held = await _held(sessions, confirm)

        async def login() -> str:
            async with sessions() as db:
                try:
                    await service.login(
                        db, limiter, email=EMAIL, password=OLD_PASSWORD, user_agent=None, ip=None
                    )
                except service.InvalidCredentials:
                    return "invalid_credentials"
                return "logged_in"

        task = asyncio.create_task(login())
        await _wait_for_a_lock(sessions)
        await held.commit()
        await held.close()
        assert await asyncio.wait_for(task, timeout=10) == "invalid_credentials"

        async with sessions() as db:
            live = await db.scalar(
                select(func.count()).where(
                    AuthSession.user_id == user_id, AuthSession.revoked_at.is_(None)
                )
            )
        assert live == 0

    _run(scratch_database_url, check)


def test_login_that_started_its_session_first_is_revoked_by_the_reset(
    scratch_database_url: str,
) -> None:
    # The other order: the login holds the user row with its new session uncommitted; the reset
    # waits, then revokes that session too.
    async def check(sessions, limiter, user_id) -> None:
        async with sessions() as db:
            await _request(db, limiter)
        token = await _token(sessions)

        async def login(db: AsyncSession) -> None:
            await service.login(
                db, limiter, email=EMAIL, password=OLD_PASSWORD, user_agent=None, ip=None
            )

        held = await _held(sessions, login)

        async def confirm() -> None:
            async with sessions() as db:
                await service.confirm_password_reset(
                    db, limiter, token=token, new_password=FIRST, ip=None
                )

        task = asyncio.create_task(confirm())
        await _wait_for_a_lock(sessions)
        await held.commit()
        await held.close()
        await asyncio.wait_for(task, timeout=10)

        async with sessions() as db:
            counts = (
                await db.execute(
                    select(func.count(), func.count(AuthSession.revoked_at)).where(
                        AuthSession.user_id == user_id
                    )
                )
            ).one()
        assert tuple(counts) == (1, 1)

    _run(scratch_database_url, check)
