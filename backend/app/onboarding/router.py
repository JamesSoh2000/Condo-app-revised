from typing import Annotated

from fastapi import APIRouter, Depends, Query, Request, Response

from app.auth.router import client_ip
from app.core.config import settings
from app.core.errors import problem_responses
from app.memberships.models import BuildingMembership
from app.onboarding import service
from app.onboarding.schemas import (
    JoinBuildingOut,
    JoinRequestCreate,
    OnboardingMeOut,
    OnboardingRequestOut,
)
from app.rate_limits.service import RateLimiter, get_rate_limiter, ip_key
from app.tenancy.deps import CurrentUser, DbSession, get_own_membership
from app.tenancy.router import BUILDING_PREFIX
from app.units.schemas import SearchText, UnitOption

# The join link's routes: the code in the path names the building, so they sit outside the building
# prefix. The lookup works without a session (app/auth/allowlist.py); the rest need one.
public_router = APIRouter(prefix="/join", tags=["onboarding"])
# Not `building_router()`: a pending member must pass, so these use `get_own_membership` instead of
# `get_tenant_context` (ADR-0004), and tests/test_architecture.py lists each one.
own_router = APIRouter(prefix=BUILDING_PREFIX, tags=["onboarding"])
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


@public_router.post(
    "/{join_code}/requests",
    status_code=201,
    # 200 for the pending request that was already there.
    responses=problem_responses(401, 404, 409) | {200: {"model": OnboardingRequestOut}},
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
