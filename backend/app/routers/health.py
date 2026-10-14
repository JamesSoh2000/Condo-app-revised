from fastapi import APIRouter, HTTPException

from app.core.config import settings
from app.core.database import check_database_connection

router = APIRouter(tags=["health"])


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


@router.get("/ready")
async def ready() -> dict[str, object]:
    checks: dict[str, str] = {
        "app": "ok",
        "database": "skipped",
    }

    if settings.readiness_check_database:
        try:
            await check_database_connection()
            checks["database"] = "ok"
        except Exception as exc:
            raise HTTPException(
                status_code=503,
                detail={
                    "status": "not_ready",
                    "checks": {
                        **checks,
                        "database": "error",
                    },
                    "error": str(exc),
                },
            ) from exc

    return {
        "status": "ready",
        "checks": checks,
    }