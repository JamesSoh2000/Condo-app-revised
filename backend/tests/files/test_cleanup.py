"""`files.cleanup` and `files.purge` (P3-04c criteria 8, 25 to 35): old pending and unattached
files are marked `deleting`, then their S3 versions and rows are deleted."""

import asyncio
import json
import threading
import uuid
from collections.abc import AsyncIterator
from datetime import timedelta
from typing import Any

import anyio.to_thread
import pytest
from sqlalchemy import delete, func, select, text, update
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession

from app.buildings.models import Building
from app.core import clock
from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.files import jobs, service, storage
from app.files.models import File, FilePurpose, FileStatus
from app.files.service import FileNotFound, claim_file, complete_file, download_url
from app.jobs import registry
from app.jobs.models import Job, JobStatus
from app.jobs.registry import JobContext
from app.jobs.service import enqueue
from app.jobs.worker import HANDLER_MODULES, RECURRING_KINDS, Worker
from app.logging_config import JsonFormatter
from app.memberships.enums import Role
from app.users.models import User
from tests.conftest import FrozenClock
from tests.files.conftest import png
from tests.files.test_claim import _wait_until_blocked_on_a_lock, ctx_of

pytestmark = pytest.mark.anyio

HOUR, DAY, SECOND = timedelta(hours=1), timedelta(days=1), timedelta(seconds=1)
MAINTENANCE = FilePurpose.MAINTENANCE_PHOTO


async def a_file(
    db: AsyncSession,
    building_id: uuid.UUID,
    uploader_id: uuid.UUID,
    *,
    age: timedelta,
    status: FileStatus = FileStatus.READY,
    attached: bool = False,
    uploaded: bool = True,
) -> File:
    """A file row created `age` ago; with `uploaded`, its key holds an object (the one pinned)."""
    file_id = uuid.uuid7()
    key = f"b/{building_id}/{MAINTENANCE}/{file_id}"
    version = None
    if uploaded:
        put = storage.client().put_object(
            Bucket=settings.s3_bucket_name, Key=key, Body=png(), ContentType="image/png"
        )
        version = put["VersionId"]
    file = File(
        id=file_id,
        building_id=building_id,
        uploaded_by_user_id=uploader_id,
        purpose=MAINTENANCE,
        s3_key=key,
        s3_version_id=(version or "v1") if status is FileStatus.READY else None,
        content_type="image/png",
        size_bytes=64,
        original_name="x.png",
        status=status,
        attached_type="maintenance_request" if attached else None,
        attached_id=uuid.uuid4() if attached else None,
        created_at=clock.now() - age,
    )
    db.add(file)
    await db.flush()
    return file


def versions_of(key: str) -> list[str]:
    listed = storage.client().list_object_versions(Bucket=settings.s3_bucket_name, Prefix=key)
    entries = listed.get("Versions", []) + listed.get("DeleteMarkers", [])
    return [entry["VersionId"] for entry in entries if entry["Key"] == key]


async def file_ids(db: AsyncSession) -> set[uuid.UUID]:
    return set(await db.scalars(select(File.id)))


async def status_of(db: AsyncSession, file_id: uuid.UUID) -> FileStatus | None:
    return await db.scalar(select(File.status).where(File.id == file_id))


def job_ctx(db: AsyncSession, kind: str) -> JobContext:
    return JobContext(db=db, job_id=uuid.uuid4(), kind=kind, attempt=1)


async def mark(db: AsyncSession) -> JobContext:
    ctx = job_ctx(db, "files.cleanup")
    await jobs.cleanup_files({}, ctx)
    return ctx


async def purge(db: AsyncSession) -> None:
    await jobs.purge_files({}, job_ctx(db, "files.purge"))


async def run_cleanup(db: AsyncSession) -> None:
    """The daily job, then the purge it enqueues."""
    await mark(db)
    await purge(db)


async def purge_jobs(db: AsyncSession) -> list[str | None]:
    return list(await db.scalars(select(Job.dedupe_key).where(Job.kind == "files.purge")))


@pytest.fixture
def no_commit(monkeypatch, db: AsyncSession) -> None:
    """The handlers write in the job's transaction and never commit (CLAUDE.md rule 5)."""

    async def refuse() -> None:
        raise AssertionError("a files job committed")

    monkeypatch.setattr(db, "commit", refuse)


# --- 8: old pending and unattached files go; attached ones stay ---------------------------------


async def test_cleanup_then_purge_deletes_old_pending_and_unattached_files_and_keeps_attached_ones(
    db, world, frozen_clock: FrozenClock, no_commit
):
    uploader = world.a_resident1.user.id
    old_pending = await a_file(db, world.a.id, uploader, age=25 * HOUR, status=FileStatus.PENDING)
    old_unattached = await a_file(db, world.a.id, uploader, age=8 * DAY)
    attached = await a_file(db, world.a.id, uploader, age=400 * DAY, attached=True)
    # A second version on the attached key: every version stays, not only the pinned one.
    storage.client().put_object(Bucket=settings.s3_bucket_name, Key=attached.s3_key, Body=png(32))
    young_pending = await a_file(db, world.a.id, uploader, age=HOUR, status=FileStatus.PENDING)
    young_unattached = await a_file(db, world.a.id, uploader, age=DAY)
    before = await file_ids(db)

    await run_cleanup(db)

    assert before - await file_ids(db) == {old_pending.id, old_unattached.id}
    assert versions_of(old_pending.s3_key) == []
    assert versions_of(old_unattached.s3_key) == []
    assert len(versions_of(attached.s3_key)) == 2
    assert len(versions_of(young_pending.s3_key)) == 1
    assert len(versions_of(young_unattached.s3_key)) == 1
    assert await status_of(db, attached.id) is FileStatus.READY
    assert await status_of(db, young_pending.id) is FileStatus.PENDING


# --- 33: the cleanup only marks; the purge deletes ----------------------------------------------


async def test_cleanup_only_marks_files_deleting_and_enqueues_the_purge(
    db, world, frozen_clock: FrozenClock, no_commit
):
    uploader = world.a_resident1.user.id
    old_pending = await a_file(db, world.a.id, uploader, age=2 * DAY, status=FileStatus.PENDING)
    old_ready = await a_file(db, world.a.id, uploader, age=8 * DAY)
    young = await a_file(db, world.a.id, uploader, age=DAY)

    ctx = await mark(db)

    assert await status_of(db, old_pending.id) is FileStatus.DELETING
    assert await status_of(db, old_ready.id) is FileStatus.DELETING
    assert await status_of(db, young.id) is FileStatus.READY
    # No object is touched before the mark commits.
    assert len(versions_of(old_pending.s3_key)) == 1
    assert len(versions_of(old_ready.s3_key)) == 1
    assert await purge_jobs(db) == [f"files.purge:{ctx.job_id}"]


async def test_cleanup_enqueues_no_purge_when_nothing_is_deleting(
    db, world, frozen_clock: FrozenClock, no_commit
):
    await a_file(db, world.a.id, world.a_resident1.user.id, age=DAY)

    await mark(db)

    assert await purge_jobs(db) == []


async def test_cleanup_enqueues_a_purge_for_files_left_deleting(
    db, world, frozen_clock: FrozenClock, no_commit
):
    # Left by an earlier purge that failed; nothing new is eligible.
    left = await a_file(
        db, world.a.id, world.a_resident1.user.id, age=DAY, status=FileStatus.DELETING
    )

    ctx = await mark(db)

    assert await purge_jobs(db) == [f"files.purge:{ctx.job_id}"]
    await purge(db)
    assert left.id not in await file_ids(db)


# --- 34: a `deleting` file is gone for every caller ---------------------------------------------


async def test_a_deleting_file_cannot_be_claimed_downloaded_or_completed(db, world, monkeypatch):
    resident = world.a_resident1
    ctx = ctx_of(resident.user.id, world.a.id, Role.RESIDENT)
    ready = await a_file(db, world.a.id, resident.user.id, age=8 * DAY)
    pending = await a_file(db, world.a.id, resident.user.id, age=2 * DAY, status=FileStatus.PENDING)
    ready_id, pending_id = ready.id, pending.id
    await mark(db)
    await db.commit()
    db.expire_all()  # as a request's own session would read them

    async def no_s3(*args: Any, **kwargs: Any) -> None:
        raise AssertionError("S3 was asked about a deleting file")

    monkeypatch.setattr(storage, "head", no_s3)

    with pytest.raises(FileNotFound):
        await claim_file(db, ctx, ready_id, MAINTENANCE, "maintenance_request", uuid.uuid4())
    with pytest.raises(FileNotFound):
        await download_url(db, ctx, ready_id)
    with pytest.raises(FileNotFound):
        await complete_file(db, ctx, pending_id)
    assert await status_of(db, ready_id) is FileStatus.DELETING
    assert await status_of(db, pending_id) is FileStatus.DELETING


# --- 25: age boundaries ------------------------------------------------------------------------


async def test_cleanup_age_boundaries(db, world, frozen_clock: FrozenClock, no_commit):
    uploader = world.a_resident1.user.id

    async def pending(age: timedelta) -> File:
        return await a_file(db, world.a.id, uploader, age=age, status=FileStatus.PENDING)

    async def ready(age: timedelta) -> File:
        return await a_file(db, world.a.id, uploader, age=age)

    kept = {
        (await pending(24 * HOUR)).id,
        (await pending(24 * HOUR - timedelta(minutes=1))).id,
        (await ready(7 * DAY)).id,
        # Older than the pending limit, younger than the ready one.
        (await ready(2 * DAY)).id,
    }
    deleted = {(await pending(24 * HOUR + SECOND)).id, (await ready(7 * DAY + SECOND)).id}

    await run_cleanup(db)

    remaining = await file_ids(db)
    assert kept <= remaining
    assert not deleted & remaining


# --- 26: a pending row with nothing uploaded --------------------------------------------------


async def test_cleanup_deletes_a_pending_row_with_nothing_uploaded(
    db, world, frozen_clock: FrozenClock, no_commit
):
    file = await a_file(
        db,
        world.a.id,
        world.a_resident1.user.id,
        age=2 * DAY,
        status=FileStatus.PENDING,
        uploaded=False,
    )

    await run_cleanup(db)

    assert file.id not in await file_ids(db)


# --- 27: a failed S3 delete keeps its row `deleting`; the run goes on ---------------------------


async def test_a_failed_s3_delete_keeps_that_row_deleting_and_the_run_goes_on(
    db, world, frozen_clock: FrozenClock, monkeypatch, caplog
):
    uploader = world.a_resident1.user.id
    failing = await a_file(db, world.a.id, uploader, age=10 * DAY)
    other = await a_file(db, world.a.id, uploader, age=9 * DAY)
    real = storage.delete_versions

    async def flaky(key: str) -> None:
        if key == failing.s3_key:
            raise storage.DeleteVersionsError("S3 refused 1 object(s), first AccessDenied")
        await real(key)

    monkeypatch.setattr(storage, "delete_versions", flaky)

    await run_cleanup(db)

    remaining = await file_ids(db)
    assert failing.id in remaining and other.id not in remaining
    assert await status_of(db, failing.id) is FileStatus.DELETING
    assert len(versions_of(failing.s3_key)) == 1
    # As production writes them (the formatter keeps only allowlisted extras), without the key.
    logged = {
        r.getMessage(): json.loads(JsonFormatter().format(r))
        for r in caplog.records
        if r.name == "app.files.jobs"
    }
    assert logged["files_marked"]["marked"] == 2
    failure = logged["file_purge_failed"]
    assert (failure["file_id"], failure["error_type"]) == (str(failing.id), "DeleteVersionsError")
    summary = logged["files_purged"]
    assert (summary["deleted"], summary["failed"], summary["left"]) == (1, 1, 0)
    assert failing.s3_key not in caplog.text and failing.s3_key not in json.dumps(logged)

    # The next day, with S3 back: the cleanup enqueues a purge for it, and the purge deletes it.
    monkeypatch.setattr(storage, "delete_versions", real)
    await run_cleanup(db)

    assert failing.id not in await file_ids(db)
    assert versions_of(failing.s3_key) == []


async def test_a_partly_deleted_file_stays_deleting_and_unclaimable(db, world, monkeypatch):
    """Review round 1: S3 deleted the pinned version but refused another one."""
    resident = world.a_resident1
    file = await a_file(db, world.a.id, resident.user.id, age=8 * DAY)
    assert file.s3_version_id is not None
    pinned: str = file.s3_version_id
    real = storage.client()
    bucket = settings.s3_bucket_name
    other = real.put_object(Bucket=bucket, Key=file.s3_key, Body=b"newer")["VersionId"]

    class PartlyRefusing:
        def __getattr__(self, name: str) -> Any:
            return getattr(real, name)

        def delete_objects(self, **kwargs: Any) -> dict[str, Any]:
            real.delete_object(Bucket=bucket, Key=file.s3_key, VersionId=pinned)
            return {"Errors": [{"Key": file.s3_key, "VersionId": other, "Code": "AccessDenied"}]}

    monkeypatch.setattr(storage, "client", lambda: PartlyRefusing())
    await run_cleanup(db)
    await db.commit()

    assert await status_of(db, file.id) is FileStatus.DELETING
    ctx = ctx_of(resident.user.id, world.a.id, Role.RESIDENT)
    with pytest.raises(FileNotFound):
        await claim_file(db, ctx, file.id, MAINTENANCE, "maintenance_request", uuid.uuid4())
    with pytest.raises(FileNotFound):
        await download_url(db, ctx, file.id)

    monkeypatch.setattr(storage, "client", lambda: real)
    await run_cleanup(db)
    assert file.id not in await file_ids(db)
    assert versions_of(file.s3_key) == []


# --- 29: bounded runs ----------------------------------------------------------------------------


async def test_one_cleanup_marks_at_most_the_batch_oldest_first(
    db, world, frozen_clock: FrozenClock, monkeypatch, no_commit
):
    uploader = world.a_resident1.user.id
    oldest = await a_file(db, world.a.id, uploader, age=30 * DAY)
    older = await a_file(db, world.a.id, uploader, age=20 * DAY, status=FileStatus.PENDING)
    newest = await a_file(db, world.a.id, uploader, age=10 * DAY)
    monkeypatch.setattr(jobs, "CLEANUP_BATCH", 2)

    await mark(db)

    assert await status_of(db, newest.id) is FileStatus.READY
    assert await status_of(db, oldest.id) is FileStatus.DELETING
    assert await status_of(db, older.id) is FileStatus.DELETING


async def test_one_purge_deletes_at_most_the_batch_oldest_first(
    db, world, frozen_clock: FrozenClock, monkeypatch, no_commit
):
    uploader = world.a_resident1.user.id
    oldest = await a_file(db, world.a.id, uploader, age=30 * DAY)
    older = await a_file(db, world.a.id, uploader, age=20 * DAY)
    newest = await a_file(db, world.a.id, uploader, age=10 * DAY)
    await mark(db)
    monkeypatch.setattr(jobs, "CLEANUP_BATCH", 2)

    await purge(db)

    remaining = await file_ids(db)
    assert newest.id in remaining and not {oldest.id, older.id} & remaining


async def test_no_s3_delete_starts_after_the_budget(
    db, world, frozen_clock: FrozenClock, monkeypatch, no_commit
):
    uploader = world.a_resident1.user.id
    first = await a_file(db, world.a.id, uploader, age=30 * DAY)
    second = await a_file(db, world.a.id, uploader, age=20 * DAY)
    elapsed = [0.0]
    real = storage.delete_versions
    started: list[str] = []

    async def slow(key: str) -> None:
        started.append(key)
        await real(key)
        elapsed[0] += jobs.CLEANUP_BUDGET + 1  # this one delete used up the budget

    monkeypatch.setattr(storage, "delete_versions", slow)
    monkeypatch.setattr(jobs, "monotonic", lambda: elapsed[0])

    await run_cleanup(db)

    assert started == [first.s3_key]
    remaining = await file_ids(db)
    assert first.id not in remaining and second.id in remaining
    assert await status_of(db, second.id) is FileStatus.DELETING
    assert len(versions_of(second.s3_key)) == 1


def test_the_run_limits():
    assert (jobs.CLEANUP_BATCH, jobs.CLEANUP_BUDGET) == (500, 30.0)
    assert (jobs.PENDING_MAX_AGE, jobs.UNATTACHED_MAX_AGE) == (24 * HOUR, 7 * DAY)


# --- 30: every building ------------------------------------------------------------------------


async def test_cleanup_deletes_eligible_files_of_every_building(
    db, world, frozen_clock: FrozenClock, no_commit
):
    in_a = await a_file(db, world.a.id, world.a_resident1.user.id, age=8 * DAY)
    in_b = await a_file(db, world.b.id, world.b_manager.user.id, age=8 * DAY)
    kept_b = await a_file(db, world.b.id, world.b_manager.user.id, age=8 * DAY, attached=True)
    before = await file_ids(db)

    await run_cleanup(db)

    assert before - await file_ids(db) == {in_a.id, in_b.id}
    assert kept_b.id in await file_ids(db)


# --- 31: in the worker, in the job's transaction ------------------------------------------------


def test_the_worker_runs_files_cleanup_daily_and_files_purge_on_demand():
    assert "app.files.jobs" in HANDLER_MODULES
    assert "files.cleanup" in RECURRING_KINDS
    assert "files.purge" not in RECURRING_KINDS  # enqueued by the cleanup
    assert registry.HANDLERS["files.cleanup"].sensitive_keys == ()
    assert registry.HANDLERS["files.purge"].sensitive_keys == ()


@pytest.fixture
def sessions(db_connection: AsyncConnection):
    return lambda: AsyncSessionLocal(bind=db_connection, join_transaction_mode="create_savepoint")


async def test_files_cleanup_and_its_purge_run_in_the_worker(
    db, world, sessions, frozen_clock: FrozenClock
):
    file = await a_file(db, world.a.id, world.a_resident1.user.id, age=8 * DAY)
    file_id, key = file.id, file.s3_key
    job_id = await enqueue(db, "files.cleanup", {})
    await db.commit()

    # The cleanup, then the purge it enqueued (due at once).
    assert await Worker(sessions, recurring=()).run_once() == 2

    db.expire_all()
    statuses = (await db.execute(select(Job.kind, Job.status).order_by(Job.created_at))).all()
    assert [tuple(row) for row in statuses] == [
        ("files.cleanup", JobStatus.SUCCEEDED),
        ("files.purge", JobStatus.SUCCEEDED),
    ]
    assert (await db.get_one(Job, job_id)).status is JobStatus.SUCCEEDED
    assert file_id not in await file_ids(db)
    assert versions_of(key) == []


async def test_a_failing_cleanup_rolls_its_marks_and_its_purge_back(
    db, world, sessions, frozen_clock: FrozenClock, monkeypatch
):
    file = await a_file(db, world.a.id, world.a_resident1.user.id, age=8 * DAY)
    file_id = file.id
    job_id = await enqueue(db, "files.cleanup", {})
    await db.commit()

    class Broken:
        def info(self, *args: Any, **kwargs: Any) -> None:
            raise RuntimeError("failed after marking")

        def warning(self, *args: Any, **kwargs: Any) -> None:
            pass

    monkeypatch.setattr(jobs, "logger", Broken())

    assert await Worker(sessions, recurring=()).run_once() == 1

    db.expire_all()
    assert (await db.get_one(Job, job_id)).status is JobStatus.QUEUED  # retried later
    assert await status_of(db, file_id) is FileStatus.READY
    assert await purge_jobs(db) == []


async def test_a_purge_timing_out_mid_delete_leaves_nothing_claimable(
    db, db_connection, world, sessions, monkeypatch
):
    """Review round 1: the worker's timeout rolls the purge back while its S3 call still runs in its
    thread. The row stays `deleting`, so a claim can't attach the object being deleted."""
    resident = world.a_resident1
    file = await a_file(db, world.a.id, resident.user.id, age=8 * DAY)
    file_id, key = file.id, file.s3_key
    ctx = ctx_of(resident.user.id, world.a.id, Role.RESIDENT)
    await mark(db)
    [purge_key] = await purge_jobs(db)
    await db.commit()
    real = storage.client()
    started, release, finished = threading.Event(), threading.Event(), threading.Event()

    class Slow:
        def __getattr__(self, name: str) -> Any:
            return getattr(real, name)

        def delete_objects(self, **kwargs: Any) -> Any:
            started.set()
            try:
                if not release.wait(5):
                    raise RuntimeError("never released")
                return real.delete_objects(**kwargs)
            finally:
                finished.set()

    monkeypatch.setattr(storage, "client", lambda: Slow())
    try:
        assert await Worker(sessions, recurring=(), handler_timeout=0.4).run_once() == 1
        assert started.is_set() and not finished.is_set()
        db.expire_all()
        purge_job = await db.scalar(select(Job).where(Job.dedupe_key == purge_key))
        assert purge_job is not None and purge_job.status is JobStatus.QUEUED
        assert await status_of(db, file_id) is FileStatus.DELETING
        with pytest.raises(FileNotFound):
            await claim_file(db, ctx, file_id, MAINTENANCE, "maintenance_request", uuid.uuid4())
    finally:
        release.set()
        assert await anyio.to_thread.run_sync(finished.wait, 5)

    # The thread finished deleting; the row is still there, and the next purge removes it.
    assert versions_of(key) == []
    assert await status_of(db, file_id) is FileStatus.DELETING
    monkeypatch.setattr(storage, "client", lambda: real)
    await purge(db)
    assert file_id not in await file_ids(db)


# --- 32: the index -----------------------------------------------------------------------------


async def test_the_cleanup_query_has_its_partial_index(db):
    indexdef = await db.scalar(
        text("SELECT indexdef FROM pg_indexes WHERE indexname = 'ix_files_unattached_created_at'")
    )
    assert indexdef is not None
    assert "(created_at)" in indexdef and "WHERE (attached_id IS NULL)" in indexdef


# --- 28: a claim or completion racing the cleanup -----------------------------------------------


@pytest.fixture
async def committed_old_file(engine: AsyncEngine) -> AsyncIterator[dict[str, Any]]:
    """A building, a user and their 8-day-old ready, unattached file with its object, committed."""
    async with AsyncSessionLocal(bind=engine) as s:
        building = Building(
            slug=f"clean-{uuid.uuid4().hex[:8]}",
            name="Cleanup",
            address="1 Main St",
            timezone="UTC",
        )
        user = User(email=f"clean-{uuid.uuid4().hex[:8]}@x.io", full_name="Someone")
        s.add_all([building, user])
        await s.flush()
        file = await a_file(s, building.id, user.id, age=8 * DAY)
        ids = {"building": building.id, "user": user.id, "file": file.id, "key": file.s3_key}
        await s.commit()
    try:
        yield ids
    finally:
        async with AsyncSessionLocal(bind=engine) as s:
            await s.execute(delete(Job).where(Job.kind == "files.purge"))
            await s.execute(delete(File).where(File.building_id == ids["building"]))
            await s.execute(delete(User).where(User.id == ids["user"]))
            await s.execute(delete(Building).where(Building.id == ids["building"]))
            await s.commit()


async def test_a_file_being_claimed_is_skipped_and_stays_attached(engine, committed_old_file):
    ids = committed_old_file
    ctx = ctx_of(ids["user"], ids["building"], Role.RESIDENT)
    record_id = uuid.uuid4()

    async with engine.connect() as c1, engine.connect() as c2:
        claimer, job = AsyncSessionLocal(bind=c1), AsyncSessionLocal(bind=c2)
        await claim_file(claimer, ctx, ids["file"], MAINTENANCE, "maintenance_request", record_id)

        # Holding the claim's lock: the cleanup skips the row instead of waiting for it.
        await asyncio.wait_for(run_cleanup(job), timeout=10)
        await job.commit()
        await claimer.commit()

    async with AsyncSessionLocal(bind=engine) as s:
        file = await s.get_one(File, ids["file"])
        assert (file.status, file.attached_type, file.attached_id) == (
            FileStatus.READY,
            "maintenance_request",
            record_id,
        )
    assert len(versions_of(ids["key"])) == 1


async def test_a_claim_waiting_on_the_cleanup_gets_file_not_found(engine, committed_old_file):
    ids = committed_old_file
    ctx = ctx_of(ids["user"], ids["building"], Role.RESIDENT)

    async with engine.connect() as c1, engine.connect() as c2:
        job, claimer = AsyncSessionLocal(bind=c1), AsyncSessionLocal(bind=c2)
        pid = (await c2.execute(select(func.pg_backend_pid()))).scalar_one()
        await c2.commit()

        await mark(job)  # holds the row, marked `deleting`, uncommitted

        async def claim() -> None:
            try:
                await claim_file(claimer, ctx, ids["file"], MAINTENANCE, "r", uuid.uuid4())
            finally:
                await claimer.rollback()

        task = asyncio.create_task(claim())
        try:
            await _wait_until_blocked_on_a_lock(engine, pid)
        finally:
            await job.commit()
        with pytest.raises(FileNotFound):
            await task

    async with AsyncSessionLocal(bind=engine) as s:
        file = await s.get_one(File, ids["file"])
        assert (file.status, file.attached_id) == (FileStatus.DELETING, None)
    assert len(versions_of(ids["key"])) == 1  # until the purge


@pytest.mark.parametrize(
    "when", ["before_head", "after_head", "purge_failed_after_s3", "after_verify"]
)
async def test_completion_racing_the_cleanup_is_file_not_found(db, world, monkeypatch, when):
    """Review round 1 (before and after HEAD); after the checks: the conditional update misses."""
    uploader = world.a_resident1.user.id
    file = await a_file(db, world.a.id, uploader, age=2 * DAY, status=FileStatus.PENDING)
    await db.commit()
    real_head, real_verify = storage.head, service._verify

    async def racing_head(key: str) -> storage.ObjectHead | None:
        if when == "before_head":
            await run_cleanup(db)
        if when == "purge_failed_after_s3":
            # Marked, and a purge deleted the objects but not the row (it failed afterwards).
            await mark(db)
            await storage.delete_versions(key)
        found = await real_head(key)
        if when == "after_head":
            await run_cleanup(db)
        return found

    async def racing_verify(target: File) -> str:
        version = await real_verify(target)
        if when == "after_verify":
            await mark(db)  # marked, not yet purged: the row is still there
        return version

    monkeypatch.setattr(storage, "head", racing_head)
    monkeypatch.setattr(service, "_verify", racing_verify)

    with pytest.raises(FileNotFound):
        await complete_file(db, ctx_of(uploader, world.a.id, Role.RESIDENT), file.id)
    assert await status_of(db, file.id) in (None, FileStatus.DELETING)


async def test_completion_of_a_row_purged_meanwhile_is_file_not_found(db, world, monkeypatch):
    uploader = world.a_resident1.user.id
    file = await a_file(db, world.a.id, uploader, age=2 * DAY, status=FileStatus.PENDING)
    await db.commit()
    real_verify = service._verify

    async def verify_then_row_goes(target: File) -> str:
        version = await real_verify(target)
        await db.execute(delete(File).where(File.id == target.id))
        return version

    monkeypatch.setattr(service, "_verify", verify_then_row_goes)

    with pytest.raises(FileNotFound):
        await complete_file(db, ctx_of(uploader, world.a.id, Role.RESIDENT), file.id)


async def test_a_ready_file_is_not_marked_while_its_claim_commits_first(db, world, no_commit):
    """A claim committed before the cleanup's statement leaves the file attached: not eligible."""
    file = await a_file(db, world.a.id, world.a_resident1.user.id, age=8 * DAY)
    await db.execute(
        update(File)
        .where(File.id == file.id)
        .values(attached_type="maintenance_request", attached_id=uuid.uuid4())
    )

    await run_cleanup(db)

    assert await status_of(db, file.id) is FileStatus.READY
    assert len(versions_of(file.s3_key)) == 1
