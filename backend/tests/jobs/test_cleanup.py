"""The recurring cleanup jobs (P3-01b criteria 19 to 23)."""

import secrets
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

# Imported first, so the handlers are registered before the `handlers` fixture copies the registry.
import app.auth.jobs
import app.files.jobs
import app.jobs.handlers
import app.rate_limits.jobs
from app.auth.models import AuthSession
from app.auth.service import SESSION_RETENTION, delete_ended_sessions
from app.core import clock
from app.jobs import registry
from app.jobs.models import Job, JobStatus
from app.jobs.registry import JobContext, job_handler
from app.jobs.service import (
    DEAD_RETENTION,
    SUCCEEDED_RETENTION,
    delete_old_succeeded_jobs,
    enqueue,
    scrub_dead_jobs,
)
from app.jobs.worker import HANDLER_MODULES, RECURRING_KINDS, Worker, load_handlers
from app.rate_limits.models import RateLimit
from app.rate_limits.service import window_start
from tests.conftest import FrozenClock
from tests.factories import make_user
from tests.jobs.conftest import Calls, Sessions

pytestmark = pytest.mark.anyio

LINK = "https://example.test/invite?token=dead-job-s3cr3t"


async def add_job(
    db: AsyncSession,
    status: JobStatus,
    *,
    kind: str = "test.echo",
    finished_ago: timedelta | None = None,
    payload: dict[str, Any] | None = None,
    **values: Any,
) -> UUID:
    now = clock.now()
    job = Job(
        kind=kind,
        payload=payload if payload is not None else {},
        status=status,
        run_at=values.pop("run_at", now - timedelta(days=100)),
        finished_at=None if finished_ago is None else now - finished_ago,
        **values,
    )
    db.add(job)
    await db.flush()
    return job.id


async def job_ids(db: AsyncSession) -> set[UUID]:
    return set(await db.scalars(select(Job.id)))


def test_the_retention_periods():
    assert (
        timedelta(days=14),
        timedelta(days=7),
        timedelta(days=30),
    ) == (SUCCEEDED_RETENTION, DEAD_RETENTION, SESSION_RETENTION)


# Criterion 19


async def test_jobs_cleanup_deletes_only_successes_finished_more_than_14_days_ago(
    db: AsyncSession, frozen_clock: FrozenClock
):
    second = timedelta(seconds=1)
    old = await add_job(db, JobStatus.SUCCEEDED, finished_ago=timedelta(days=14) + second)
    very_old = await add_job(db, JobStatus.SUCCEEDED, finished_ago=timedelta(days=400))
    kept = {
        await add_job(db, JobStatus.SUCCEEDED, finished_ago=timedelta(days=14)),
        await add_job(db, JobStatus.SUCCEEDED, finished_ago=timedelta(days=13)),
        await add_job(db, JobStatus.SUCCEEDED, finished_ago=timedelta(0)),
        await add_job(db, JobStatus.QUEUED),
        await add_job(
            db,
            JobStatus.RUNNING,
            attempts=1,
            locked_by="w",
            locked_until=clock.now() - timedelta(days=100),
        ),
        await add_job(db, JobStatus.DEAD, finished_ago=timedelta(days=400)),
        # A finished_at on a status that never has one must not make it deletable.
        await add_job(db, JobStatus.QUEUED, finished_ago=timedelta(days=400)),
    }

    assert await delete_old_succeeded_jobs(db) == 2

    remaining = await job_ids(db)
    assert remaining == kept
    assert old not in remaining and very_old not in remaining


# Criterion 20


async def test_jobs_cleanup_scrubs_secrets_of_jobs_dead_more_than_7_days(
    db: AsyncSession, handlers: Calls, frozen_clock: FrozenClock
):
    @job_handler("test.two", sensitive_keys=("a", "b"))
    async def two(payload: dict[str, Any], ctx: JobContext) -> None:
        pass

    week = timedelta(days=7)
    second = timedelta(seconds=1)
    payload = {"link": LINK, "to": "user@example.test"}
    scrubbed = await add_job(
        db,
        JobStatus.DEAD,
        kind="test.fail",
        finished_ago=week + second,
        payload=payload,
        last_error="SecretFailure: could not send [redacted]",
        attempts=8,
    )
    two_keys = await add_job(
        db,
        JobStatus.DEAD,
        kind="test.two",
        finished_ago=timedelta(days=30),
        payload={"a": 1, "c": 2},
    )
    unchanged = {
        "at the boundary": await add_job(
            db, JobStatus.DEAD, kind="test.fail", finished_ago=week, payload=payload
        ),
        "recent": await add_job(
            db, JobStatus.DEAD, kind="test.fail", finished_ago=timedelta(days=1), payload=payload
        ),
        "queued": await add_job(db, JobStatus.QUEUED, kind="test.fail", payload=payload),
        "succeeded": await add_job(
            db, JobStatus.SUCCEEDED, kind="test.fail", finished_ago=week + second, payload=payload
        ),
        "no sensitive keys": await add_job(
            db, JobStatus.DEAD, kind="test.echo", finished_ago=timedelta(days=30), payload=payload
        ),
        "no handler": await add_job(
            db, JobStatus.DEAD, kind="test.gone", finished_ago=timedelta(days=30), payload=payload
        ),
    }
    sensitive = {kind: spec.sensitive_keys for kind, spec in registry.HANDLERS.items()}

    assert await scrub_dead_jobs(db, sensitive) == 2

    db.expire_all()
    job = await db.get_one(Job, scrubbed)
    assert job.payload == {"to": "user@example.test"}
    assert (job.status, job.last_error, job.attempts) == (
        JobStatus.DEAD,
        "SecretFailure: could not send [redacted]",
        8,
    )
    assert (await db.get_one(Job, two_keys)).payload == {"c": 2}
    for case, job_id in unchanged.items():
        assert (await db.get_one(Job, job_id)).payload == payload, case
    # Idempotent: a second pass finds nothing left to scrub.
    assert await scrub_dead_jobs(db, sensitive) == 0


# Criterion 21


async def test_rate_limits_cleanup_deletes_ended_windows_through_the_worker(
    db: AsyncSession, sessions: Sessions, frozen_clock: FrozenClock
):
    now = clock.now()
    current = window_start(now, timedelta(minutes=15))
    db.add_all(
        [
            RateLimit(key="login:ip:203.0.113.9", window_start=current, count=3),
            RateLimit(
                key="login:ip:203.0.113.9",
                window_start=now - timedelta(days=1, seconds=1),
                count=9,
            ),
        ]
    )
    job_id = await enqueue(db, "rate_limits.cleanup", {})
    await db.commit()

    assert await Worker(sessions, recurring=()).run_once() == 1

    db.expire_all()
    assert (await db.get_one(Job, job_id)).status is JobStatus.SUCCEEDED
    assert list(await db.scalars(select(RateLimit.window_start))) == [current]


# Criterion 22


async def add_session(db: AsyncSession, user_id: UUID, **values: datetime | None) -> UUID:
    now = clock.now()
    session = AuthSession(
        user_id=user_id,
        token_hash=secrets.token_hex(32),
        last_seen_at=now - timedelta(days=60),
        expires_at=values.get("expires_at", now + timedelta(days=1)),
        idle_expires_at=values.get("idle_expires_at", now + timedelta(hours=1)),
        revoked_at=values.get("revoked_at"),
    )
    db.add(session)
    await db.flush()
    return session.id


async def test_sessions_cleanup_deletes_sessions_ended_more_than_30_days_ago(
    db: AsyncSession, frozen_clock: FrozenClock
):
    user = await make_user(db)
    now = clock.now()
    past = now - timedelta(days=30, seconds=1)
    boundary = now - timedelta(days=30)
    recent = now - timedelta(days=29)
    deleted = {
        await add_session(db, user.id, revoked_at=past),
        await add_session(db, user.id, expires_at=past, idle_expires_at=past),
        # The absolute deadline alone ended it (review round 1: no case isolated it).
        await add_session(db, user.id, expires_at=past),
        # The idle deadline alone ended it; the absolute one is still ahead.
        await add_session(db, user.id, idle_expires_at=past),
    }
    kept = {
        await add_session(db, user.id),
        await add_session(db, user.id, revoked_at=boundary),
        await add_session(db, user.id, revoked_at=recent),
        await add_session(db, user.id, expires_at=boundary, idle_expires_at=recent),
        await add_session(db, user.id, expires_at=recent, idle_expires_at=recent),
        await add_session(db, user.id, idle_expires_at=boundary),
        await add_session(db, user.id, idle_expires_at=recent),
    }

    assert await delete_ended_sessions(db) == 4

    assert set(await db.scalars(select(AuthSession.id))) == kept
    assert not deleted & kept


# Criterion 23


def test_the_worker_imports_the_three_handler_modules():
    assert set(HANDLER_MODULES) >= {"app.jobs.handlers", "app.rate_limits.jobs", "app.auth.jobs"}
    load_handlers()
    for kind in RECURRING_KINDS:
        spec = registry.HANDLERS[kind]
        assert spec.sensitive_keys == (), kind


async def test_each_cleanup_job_runs_in_the_worker_and_commits_with_the_job(
    db: AsyncSession, sessions: Sessions, handlers: Calls, frozen_clock: FrozenClock
):
    user = await make_user(db)
    ended = await add_session(db, user.id, revoked_at=clock.now() - timedelta(days=31))
    live = await add_session(db, user.id)
    old_job = await add_job(db, JobStatus.SUCCEEDED, finished_ago=timedelta(days=15))
    dead = await add_job(
        db, JobStatus.DEAD, kind="test.fail", finished_ago=timedelta(days=8), payload={"link": LINK}
    )
    db.add(RateLimit(key="k", window_start=clock.now() - timedelta(days=2), count=1))
    ids = [await enqueue(db, kind, {}) for kind in RECURRING_KINDS]
    await db.commit()

    assert await Worker(sessions, recurring=()).run_once() == len(RECURRING_KINDS)

    db.expire_all()
    statuses = [(await db.get_one(Job, job_id)).status for job_id in ids]
    assert statuses == [JobStatus.SUCCEEDED] * len(RECURRING_KINDS)
    assert set(await db.scalars(select(AuthSession.id))) == {live}
    assert ended not in set(await db.scalars(select(AuthSession.id)))
    assert old_job not in await job_ids(db)
    assert (await db.get_one(Job, dead)).payload == {}
    assert list(await db.scalars(select(RateLimit.key))) == []


async def test_a_failing_cleanup_rolls_its_deletions_back(
    db: AsyncSession, sessions: Sessions, handlers: Calls, frozen_clock: FrozenClock, monkeypatch
):
    """The handler's deletes share the job's transaction: a failure after them keeps the rows."""
    old_job = await add_job(db, JobStatus.SUCCEEDED, finished_ago=timedelta(days=15))
    job_id = await enqueue(db, "jobs.cleanup", {})
    await db.commit()

    async def broken_scrub(*args: Any, **kwargs: Any) -> int:
        raise RuntimeError("scrub failed")

    monkeypatch.setattr(app.jobs.handlers, "scrub_dead_jobs", broken_scrub)

    assert await Worker(sessions, recurring=()).run_once() == 1

    db.expire_all()
    job = await db.get_one(Job, job_id)
    assert (job.status, job.last_error) == (JobStatus.QUEUED, "RuntimeError: scrub failed")
    assert old_job in await job_ids(db)
