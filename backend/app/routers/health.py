import logging

from fastapi import APIRouter
from fastapi.responses import JSONResponse

from app.core.config import settings
from app.core.database import check_database_connection
from app.logging_config import request_id_ctx

router = APIRouter(tags=["health"])
logger = logging.getLogger("app.health")


@router.get("/health")
async def health() -> dict[str, str]:
    """
    Lightweight liveness check.

    This confirms that the FastAPI process is running.
    It should stay fast and should not depend on external services.
    """
    return {
        "status": "ok",
    }


@router.get("/ready", response_model=None)
async def ready() -> dict[str, object] | JSONResponse:
    checks: dict[str, str] = {
        "app": "ok",
        "database": "skipped",
    }

    if settings.readiness_check_database:
        try:
            await check_database_connection()
            checks["database"] = "ok"
        except Exception as exc:
            # The error details go to the log only; clients get a generic body.
            logger.exception(
                "readiness_check_failed",
                extra={"request_id": request_id_ctx.get(), "error_type": type(exc).__name__},
            )
            return JSONResponse(
                status_code=503,
                content={
                    "status": "not_ready",
                    "checks": {**checks, "database": "error"},
                },
            )

    return {
        "status": "ready",
        "checks": checks,
    }
