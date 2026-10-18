"""`sessions.cleanup`, scheduled daily by the worker (P3-01b)."""

import logging
from typing import Any

from app.auth.service import delete_ended_sessions
from app.jobs.registry import JobContext, job_handler

logger = logging.getLogger(__name__)


@job_handler("sessions.cleanup")
async def cleanup_sessions(payload: dict[str, Any], ctx: JobContext) -> None:
    deleted = await delete_ended_sessions(ctx.db)
    logger.info("sessions_cleaned", extra={"deleted": deleted})
