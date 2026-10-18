"""`jobs.cleanup`, scheduled daily by the worker (P3-01b)."""

import logging
from typing import Any

from app.jobs import registry
from app.jobs.registry import JobContext, job_handler
from app.jobs.service import delete_old_succeeded_jobs, scrub_dead_jobs

logger = logging.getLogger(__name__)


@job_handler("jobs.cleanup")
async def cleanup_jobs(payload: dict[str, Any], ctx: JobContext) -> None:
    """Delete old successes and drop old dead jobs' secrets, in the job's transaction."""
    deleted = await delete_old_succeeded_jobs(ctx.db)
    sensitive = {kind: spec.sensitive_keys for kind, spec in registry.HANDLERS.items()}
    scrubbed = await scrub_dead_jobs(ctx.db, sensitive)
    logger.info("jobs_cleaned", extra={"deleted": deleted, "scrubbed": scrubbed})
