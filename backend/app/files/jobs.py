"""`files.cleanup`, scheduled daily by the worker (P3-04c, ADR-0007 "Cleanup").

Deletes `pending` files created more than 24 h ago and `ready`, unattached ones created more than
7 days ago: every S3 version of the key, then the row. The rows are locked first (`SKIP LOCKED`,
eligibility re-checked in the same statement), so a file being claimed is skipped and a claim
arriving later waits, then finds no file. A row whose S3 delete fails is kept for the next run.
"""

import logging
from datetime import timedelta
from time import monotonic
from typing import Any

from sqlalchemy import and_, delete, or_, select

from app.core import clock
from app.files import storage
from app.files.models import File, FileStatus
from app.jobs.registry import JobContext, job_handler

logger = logging.getLogger(__name__)

PENDING_MAX_AGE = timedelta(hours=24)
UNATTACHED_MAX_AGE = timedelta(days=7)
# One run's limits, well inside the worker's 50 s HANDLER_TIMEOUT; the rest waits for the next run.
CLEANUP_BATCH = 500
CLEANUP_BUDGET = 30.0


@job_handler("files.cleanup")
async def cleanup_files(payload: dict[str, Any], ctx: JobContext) -> None:
    """Delete abandoned files, in the job's transaction (never commits)."""
    now = clock.now()
    eligible = (
        select(File.id, File.s3_key)
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
    candidates = (await ctx.db.execute(eligible)).all()
    started = monotonic()
    deleted = failed = 0
    for file_id, key in candidates:
        if monotonic() - started >= CLEANUP_BUDGET:
            break
        try:
            await storage.delete_versions(key)
        except Exception as exc:
            # The row stays (still pointing at whatever is left) and the next run tries again.
            logger.warning(
                "file_cleanup_failed",
                extra={"file_id": str(file_id), "error_type": type(exc).__name__},
            )
            failed += 1
            continue
        await ctx.db.execute(delete(File).where(File.id == file_id))
        deleted += 1
    logger.info(
        "files_cleaned",
        extra={"deleted": deleted, "failed": failed, "left": len(candidates) - deleted - failed},
    )
