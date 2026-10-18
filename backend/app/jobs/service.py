"""Enqueue background jobs in the caller's transaction (P3-01a, ADR-0006: the outbox)."""

from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.jobs.models import Job

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
