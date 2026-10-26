from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response

from app.auth.router import client_ip, set_session_cookie
from app.core.config import settings
from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.invitations import service
from app.invitations.schemas import (
    InvitationAccept,
    InvitationAcceptedOut,
    InvitationCreate,
    InvitationOut,
    InvitationPublicOut,
    InvitationStatus,
)
from app.memberships.enums import Role
from app.rate_limits.service import RateLimiter, get_rate_limiter
from app.tenancy.deps import Ctx, DbSession, require_roles
from app.tenancy.router import building_router

router = building_router(tags=["invitations"])
# The invitee's routes: no session needed (app/auth/allowlist.py), so no building in the path; the
# token decides the building.
public_router = APIRouter(prefix="/invitations", tags=["invitations"])
Limiter = Annotated[RateLimiter, Depends(get_rate_limiter)]
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


@router.get(
    "/invitations", dependencies=_MANAGEMENT, responses=problem_responses(400, 401, 403, 404)
)
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


@public_router.get("/{token}", responses=problem_responses(404, 429))
async def get_public(
    token: str, request: Request, db: DbSession, limiter: Limiter
) -> InvitationPublicOut:
    """The building, masked email and roles of a pending invitation. 404 `invitation_invalid` for
    any token that can't be accepted, with one body whatever the reason."""
    return await service.get_public_invitation(db, limiter, token, ip=client_ip(request))


@public_router.post("/{token}/accept", responses=problem_responses(403, 404, 409, 429))
async def accept(
    token: str,
    body: InvitationAccept,
    request: Request,
    response: Response,
    db: DbSession,
    limiter: Limiter,
) -> InvitationAcceptedOut:
    """Accept: the membership becomes active with the invited roles. A new email needs
    `full_name` and `password` and is logged in (session cookie); an existing account must be
    logged in as itself (409 `login_required`, 403 `invitation_email_mismatch`). 409
    `occupancy_changed`: retry."""
    result = await service.accept_invitation(
        db,
        limiter,
        token,
        body,
        session_token=request.cookies.get(settings.session_cookie_name),
        user_agent=request.headers.get("user-agent"),
        ip=client_ip(request),
    )
    if result.session_token is not None:
        set_session_cookie(
            response, result.session_token, max_age=settings.session_absolute_days * 24 * 3600
        )
    return result.out
