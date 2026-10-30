from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Response

from app.buildings.enums import Feature
from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.maintenance import service
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.schemas import (
    MaintenanceCommentCreate,
    MaintenanceCommentOut,
    MaintenanceRequestCreate,
    MaintenanceRequestOut,
    MaintenanceStatusEventOut,
)
from app.memberships.enums import Role
from app.tenancy.deps import Ctx, DbSession, require_feature, require_roles
from app.tenancy.router import building_router

router = building_router(tags=["maintenance"])
_FEATURE = Depends(require_feature(Feature.MAINTENANCE))
# Residents file and cancel their own requests (P6-03b D2, D3); property management runs them
# (P6-03c). Reads are open to every member; `visible_maintenance` decides what each one sees.
_RESIDENT = [_FEATURE, Depends(require_roles(Role.RESIDENT))]
# Security reads and comments only (P6-03c framing, the stub's default).
_MANAGER = [_FEATURE, Depends(require_roles(Role.PROPERTY_MANAGEMENT))]


@router.post(
    "/maintenance-requests",
    status_code=201,
    dependencies=_RESIDENT,
    responses=problem_responses(400, 401, 403, 404, 409, 422),
)
async def create(
    ctx: Ctx,
    db: DbSession,
    body: MaintenanceRequestCreate,
    response: Response,
    idempotency_key: Annotated[
        str | None,
        Header(description="8-80 visible ASCII characters; repeat it to retry the same request."),
    ] = None,
) -> MaintenanceRequestOut:
    """File a request for the unit you live in now, or a common area, and tell the managers.

    An `emergency` request answers with the building's `emergency_phone` to call: the app
    alerts no one. A retry with the same `Idempotency-Key` and body answers 201 with the same
    request and `Idempotent-Replayed: true`, writing nothing; the key with another body, or
    another member's key, is 409 `idempotency_key_reused`.
    """
    created = await service.create_request(db, ctx, body, idempotency_key)
    if created.replayed:
        response.headers["Idempotent-Replayed"] = "true"
    return created.request


@router.get(
    "/maintenance-requests",
    dependencies=[_FEATURE],
    responses=problem_responses(400, 401, 403, 404),
)
async def list(
    ctx: Ctx,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    status: MaintenanceStatus | None = None,
) -> Page[MaintenanceRequestOut]:
    """The requests you may see in this building, newest first."""
    return await service.list_requests(db, ctx, params, status=status)


@router.get(
    "/maintenance-requests/{request_id}",
    dependencies=[_FEATURE],
    responses=problem_responses(401, 403, 404),
)
async def get(request_id: UUID, ctx: Ctx, db: DbSession) -> MaintenanceRequestOut:
    """One request you may see; anyone else's is a 404."""
    return await service.get_request(db, ctx, request_id)


@router.post(
    "/maintenance-requests/{request_id}/cancel",
    dependencies=_RESIDENT,
    responses=problem_responses(401, 403, 404, 409),
)
async def cancel(request_id: UUID, ctx: Ctx, db: DbSession) -> MaintenanceRequestOut:
    """Withdraw your own request before work starts.

    403 `not_requester` for a request you see but didn't file; 409 `invalid_transition` unless it
    is `submitted`; of two at once, one wins.
    """
    return await service.cancel_request(db, ctx, request_id)


@router.post(
    "/maintenance-requests/{request_id}/start",
    dependencies=_MANAGER,
    responses=problem_responses(401, 403, 404, 409),
)
async def start(request_id: UUID, ctx: Ctx, db: DbSession) -> MaintenanceRequestOut:
    """Start work on a `submitted` request, or resume an `on_hold` one; tells the requester.

    409 `invalid_transition` from any other status (a `resolved` request is reopened instead);
    of two at once, one wins.
    """
    return await service.move_request(db, ctx, request_id, "start")


@router.post(
    "/maintenance-requests/{request_id}/hold",
    dependencies=_MANAGER,
    responses=problem_responses(401, 403, 404, 409),
)
async def hold(request_id: UUID, ctx: Ctx, db: DbSession) -> MaintenanceRequestOut:
    """Put an `in_progress` request on hold; tells the requester. A reason goes in a public
    comment. 409 `invalid_transition` from any other status."""
    return await service.move_request(db, ctx, request_id, "hold")


@router.post(
    "/maintenance-requests/{request_id}/resolve",
    dependencies=_MANAGER,
    responses=problem_responses(401, 403, 404, 409),
)
async def resolve(request_id: UUID, ctx: Ctx, db: DbSession) -> MaintenanceRequestOut:
    """Resolve an `in_progress` or `on_hold` request; tells the requester. 409
    `invalid_transition` from any other status."""
    return await service.move_request(db, ctx, request_id, "resolve")


@router.post(
    "/maintenance-requests/{request_id}/reopen",
    dependencies=_MANAGER,
    responses=problem_responses(401, 403, 404, 409),
)
async def reopen(request_id: UUID, ctx: Ctx, db: DbSession) -> MaintenanceRequestOut:
    """Reopen a `resolved` request to `in_progress` while it was resolved less than 14 days ago;
    tells the requester.

    409 `reopen_window_closed` at 14 days and after; 409 `invalid_transition` from any other status
    (a `cancelled` request is final).
    """
    return await service.move_request(db, ctx, request_id, "reopen")


@router.post(
    "/maintenance-requests/{request_id}/comments",
    status_code=201,
    dependencies=[_FEATURE],
    responses=problem_responses(401, 403, 404, 422),
)
async def comment(
    request_id: UUID, ctx: Ctx, db: DbSession, body: MaintenanceCommentCreate
) -> MaintenanceCommentOut:
    """Comment on a request you may see, at any status.

    A public comment by security or property management tells the requester (and emails them); a
    resident's tells the managers. `internal: true` is for security and property management only
    (403 `internal_comment_forbidden` for anyone else): no resident ever sees it, and it tells no
    one.
    """
    return await service.add_comment(db, ctx, request_id, body)


@router.get(
    "/maintenance-requests/{request_id}/comments",
    dependencies=[_FEATURE],
    responses=problem_responses(400, 401, 403, 404),
)
async def list_comments(
    request_id: UUID, ctx: Ctx, db: DbSession, params: Annotated[CursorParams, Depends()]
) -> Page[MaintenanceCommentOut]:
    """The comments you may see on a request, oldest first: residents get the public ones."""
    return await service.list_comments(db, ctx, request_id, params)


@router.get(
    "/maintenance-requests/{request_id}/status-events",
    dependencies=[_FEATURE],
    responses=problem_responses(400, 401, 403, 404),
)
async def list_status_events(
    request_id: UUID, ctx: Ctx, db: DbSession, params: Annotated[CursorParams, Depends()]
) -> Page[MaintenanceStatusEventOut]:
    """The status changes of a request you may see, oldest first: every start, hold, resume,
    resolve and reopen. Submit and cancel are the request's `submitted_at` and `cancelled_at`."""
    return await service.list_status_events(db, ctx, request_id, params)
