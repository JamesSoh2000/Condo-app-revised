"""`enqueue` (P3-01a criteria 1 and 7)."""

from datetime import UTC, datetime

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs.models import Job, JobStatus
from app.jobs.service import enqueue

pytestmark = pytest.mark.anyio


async def count_jobs(db: AsyncSession) -> int:
    return (await db.scalar(select(func.count()).select_from(Job))) or 0


# Criterion 1


async def test_enqueue_rolled_back_leaves_no_job(db: AsyncSession):
    before = await count_jobs(db)
    await enqueue(db, "test.echo", {"n": 1})

    await db.rollback()

    assert await count_jobs(db) == before


async def test_enqueue_committed_job_is_queued_with_defaults(db: AsyncSession, frozen_clock):
    job_id = await enqueue(db, "test.echo", {"n": 1})
    await db.commit()
    db.expire_all()

    job = await db.get(Job, job_id)
    assert job is not None
    assert job.kind == "test.echo"
    assert job.payload == {"n": 1}
    assert job.status is JobStatus.QUEUED
    assert job.attempts == 0
    assert job.max_attempts == 8
    assert job.run_at == frozen_clock.at
    assert job.locked_by is None
    assert job.locked_until is None
    assert job.last_error is None
    assert job.finished_at is None


async def test_enqueue_takes_run_at_and_max_attempts(db: AsyncSession):
    later = datetime(2030, 1, 1, tzinfo=UTC)
    job_id = await enqueue(db, "test.echo", {}, run_at=later, max_attempts=3)
    await db.commit()
    db.expire_all()

    job = await db.get(Job, job_id)
    assert job is not None
    assert (job.run_at, job.max_attempts) == (later, 3)


# Criterion 7


async def test_same_dedupe_key_keeps_one_row(db: AsyncSession):
    first = await enqueue(db, "test.echo", {"n": 1}, dedupe_key="echo:1")
    second = await enqueue(db, "test.echo", {"n": 2}, dedupe_key="echo:1")
    await db.commit()

    assert first is not None
    assert second is None
    rows = (await db.scalars(select(Job).where(Job.dedupe_key == "echo:1"))).all()
    assert [row.payload for row in rows] == [{"n": 1}]


async def test_jobs_without_dedupe_key_never_collide(db: AsyncSession):
    before = await count_jobs(db)

    ids = [await enqueue(db, "test.echo", {}) for _ in range(3)]

    assert None not in ids
    assert len(set(ids)) == 3
    assert await count_jobs(db) == before + 3
