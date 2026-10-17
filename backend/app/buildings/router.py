from typing import Annotated

from fastapi import Depends
from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings import service
from app.buildings.schemas import BuildingOut
from app.core.dependencies import get_db_session
from app.core.errors import problem_responses
from app.tenancy.context import TenantContext
from app.tenancy.deps import get_tenant_context
from app.tenancy.router import building_router

router = building_router(tags=["buildings"])


@router.get("", responses=problem_responses(401, 404))
async def get(
    ctx: Annotated[TenantContext, Depends(get_tenant_context)],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> BuildingOut:
    """The building, the caller's roles in it and its enabled features; any active member."""
    return await service.get_building(db, ctx)
