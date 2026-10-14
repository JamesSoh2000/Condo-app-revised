from datetime import datetime, timezone

from fastapi import APIRouter

from app.core.config import settings

router = APIRouter(tags=["version"])

@router.get("/version")
async def version() -> dict[str, str]:
    return {
        "service": settings.service_name,
        "environment": settings.app_env,
        "git_sha": settings.git_sha,
        "image_tag": settings.image_tag,
        "build_time": settings.build_time,
        "server_time": datetime.now(timezone.utc).isoformat(),
    }
