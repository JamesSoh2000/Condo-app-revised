"""Enqueue background jobs in the caller's transaction (P3-01a, ADR-0006: the outbox), and the
operations on them: cleanup, status and retry (P3-01b). None of these functions commits."""

from collections.abc import Mapping, Sequence
from dataclasses import dataclass
from datetime import datetime, timedelta
from typing import Any
from uuid import UUID

from sqlalchemy import ColumnElement, Text, and_, cast, delete, func, or_, select, update
from sqlalchemy.dialects import postgresql
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.jobs.models import Job, JobStatus

DEFAULT_MAX_ATTEMPTS = 8


async def enqueue(
    db: AsyncSession,
    kind: str,
    payload: dict[str, Any],
    *,
    run_at: datetime | None = None,
    dedupe_key: str | None = None,
    max_attempts: int | None = None,
) -> UUID | None:
    """Add a `queued` job in `db`'s transaction; return its id, or None if `dedupe_key` exists.

    Never commits: the job exists only if the caller's transaction commits. `run_at` defaults to
    `clock.now()`, the time the worker's claim compares it with.
    """
    statement = (
        insert(Job)
        .values(
            kind=kind,
            payload=payload,
            run_at=run_at if run_at is not None else clock.now(),
            dedupe_key=dedupe_key,
            max_attempts=max_attempts if max_attempts is not None else DEFAULT_MAX_ATTEMPTS,
        )
        .on_conflict_do_nothing(index_elements=[Job.dedupe_key])
        .returning(Job.id)
    )
    job_id: UUID | None = (await db.execute(statement)).scalar_one_or_none()
    return job_id


# Kept for `jobs-status` and as the record of a finish; deleted by `jobs.cleanup` after this.
SUCCEEDED_RETENTION = timedelta(days=14)
# A dead job's sensitive keys are removed after this, and `jobs-retry` refuses it from then on:
# the longest-lived link a job carries (an invitation) has expired by then (P3-01b D2).
DEAD_RETENTION = timedelta(days=7)
DEAD_JOBS_SHOWN = 10


class JobNotRetryable(Exception):
    """`retry_dead_job` changed nothing; the message says why (safe to print)."""


@dataclass(frozen=True)
class DeadJobRow:
    id: UUID
    kind: str
    attempts: int
    max_attempts: int
    finished_at: datetime | None
    last_error: str | None


@dataclass(frozen=True)
class JobStatusReport:
    counts: dict[JobStatus, int]
    # Of the jobs the worker's claim would take now; None when nothing is due.
    oldest_due_run_at: datetime | None
    # The most recently finished first, at most DEAD_JOBS_SHOWN. Never the payload.
    dead: list[DeadJobRow]


async def delete_old_succeeded_jobs(db: AsyncSession) -> int:
    """Delete `succeeded` jobs finished more than SUCCEEDED_RETENTION ago; return how many.

    Never commits. Every other status stays: queued and running jobs are still to do, and dead
    ones are the failure record operators read and retry.
    """
    result = await db.execute(
        delete(Job).where(
            Job.status == JobStatus.SUCCEEDED,
            Job.finished_at < clock.now() - SUCCEEDED_RETENTION,
        )
    )
    deleted: int = result.rowcount  # type: ignore[attr-defined]
    return deleted


async def scrub_dead_jobs(db: AsyncSession, sensitive_keys: Mapping[str, Sequence[str]]) -> int:
    """Remove each kind's sensitive keys from its jobs dead more than DEAD_RETENTION; return how
    many jobs changed. Never commits.

    `sensitive_keys` maps a kind to its handler's keys (the registry). A kind with no registered
    handler is left alone: its keys are unknown.
    """
    cutoff = clock.now() - DEAD_RETENTION
    scrubbed = 0
    for kind, keys in sensitive_keys.items():
        if not keys:
            continue
        key_array = cast(postgresql.array(list(keys)), postgresql.ARRAY(Text))
        result = await db.execute(
            update(Job)
            .where(
                Job.kind == kind,
                Job.status == JobStatus.DEAD,
                Job.finished_at < cutoff,
                Job.payload.has_any(key_array),
            )
            .values(payload=Job.payload.op("-")(key_array))
            .execution_options(synchronize_session=False)
        )
        scrubbed += result.rowcount  # type: ignore[attr-defined]
    return scrubbed


def _due(now: datetime) -> ColumnElement[bool]:
    # The worker's claim predicate (`app.jobs.worker.Worker._claim`).
    return or_(
        and_(Job.status == JobStatus.QUEUED, Job.run_at <= now),
        and_(Job.status == JobStatus.RUNNING, Job.locked_until < now),
    )


async def job_status(db: AsyncSession) -> JobStatusReport:
    """Counts by status (zeros included), the oldest due job's `run_at`, the latest dead jobs."""
    now = clock.now()
    counts = dict.fromkeys(JobStatus, 0)
    for status, count in await db.execute(select(Job.status, func.count()).group_by(Job.status)):
        counts[status] = count
    oldest = await db.scalar(select(func.min(Job.run_at)).where(_due(now)))
    rows = await db.execute(
        select(Job.id, Job.kind, Job.attempts, Job.max_attempts, Job.finished_at, Job.last_error)
        .where(Job.status == JobStatus.DEAD)
        .order_by(Job.finished_at.desc().nulls_last(), Job.id.desc())
        .limit(DEAD_JOBS_SHOWN)
    )
    return JobStatusReport(counts, oldest, [DeadJobRow(*row) for row in rows])


async def retry_dead_job(db: AsyncSession, job_id: UUID) -> None:
    """Re-queue a job that died within DEAD_RETENTION, as if new. Never commits.

    `attempts = 0`, so the worker's guard and the claim's `attempts + 1` work as for a new job;
    the payload, `max_attempts` and `last_error` stay. Anything else raises `JobNotRetryable` and
    changes nothing.

    The row is locked before the clock is read (review round 1): a retry delayed across the
    retention boundary must not re-queue a job `scrub_dead_jobs` emptied meanwhile. A scrub
    holding the row is waited for; one that comes after waits for this transaction and then finds
    the job no longer dead. Of two retries at once, one wins.
    """
    row = (
        await db.execute(
            select(Job.status, Job.finished_at).where(Job.id == job_id).with_for_update()
        )
    ).one_or_none()
    if row is None:
        raise JobNotRetryable(f"no job {job_id}")
    status, finished_at = row
    if status is not JobStatus.DEAD:
        raise JobNotRetryable(f"job {job_id} is {status.value}, not dead")
    now = clock.now()
    if finished_at is None or finished_at < now - DEAD_RETENTION:
        raise JobNotRetryable(
            f"job {job_id} died more than {DEAD_RETENTION.days} days ago (or has no finish time):"
            " its secrets may be gone; enqueue a new job instead"
        )
    await db.execute(
        update(Job)
        .where(Job.id == job_id)
        .values(
            status=JobStatus.QUEUED,
            attempts=0,
            run_at=now,
            locked_by=None,
            locked_until=None,
            finished_at=None,
        )
        .execution_options(synchronize_session=False)
    )
