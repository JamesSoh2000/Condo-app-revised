"""`act_blocked_on_lock` (WF-02 criteria 5 and 6, as WF-02b redesigned it), on a scratch database.

A plain table, not the app's schema: the helper needs only a row to lock. Each test runs the
helper with real connections, as `tests/notices/test_concurrency.py` does. The cases marked R1, R2
and R3 are the ways PR #142's pool-event version credited the action with another session's wait.
"""

import asyncio
from collections.abc import Awaitable, Callable
from typing import Any

import pytest
from sqlalchemy import text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core.errors import DomainError
from tests.helpers import lock_wait
from tests.helpers.lock_wait import NEVER_BLOCKED, act_blocked_on_lock

type Sessions = async_sessionmaker[AsyncSession]

_ANY_WAITER = text(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE :holder = ANY(pg_blocking_pids(pid)))"
)


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


async def _add_one(db: AsyncSession, row: int) -> int:
    value = await db.scalar(
        text("UPDATE things SET value = value + 1 WHERE id = :id RETURNING value"), {"id": row}
    )
    await db.commit()
    assert value is not None
    return int(value)


def _increment(row: int) -> Callable[[AsyncSession], Awaitable[int]]:
    """The action: add one to the row's value in the session it is given, and return it."""

    async def act(db: AsyncSession) -> int:
        return await _add_one(db, row)

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


async def _backends(sessions: Sessions) -> int:
    async with sessions() as db:
        count = await db.scalar(
            text("SELECT count(*) FROM pg_stat_activity WHERE datname = current_database()")
        )
        return int(count)


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
            sessions, hold=_hold(1), act=_increment(1), change=change
        )

        assert changed == ["changed"]
        assert result == 11  # the action's UPDATE ran on the holder's committed 10
        assert await _value(sessions, 1) == 11

    _run(scratch_database_url, body)


def test_an_action_that_commits_before_it_waits_is_still_seen(scratch_database_url: str) -> None:
    # The action's session keeps its connection across a commit, so its later wait is attributed.
    async def body(sessions: Sessions) -> None:
        async def act(db: AsyncSession) -> tuple[int, int]:
            first = await _add_one(db, 2)
            return first, await _add_one(db, 1)

        assert await act_blocked_on_lock(sessions, hold=_hold(1), act=act, change=_nothing) == (
            1,
            1,
        )

    _run(scratch_database_url, body)


def test_the_helper_leaves_no_connection_open(scratch_database_url: str) -> None:
    # Its two connections are detached from the pool, so they must be closed, not returned.
    async def body(sessions: Sessions) -> None:
        before = await _backends(sessions)

        await act_blocked_on_lock(sessions, hold=_hold(1), act=_increment(1), change=_nothing)

        assert await _backends(sessions) == before

    _run(scratch_database_url, body)


def test_an_action_on_another_row_is_never_blocked(scratch_database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        changed: list[str] = []

        async def change(_db: AsyncSession) -> None:
            changed.append("changed")

        with pytest.raises(AssertionError, match=NEVER_BLOCKED) as raised:
            await act_blocked_on_lock(sessions, hold=_hold(1), act=_increment(2), change=change)

        assert raised.value.__cause__ is None
        assert changed == []

    _run(scratch_database_url, body)


def test_a_holder_that_takes_no_lock_blocks_nothing(scratch_database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        with pytest.raises(AssertionError, match=NEVER_BLOCKED):
            await act_blocked_on_lock(sessions, hold=_nothing, act=_increment(1), change=_nothing)

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
                        sessions, hold=_hold(2), act=_increment(1), change=change, timeout=1.0
                    )
            finally:
                await third.rollback()

        assert changed == []
        # The cancelled action never wrote.
        assert await _value(sessions, 1) == 0

    _run(scratch_database_url, body)


def test_an_action_that_waits_in_a_session_of_its_own_is_not_seen(
    scratch_database_url: str,
) -> None:
    # The documented limit: only statements on the session the helper passes in are the action's.
    async def body(sessions: Sessions) -> None:
        async def act(_db: AsyncSession) -> int:
            async with sessions() as own:
                return await _add_one(own, 1)

        with pytest.raises(AssertionError, match=NEVER_BLOCKED):
            await act_blocked_on_lock(
                sessions, hold=_hold(1), act=act, change=_nothing, timeout=1.0
            )

        assert await _value(sessions, 1) in (0, 1)

    _run(scratch_database_url, body)


def test_a_domain_error_raised_after_the_wait_propagates_unchanged(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions) -> None:
        refused = _Refused()

        async def act(db: AsyncSession) -> int:
            await _add_one(db, 1)
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

        async def act(_db: AsyncSession) -> int:
            raise refused

        with pytest.raises(AssertionError, match=NEVER_BLOCKED) as raised:
            await act_blocked_on_lock(sessions, hold=_hold(1), act=act, change=_nothing)

        assert raised.value.__cause__ is refused

    _run(scratch_database_url, body)


def test_a_failing_change_is_raised_and_leaves_no_lock_task_or_connection(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions) -> None:
        before = await _backends(sessions)

        async def change(_db: AsyncSession) -> None:
            raise RuntimeError("change failed")

        with pytest.raises(RuntimeError, match="change failed"):
            await asyncio.wait_for(
                act_blocked_on_lock(sessions, hold=_hold(1), act=_increment(1), change=change),
                timeout=10,
            )

        # The holder was rolled back: the row can be locked again (`_value` fails after 1 s if not).
        assert await _value(sessions, 1) in (0, 1)
        assert await _backends(sessions) == before

    _run(scratch_database_url, body)


def test_an_unrelated_session_waiting_on_the_holder_does_not_count_as_the_action(
    scratch_database_url: str,
) -> None:
    # R1 (PR #142, Codex, High): any backend blocked by the holder passed, so an action that never
    # waited was accepted while another session waited on the holder.
    async def body(sessions: Sessions) -> None:
        unrelated: asyncio.Future[int] | None = None
        changed = asyncio.Event()

        async def hold(db: AsyncSession) -> None:
            nonlocal unrelated
            await _hold(1)(db)
            unrelated = asyncio.ensure_future(_in_own_session(sessions, 1))

        async def act(_db: AsyncSession) -> str:
            await changed.wait()  # no statement of the action ever waits on the holder
            return "never blocked"

        async def change(_db: AsyncSession) -> None:
            changed.set()

        try:
            with pytest.raises(AssertionError, match=NEVER_BLOCKED):
                await act_blocked_on_lock(sessions, hold=hold, act=act, change=change, timeout=1.0)
        finally:
            assert unrelated is not None
            await asyncio.gather(unrelated, return_exceptions=True)

    _run(scratch_database_url, body)


def test_an_action_blocked_by_a_third_session_fails_even_while_another_waits_on_the_holder(
    scratch_database_url: str,
) -> None:
    async def body(sessions: Sessions) -> None:
        unrelated: asyncio.Future[int] | None = None
        changed: list[str] = []

        async def hold(db: AsyncSession) -> None:
            nonlocal unrelated
            await _hold(1)(db)
            unrelated = asyncio.ensure_future(_in_own_session(sessions, 1))

        async def change(_db: AsyncSession) -> None:
            changed.append("changed")

        async with sessions() as third:
            await _hold(2)(third)
            try:
                with pytest.raises(AssertionError, match=NEVER_BLOCKED):
                    await act_blocked_on_lock(
                        sessions, hold=hold, act=_increment(2), change=change, timeout=1.0
                    )
            finally:
                await third.rollback()
                assert unrelated is not None
                await asyncio.gather(unrelated, return_exceptions=True)

        assert changed == []

    _run(scratch_database_url, body)


def test_two_overlapping_calls_each_watch_only_their_own_action(scratch_database_url: str) -> None:
    # R2 (PR #142, Codex, High): a flag shared by overlapping calls let B's action, waiting on A's
    # holder, count as A's, and A passed with an action that ran no statement.
    async def body(sessions: Sessions) -> None:
        held_a = asyncio.Event()
        changed_a = asyncio.Event()

        async def hold_a(db: AsyncSession) -> None:
            await _hold(1)(db)
            held_a.set()

        async def hold_b(db: AsyncSession) -> None:
            await held_a.wait()
            await _hold(2)(db)

        async def act_a(_db: AsyncSession) -> str:
            await changed_a.wait()  # runs no statement
            return "never blocked"

        async def change_a(_db: AsyncSession) -> None:
            changed_a.set()

        results = await asyncio.gather(
            act_blocked_on_lock(sessions, hold=hold_a, act=act_a, change=change_a, timeout=1.0),
            act_blocked_on_lock(
                sessions, hold=hold_b, act=_increment(1), change=_nothing, timeout=1.0
            ),
            return_exceptions=True,
        )

        assert isinstance(results[0], AssertionError)
        assert str(results[0]) == NEVER_BLOCKED

    _run(scratch_database_url, body)


def test_two_overlapping_calls_whose_actions_both_wait_both_pass(scratch_database_url: str) -> None:
    async def body(sessions: Sessions) -> None:
        results = await asyncio.gather(
            act_blocked_on_lock(sessions, hold=_hold(1), act=_increment(1), change=_nothing),
            act_blocked_on_lock(sessions, hold=_hold(2), act=_increment(2), change=_nothing),
        )

        assert list(results) == [1, 1]

    _run(scratch_database_url, body)


def test_a_connection_the_action_gives_up_during_the_probe_does_not_count(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # R3 (PR #142, Codex, High), rebuilt for this design: the probe is held at its I/O point while
    # the action closes its connection and an unrelated session waits on the holder. The closed
    # backend ends instead of going back to the pool, so no other session can wait on it.
    async def body(sessions: Sessions) -> None:
        probing = asyncio.Event()
        given_up = asyncio.Event()
        changed = asyncio.Event()
        unrelated: asyncio.Future[int] | None = None
        holder_pid: list[int] = []
        gated: list[bool] = []
        real_scalar = AsyncSession.scalar

        async def gated_scalar(self: AsyncSession, statement: Any, *args: Any, **kw: Any) -> Any:
            if statement is lock_wait._BLOCKED_BY_HOLDER and not given_up.is_set():
                probing.set()
                await given_up.wait()
                # Run the real probe only once the unrelated session waits on the holder.
                async with asyncio.timeout(3):
                    while True:
                        if await real_scalar(self, _ANY_WAITER, {"holder": holder_pid[0]}):
                            break
                        await asyncio.sleep(0)
                gated.append(await real_scalar(self, statement, *args, **kw))
                return gated[-1]
            return await real_scalar(self, statement, *args, **kw)

        async def hold(db: AsyncSession) -> None:
            holder_pid.append(int(await real_scalar(db, text("SELECT pg_backend_pid()"))))
            await _hold(1)(db)

        async def act(db: AsyncSession) -> str:
            nonlocal unrelated
            await db.execute(text("SELECT 1"))
            await probing.wait()
            await (await db.connection()).close()
            unrelated = asyncio.ensure_future(_in_own_session(sessions, 1))
            given_up.set()
            await changed.wait()
            return "never blocked"

        async def change(_db: AsyncSession) -> None:
            changed.set()

        monkeypatch.setattr(AsyncSession, "scalar", gated_scalar)
        try:
            with pytest.raises(AssertionError, match=NEVER_BLOCKED) as raised:
                await act_blocked_on_lock(sessions, hold=hold, act=act, change=change, timeout=2.0)
        finally:
            monkeypatch.undo()
            if unrelated is not None:
                await asyncio.gather(unrelated, return_exceptions=True)

        # The interleaving happened: the held probe ran while another session waited on the holder,
        # and the action was still waiting (it didn't fail before the timeout).
        assert gated == [False]
        assert raised.value.__cause__ is None
        assert unrelated is not None and unrelated.result() == 1

    _run(scratch_database_url, body)


async def _in_own_session(sessions: Sessions, row: int) -> int:
    async with sessions() as db:
        return await _add_one(db, row)


def test_a_call_cancelled_while_it_identifies_its_backend_leaves_no_connection(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Round 1 (WF-02b, Codex, Medium): the connection was detached before its backend was read, so a
    # cancellation during that read left a detached backend that nothing ended.
    async def body(sessions: Sessions) -> None:
        before = await _backends(sessions)
        identifying = asyncio.Event()
        real_execute = AsyncSession.execute

        async def slow_identity(self: AsyncSession, statement: Any, *args: Any, **kw: Any) -> Any:
            if statement is lock_wait._THIS_BACKEND:
                identifying.set()
                await real_execute(self, text("SELECT pg_sleep(30)"))
            return await real_execute(self, statement, *args, **kw)

        monkeypatch.setattr(AsyncSession, "execute", slow_identity)
        call = asyncio.ensure_future(
            act_blocked_on_lock(sessions, hold=_hold(1), act=_increment(1), change=_nothing)
        )
        try:
            await identifying.wait()
            call.cancel()
            await asyncio.gather(call, return_exceptions=True)
        finally:
            monkeypatch.undo()

        assert call.cancelled()
        assert await _backends(sessions) == before

    _run(scratch_database_url, body)


def test_a_call_cancelled_while_it_waits_leaves_no_lock_task_or_connection(
    scratch_database_url: str,
) -> None:
    # The neighbour: an abandoned caller at the helper's longest await (the probe loop).
    async def body(sessions: Sessions) -> None:
        before = await _backends(sessions)
        polling = asyncio.Event()

        async def act(db: AsyncSession) -> int:
            value = await _add_one(db, 2)  # never blocked, and still running
            await db.execute(text("SELECT 1 FROM things WHERE id = 2 FOR UPDATE"))
            polling.set()
            await asyncio.Event().wait()
            return value

        call = asyncio.ensure_future(
            act_blocked_on_lock(sessions, hold=_hold(1), act=act, change=_nothing, timeout=30)
        )
        await polling.wait()
        assert not call.done()
        call.cancel()
        await asyncio.gather(call, return_exceptions=True)

        assert call.cancelled()
        # Neither the holder's lock on row 1 nor the action's open transaction on row 2 is left.
        assert (await _value(sessions, 1), await _value(sessions, 2)) == (0, 1)
        assert await _backends(sessions) == before

    _run(scratch_database_url, body)


def test_an_error_raised_during_the_last_probe_is_the_cause_of_the_assertion(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Round 1 (WF-02b, Codex, Medium): the deadline was checked after a probe without looking at
    # the action again, so an error it raised during that probe was lost.
    async def body(sessions: Sessions) -> None:
        refused = _Refused()
        probing = asyncio.Event()
        real_scalar = AsyncSession.scalar

        async def act(_db: AsyncSession) -> int:
            await probing.wait()
            raise refused

        async def slow_probe(self: AsyncSession, statement: Any, *args: Any, **kw: Any) -> Any:
            if statement is lock_wait._BLOCKED_BY_HOLDER:
                probing.set()
                await real_scalar(self, text("SELECT pg_sleep(0.05)"))
            return await real_scalar(self, statement, *args, **kw)

        monkeypatch.setattr(AsyncSession, "scalar", slow_probe)
        try:
            with pytest.raises(AssertionError, match=NEVER_BLOCKED) as raised:
                await act_blocked_on_lock(
                    sessions, hold=_hold(1), act=act, change=_nothing, timeout=0.01
                )
        finally:
            monkeypatch.undo()

        assert raised.value.__cause__ is refused

    _run(scratch_database_url, body)


@pytest.mark.parametrize("ending", ["action", "holder"])
def test_a_call_cancelled_while_it_ends_a_backend_still_ends_it(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch, ending: str
) -> None:
    # Review of the split diff (WF-02b, Codex, Medium): one cancellation during `_end`'s query,
    # after `change` failed, left the action's backend alive and holding its row lock. The action's
    # backend is ended first (its `_detached` is the inner one), then the holder's.
    async def body(sessions: Sessions) -> None:
        before = await _backends(sessions)
        terminating = asyncio.Event()
        released = asyncio.Event()
        seen = 0
        real_scalars = AsyncSession.scalars

        async def gated_scalars(self: AsyncSession, statement: Any, *args: Any, **kw: Any) -> Any:
            nonlocal seen
            if statement is lock_wait._TERMINATE:
                seen += 1
                if seen == ("action", "holder").index(ending) + 1:
                    # Held at the query's I/O point until the caller has been cancelled.
                    terminating.set()
                    await released.wait()
            return await real_scalars(self, statement, *args, **kw)

        async def change(_db: AsyncSession) -> None:
            raise RuntimeError("change failed")

        monkeypatch.setattr(AsyncSession, "scalars", gated_scalars)
        call = asyncio.ensure_future(
            act_blocked_on_lock(sessions, hold=_hold(1), act=_increment(1), change=change)
        )
        try:
            # Longer than the helper's own 5 s, so a broken helper fails here instead of racing it.
            await asyncio.wait_for(terminating.wait(), 30)
            call.cancel()
        finally:
            # Always let the held query go, or a failure above leaves the call waiting forever.
            released.set()
            await asyncio.gather(call, return_exceptions=True)
            monkeypatch.undo()

        assert call.cancelled()
        assert await _backends(sessions) == before
        # The row is no longer locked (`_value` would time out on the lock). The action may have
        # committed its increment after the holder's rollback, before its task was cancelled.
        assert await _value(sessions, 1) in (0, 1)

    _run(scratch_database_url, body)
