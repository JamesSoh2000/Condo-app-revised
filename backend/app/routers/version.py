from datetime import UTC, datetime

from fastapi import APIRouter

from app.core.config import settings
from app.core.schemas import APIModel

router = APIRouter(tags=["version"])


class VersionOut(APIModel):
    service: str
    environment: str
    git_sha: str
    image_tag: str
    build_time: str
    server_time: str


@router.get("/version")
async def version() -> VersionOut:
    return VersionOut(
        service=settings.service_name,
        environment=settings.app_env,
        git_sha=settings.git_sha,
        image_tag=settings.image_tag,
        build_time=settings.build_time,
        server_time=datetime.now(UTC).isoformat(),
    )
