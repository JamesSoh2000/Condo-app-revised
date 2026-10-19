from typing import Annotated
from uuid import UUID

from fastapi import Depends, Query

from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.memberships.enums import Role
from app.tenancy.deps import Ctx, DbSession, require_roles
from app.tenancy.router import building_router
from app.units import service
from app.units.schemas import SearchText, UnitCreate, UnitOut, UnitUpdate

router = building_router(tags=["units"])
# Staff who look units up (security at the desk) and the managers who maintain them.
_STAFF = [Depends(require_roles(Role.SECURITY, Role.PROPERTY_MANAGEMENT))]
_MANAGEMENT = [Depends(require_roles(Role.PROPERTY_MANAGEMENT))]


@router.get("/units", dependencies=_STAFF, responses=problem_responses(400, 401, 403, 404))
async def list(
    ctx: Ctx,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    search: Annotated[SearchText | None, Query(description="Label prefix, any case.")] = None,
    tower: Annotated[SearchText | None, Query()] = None,
    active: bool | None = None,
) -> Page[UnitOut]:
    """The building's units, newest first, with how many people currently occupy each."""
    return await service.list_units(db, ctx, params, search=search, tower=tower, active=active)


@router.post(
    "/units",
    status_code=201,
    dependencies=_MANAGEMENT,
    responses=problem_responses(401, 403, 404, 409),
)
async def create(ctx: Ctx, db: DbSession, body: UnitCreate) -> UnitOut:
    """Add a unit; 409 `unit_exists` if the building has one with the same tower and label."""
    return await service.create_unit(db, ctx, body)


@router.patch(
    "/units/{unit_id}", dependencies=_MANAGEMENT, responses=problem_responses(401, 403, 404, 409)
)
async def update(unit_id: UUID, ctx: Ctx, db: DbSession, body: UnitUpdate) -> UnitOut:
    """Change a unit's tower, label or floor; only the fields sent change."""
    return await service.update_unit(db, ctx, unit_id, body)


@router.post(
    "/units/{unit_id}/deactivate",
    status_code=204,
    dependencies=_MANAGEMENT,
    responses=problem_responses(401, 403, 404, 409),
)
async def deactivate(unit_id: UUID, ctx: Ctx, db: DbSession) -> None:
    """Deactivate a unit; 409 `unit_has_occupants` while anyone currently occupies it."""
    await service.deactivate_unit(db, ctx, unit_id)


@router.post(
    "/units/{unit_id}/activate",
    status_code=204,
    dependencies=_MANAGEMENT,
    responses=problem_responses(401, 403, 404, 409),
)
async def activate(unit_id: UUID, ctx: Ctx, db: DbSession) -> None:
    """Activate a deactivated unit."""
    await service.activate_unit(db, ctx, unit_id)
