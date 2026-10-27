"""Run an action while another transaction holds a lock it needs, and change the world meanwhile.

The CLAUDE.md lesson "don't write from a value read before a slow `await`" as a one-line test
(WF-02): a value the action read before a lock wait (an expiry, a status) must be checked again
after it. The helper proves the action really waited on *the holder's* lock, so a test can't pass
because the action never waited.
"""

import asyncio
from collections.abc import Awaitable, Callable

from sqlalchemy import Integer, bindparam, text
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker

NEVER_BLOCKED = "the action was never blocked by the holder's lock"

# Another backend of this database waiting on the holder. `pg_stat_activity` is read in a session
# of its own per poll: inside one transaction its rows are a snapshot that never changes.
_BLOCKED_BY_HOLDER = text(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity"
    " WHERE datname = current_database() AND :holder = ANY(pg_blocking_pids(pid)))"
).bindparams(bindparam("holder", type_=Integer))

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

    `act` must use its own session. `change` cannot update a row `act` already locked (that would
    deadlock): change rows the holder owns, or wait on the database clock (`SELECT pg_sleep(…)`)
    for a deadline to pass. Raises `AssertionError(NEVER_BLOCKED)` if `act` finishes, or `timeout`
    passes, without the holder ever blocking it; an error `act` raised is its `__cause__`.
    """
    async with sessions() as holder:
        pid = await holder.scalar(text("SELECT pg_backend_pid()"))

        async def run() -> T:
            return await act()

        task: asyncio.Task[T] | None = None
        try:
            await hold(holder)
            task = asyncio.create_task(run())
            await _wait_until_blocked(
                sessions, pid, task, asyncio.get_running_loop().time() + timeout
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
    deadline: float,
) -> None:
    loop = asyncio.get_running_loop()
    while True:
        if task.done():
            error = None if task.cancelled() else task.exception()
            raise AssertionError(NEVER_BLOCKED) from error
        async with sessions() as probe:
            if await probe.scalar(_BLOCKED_BY_HOLDER, {"holder": pid}):
                return
        if loop.time() >= deadline:
            raise AssertionError(NEVER_BLOCKED)
        # Wakes early when the action finishes; the next turn then reports it.
        await asyncio.wait([task], timeout=_POLL_SECONDS)
