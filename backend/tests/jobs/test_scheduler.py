"""The scheduler in the worker (P3-01b criteria 9 and 18)."""

import asyncio
import logging
from datetime import datetime, timedelta, timezone
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs import worker as worker_module
from app.jobs.models import Job, JobStatus
from app.jobs.service import enqueue
from app.jobs.worker import RECURRING_KINDS, SCHEDULE_INTERVAL, Worker
from tests.conftest import FrozenClock
from tests.jobs.conftest import Calls, Sessions

pytestmark = pytest.mark.anyio

KINDS = ("jobs.cleanup", "rate_limits.cleanup", "sessions.cleanup", "files.cleanup")


async def scheduled(sessions: Sessions) -> list[tuple[str, str | None, JobStatus]]:
    async with sessions() as db:
        rows = await db.execute(
            select(Job.kind, Job.dedupe_key, Job.status).order_by(Job.dedupe_key)
        )
        return [(kind, key, status) for kind, key, status in rows]


def queued(*days: str) -> list[tuple[str, str, JobStatus]]:
    rows = [(kind, f"{kind}:{day}", JobStatus.QUEUED) for kind in KINDS for day in days]
    return sorted(rows, key=lambda row: row[1])


def test_the_recurring_kinds_are_the_four_cleanups_every_60_seconds():
    assert RECURRING_KINDS == KINDS
    assert SCHEDULE_INTERVAL == 60.0


# Criterion 9


async def test_scheduling_twice_on_one_day_keeps_one_job_per_kind_and_the_next_day_adds_one(
    sessions, frozen_clock: FrozenClock
):
    first = Worker(sessions, worker_id="worker-a")
    assert sorted(await first.schedule()) == sorted(KINDS)

    # A restart: another Worker instance, later the same UTC day.
    frozen_clock.advance(hours=11, minutes=59, seconds=59)  # 2026-01-15 23:59:59 UTC
    second = Worker(sessions, worker_id="worker-b")
    assert await second.schedule() == []
    assert await scheduled(sessions) == queued("2026-01-15")

    frozen_clock.advance(seconds=1)  # 2026-01-16 00:00:00 UTC
    assert sorted(await second.schedule()) == sorted(KINDS)
    third = Worker(sessions, worker_id="worker-c")
    assert await third.schedule() == []
    frozen_clock.advance(hours=23)
    assert await third.schedule() == []

    assert await scheduled(sessions) == queued("2026-01-15", "2026-01-16")


async def test_the_dedupe_key_uses_the_utc_date(sessions, frozen_clock: FrozenClock):
    # 20:00 at UTC-5 on the 15th is 01:00 UTC on the 16th.
    frozen_clock.at = datetime(2026, 1, 15, 20, 0, tzinfo=timezone(timedelta(hours=-5)))

    await Worker(sessions).schedule()

    assert await scheduled(sessions) == queued("2026-01-16")


async def test_a_scheduled_job_is_due_at_once(sessions, frozen_clock: FrozenClock):
    await Worker(sessions).schedule()

    async with sessions() as db:
        jobs = (await db.scalars(select(Job))).all()
    assert [(job.run_at, job.attempts, job.payload) for job in jobs] == [
        (frozen_clock.at, 0, {})
    ] * len(KINDS)


async def test_two_schedulers_at_the_same_moment_leave_one_job_per_kind(
    committed_sessions, frozen_clock: FrozenClock
):
    """Two workers on separate connections: B's insert runs while A's rows are uncommitted."""
    a_inserted = asyncio.Event()
    release = asyncio.Event()

    def held_commits() -> AsyncSession:
        session: AsyncSession = committed_sessions()
        commit = session.commit

        async def held_commit() -> None:
            a_inserted.set()
            await release.wait()
            await commit()

        session.commit = held_commit  # type: ignore[method-assign]
        return session

    a = asyncio.create_task(Worker(held_commits, worker_id="worker-a").schedule())
    await asyncio.wait_for(a_inserted.wait(), timeout=5)
    b = asyncio.create_task(Worker(committed_sessions, worker_id="worker-b").schedule())
    await asyncio.sleep(0.2)
    assert not b.done(), "B waits on A's uncommitted keys instead of inserting its own"
    release.set()

    added = await asyncio.wait_for(asyncio.gather(a, b), timeout=5)

    assert sorted(added[0]) == sorted(KINDS)
    assert added[1] == []
    assert await scheduled(committed_sessions) == queued("2026-01-15")


# Criterion 18


async def test_run_forever_schedules_before_the_first_claim_and_runs_the_job(
    sessions, handlers: Calls, frozen_clock: FrozenClock
):
    stop = asyncio.Event()
    order: list[str] = []
    schedule = Worker.schedule

    async def recording_schedule(self: Worker) -> list[str]:
        order.append("schedule")
        return await schedule(self)

    original_claim = Worker._claim

    async def recording_claim(self: Worker) -> Any:
        order.append("claim")
        return await original_claim(self)

    w = Worker(sessions, worker_id="worker-a", recurring=("test.echo",))
    w.schedule = recording_schedule.__get__(w)  # type: ignore[method-assign]
    w._claim = recording_claim.__get__(w)  # type: ignore[method-assign]

    task = asyncio.create_task(w.run_forever(stop, idle_sleep=0.01))
    for _ in range(100):
        if handlers.of("test.echo"):
            break
        await asyncio.sleep(0.01)
    stop.set()
    await asyncio.wait_for(task, timeout=5)

    assert order[0] == "schedule"
    assert len(handlers.of("test.echo")) == 1
    async with sessions() as db:
        job = (await db.scalars(select(Job))).one()
    assert (job.dedupe_key, job.status) == ("test.echo:2026-01-15", JobStatus.SUCCEEDED)


async def test_the_scheduler_runs_again_every_interval(
    committed_sessions, handlers: Calls, frozen_clock: FrozenClock
):
    """Real connections: the scheduler's timer and the job loop run at once, as in production."""
    sessions = committed_sessions
    stop = asyncio.Event()
    w = Worker(sessions, worker_id="worker-a", recurring=("test.echo",), schedule_interval=0.05)

    task = asyncio.create_task(w.run_forever(stop, idle_sleep=0.01))
    await asyncio.sleep(0.1)
    frozen_clock.advance(days=1)
    for _ in range(100):
        if len(handlers.of("test.echo")) == 2:
            break
        await asyncio.sleep(0.01)
    stop.set()
    await asyncio.wait_for(task, timeout=5)

    assert [key for _, key, _ in await scheduled(sessions)] == [
        "test.echo:2026-01-15",
        "test.echo:2026-01-16",
    ]


async def test_a_scheduler_error_is_logged_by_type_and_the_worker_goes_on(
    committed_sessions, handlers: Calls, frozen_clock: FrozenClock, caplog, monkeypatch
):
    sessions = committed_sessions
    caplog.set_level(logging.INFO, logger="app.jobs.worker")
    calls = {"n": 0}

    async def failing_once(db: AsyncSession, kind: str, payload: dict[str, Any], **kw: Any):
        calls["n"] += 1
        if calls["n"] == 1:
            raise RuntimeError("scheduler secret-ish message")
        return await enqueue(db, kind, payload, **kw)

    monkeypatch.setattr(worker_module, "enqueue", failing_once)
    async with sessions() as db:
        await enqueue(db, "test.echo", {"queued": "before"})
        await db.commit()
    stop = asyncio.Event()
    w = Worker(sessions, worker_id="worker-a", recurring=("test.secret",), schedule_interval=0.05)

    task = asyncio.create_task(w.run_forever(stop, idle_sleep=0.01))
    for _ in range(200):
        if handlers.of("test.echo") and handlers.of("test.secret"):
            break
        await asyncio.sleep(0.01)
    stop.set()
    await asyncio.wait_for(task, timeout=5)

    errors = [r for r in caplog.records if r.getMessage() == "scheduler_error"]
    assert len(errors) == 1
    assert errors[0].levelno == logging.ERROR
    assert errors[0].error_type == "RuntimeError"
    assert not any("secret-ish" in str(vars(r)) for r in caplog.records)
    assert len(handlers.of("test.echo")) == 1, "the job loop kept running"
    assert len(handlers.of("test.secret")) == 1, "the next tick scheduled it"


async def test_a_worker_without_recurring_kinds_schedules_nothing(sessions, frozen_clock):
    assert await Worker(sessions, recurring=()).schedule() == []
    assert await scheduled(sessions) == []
