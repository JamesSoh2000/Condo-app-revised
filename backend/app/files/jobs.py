"""Abandoned uploads (P3-04c, ADR-0007 "Cleanup", ADR-0018), in two jobs.

`files.cleanup` (daily) marks `pending` files created more than 24 h ago and `ready`, unattached
ones created more than 7 days ago `deleting`, and enqueues `files.purge` in the same transaction.
It touches no object. Once that commits, no claim, completion or download can use those files.

`files.purge` deletes each `deleting` file's S3 versions, then its row. Whatever happens to it (a
refused object, a timeout while an S3 call still runs in its thread), the row stays `deleting` and
the next purge tries again; the daily cleanup enqueues one while any is left.
"""

import logging
from datetime import timedelta
from time import monotonic
from typing import Any

from sqlalchemy import and_, delete, exists, or_, select, update

from app.core import clock
from app.files import storage
from app.files.models import File, FileStatus
from app.jobs.registry import JobContext, job_handler
from app.jobs.service import enqueue

logger = logging.getLogger(__name__)

PENDING_MAX_AGE = timedelta(hours=24)
UNATTACHED_MAX_AGE = timedelta(days=7)
# One run's limits; the purge's budget stays well inside the worker's 50 s HANDLER_TIMEOUT. What's
# left waits for the next daily run.
CLEANUP_BATCH = 500
CLEANUP_BUDGET = 30.0


@job_handler("files.cleanup")
async def cleanup_files(payload: dict[str, Any], ctx: JobContext) -> None:
    """Mark abandoned files `deleting`; enqueue a purge if any file is `deleting`. Never commits."""
    now = clock.now()
    # Locked with the conditions in the same statement: a claim or completion in flight holds its
    # row, so it is skipped; one arriving later waits, then finds the file `deleting`.
    eligible = (
        select(File.id)
        .where(
            File.attached_id.is_(None),
            or_(
                and_(File.status == FileStatus.PENDING, File.created_at < now - PENDING_MAX_AGE),
                and_(File.status == FileStatus.READY, File.created_at < now - UNATTACHED_MAX_AGE),
            ),
        )
        .order_by(File.created_at)
        .limit(CLEANUP_BATCH)
        .with_for_update(skip_locked=True)
    )
    ids = list(await ctx.db.scalars(eligible))
    if ids:
        await ctx.db.execute(
            update(File)
            .where(File.id.in_(ids))
            .values(status=FileStatus.DELETING)
            .execution_options(synchronize_session=False)
        )
    if await ctx.db.scalar(select(exists().where(File.status == FileStatus.DELETING))):
        await enqueue(ctx.db, "files.purge", {}, dedupe_key=f"files.purge:{ctx.job_id}")
    logger.info("files_marked", extra={"marked": len(ids)})


@job_handler("files.purge")
async def purge_files(payload: dict[str, Any], ctx: JobContext) -> None:
    """Delete `deleting` files: every S3 version, then the row. Never commits."""
    doomed = (
        select(File.id, File.s3_key)
        .where(File.status == FileStatus.DELETING)
        .order_by(File.created_at)
        .limit(CLEANUP_BATCH)
        # A second purge at the same time takes other rows instead of waiting.
        .with_for_update(skip_locked=True)
    )
    candidates = (await ctx.db.execute(doomed)).all()
    started = monotonic()
    deleted = failed = 0
    for file_id, key in candidates:
        if monotonic() - started >= CLEANUP_BUDGET:
            break
        try:
            await storage.delete_versions(key)
        except Exception as exc:
            # The row stays `deleting` and the next purge tries again.
            logger.warning(
                "file_purge_failed",
                extra={"file_id": str(file_id), "error_type": type(exc).__name__},
            )
            failed += 1
            continue
        await ctx.db.execute(delete(File).where(File.id == file_id))
        deleted += 1
    logger.info(
        "files_purged",
        extra={"deleted": deleted, "failed": failed, "left": len(candidates) - deleted - failed},
    )
