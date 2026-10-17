"""Reading a building for its members. The tenant context has already authorized the caller."""

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings.models import Building
from app.buildings.schemas import BuildingOut
from app.tenancy.context import TenantContext


async def get_building(db: AsyncSession, ctx: TenantContext) -> BuildingOut:
    building = (await db.execute(select(Building).where(Building.id == ctx.building_id))).scalar_one()
    return BuildingOut(
        id=building.id,
        name=building.name,
        slug=building.slug,
        timezone=building.timezone,
        locale=building.locale,
        # Sorted by value, as /api/auth/me sorts roles.
        my_roles=sorted(ctx.roles),
        features=sorted(ctx.features),
    )
