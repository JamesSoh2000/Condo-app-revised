from datetime import datetime
from enum import StrEnum
from typing import Any

from sqlalchemy import CheckConstraint, DateTime, Index, Integer, String, Text, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.mixins import UUIDPrimaryKeyMixin
from app.models.types import database_enum


class JobStatus(StrEnum):
    QUEUED = "queued"
    RUNNING = "running"
    SUCCEEDED = "succeeded"
    DEAD = "dead"


class Job(UUIDPrimaryKeyMixin, Base):
    """A background job (P3-01a, ADR-0006). Created by `app.jobs.service.enqueue` inside the
    business transaction; claimed, run and finished by `app.jobs.worker.Worker`."""

    __tablename__ = "jobs"
    __table_args__ = (
        # The claim's scan: due queued jobs and running ones whose lease may have expired.
        Index(
            "ix_jobs_run_at_due", "run_at", postgresql_where=text("status IN ('queued', 'running')")
        ),
        CheckConstraint("attempts >= 0", name="attempts_not_negative"),
        CheckConstraint("max_attempts >= 1", name="max_attempts_positive"),
    )

    kind: Mapped[str] = mapped_column(String(64))
    payload: Mapped[dict[str, Any]] = mapped_column(JSONB)
    status: Mapped[JobStatus] = mapped_column(
        database_enum(JobStatus, name="job_status"), server_default=JobStatus.QUEUED.value
    )
    run_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    attempts: Mapped[int] = mapped_column(Integer, server_default=text("0"))
    max_attempts: Mapped[int] = mapped_column(Integer, server_default=text("8"))
    locked_by: Mapped[str | None] = mapped_column(String(64))
    locked_until: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # At most 2,000 characters, with the handler's sensitive payload values redacted.
    last_error: Mapped[str | None] = mapped_column(Text)
    # Unique; NULLs never collide, so jobs without a key are never deduplicated.
    dedupe_key: Mapped[str | None] = mapped_column(String(200), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    finished_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
