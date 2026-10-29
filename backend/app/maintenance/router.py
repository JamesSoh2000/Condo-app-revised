from typing import Annotated
from uuid import UUID

from fastapi import Depends, Header, Response

from app.buildings.enums import Feature
from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.maintenance import service
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.schemas import MaintenanceRequestCreate, MaintenanceRequestOut
from app.memberships.enums import Role
from app.tenancy.deps import Ctx, DbSession, require_feature, require_roles
from app.tenancy.router import building_router

router = building_router(tags=["maintenance"])
_FEATURE = Depends(require_feature(Feature.MAINTENANCE))
# Residents file and cancel their own requests (P6-03b D2, D3); property management runs them
# (P6-03c). Reads are open to every member; `visible_maintenance` decides what each one sees.
_RESIDENT = [_FEATURE, Depends(require_roles(Role.RESIDENT))]


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
