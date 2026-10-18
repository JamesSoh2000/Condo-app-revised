from typing import Annotated
from uuid import UUID

from fastapi import Depends

from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.notifications import service
from app.notifications.schemas import NotificationOut, NotificationSummary
from app.tenancy.deps import Ctx, DbSession
from app.tenancy.router import building_router

# Any active member: each sees and marks only their own notifications in this building.
router = building_router(tags=["notifications"])


@router.get("/notifications", responses=problem_responses(400, 401, 404))
async def list(
    ctx: Ctx,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    unread_only: bool = False,
) -> Page[NotificationOut]:
    """Your notifications in this building, newest first; `unread_only` leaves out read ones."""
    return await service.list_notifications(db, ctx, params, unread_only=unread_only)


@router.get("/notifications/summary", responses=problem_responses(401, 404))
async def summary(ctx: Ctx, db: DbSession) -> NotificationSummary:
    """How many of your notifications in this building are unread (for the badge)."""
    return await service.notification_summary(db, ctx)


@router.post("/notifications/read-all", status_code=204, responses=problem_responses(401, 404))
async def read_all(ctx: Ctx, db: DbSession) -> None:
    """Mark all your unread notifications in this building read."""
    await service.mark_all_read(db, ctx)


@router.post(
    "/notifications/{notification_id}/read",
    status_code=204,
    responses=problem_responses(401, 404),
)
async def read(notification_id: UUID, ctx: Ctx, db: DbSession) -> None:
    """Mark one of your notifications read; repeating it keeps the first `read_at`. Anyone
    else's is a 404."""
    await service.mark_read(db, ctx, notification_id)
