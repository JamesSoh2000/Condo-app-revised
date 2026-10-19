"""The job worker (P3-01a, ADR-0006, docs/ARCHITECTURE.md §9): claims due jobs, runs their handlers.

Delivery is at-least-once: a worker that dies after a handler ran but before the job's update leaves
the job `running`, and another worker reclaims it when its lease expires. Handlers are idempotent
where they can be.
"""

import asyncio
import contextlib
import copy
import importlib
import logging
import os
import random
import re
import secrets
import signal
import socket
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from datetime import UTC, timedelta
from pathlib import Path
from typing import Any
from uuid import UUID

from sqlalchemy import and_, or_, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.core.database import AsyncSessionLocal, dispose_database_engine
from app.jobs import registry
from app.jobs.models import Job, JobStatus
from app.jobs.service import enqueue

logger = logging.getLogger(__name__)

LEASE = timedelta(seconds=60)
# Below the lease, so a slow handler is cancelled before another worker could reclaim its job.
HANDLER_TIMEOUT = 50.0
HEARTBEAT_INTERVAL = 30.0
MAX_ERROR_LENGTH = 2000
MAX_BACKOFF = timedelta(hours=1)
# Touched every loop and before every job; the Docker healthcheck fails when it is older than
# 120 s, above HANDLER_TIMEOUT (docker-compose.yml, compose.prodlike.yml).
HEARTBEAT_FILE = Path(tempfile.gettempdir()) / "worker_heartbeat"
# Modules whose `@job_handler`s the worker runs.
HANDLER_MODULES: tuple[str, ...] = (
    "app.jobs.handlers",
    "app.rate_limits.jobs",
    "app.auth.jobs",
    "app.email.handler",
    "app.files.jobs",
)
# Enqueued once per UTC day by the scheduler (P3-01b), with the key `<kind>:<yyyy-mm-dd>`.
RECURRING_KINDS: tuple[str, ...] = (
    "jobs.cleanup",
    "rate_limits.cleanup",
    "sessions.cleanup",
    "files.cleanup",
)
SCHEDULE_INTERVAL = 60.0


@dataclass(frozen=True)
class ClaimedJob:
    id: UUID
    kind: str
    payload: dict[str, Any]
    attempts: int
    max_attempts: int


def backoff(attempts: int, jitter: float) -> timedelta:
    """`min(2^attempts * 10 s, 1 h) * jitter`: the delay before retry `attempts + 1`."""
    capped = min(timedelta(seconds=10 * 2 ** min(attempts, 20)), MAX_BACKOFF)
    return capped * jitter


def _jitter() -> float:
    # Spreads retries out so jobs that failed together don't retry together; not security.
    return random.uniform(0.8, 1.2)  # noqa: S311


def describe_error(
    exc: BaseException, payload: dict[str, Any], sensitive_keys: Sequence[str]
) -> str:
    """`<Type>: <message>`, the sensitive payload values replaced, cut to `MAX_ERROR_LENGTH`.

    Redacted before it is cut, so a secret at the cut can't leave a prefix behind. A database
    error (any SQLAlchemy or asyncpg one) keeps only its types and SQLSTATE: its message can quote
    statement parameters, shortened, so redacting the full values would miss them (review rounds
    1 and 2).
    """
    if isinstance(exc, SQLAlchemyError) or type(exc).__module__.startswith("asyncpg"):
        orig = getattr(exc, "orig", None) or exc
        code = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
        detail = type(orig).__name__ + (f", SQLSTATE {code}" if code else "")
        return f"{type(exc).__name__}: database error ({detail}); message withheld"
    text = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    secrets_ = {s for key in sensitive_keys for s in _strings(payload.get(key))}
    if secrets_:
        # One pass, longest first: replacing a shorter value (a URL prefix) first would break a
        # longer one that contains it and leave its token behind.
        pattern = "|".join(re.escape(s) for s in sorted(secrets_, key=len, reverse=True))
        text = re.sub(pattern, "[redacted]", text)
    return text[:MAX_ERROR_LENGTH]


def _strings(value: Any) -> list[str]:
    if isinstance(value, dict):
        return [s for item in value.values() for s in _strings(item)]
    if isinstance(value, list):
        return [s for item in value for s in _strings(item)]
    text = "" if value is None else str(value)
    return [text] if text else []


class Worker:
    """Claims and runs jobs. `sessions` makes a session per transaction (`AsyncSessionLocal`)."""

    def __init__(
        self,
        sessions: Callable[[], AsyncSession],
        *,
        worker_id: str | None = None,
        handler_timeout: float = HANDLER_TIMEOUT,
        heartbeat_interval: float = HEARTBEAT_INTERVAL,
        jitter: Callable[[], float] = _jitter,
        recurring: Sequence[str] = RECURRING_KINDS,
        schedule_interval: float = SCHEDULE_INTERVAL,
    ) -> None:
        self._sessions = sessions
        self.worker_id = (
            worker_id or f"{socket.gethostname()[:40]}:{os.getpid()}:{secrets.token_hex(4)}"
        )
        self._handler_timeout = handler_timeout
        self._heartbeat_interval = heartbeat_interval
        self._jitter = jitter
        self._recurring = tuple(recurring)
        self._schedule_interval = schedule_interval
        self._counts = {"succeeded": 0, "retried": 0, "dead": 0}

    async def run_once(self, batch: int = 10, stop: asyncio.Event | None = None) -> int:
        """Run up to `batch` due jobs, claiming each just before it runs; return how many ran.

        One claim per job: a job is never leased while it waits behind another, so its lease
        can't run out unstarted and be reclaimed, charged or dead-lettered (review round 2).
        Stops early when `stop` is set or nothing is due.
        """
        ran = 0
        while ran < batch and not (stop is not None and stop.is_set()):
            job = await self._claim()
            if job is None:
                break
            # Per job too: a run of slow jobs is not a hung worker.
            HEARTBEAT_FILE.touch()
            await self._process(job)
            ran += 1
        return ran

    async def run_forever(
        self, stop: asyncio.Event, *, batch: int = 10, idle_sleep: float = 1.0
    ) -> None:
        """Run until `stop` is set; the job running then finishes first.

        Schedules the recurring jobs before the first claim, then every `schedule_interval`.
        """
        await self._schedule_logged()
        timers = [
            asyncio.create_task(self._heartbeats(stop)),
            asyncio.create_task(self._scheduler(stop)),
        ]
        try:
            await self._loop(stop, batch, idle_sleep)
        finally:
            for timer in timers:
                timer.cancel()
            for timer in timers:
                with contextlib.suppress(asyncio.CancelledError):
                    await timer

    async def schedule(self) -> list[str]:
        """Enqueue today's job of each recurring kind not yet enqueued; return the kinds added.

        The key `<kind>:<UTC date>` is unique (`enqueue`'s ON CONFLICT DO NOTHING), so a restart,
        a second worker or a later tick the same day adds nothing.
        """
        today = clock.now().astimezone(UTC).date().isoformat()
        added: list[str] = []
        async with self._sessions() as db:
            for kind in self._recurring:
                if await enqueue(db, kind, {}, dedupe_key=f"{kind}:{today}") is not None:
                    added.append(kind)
            await db.commit()
        return added

    async def _scheduler(self, stop: asyncio.Event) -> None:
        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=self._schedule_interval)
            if not stop.is_set():
                await self._schedule_logged()

    async def _schedule_logged(self) -> None:
        if not self._recurring:
            return
        try:
            await self.schedule()
        except Exception as exc:
            # As `worker_loop_error`: type only, and the next tick tries again.
            logger.error("scheduler_error", extra={"error_type": type(exc).__name__})

    async def _heartbeats(self, stop: asyncio.Event) -> None:
        """Log `worker_heartbeat` every interval, also while a long batch runs (review round 1)."""
        while not stop.is_set():
            with contextlib.suppress(TimeoutError):
                await asyncio.wait_for(stop.wait(), timeout=self._heartbeat_interval)
            if not stop.is_set():
                logger.info("worker_heartbeat", extra={"worker_id": self.worker_id, **self._counts})
                self._counts = dict.fromkeys(self._counts, 0)

    async def _loop(self, stop: asyncio.Event, batch: int, idle_sleep: float) -> None:
        while not stop.is_set():
            try:
                claimed = await self.run_once(batch, stop)
            except Exception as exc:
                # The database is down or not migrated yet: log, wait, try again. Type only: a
                # driver's message can carry statement parameters (CLAUDE.md rule 10).
                logger.error("worker_loop_error", extra={"error_type": type(exc).__name__})
                claimed = 0
                idle_sleep_now = max(idle_sleep, 5.0)
            else:
                idle_sleep_now = idle_sleep
            HEARTBEAT_FILE.touch()
            if not claimed:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(stop.wait(), timeout=idle_sleep_now)

    async def _claim(self) -> ClaimedJob | None:
        # docs/ARCHITECTURE.md §9, with the clock bound in: SKIP LOCKED gives concurrent claims
        # disjoint rows, and a `running` job past its lease belongs to a worker that died.
        now = clock.now()
        due = (
            select(Job.id)
            .where(
                or_(
                    and_(Job.status == JobStatus.QUEUED, Job.run_at <= now),
                    and_(Job.status == JobStatus.RUNNING, Job.locked_until < now),
                )
            )
            .order_by(Job.run_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        claim = (
            update(Job)
            # `=` a scalar subquery, not `IN`: Postgres may run `IN (… LIMIT 1 …)` as a semi-join
            # that re-runs the subquery per row and leases several jobs (flaky-test diagnosis).
            .where(Job.id == due.scalar_subquery())
            .values(
                status=JobStatus.RUNNING,
                attempts=Job.attempts + 1,
                locked_by=self.worker_id,
                locked_until=now + LEASE,
            )
            .returning(Job.id, Job.kind, Job.payload, Job.attempts, Job.max_attempts)
            .execution_options(synchronize_session=False)
        )
        async with self._sessions() as db:
            row = (await db.execute(claim)).one_or_none()
            await db.commit()
        return None if row is None else ClaimedJob(*row)

    async def _process(self, job: ClaimedJob) -> None:
        if job.attempts > job.max_attempts:
            # Claimed again after the last attempt's lease ran out: the worker died running it.
            await self._fail(
                job, "the lease expired during the last attempt (the worker stopped)", dead=True
            )
            return
        spec = registry.HANDLERS.get(job.kind)
        if spec is None:
            await self._fail(job, f"no handler registered for job kind {job.kind!r}", dead=True)
            return
        # Deep: a handler changing nested values must not change what is redacted or scrubbed.
        context_payload = copy.deepcopy(job.payload)
        try:
            async with self._sessions() as db:
                ctx = registry.JobContext(db=db, job_id=job.id, kind=job.kind, attempt=job.attempts)
                async with asyncio.timeout(self._handler_timeout):
                    await spec.handler(context_payload, ctx)
                scrubbed = {k: v for k, v in job.payload.items() if k not in spec.sensitive_keys}
                if await self._finish(
                    db, job, status=JobStatus.SUCCEEDED, payload=scrubbed, finished_at=clock.now()
                ):
                    await db.commit()
                    self._counts["succeeded"] += 1
                # Otherwise the session closes without a commit: the handler's writes roll back.
        except Exception as exc:
            dead = isinstance(exc, registry.PermanentJobError) or job.attempts >= job.max_attempts
            error = describe_error(exc, job.payload, spec.sensitive_keys)
            logger.warning(
                "job_failed",
                extra={
                    "job_id": str(job.id),
                    "job_kind": job.kind,
                    "attempt": job.attempts,
                    "error_type": type(exc).__name__,
                },
            )
            await self._fail(job, error, dead=dead)

    async def _fail(self, job: ClaimedJob, error: str, *, dead: bool) -> None:
        now = clock.now()
        values: dict[str, Any] = {"last_error": error}
        if dead:
            values |= {"status": JobStatus.DEAD, "finished_at": now}
        else:
            values |= {
                "status": JobStatus.QUEUED,
                "run_at": now + backoff(job.attempts, self._jitter()),
            }
        async with self._sessions() as db:
            if await self._finish(db, job, **values):
                await db.commit()
                self._counts["dead" if dead else "retried"] += 1

    async def _finish(self, db: AsyncSession, job: ClaimedJob, **values: Any) -> bool:
        """Apply `values` and clear the lease, only while this worker still holds it."""
        result = await db.execute(
            update(Job)
            .where(
                Job.id == job.id,
                Job.status == JobStatus.RUNNING,
                Job.locked_by == self.worker_id,
                Job.attempts == job.attempts,
            )
            .values(locked_by=None, locked_until=None, **values)
            .returning(Job.id)
            .execution_options(synchronize_session=False)
        )
        if result.first() is None:
            # Another worker reclaimed it (our lease ran out): its outcome wins.
            logger.warning("job_lease_lost", extra={"job_id": str(job.id), "job_kind": job.kind})
            return False
        return True


def load_handlers() -> None:
    for module in HANDLER_MODULES:
        importlib.import_module(module)


async def main() -> None:
    """Run a worker until SIGTERM or SIGINT, then finish the current job and return."""
    load_handlers()
    stop = asyncio.Event()
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, stop.set)
    worker = Worker(AsyncSessionLocal)
    logger.info("worker_started", extra={"worker_id": worker.worker_id})
    try:
        await worker.run_forever(stop)
    finally:
        await dispose_database_engine()
        logger.info("worker_stopped", extra={"worker_id": worker.worker_id})
