"""`jobs-status` and `jobs-retry` (P3-01b criteria 24 to 26).

The queries run in the test's transaction. The end-to-end tests run the real CLI, which opens its
own event loop and commits, against this run's database (`committed_db`), and delete what they add.
"""

import asyncio
from collections.abc import Awaitable, Callable, Iterator
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid7

import pytest
from sqlalchemy import delete, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine
from sqlalchemy.pool import NullPool
from typer.testing import CliRunner

from app import cli
from app.core import clock
from app.jobs.models import Job, JobStatus
from app.jobs.report import render_status
from app.jobs.service import DEAD_RETENTION, JobNotRetryable, job_status, retry_dead_job
from app.jobs.worker import Worker
from tests.conftest import FrozenClock
from tests.jobs.conftest import Calls, Sessions

pytestmark = pytest.mark.anyio

runner = CliRunner()
SECRET = "https://example.test/reset?token=cli-s3cr3t"  # noqa: S105 (a fake)
ESCAPE = "\x1b]0;owned\x07\x1b[31m"


def make_job(status: JobStatus, *, finished_ago: timedelta | None = None, **values: Any) -> Job:
    now = clock.now()
    defaults: dict[str, Any] = {
        "kind": "test.fail",
        "payload": {"link": SECRET, "to": "user@example.test"},
        "run_at": now - timedelta(hours=1),
        "attempts": 8 if status is JobStatus.DEAD else 0,
        "max_attempts": 8,
        "last_error": "SecretFailure: could not send [redacted]"
        if status is JobStatus.DEAD
        else None,
        "finished_at": None if finished_ago is None else now - finished_ago,
    }
    return Job(status=status, **(defaults | values))


async def add(db: AsyncSession, job: Job) -> UUID:
    db.add(job)
    await db.flush()
    return job.id


def snapshot(job: Job) -> tuple[Any, ...]:
    return tuple(getattr(job, column.key) for column in Job.__table__.columns)


# Criterion 24: the report


async def test_status_counts_every_status_including_zeros(db: AsyncSession, frozen_clock):
    for status in (JobStatus.QUEUED, JobStatus.QUEUED, JobStatus.DEAD):
        await add(db, make_job(status, finished_ago=timedelta(hours=1)))

    report = await job_status(db)

    assert report.counts == {
        JobStatus.QUEUED: 2,
        JobStatus.RUNNING: 0,
        JobStatus.SUCCEEDED: 0,
        JobStatus.DEAD: 1,
    }


async def test_oldest_due_follows_the_claims_predicate(db: AsyncSession, frozen_clock):
    now = clock.now()
    assert (await job_status(db)).oldest_due_run_at is None

    await add(db, make_job(JobStatus.QUEUED, run_at=now + timedelta(minutes=1)))
    await add(
        db,
        make_job(
            JobStatus.RUNNING,
            run_at=now - timedelta(hours=5),
            locked_by="w",
            locked_until=now + timedelta(seconds=30),
        ),
    )
    await add(
        db, make_job(JobStatus.DEAD, run_at=now - timedelta(days=9), finished_ago=timedelta(1))
    )
    assert (await job_status(db)).oldest_due_run_at is None, "not due, leased, or finished"

    await add(db, make_job(JobStatus.QUEUED, run_at=now - timedelta(minutes=5)))
    assert (await job_status(db)).oldest_due_run_at == now - timedelta(minutes=5)

    # A running job past its lease belongs to a dead worker: it is due again.
    await add(
        db,
        make_job(
            JobStatus.RUNNING,
            run_at=now - timedelta(minutes=10),
            locked_by="w",
            locked_until=now - timedelta(seconds=1),
        ),
    )
    assert (await job_status(db)).oldest_due_run_at == now - timedelta(minutes=10)


async def test_status_lists_the_10_most_recently_dead_jobs_newest_first(
    db: AsyncSession, frozen_clock
):
    ids = [
        await add(db, make_job(JobStatus.DEAD, finished_ago=timedelta(hours=hours)))
        for hours in range(12)
    ]

    report = await job_status(db)

    assert [row.id for row in report.dead] == ids[:10]
    assert report.dead[0].finished_at == clock.now()


async def test_render_prints_no_payload_no_control_characters_and_200_error_characters(
    db: AsyncSession, frozen_clock: FrozenClock
):
    error = "SecretFailure: " + ESCAPE + "line one\nline two\t" + "x" * 300 + "TAIL"
    job_id = await add(db, make_job(JobStatus.DEAD, finished_ago=timedelta(0), last_error=error))
    await add(db, make_job(JobStatus.QUEUED, run_at=clock.now() - timedelta(seconds=75)))

    text = render_status(await job_status(db), now=clock.now())

    lines = text.splitlines()
    assert lines[:4] == ["queued     1", "running    0", "succeeded  0", "dead       1"]
    assert lines[4] == "oldest due: 75 s ago"
    assert str(job_id) in text
    assert "test.fail" in text
    assert "8/8" in text
    assert SECRET not in text and "user@example.test" not in text and "token" not in text
    assert "\x1b" not in text and "\x07" not in text and "\t" not in text
    shown = error[:200]
    expected = "".join(ch if ch.isprintable() else "?" for ch in shown)
    assert lines[-1].endswith(expected)
    assert "TAIL" not in text


async def test_render_says_none_when_nothing_is_due_or_dead(db: AsyncSession, frozen_clock):
    text = render_status(await job_status(db), now=clock.now())

    assert "oldest due: none" in text
    assert "dead jobs: none" in text


# Criteria 25 and 26: the retry


async def test_retry_requeues_a_dead_job_as_new_keeping_payload_and_error(
    db: AsyncSession, frozen_clock: FrozenClock
):
    job_id = await add(
        db,
        make_job(
            JobStatus.DEAD,
            finished_ago=timedelta(days=7),
            run_at=clock.now() - timedelta(days=8),
            attempts=9,
            max_attempts=8,
            locked_by="stale",
            locked_until=clock.now() - timedelta(days=8),
        ),
    )

    await retry_dead_job(db, job_id)

    db.expire_all()
    job = await db.get_one(Job, job_id)
    assert (job.status, job.attempts, job.run_at) == (JobStatus.QUEUED, 0, clock.now())
    assert (job.locked_by, job.locked_until, job.finished_at) == (None, None, None)
    assert job.payload == {"link": SECRET, "to": "user@example.test"}
    assert (job.max_attempts, job.last_error) == (8, "SecretFailure: could not send [redacted]")


async def test_a_retried_job_is_claimed_and_run_like_a_new_one(
    db: AsyncSession, sessions: Sessions, handlers: Calls, frozen_clock: FrozenClock
):
    job_id = await add(
        db, make_job(JobStatus.DEAD, kind="test.echo", finished_ago=timedelta(hours=1))
    )
    await retry_dead_job(db, job_id)
    await db.commit()

    assert await Worker(sessions, recurring=()).run_once() == 1

    db.expire_all()
    job = await db.get_one(Job, job_id)
    assert (job.status, job.attempts) == (JobStatus.SUCCEEDED, 1)
    assert [run[2] for run in handlers.of("test.echo")] == [1]


@pytest.mark.parametrize(
    ("status", "finished_ago", "message"),
    [
        (JobStatus.QUEUED, None, "is queued, not dead"),
        (JobStatus.RUNNING, None, "is running, not dead"),
        (JobStatus.SUCCEEDED, timedelta(hours=1), "is succeeded, not dead"),
        (JobStatus.DEAD, DEAD_RETENTION + timedelta(seconds=1), "died more than 7 days ago"),
        (JobStatus.DEAD, None, "died more than 7 days ago"),
    ],
    ids=["queued", "running", "succeeded", "dead-too-long", "dead-without-finish-time"],
)
async def test_retry_refuses_a_job_that_is_not_recently_dead_and_changes_nothing(
    db: AsyncSession, frozen_clock, status: JobStatus, finished_ago, message: str
):
    values: dict[str, Any] = (
        {"locked_by": "w", "locked_until": clock.now()} if status is JobStatus.RUNNING else {}
    )
    job_id = await add(db, make_job(status, finished_ago=finished_ago, **values))
    before = snapshot(await db.get_one(Job, job_id))

    with pytest.raises(JobNotRetryable, match=message):
        await retry_dead_job(db, job_id)

    db.expire_all()
    assert snapshot(await db.get_one(Job, job_id)) == before


async def test_retry_refuses_an_unknown_id(db: AsyncSession):
    with pytest.raises(JobNotRetryable, match="no job"):
        await retry_dead_job(db, uuid7())


async def test_a_second_retry_is_refused(db: AsyncSession, frozen_clock):
    job_id = await add(db, make_job(JobStatus.DEAD, finished_ago=timedelta(hours=1)))
    await retry_dead_job(db, job_id)
    db.expire_all()
    before = snapshot(await db.get_one(Job, job_id))

    with pytest.raises(JobNotRetryable, match="is queued, not dead"):
        await retry_dead_job(db, job_id)

    db.expire_all()
    assert snapshot(await db.get_one(Job, job_id)) == before


# End to end: the real commands, on committed rows


class CommittedDb:
    """This run's database through the CLI's own `run_in_session`, on a pool-less engine (each
    `asyncio.run` has its own loop). Deletes every job it was given, or the CLI touched."""

    def __init__(self, url: str) -> None:
        self.factory = async_sessionmaker(
            create_async_engine(url, poolclass=NullPool), expire_on_commit=False
        )

    def run[T](self, work: Callable[[AsyncSession], Awaitable[T]]) -> T:
        async def main() -> T:
            async with self.factory() as db:
                result = await work(db)
                await db.commit()
                return result

        return asyncio.run(main())

    def add(self, job: Job) -> UUID:
        return self.run(lambda db: add(db, job))

    def get(self, job_id: UUID) -> Job:
        return self.run(lambda db: db.get_one(Job, job_id))


@pytest.fixture
def committed_db(
    migrated_test_database: str, monkeypatch: pytest.MonkeyPatch
) -> Iterator[CommittedDb]:
    committed = CommittedDb(migrated_test_database)
    monkeypatch.setattr(cli, "AsyncSessionLocal", committed.factory)
    try:
        yield committed
    finally:
        committed.run(lambda db: db.execute(delete(Job)))


def test_jobs_status_command_prints_the_report_and_changes_nothing(committed_db: CommittedDb):
    now = datetime.now(UTC)
    dead = committed_db.add(
        make_job(JobStatus.DEAD, finished_at=now, last_error="Boom: " + ESCAPE + "x" * 300)
    )
    committed_db.add(make_job(JobStatus.QUEUED, run_at=now - timedelta(minutes=2)))
    before = snapshot(committed_db.get(dead))

    result = runner.invoke(cli.app, ["jobs-status"])

    assert result.exit_code == 0, result.output
    assert result.output.splitlines()[:4] == [
        "queued     1",
        "running    0",
        "succeeded  0",
        "dead       1",
    ]
    assert str(dead) in result.output
    assert SECRET not in result.output and "\x1b" not in result.output
    assert snapshot(committed_db.get(dead)) == before


def test_jobs_retry_command_requeues_a_dead_job(committed_db: CommittedDb):
    job_id = committed_db.add(
        make_job(JobStatus.DEAD, finished_at=datetime.now(UTC) - timedelta(hours=1))
    )

    result = runner.invoke(cli.app, ["jobs-retry", str(job_id)])

    assert result.exit_code == 0, result.output
    assert result.output.strip() == f"requeued {job_id}"
    job = committed_db.get(job_id)
    assert (job.status, job.attempts, job.finished_at) == (JobStatus.QUEUED, 0, None)

    again = runner.invoke(cli.app, ["jobs-retry", str(job_id)])

    assert again.exit_code == 1
    assert "is queued, not dead" in again.output
    assert snapshot(committed_db.get(job_id)) == snapshot(job)


@pytest.mark.parametrize(
    "status", [JobStatus.QUEUED, JobStatus.RUNNING, JobStatus.SUCCEEDED, JobStatus.DEAD]
)
def test_jobs_retry_command_refuses_a_job_that_is_not_recently_dead(
    committed_db: CommittedDb, status: JobStatus
):
    now = datetime.now(UTC)
    finished = {
        JobStatus.SUCCEEDED: now,
        JobStatus.DEAD: now - DEAD_RETENTION - timedelta(minutes=1),
    }.get(status)
    values: dict[str, Any] = (
        {"locked_by": "w", "locked_until": now} if status is JobStatus.RUNNING else {}
    )
    job_id = committed_db.add(make_job(status, finished_at=finished, **values))
    before = snapshot(committed_db.get(job_id))

    result = runner.invoke(cli.app, ["jobs-retry", str(job_id)])

    assert result.exit_code == 1
    assert result.output.startswith("error: ")
    assert snapshot(committed_db.get(job_id)) == before


def test_jobs_retry_command_refuses_an_unknown_id(committed_db: CommittedDb):
    result = runner.invoke(cli.app, ["jobs-retry", str(uuid7())])

    assert result.exit_code == 1
    assert "no job" in result.output
    assert committed_db.run(lambda db: db.scalar(select(Job.id))) is None


@pytest.mark.parametrize("raw", ["not-a-uuid", "", "1234", ESCAPE, f"{uuid7()}x"])
def test_jobs_retry_command_refuses_a_malformed_id_before_any_session(
    raw: str, monkeypatch: pytest.MonkeyPatch
):
    def no_session() -> None:
        raise AssertionError("opened a session")

    monkeypatch.setattr(cli, "AsyncSessionLocal", no_session)

    result = runner.invoke(cli.app, ["jobs-retry", raw])

    assert result.exit_code == 1
    assert "not a job id" in result.output
    assert "\x1b" not in result.output
