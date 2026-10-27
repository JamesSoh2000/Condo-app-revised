"""`act_blocked_on_lock` (WF-02 criteria 5 and 6), on a scratch database of its own.

A plain table, not the app's schema: the helper needs only a row to lock. Each test runs the
helper with real connections, as `tests/notices/test_concurrency.py` does.
"""

import asyncio
from collections.abc import Awaitable, Callable

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.errors import DomainError
from tests.helpers.lock_wait import NEVER_BLOCKED, act_blocked_on_lock

type Sessions = async_sessionmaker[AsyncSession]


def _run(url: str, body: Callable[[Sessions], Awaitable[None]]) -> None:
    async def check() -> None:
        engine = create_async_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                await db.execute(
                    text("CREATE TABLE things (id int PRIMARY KEY, value int NOT NULL)")
                )
                await db.execute(text("INSERT INTO things VALUES (1, 0), (2, 0)"))
                await db.commit()
            await body(sessions)
            # Nothing the helper started is still running.
            assert asyncio.all_tasks() == {asyncio.current_task()}
        finally:
            await engine.dispose()

    asyncio.run(check())


def _hold(row: int) -> Callable[[AsyncSession], Awaitable[None]]:
    async def hold(db: AsyncSession) -> None:
        await db.execute(text("SELECT 1 FROM things WHERE id = :id FOR UPDATE"), {"id": row})

    return hold


async def _nothing(_db: AsyncSession) -> None:
    return None


def _increment(sessions: Sessions, row: int) -> Callable[[], Awaitable[int]]:
    """The action: add one to the row's value in a session of its own, and return the new value."""

    async def act() -> int:
        async with sessions() as db:
            value = await db.scalar(
                text("UPDATE things SET value = value + 1 WHERE id = :id RETURNING value"),
                {"id": row},
            )
            await db.commit()
            assert value is not None
            return int(value)

    return act


async def _value(sessions: Sessions, row: int) -> int:
    async with sessions() as db:
        await db.execute(text("SET LOCAL lock_timeout = '1s'"))
        # A row update, so a lock left behind by the helper fails here instead of passing.
        value = await db.scalar(
            text("UPDATE things SET value = value WHERE id = :id RETURNING value"), {"id": row}
        )
        await db.commit()
        return int(value)


class _Refused(DomainError):
    def __init__(self) -> None:
        super().__init__("thing_refused", 409, "Refused")


def test_the_action_sees_the_change_made_while_it_waited(scratch_database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        changed: list[str] = []

        async def change(db: AsyncSession) -> None:
            await db.execute(text("UPDATE things SET value = 10 WHERE id = 1"))
            changed.append("changed")

        result = await act_blocked_on_lock(
            sessions, hold=_hold(1), act=_increment(sessions, 1), change=change
        )

        assert changed == ["changed"]
        assert result == 11  # the action's UPDATE ran on the holder's committed 10
        assert await _value(sessions, 1) == 11

    _run(scratch_database_url, body)


def test_an_action_on_another_row_is_never_blocked(scratch_database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        changed: list[str] = []

        async def change(_db: AsyncSession) -> None:
            changed.append("changed")

        with pytest.raises(AssertionError, match=NEVER_BLOCKED) as raised:
            await act_blocked_on_lock(
                sessions, hold=_hold(1), act=_increment(sessions, 2), change=change
            )

        assert raised.value.__cause__ is None
        assert changed == []

    _run(scratch_database_url, body)


def test_a_holder_that_takes_no_lock_blocks_nothing(scratch_database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        with pytest.raises(AssertionError, match=NEVER_BLOCKED):
            await act_blocked_on_lock(
                sessions, hold=_nothing, act=_increment(sessions, 1), change=_nothing
            )

    _run(scratch_database_url, body)


def test_an_action_blocked_by_a_third_session_is_not_blocked_by_the_holder(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions) -> None:
        changed: list[str] = []

        async def change(_db: AsyncSession) -> None:
            changed.append("changed")

        async with sessions() as third:
            await _hold(1)(third)
            try:
                with pytest.raises(AssertionError, match=NEVER_BLOCKED):
                    await act_blocked_on_lock(
                        sessions,
                        hold=_hold(2),
                        act=_increment(sessions, 1),
                        change=change,
                        timeout=1.0,
                    )
            finally:
                await third.rollback()

        assert changed == []
        # The cancelled action never wrote.
        assert await _value(sessions, 1) == 0

    _run(scratch_database_url, body)


def test_a_domain_error_raised_after_the_wait_propagates_unchanged(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions) -> None:
        refused = _Refused()
        increment = _increment(sessions, 1)

        async def act() -> int:
            await increment()
            raise refused

        with pytest.raises(_Refused) as raised:
            await act_blocked_on_lock(sessions, hold=_hold(1), act=act, change=_nothing)

        assert raised.value is refused

    _run(scratch_database_url, body)


def test_an_error_raised_before_any_wait_is_the_cause_of_the_assertion(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions) -> None:
        refused = _Refused()

        async def act() -> int:
            raise refused

        with pytest.raises(AssertionError, match=NEVER_BLOCKED) as raised:
            await act_blocked_on_lock(sessions, hold=_hold(1), act=act, change=_nothing)

        assert raised.value.__cause__ is refused

    _run(scratch_database_url, body)


def test_a_failing_change_is_raised_and_leaves_no_lock_or_task(scratch_database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        async def change(_db: AsyncSession) -> None:
            raise RuntimeError("change failed")

        with pytest.raises(RuntimeError, match="change failed"):
            await asyncio.wait_for(
                act_blocked_on_lock(
                    sessions, hold=_hold(1), act=_increment(sessions, 1), change=change
                ),
                timeout=10,
            )

        # The holder was rolled back: the row can be locked again (`_value` fails after 1 s if not).
        assert await _value(sessions, 1) in (0, 1)

    _run(scratch_database_url, body)
