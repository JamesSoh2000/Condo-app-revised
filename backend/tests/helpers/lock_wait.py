"""Run an action while another transaction holds a lock it needs, and change the world meanwhile.

The CLAUDE.md lesson "don't write from a value read before a slow `await`" as a one-line test
(WF-02): a value the action read before a lock wait (an expiry, a status) must be checked again
after it. The helper proves the action really waited on *the holder's* lock, so a test can't pass
because the action never waited.
"""

import asyncio
from collections.abc import Awaitable, Callable, Coroutine
from contextvars import ContextVar
from typing import Any

from sqlalchemy import Integer, bindparam, event, text
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

NEVER_BLOCKED = "the action was never blocked by the holder's lock"

# One of the action's own backends waiting on the holder: another session waiting on the holder
# proves nothing about the action (review round 1, Codex). Read in a session of its own per poll.
_BLOCKED_BY_HOLDER = text(
    "SELECT EXISTS (SELECT 1 FROM unnest(:pids) AS waiting(pid)"
    " WHERE :holder = ANY(pg_blocking_pids(waiting.pid)))"
).bindparams(bindparam("holder", type_=Integer), bindparam("pids", type_=ARRAY(Integer)))

# True inside the action's task and the tasks it starts (they copy its context), so the pool's
# checkout hook can tell the action's connections from everyone else's.
_IN_ACTION: ContextVar[bool] = ContextVar("in_action", default=False)

_POLL_SECONDS = 0.01


async def act_blocked_on_lock[T](
    sessions: async_sessionmaker[AsyncSession],
    *,
    hold: Callable[[AsyncSession], Awaitable[None]],
    act: Callable[[], Awaitable[T]],
    change: Callable[[AsyncSession], Awaitable[None]],
    # The ticket's interface (WF-02): it bounds two separate waits, so `asyncio.timeout` can't.
    timeout: float = 5.0,  # noqa: ASYNC109
) -> T:
    """Take a lock with `hold`, start `act`, wait until the holder blocks it, run `change` in the
    holder's transaction, commit the holder, and return `act`'s result (or raise its error).

    `act` must open its own sessions from `sessions`: only their connections count as the action's
    (a checkout inside its task, or a task it starts). `change` cannot update a row `act` already
    locked (that would deadlock): change rows the holder owns, or wait on the database clock
    (`SELECT pg_sleep(…)`) for a deadline to pass. Raises `AssertionError(NEVER_BLOCKED)` if `act`
    finishes, or `timeout` passes, without the holder ever blocking it; an error `act` raised is
    its `__cause__`.
    """
    engine = sessions.kw["bind"]
    assert isinstance(engine, AsyncEngine), "act_blocked_on_lock needs sessions bound to an engine"
    # The backends the action holds now: added at checkout in its context, removed at checkin.
    acting: dict[int, int] = {}

    def checkout(dbapi_connection: Any, record: Any, _proxy: Any) -> None:
        if _IN_ACTION.get():
            acting[id(record)] = dbapi_connection.driver_connection.get_server_pid()

    def checkin(_dbapi_connection: Any, record: Any) -> None:
        acting.pop(id(record), None)

    async def run() -> T:
        _IN_ACTION.set(True)
        return await act()

    event.listen(engine.sync_engine, "checkout", checkout)
    event.listen(engine.sync_engine, "checkin", checkin)
    try:
        return await _act_while_held(sessions, hold, run, change, timeout, acting)
    finally:
        event.remove(engine.sync_engine, "checkout", checkout)
        event.remove(engine.sync_engine, "checkin", checkin)


async def _act_while_held[T](
    sessions: async_sessionmaker[AsyncSession],
    hold: Callable[[AsyncSession], Awaitable[None]],
    run: Callable[[], Coroutine[Any, Any, T]],
    change: Callable[[AsyncSession], Awaitable[None]],
    timeout: float,  # noqa: ASYNC109 (bounds two separate waits, as above)
    acting: dict[int, int],
) -> T:
    async with sessions() as holder:
        pid = await holder.scalar(text("SELECT pg_backend_pid()"))
        task: asyncio.Task[T] | None = None
        try:
            await hold(holder)
            task = asyncio.create_task(run())
            await _wait_until_blocked(
                sessions, pid, task, acting, asyncio.get_running_loop().time() + timeout
            )
            await change(holder)
            await holder.commit()
            return await asyncio.wait_for(task, timeout)
        finally:
            # Unblock first, then stop the action: a task left waiting, or a holder transaction left
            # open, would hang the test or the engine's disposal.
            try:
                await holder.rollback()
            finally:
                if task is not None:
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)


async def _wait_until_blocked(
    sessions: async_sessionmaker[AsyncSession],
    pid: int,
    task: asyncio.Task[object],
    acting: dict[int, int],
    deadline: float,
) -> None:
    loop = asyncio.get_running_loop()
    while True:
        if task.done():
            error = None if task.cancelled() else task.exception()
            raise AssertionError(NEVER_BLOCKED) from error
        pids = list(acting.values())
        if pids:
            async with sessions() as probe:
                if await probe.scalar(_BLOCKED_BY_HOLDER, {"holder": pid, "pids": pids}):
                    return
        if loop.time() >= deadline:
            raise AssertionError(NEVER_BLOCKED)
        # Wakes early when the action finishes; the next turn then reports it.
        await asyncio.wait([task], timeout=_POLL_SECONDS)
