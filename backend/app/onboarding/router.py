from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Query, Request, Response

from app.auth.router import client_ip
from app.core.config import settings
from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.memberships.enums import Role
from app.memberships.models import BuildingMembership
from app.onboarding import service
from app.onboarding.models import OnboardingStatus
from app.onboarding.schemas import (
    JoinBuildingOut,
    JoinRequestCreate,
    OnboardingDecisionIn,
    OnboardingMeOut,
    OnboardingRequestManagerOut,
    OnboardingRequestOut,
    OnboardingSummary,
)
from app.rate_limits.service import RateLimiter, get_rate_limiter, ip_key
from app.tenancy.context import TenantContext
from app.tenancy.deps import CurrentUser, DbSession, get_own_membership, require_roles
from app.tenancy.router import BUILDING_PREFIX, building_router
from app.units.schemas import SearchText, UnitOption

# The join link's routes: the code in the path names the building, so they sit outside the building
# prefix. The lookup works without a session (app/auth/allowlist.py); the rest need one.
public_router = APIRouter(prefix="/join", tags=["onboarding"])
# Not `building_router()`: a pending member must pass, so these use `get_own_membership` instead of
# `get_tenant_context` (ADR-0004), and tests/test_architecture.py lists each one.
own_router = APIRouter(prefix=BUILDING_PREFIX, tags=["onboarding"])
# Property management's list, count and decisions (P4-05b): operational, so `get_tenant_context`.
router = building_router(tags=["onboarding"])
Limiter = Annotated[RateLimiter, Depends(get_rate_limiter)]
OwnMembership = Annotated[BuildingMembership, Depends(get_own_membership)]


@public_router.get("/{join_code}", responses=problem_responses(404, 429))
async def lookup(
    join_code: str, request: Request, db: DbSession, limiter: Limiter
) -> JoinBuildingOut:
    """The building a join link names. 404 `join_code_invalid` for any code that can't be used,
    with one body whatever the reason."""
    return await service.lookup(db, limiter, join_code, ip=client_ip(request))


async def join_units_limit(request: Request, limiter: Limiter) -> None:
    """Count the request against the IP before the session is resolved, so a 401 counts too, and the
    count isn't made inside the request's transaction. A bucket of its own: searching as the user
    types mustn't use up the lookup's (D3)."""
    await limiter.enforce(
        ip_key("join_units", client_ip(request)), settings.rate_limit_join_units_ip
    )


@public_router.get(
    "/{join_code}/units",
    dependencies=[Depends(join_units_limit)],
    responses=problem_responses(401, 404, 429),
)
async def units(
    user: CurrentUser,
    join_code: str,
    db: DbSession,
    search: Annotated[SearchText, Query(description="Label prefix, any case.")] = "",
) -> list[UnitOption]:
    """The building's active units whose label starts with `search`, at most 20, to choose from
    when asking to join."""
    return await service.unit_options(db, join_code, search)


async def join_request_limit(user: CurrentUser, limiter: Limiter) -> None:
    """Count the request against the user, after the session check (an anonymous one is a 401
    first). After a denial each new request notifies every manager (P4-05b D3)."""
    await limiter.enforce(f"join_request:user:{user.id}", settings.rate_limit_join_request_user)


@public_router.post(
    "/{join_code}/requests",
    status_code=201,
    dependencies=[Depends(join_request_limit)],
    # 200 for the pending request that was already there.
    responses=problem_responses(401, 404, 409, 429) | {200: {"model": OnboardingRequestOut}},
)
async def create_request(
    user: CurrentUser, join_code: str, body: JoinRequestCreate, response: Response, db: DbSession
) -> OnboardingRequestOut:
    """Ask to join the building as a resident of a unit; the membership waits as `pending` until a
    manager decides. 201 with the new request; 200 with the pending one if there is one already. 409
    `already_member` for an active member, `membership_not_eligible` for a suspended or
    deactivated one; 404 `unit_not_found` for a unit that isn't this building's or is inactive."""
    result = await service.submit_request(db, user.id, join_code, body)
    if not result.created:
        response.status_code = 200
    return result.out


@own_router.get("/onboarding/me", responses=problem_responses(401, 404))
async def my_status(membership: OwnMembership, db: DbSession) -> OnboardingMeOut:
    """The caller's status in this building, pending and denied included, with their latest join
    request's unit and relationship and, after a denial, the reason."""
    return await service.my_status(db, membership)


Manager = Annotated[TenantContext, Depends(require_roles(Role.PROPERTY_MANAGEMENT))]


# `name=`: the operation ids are `onboarding_list` and so on (app/main.py::operation_id), and a
# function named `list` would shadow the builtin in this module's annotations.
@router.get("/onboarding-requests", name="list", responses=problem_responses(400, 401, 403, 404))
async def list_requests(
    ctx: Manager,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    status: OnboardingStatus = OnboardingStatus.PENDING,
) -> Page[OnboardingRequestManagerOut]:
    """The building's join requests in `status`, newest first. Pending ones whose membership is no
    longer pending (an invitation was accepted) are left out: they can't be decided."""
    return await service.list_requests(db, ctx, params, status)


@router.get(
    "/onboarding-requests/summary", name="summary", responses=problem_responses(401, 403, 404)
)
async def summary(ctx: Manager, db: DbSession) -> OnboardingSummary:
    """How many join requests the pending list shows (for the managers' badge)."""
    return await service.pending_summary(db, ctx)


@router.post(
    "/onboarding-requests/{request_id}/approve",
    name="approve",
    responses=problem_responses(401, 403, 404, 409),
)
async def approve(request_id: UUID, ctx: Manager, db: DbSession) -> OnboardingRequestManagerOut:
    """Approve a pending join request: the member becomes an active resident of the request's unit
    and is notified. 409 `already_decided`, `membership_not_pending`, `unit_inactive` or
    `occupancy_changed` (retry)."""
    return await service.approve_request(db, ctx, request_id)


@router.post(
    "/onboarding-requests/{request_id}/deny",
    name="deny",
    responses=problem_responses(401, 403, 404, 409),
)
async def deny(
    request_id: UUID, body: OnboardingDecisionIn, ctx: Manager, db: DbSession
) -> OnboardingRequestManagerOut:
    """Deny a pending join request with a reason the requester sees; they may ask again. 409
    `already_decided` or `membership_not_pending`."""
    return await service.deny_request(db, ctx, request_id, body)
