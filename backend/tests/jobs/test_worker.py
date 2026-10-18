"""The worker (P3-01a criteria 2 to 6, 8 and 10 to 16)."""

import asyncio
import logging
import os
import signal
import subprocess
import sys
import time
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.jobs.models import Job, JobStatus
from app.jobs.registry import JobContext, job_handler
from app.jobs.service import enqueue
from app.jobs.worker import MAX_ERROR_LENGTH, Worker, backoff
from tests.jobs.conftest import Calls, Sessions, load

pytestmark = pytest.mark.anyio

BACKEND_DIR = Path(__file__).resolve().parents[2]
SECRET_LINK = "https://example.test/reset?token=s3cr3t-t0ken-value"  # noqa: S105 (a fake)


async def add(sessions: Sessions, kind: str, payload: dict[str, Any], **kwargs: Any):
    async with sessions() as db:
        job_id = await enqueue(db, kind, payload, **kwargs)
        await db.commit()
    return job_id


async def insert_running(sessions: Sessions, *, locked_until, attempts: int, max_attempts=8):
    """A job a worker claimed and never finished (it crashed, or still runs)."""
    async with sessions() as db:
        job = Job(
            kind="test.echo",
            payload={},
            status=JobStatus.RUNNING,
            run_at=clock.now() - timedelta(minutes=5),
            attempts=attempts,
            max_attempts=max_attempts,
            locked_by="crashed-worker",
            locked_until=locked_until,
        )
        db.add(job)
        await db.commit()
        return job.id


def worker(sessions: Sessions, **kwargs: Any) -> Worker:
    kwargs.setdefault("worker_id", "worker-a")
    return Worker(sessions, **kwargs)


# Criterion 2


async def test_echo_job_succeeds_and_runs_once(sessions, handlers: Calls, frozen_clock):
    job_id = await add(sessions, "test.echo", {"n": 1})

    assert await worker(sessions).run_once() == 1
    assert await worker(sessions).run_once() == 0

    job = await load(sessions, job_id)
    assert job.status is JobStatus.SUCCEEDED
    assert job.attempts == 1
    assert job.finished_at == frozen_clock.at
    assert (job.locked_by, job.locked_until) == (None, None)
    assert handlers.of("test.echo") == [("test.echo", {"n": 1}, 1)]


# Criterion 3


async def test_flaky_job_succeeds_on_third_attempt_with_growing_backoff(
    sessions, handlers: Calls, frozen_clock
):
    job_id = await add(sessions, "test.flaky", {"succeed_on": 3})
    delays = []

    for attempt in (1, 2):
        failed_at = frozen_clock.at
        await worker(sessions).run_once()
        job = await load(sessions, job_id)
        assert (job.status, job.attempts) == (JobStatus.QUEUED, attempt)
        delay = (job.run_at - failed_at).total_seconds()
        assert 0.8 * 2**attempt * 10 <= delay <= 1.2 * 2**attempt * 10
        delays.append(delay)
        frozen_clock.at = job.run_at

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert (job.status, job.attempts) == (JobStatus.SUCCEEDED, 3)
    assert delays[1] > delays[0]
    assert [run[2] for run in handlers.of("test.flaky")] == [1, 2, 3]


def test_backoff_is_jittered_and_capped():
    assert backoff(1, 1.0) == timedelta(seconds=20)
    assert backoff(2, 0.8) == timedelta(seconds=32)
    assert backoff(8, 1.0) == timedelta(seconds=2560)
    # 2^9 * 10 s is over an hour: the cap applies before the jitter.
    assert backoff(9, 1.0) == timedelta(hours=1)
    assert backoff(10_000, 1.2) == timedelta(hours=1.2)


async def test_retry_is_not_claimed_before_its_run_at(sessions, handlers: Calls, frozen_clock):
    job_id = await add(sessions, "test.flaky", {"succeed_on": 2})
    await worker(sessions, jitter=lambda: 1.0).run_once()

    frozen_clock.advance(seconds=19)
    assert await worker(sessions).run_once() == 0
    frozen_clock.advance(seconds=1)
    assert await worker(sessions).run_once() == 1

    assert (await load(sessions, job_id)).status is JobStatus.SUCCEEDED


# Criterion 4


async def test_always_failing_job_is_dead_after_max_attempts_without_secrets(
    sessions, handlers: Calls, frozen_clock
):
    job_id = await add(sessions, "test.fail", {"link": SECRET_LINK}, max_attempts=3)

    for _ in range(3):
        await worker(sessions).run_once()
        job = await load(sessions, job_id)
        frozen_clock.at = job.run_at

    job = await load(sessions, job_id)
    assert (job.status, job.attempts) == (JobStatus.DEAD, 3)
    assert job.finished_at is not None
    assert job.last_error is not None
    assert job.last_error.startswith("SecretFailure: could not send ")
    assert "s3cr3t" not in job.last_error
    assert "[redacted]" in job.last_error
    assert len(handlers.of("test.fail")) == 3
    assert await worker(sessions).run_once() == 0


async def test_last_error_is_truncated(sessions, handlers: Calls):
    job_id = await add(sessions, "test.fail", {"link": SECRET_LINK, "pad": 5000})

    await worker(sessions).run_once()

    last_error = (await load(sessions, job_id)).last_error
    assert last_error is not None
    assert len(last_error) == MAX_ERROR_LENGTH == 2000
    assert "s3cr3t" not in last_error


async def test_permanent_error_is_dead_after_one_attempt(sessions, handlers: Calls):
    job_id = await add(sessions, "test.permanent", {})

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert (job.status, job.attempts) == (JobStatus.DEAD, 1)
    assert job.last_error == "PermanentJobError: bad address"


# Criterion 5


async def test_two_workers_run_each_of_20_jobs_exactly_once(committed_sessions, handlers: Calls):
    ids = [await add(committed_sessions, "test.slow", {"seconds": 0.01, "n": n}) for n in range(20)]
    overlap = {"open": 0, "max": 0}

    def slow_commits() -> AsyncSession:
        """A session whose commit waits first, so the other worker's claim runs while this
        one's rows are still locked and uncommitted (without it the claims hardly overlap)."""
        session: AsyncSession = committed_sessions()
        commit = session.commit

        async def slow_commit() -> None:
            overlap["open"] += 1
            overlap["max"] = max(overlap["max"], overlap["open"])
            await asyncio.sleep(0.05)
            overlap["open"] -= 1
            await commit()

        session.commit = slow_commit  # type: ignore[method-assign]
        return session

    a = worker(slow_commits, worker_id="worker-a")
    b = worker(slow_commits, worker_id="worker-b")

    async def drain(w: Worker) -> int:
        total = 0
        while claimed := await w.run_once(batch=5):
            total += claimed
        return total

    claimed = await asyncio.gather(drain(a), drain(b))

    assert overlap["max"] == 2, "the two workers' transactions overlapped"
    assert sum(claimed) == 20
    assert all(claimed), "both workers claimed jobs"
    assert sorted(run[1]["n"] for run in handlers.of("test.slow")) == list(range(20))
    async with committed_sessions() as db:
        jobs = (await db.scalars(select(Job).where(Job.id.in_(ids)))).all()
    assert {(job.status, job.attempts) for job in jobs} == {(JobStatus.SUCCEEDED, 1)}


async def test_a_claim_does_not_wait_for_another_workers_open_claim(
    committed_sessions, handlers: Calls
):
    """SKIP LOCKED: while worker A's claim is uncommitted, worker B claims other jobs at once
    instead of waiting for A (plain FOR UPDATE would block here)."""
    ids = [await add(committed_sessions, "test.echo", {"n": n}) for n in range(4)]
    release = asyncio.Event()

    def held_commits() -> AsyncSession:
        session: AsyncSession = committed_sessions()
        commit = session.commit

        async def held_commit() -> None:
            await release.wait()
            await commit()

        session.commit = held_commit  # type: ignore[method-assign]
        return session

    a = worker(held_commits, worker_id="worker-a")
    b = worker(committed_sessions, worker_id="worker-b")
    a_claim = asyncio.create_task(a.run_once(batch=2))
    await asyncio.sleep(0.2)  # A has locked its two rows and waits to commit

    try:
        assert await asyncio.wait_for(b.run_once(batch=10), timeout=2) == 2
    finally:
        release.set()
        await a_claim

    async with committed_sessions() as db:
        jobs = (await db.scalars(select(Job).where(Job.id.in_(ids)))).all()
    assert {job.status for job in jobs} == {JobStatus.SUCCEEDED}


# Criterion 6


async def test_expired_lease_is_reclaimed(sessions, handlers: Calls):
    job_id = await insert_running(
        sessions, locked_until=clock.now() - timedelta(seconds=1), attempts=1
    )

    assert await worker(sessions).run_once() == 1

    job = await load(sessions, job_id)
    assert (job.status, job.attempts, job.locked_by) == (JobStatus.SUCCEEDED, 2, None)
    assert len(handlers.of("test.echo")) == 1


async def test_unexpired_lease_is_not_claimed(sessions, handlers: Calls):
    job_id = await insert_running(
        sessions, locked_until=clock.now() + timedelta(seconds=30), attempts=1
    )

    assert await worker(sessions).run_once() == 0

    job = await load(sessions, job_id)
    assert (job.status, job.locked_by) == (JobStatus.RUNNING, "crashed-worker")
    assert handlers.runs == []


# Criterion 8


async def test_sensitive_keys_removed_on_success(sessions, handlers: Calls):
    job_id = await add(sessions, "test.secret", {"link": SECRET_LINK, "to": "a@example.test"})

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.SUCCEEDED
    assert job.payload == {"to": "a@example.test"}
    assert handlers.of("test.secret")[0][1]["link"] == SECRET_LINK


async def test_payload_kept_on_retry(sessions, handlers: Calls):
    job_id = await add(sessions, "test.fail", {"link": SECRET_LINK})

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.QUEUED
    assert job.payload == {"link": SECRET_LINK}


# Criterion 10


async def test_unknown_kind_is_dead_and_batch_continues(sessions, handlers: Calls, frozen_clock):
    unknown = await add(sessions, "test.nobody", {})
    frozen_clock.advance(seconds=1)
    known = await add(sessions, "test.echo", {})

    assert await worker(sessions).run_once() == 2

    job = await load(sessions, unknown)
    assert job.status is JobStatus.DEAD
    assert job.last_error == "no handler registered for job kind 'test.nobody'"
    assert (await load(sessions, known)).status is JobStatus.SUCCEEDED


# Criterion 11


async def test_handler_writes_commit_with_success(sessions, handlers: Calls):
    job_id = await add(sessions, "test.echo", {"child": True})

    await worker(sessions).run_once()

    assert (await load(sessions, job_id)).status is JobStatus.SUCCEEDED
    async with sessions() as db:
        children = (
            await db.scalars(select(Job).where(Job.payload["parent"].astext == str(job_id)))
        ).all()
    assert [child.status for child in children] == [JobStatus.QUEUED]


async def test_handler_writes_roll_back_on_failure(sessions, handlers: Calls):
    job_id = await add(sessions, "test.echo", {"child": True, "then_fail": True})

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert (job.status, job.attempts) == (JobStatus.QUEUED, 1)
    assert job.last_error == "RuntimeError: failed after writing"
    async with sessions() as db:
        children = (
            await db.scalars(select(Job).where(Job.payload["parent"].astext == str(job_id)))
        ).all()
    assert children == []


# Criterion 12


async def test_reclaimed_job_past_max_attempts_is_dead_unrun(sessions, handlers: Calls):
    job_id = await insert_running(
        sessions, locked_until=clock.now() - timedelta(seconds=1), attempts=3, max_attempts=3
    )

    assert await worker(sessions).run_once() == 1

    job = await load(sessions, job_id)
    assert job.status is JobStatus.DEAD
    assert job.last_error == "the lease expired during the last attempt (the worker stopped)"
    assert handlers.runs == []


# Criterion 13


@pytest.mark.parametrize("then_fail", [False, True])
async def test_finish_after_lost_lease_changes_nothing(
    committed_sessions, handlers: Calls, then_fail: bool
):
    @job_handler("test.stolen")
    async def stolen(payload: dict[str, Any], ctx: JobContext) -> None:
        # Another worker reclaims the job while this one still runs it.
        async with committed_sessions() as other:
            await other.execute(
                update(Job)
                .where(Job.id == ctx.job_id)
                .values(locked_by="worker-b", locked_until=clock.now() + timedelta(seconds=60))
            )
            await other.commit()
        await enqueue(ctx.db, "test.echo", {"parent": str(ctx.job_id)})
        if payload["then_fail"]:
            raise RuntimeError("late failure")

    job_id = await add(committed_sessions, "test.stolen", {"then_fail": then_fail})

    await worker(committed_sessions).run_once()

    job = await load(committed_sessions, job_id)
    assert (job.status, job.attempts, job.locked_by) == (JobStatus.RUNNING, 1, "worker-b")
    assert (job.finished_at, job.last_error) == (None, None)
    async with committed_sessions() as db:
        children = (
            await db.scalars(select(Job).where(Job.payload["parent"].astext == str(job_id)))
        ).all()
    assert children == []


# Criterion 14


async def test_handler_past_timeout_is_cancelled_and_retried(sessions, handlers: Calls):
    job_id = await add(sessions, "test.slow", {"seconds": 5})

    started = time.monotonic()
    await worker(sessions, handler_timeout=0.05).run_once()

    assert time.monotonic() - started < 2
    job = await load(sessions, job_id)
    assert (job.status, job.attempts) == (JobStatus.QUEUED, 1)
    assert job.last_error is not None
    assert job.last_error.startswith("TimeoutError")


def test_handler_timeout_is_below_the_lease():
    from app.jobs.worker import HANDLER_TIMEOUT, LEASE

    assert LEASE.total_seconds() > HANDLER_TIMEOUT


# Criterion 15


async def test_sigterm_finishes_current_job_releases_the_rest_and_exits_0(
    committed_sessions, migrated_test_database: str, tmp_path: Path
):
    started = tmp_path / "started"
    ids = [
        await add(committed_sessions, "test.marker", {"started": str(started), "seconds": 1.5})
        for _ in range(3)
    ]
    env = {**os.environ, "DATABASE_URL": migrated_test_database, "LOG_LEVEL": "INFO"}
    process = subprocess.Popen(  # noqa: ASYNC220 (waited for below, off the loop)
        [sys.executable, "-m", "tests.jobs.worker_process"],
        cwd=BACKEND_DIR,
        env=env,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
    )
    try:
        for _ in range(200):
            if started.exists():
                break
            await asyncio.sleep(0.05)
        assert started.exists(), process.communicate()[0] if process.poll() is not None else ""
        process.send_signal(signal.SIGTERM)
        output, _ = await asyncio.to_thread(process.communicate, timeout=30)
    finally:
        if process.poll() is None:
            process.kill()

    assert process.returncode == 0, output.decode()
    first = started.read_text()
    jobs = {str(job_id): await load(committed_sessions, job_id) for job_id in ids}
    assert jobs[first].status is JobStatus.SUCCEEDED
    rest = [job for key, job in jobs.items() if key != first]
    assert [(job.status, job.attempts, job.locked_by) for job in rest] == [
        (JobStatus.QUEUED, 0, None)
    ] * 2


# Criterion 16


async def test_heartbeat_logs_counts_every_interval(sessions, handlers: Calls, caplog):
    for payload in ({"n": 1}, {"n": 2}):
        await add(sessions, "test.echo", payload)
    await add(sessions, "test.fail", {"link": SECRET_LINK}, max_attempts=1)
    await add(sessions, "test.flaky", {"succeed_on": 2})
    stop = asyncio.Event()
    caplog.set_level(logging.INFO, logger="app.jobs.worker")

    task = asyncio.create_task(
        worker(sessions, heartbeat_interval=0.05).run_forever(stop, idle_sleep=0.01)
    )
    await asyncio.sleep(0.3)
    stop.set()
    await asyncio.wait_for(task, timeout=5)

    beats = [r for r in caplog.records if r.getMessage() == "worker_heartbeat"]
    assert len(beats) >= 2
    totals = {key: sum(getattr(r, key) for r in beats) for key in ("succeeded", "retried", "dead")}
    assert totals == {"succeeded": 2, "retried": 1, "dead": 1}
    assert all(r.worker_id == "worker-a" for r in beats)
    assert not any("s3cr3t" in str(vars(r)) for r in caplog.records)


async def test_no_heartbeat_before_the_interval(sessions, handlers: Calls, caplog):
    stop = asyncio.Event()
    caplog.set_level(logging.INFO, logger="app.jobs.worker")

    task = asyncio.create_task(
        worker(sessions, heartbeat_interval=30).run_forever(stop, idle_sleep=0.01)
    )
    await asyncio.sleep(0.1)
    stop.set()
    await asyncio.wait_for(task, timeout=5)

    assert not [r for r in caplog.records if r.getMessage() == "worker_heartbeat"]


# Criterion 17: what the compose healthcheck reads


async def test_heartbeat_file_is_touched_per_loop_and_per_job(
    sessions, handlers: Calls, monkeypatch, tmp_path: Path
):
    from app.jobs import worker as worker_module

    beat = tmp_path / "worker_heartbeat"
    monkeypatch.setattr(worker_module, "HEARTBEAT_FILE", beat)
    touched: list[float] = []

    @job_handler("test.watch")
    async def watch(payload: dict[str, Any], ctx: JobContext) -> None:
        touched.append(beat.stat().st_mtime)

    await add(sessions, "test.watch", {})
    await worker(sessions).run_once()
    assert touched, "touched before the job ran"

    beat.unlink()
    stop = asyncio.Event()
    task = asyncio.create_task(worker(sessions).run_forever(stop, idle_sleep=0.01))
    await asyncio.sleep(0.1)
    stop.set()
    await asyncio.wait_for(task, timeout=5)
    assert beat.exists(), "touched by an idle loop"


# Review round 1 (Codex gpt-6.1-sol): each test failed before its fix.


async def test_waiting_batch_job_is_not_run_by_two_live_workers(
    committed_sessions, handlers: Calls, frozen_clock
):
    """Finding 1: jobs later in a batch wait while earlier ones run. Their lease must not lapse
    unnoticed, or another worker reclaims a job this one is about to run."""
    runs: list[tuple[int, str]] = []
    third_started = asyncio.Event()
    release_third = asyncio.Event()

    @job_handler("test.batchlease")
    async def batchlease(payload: dict[str, Any], ctx: JobContext) -> None:
        runs.append((payload["n"], ctx.kind))
        if payload["n"] < 3:
            frozen_clock.advance(seconds=40)  # below the handler timeout, past the lease in total
        elif ctx.attempt == 1:
            third_started.set()
            await release_third.wait()

    for n in (1, 2, 3):
        await add(committed_sessions, "test.batchlease", {"n": n})
        frozen_clock.advance(seconds=0.001)
    a = worker(committed_sessions, worker_id="worker-a")
    b = worker(committed_sessions, worker_id="worker-b")

    task = asyncio.create_task(a.run_once())
    try:
        await asyncio.wait_for(third_started.wait(), timeout=5)
        assert await b.run_once() == 0
    finally:
        release_third.set()
        await task

    assert sorted(n for n, _ in runs) == [1, 2, 3]


async def test_job_whose_lease_another_worker_took_is_skipped(committed_sessions, handlers: Calls):
    """Neighbour of finding 1: if a waiting job of the batch was reclaimed meanwhile, this worker
    must not run it at all."""

    @job_handler("test.first")
    async def first(payload: dict[str, Any], ctx: JobContext) -> None:
        # Meanwhile worker-b reclaims the second job (as after an expired lease).
        async with committed_sessions() as other:
            await other.execute(
                update(Job)
                .where(Job.id == payload["second"])
                .values(locked_by="worker-b", attempts=Job.attempts + 1)
            )
            await other.commit()

    second_id = await add(committed_sessions, "test.echo", {"n": 2}, run_at=clock.now())
    first_id = await add(
        committed_sessions,
        "test.first",
        {"second": str(second_id)},
        run_at=clock.now() - timedelta(seconds=1),
    )

    assert await worker(committed_sessions, worker_id="worker-a").run_once() == 2

    assert (await load(committed_sessions, first_id)).status is JobStatus.SUCCEEDED
    assert handlers.of("test.echo") == [], "worker-a skipped the job it no longer holds"
    second = await load(committed_sessions, second_id)
    assert (second.status, second.locked_by, second.attempts) == (JobStatus.RUNNING, "worker-b", 2)


@pytest.mark.parametrize("kind_length", [65, 64])
async def test_database_error_keeps_no_parameters_in_last_error(
    sessions, handlers: Calls, kind_length: int
):
    """Finding 2: SQLAlchemy cuts long parameters in its message, so value redaction misses them;
    a database error is stored without its message. 64 makes the insert valid, then a duplicate."""
    token = "usable-private-reset-token"  # noqa: S105 (a fake)
    link = f"https://example.test/reset?token={token}&padding=" + "x" * 600

    @job_handler("test.dbsecret", sensitive_keys=("link",))
    async def dbsecret(payload: dict[str, Any], ctx: JobContext) -> None:
        for _ in range(2):  # the second insert breaks the dedupe key's unique constraint
            await ctx.db.execute(
                Job.__table__.insert().values(
                    kind="k" * kind_length, payload={"link": payload["link"]}, dedupe_key=link[:200]
                )
            )

    job_id = await add(sessions, "test.dbsecret", {"link": link}, max_attempts=1)

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.DEAD
    assert job.last_error is not None
    assert token not in job.last_error
    assert "padding" not in job.last_error
    expected = "DBAPIError" if kind_length == 65 else "IntegrityError"
    assert job.last_error.startswith(f"{expected}: database error (")


@pytest.mark.parametrize("container", ["dict", "list"])
async def test_nested_handler_mutation_does_not_remove_redaction_source(
    sessions, handlers: Calls, container: str
):
    """Finding 3: the handler gets a deep copy, so popping a nested secret can't hide it from
    redaction or from the success scrub."""
    token = "nested-private-token"  # noqa: S105 (a fake)
    value: Any = {"token": token} if container == "dict" else [token]

    @job_handler("test.mutatingsecret", sensitive_keys=("credentials",))
    async def mutating(payload: dict[str, Any], ctx: JobContext) -> None:
        nested = payload["credentials"]
        secret = nested.pop("token") if isinstance(nested, dict) else nested.pop()
        raise RuntimeError(f"failed sending {secret}")

    job_id = await add(sessions, "test.mutatingsecret", {"credentials": value})

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.last_error == "RuntimeError: failed sending [redacted]"
    assert job.payload == {"credentials": value}


async def test_heartbeat_is_logged_while_a_batch_runs(sessions, handlers: Calls, caplog):
    """Finding 4 (Medium): a batch of slow jobs must not hold back the heartbeat log."""
    caplog.set_level(logging.INFO, logger="app.jobs.worker")
    stop = asyncio.Event()
    seen: list[bool] = []

    @job_handler("test.busy")
    async def busy(payload: dict[str, Any], ctx: JobContext) -> None:
        seen.append(any(r.getMessage() == "worker_heartbeat" for r in caplog.records))
        await asyncio.sleep(0.1)
        if len(seen) == 3:
            stop.set()

    for _ in range(3):
        await add(sessions, "test.busy", {})

    await asyncio.wait_for(
        worker(sessions, heartbeat_interval=0.15).run_forever(stop, idle_sleep=0.01), timeout=5
    )

    assert seen == [False, False, True], "one beat during the batch, before its third job"
