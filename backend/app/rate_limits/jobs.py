"""`rate_limits.cleanup`, scheduled daily by the worker (P3-01b)."""

import logging
from typing import Any

from app.jobs.registry import JobContext, job_handler
from app.rate_limits.service import delete_expired_rate_limits

logger = logging.getLogger(__name__)


@job_handler("rate_limits.cleanup")
async def cleanup_rate_limits(payload: dict[str, Any], ctx: JobContext) -> None:
    deleted = await delete_expired_rate_limits(ctx.db)
    logger.info("rate_limits_cleaned", extra={"deleted": deleted})
