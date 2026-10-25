from typing import Annotated
from uuid import UUID

from fastapi import Depends

from app.buildings.enums import Feature
from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.memberships.enums import Role
from app.notices import service
from app.notices.enums import NoticePriority, NoticeStatus
from app.notices.schemas import NoticeCreate, NoticeOut, NoticeSummary, NoticeUpdate
from app.tenancy.deps import Ctx, DbSession, require_feature, require_roles
from app.tenancy.router import building_router

router = building_router(tags=["notices"])
_FEATURE = Depends(require_feature(Feature.NOTICES))
# The manager publishes notices (PRODUCT_SCOPE.md); security doesn't author (the stub's default).
# Reads are open to every member; `visible_notices` decides what each one sees.
_AUTHOR = [_FEATURE, Depends(require_roles(Role.PROPERTY_MANAGEMENT))]


@router.post(
    "/notices",
    status_code=201,
    dependencies=_AUTHOR,
    responses=problem_responses(400, 401, 403, 404, 422),
)
async def create(ctx: Ctx, db: DbSession, body: NoticeCreate) -> NoticeOut:
    """Write a draft notice, with an optional attachment uploaded through the files API.

    422 `notice_expired` if `expires_at` isn't in the future; the attachment's 404
    `file_not_found` or 422 `invalid_file`.
    """
    return await service.create_notice(db, ctx, body)


@router.get("/notices", dependencies=[_FEATURE], responses=problem_responses(400, 401, 403, 404))
async def list(
    ctx: Ctx,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    status: NoticeStatus | None = None,
    live: bool = False,
    priority: NoticePriority | None = None,
    unread: bool = False,
) -> Page[NoticeOut]:
    """The notices you may see in this building, newest written first: published ones that
    haven't expired, and for the manager drafts, expired and archived ones too.

    `live=true` keeps only published notices that haven't expired, for every role: the feed, and
    what the unread summary counts (P6-02a). `priority` keeps one priority, and `unread=true` the
    notices you haven't read yourself: with `live=true&priority=urgent`, the urgent banner's
    notices (P6-02b).
    """
    return await service.list_notices(
        db, ctx, params, status=status, live_only=live, priority=priority, unread_only=unread
    )


@router.get("/notices/summary", dependencies=[_FEATURE], responses=problem_responses(401, 403, 404))
async def summary(ctx: Ctx, db: DbSession) -> NoticeSummary:
    """How many live notices you haven't read here, and how many of those are urgent (for the
    badge and the urgent banner). Drafts, archived and expired notices never count."""
    return await service.notice_summary(db, ctx)


@router.get(
    "/notices/{notice_id}", dependencies=[_FEATURE], responses=problem_responses(401, 403, 404)
)
async def get(notice_id: UUID, ctx: Ctx, db: DbSession) -> NoticeOut:
    """One notice you may see; any other is a 404."""
    return await service.get_notice(db, ctx, notice_id)


@router.post(
    "/notices/{notice_id}/read",
    status_code=204,
    dependencies=[_FEATURE],
    responses=problem_responses(401, 403, 404),
)
async def read(notice_id: UUID, ctx: Ctx, db: DbSession) -> None:
    """Mark a notice you can see read; repeating it keeps the first `read_at`. Others are 404."""
    await service.mark_read(db, ctx, notice_id)


@router.patch(
    "/notices/{notice_id}",
    dependencies=_AUTHOR,
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def update(notice_id: UUID, ctx: Ctx, db: DbSession, body: NoticeUpdate) -> NoticeOut:
    """Change a draft: only the fields sent. `null` clears `expires_at` or the attachment.

    409 `notice_not_editable` unless the notice is a draft: a published notice is archived and
    written again, not edited.
    """
    return await service.update_notice(db, ctx, notice_id, body)


@router.post(
    "/notices/{notice_id}/publish",
    dependencies=_AUTHOR,
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def publish(notice_id: UUID, ctx: Ctx, db: DbSession) -> NoticeOut:
    """Show a draft to every member of the building.

    409 `invalid_transition` unless it is a draft; of two at once, one wins. 422 `notice_expired`
    if its `expires_at` has passed.
    """
    return await service.publish_notice(db, ctx, notice_id)


@router.post(
    "/notices/{notice_id}/archive",
    dependencies=_AUTHOR,
    responses=problem_responses(400, 401, 403, 404, 409),
)
async def archive(notice_id: UUID, ctx: Ctx, db: DbSession) -> NoticeOut:
    """Withdraw a published notice or discard a draft; final.

    409 `invalid_transition` if it is already archived.
    """
    return await service.archive_notice(db, ctx, notice_id)
