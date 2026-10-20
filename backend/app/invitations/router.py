from typing import Annotated
from uuid import UUID

from fastapi import Depends

from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.invitations import service
from app.invitations.schemas import InvitationCreate, InvitationOut, InvitationStatus
from app.memberships.enums import Role
from app.tenancy.deps import Ctx, DbSession, require_roles
from app.tenancy.router import building_router

router = building_router(tags=["invitations"])
_MANAGEMENT = [Depends(require_roles(Role.PROPERTY_MANAGEMENT))]


@router.post(
    "/invitations",
    status_code=201,
    dependencies=_MANAGEMENT,
    responses=problem_responses(401, 403, 404, 409),
)
async def create(ctx: Ctx, db: DbSession, body: InvitationCreate) -> InvitationOut:
    """Invite an email with preassigned roles (and optionally a unit) and queue the email with its
    link. 409 `invitation_pending` if the email already has a pending invitation here."""
    return await service.create_invitation(db, ctx, body)


@router.get("/invitations", dependencies=_MANAGEMENT, responses=problem_responses(400, 401, 403, 404))
async def list(
    ctx: Ctx,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    status: InvitationStatus | None = None,
) -> Page[InvitationOut]:
    """The building's invitations, newest first, optionally of one status."""
    return await service.list_invitations(db, ctx, params, status)


@router.post(
    "/invitations/{invitation_id}/revoke",
    status_code=204,
    dependencies=_MANAGEMENT,
    responses=problem_responses(401, 403, 404, 409),
)
async def revoke(invitation_id: UUID, ctx: Ctx, db: DbSession) -> None:
    """Revoke an invitation not yet accepted; its link stops working."""
    await service.revoke_invitation(db, ctx, invitation_id)


@router.post(
    "/invitations/{invitation_id}/resend",
    dependencies=_MANAGEMENT,
    responses=problem_responses(401, 403, 404, 409),
)
async def resend(invitation_id: UUID, ctx: Ctx, db: DbSession) -> InvitationOut:
    """A new link and a new 7-day expiry, emailed again; the old link stops working."""
    return await service.resend_invitation(db, ctx, invitation_id)
