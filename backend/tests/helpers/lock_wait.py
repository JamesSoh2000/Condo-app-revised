"""Run an action while another transaction holds a lock it needs, and change the world meanwhile.

The CLAUDE.md lesson "don't write from a value read before a slow `await`" as a one-line test
(WF-02, redesigned in WF-02b): a value the action read before a lock wait (an expiry, a status)
must be checked again after it. The helper proves the action really waited on *the holder's* lock,
so a test can't pass because the action never waited.

The action runs in a session the helper opens and passes in. Its connection is detached from the
pool, so the backend it names is the action's alone for the whole call: nothing infers ownership
from pool events (PR #142's three review rounds each found a race in that inference).
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import datetime

from sqlalchemy import BigInteger, DateTime, Integer, bindparam, text
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker

NEVER_BLOCKED = "the action was never blocked by the holder's lock"

# A backend by pid and start time, so a backend that ended can't be taken for a later one that got
# its pid.
type _Backend = tuple[int, datetime]

_THIS_BACKEND = text("SELECT pid, backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()")

# The action's backend waiting on the holder's: another session waiting on the holder proves
# nothing about the action. Read in a session of its own per poll.
_BLOCKED_BY_HOLDER = text(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity AS waiting"
    " JOIN pg_stat_activity AS holding ON holding.pid = ANY(pg_blocking_pids(waiting.pid))"
    " WHERE waiting.pid = :action_pid AND waiting.backend_start = :action_start"
    " AND holding.pid = :holder_pid AND holding.backend_start = :holder_start)"
).bindparams(
    bindparam("action_pid", type_=Integer),
    bindparam("action_start", type_=DateTime(timezone=True)),
    bindparam("holder_pid", type_=Integer),
    bindparam("holder_start", type_=DateTime(timezone=True)),
)

_END_SECONDS = 5
_TERMINATE = text(
    "SELECT pg_terminate_backend(pid, :timeout_ms) FROM pg_stat_activity"
    " WHERE pid = :pid AND backend_start = :started"
).bindparams(
    bindparam("pid", type_=Integer),
    bindparam("started", type_=DateTime(timezone=True)),
    bindparam("timeout_ms", value=_END_SECONDS * 1000, type_=BigInteger),
)

_POLL_SECONDS = 0.01


async def act_blocked_on_lock[T](
    sessions: async_sessionmaker[AsyncSession],
    *,
    hold: Callable[[AsyncSession], Awaitable[None]],
    act: Callable[[AsyncSession], Awaitable[T]],
    change: Callable[[AsyncSession], Awaitable[None]],
    # The ticket's interface (WF-02): it bounds two separate waits, so `asyncio.timeout` can't.
    timeout: float = 5.0,  # noqa: ASYNC109
) -> T:
    """Take a lock with `hold`, start `act`, wait until the holder blocks it, run `change` in the
    holder's transaction, commit the holder, and return `act`'s result (or raise its error).

    `act` gets the action's session and must run its statements there: a session it opens itself
    is not the action's, and its wait is not seen (the call then fails). It may commit any number
    of times. `change` cannot update a row `act` already locked (that would deadlock): change rows
    the holder owns, or wait on the database clock (`SELECT pg_sleep(…)`) for a deadline to pass.
    Raises `AssertionError(NEVER_BLOCKED)` if `act` finishes, or `timeout` passes, without the
    holder ever blocking it; an error `act` raised is its `__cause__`.
    """
    engine = sessions.kw["bind"]
    assert isinstance(engine, AsyncEngine), "act_blocked_on_lock needs sessions bound to an engine"
    async with (
        _detached(sessions, engine) as (holder, holding),
        _detached(sessions, engine) as (acting, action),
    ):
        task: asyncio.Task[T] | None = None
        try:
            await hold(holder)
            task = asyncio.create_task(_call(act, acting))
            deadline = asyncio.get_running_loop().time() + timeout
            await _wait_until_blocked(sessions, holding, action, task, deadline)
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


@asynccontextmanager
async def _detached(
    sessions: async_sessionmaker[AsyncSession], engine: AsyncEngine
) -> AsyncIterator[tuple[AsyncSession, _Backend]]:
    """A session bound to a connection of its own, and that connection's backend. Detached from
    the pool, the connection is closed at the end instead of going back to it, so no other session
    can ever run on this backend."""
    backend: _Backend | None = None
    try:
        async with engine.connect() as connection:
            assert connection.sync_connection is not None
            connection.sync_connection.detach()
            async with sessions(bind=connection) as session:
                pid, started = (await session.execute(_THIS_BACKEND)).one()
                await session.commit()
                backend = (pid, started)
                yield session, backend
    finally:
        if backend is not None:
            await _end(sessions, backend)


async def _end(sessions: async_sessionmaker[AsyncSession], backend: _Backend) -> None:
    """End the backend if closing its connection didn't. A statement cancelled mid-flight (the
    action's task, stopped by the `finally` above) invalidates the connection, and a detached one is
    then dropped without being closed: its backend stayed idle in transaction, holding the action's
    locks. `pg_terminate_backend` with a timeout waits for the backend to exit."""
    async with sessions() as db:
        ended = await db.scalars(_TERMINATE, {"pid": backend[0], "started": backend[1]})
        assert all(ended), f"backend {backend[0]} did not end within {_END_SECONDS} s"


async def _call[T](act: Callable[[AsyncSession], Awaitable[T]], session: AsyncSession) -> T:
    return await act(session)


async def _wait_until_blocked(
    sessions: async_sessionmaker[AsyncSession],
    holding: _Backend,
    action: _Backend,
    task: asyncio.Task[object],
    deadline: float,
) -> None:
    params = {
        "holder_pid": holding[0],
        "holder_start": holding[1],
        "action_pid": action[0],
        "action_start": action[1],
    }
    loop = asyncio.get_running_loop()
    while True:
        if task.done():
            error = None if task.cancelled() else task.exception()
            raise AssertionError(NEVER_BLOCKED) from error
        async with sessions() as probe:
            if await probe.scalar(_BLOCKED_BY_HOLDER, params):
                return
        if loop.time() >= deadline:
            raise AssertionError(NEVER_BLOCKED)
        # Wakes early when the action finishes; the next turn then reports it.
        await asyncio.wait([task], timeout=_POLL_SECONDS)
