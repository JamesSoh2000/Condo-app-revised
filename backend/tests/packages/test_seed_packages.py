"""P5-01 criterion 12: the seed's Maple packages."""

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings.models import Building
from app.memberships.enums import Role
from app.memberships.models import BuildingMembership
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.packages.queries import visible_packages
from app.seed import seed
from app.users.models import User
from tests.packages.conftest import ctx_of

pytestmark = pytest.mark.anyio


async def _maple_packages(db: AsyncSession) -> list[Package]:
    return list(
        await db.scalars(
            select(Package)
            .join(Building, Building.id == Package.building_id)
            .where(Building.slug == "maple")
        )
    )


async def _membership(db: AsyncSession, email: str) -> BuildingMembership:
    return (
        await db.scalars(
            select(BuildingMembership)
            .join(User, User.id == BuildingMembership.user_id)
            .join(Building, Building.id == BuildingMembership.building_id)
            .where(Building.slug == "maple", User.email == email)
        )
    ).one()


async def test_seed_creates_maple_packages_across_units_and_states(db: AsyncSession) -> None:
    await seed(db, app_env="dev")

    packages = await _maple_packages(db)

    assert 12 <= len(packages) <= 18
    assert len({p.unit_id for p in packages}) >= 4
    assert {p.status for p in packages} == set(PackageStatus)


async def test_seed_twice_adds_no_package(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    first = {p.id for p in await _maple_packages(db)}
    await seed(db, app_env="dev")

    assert {p.id for p in await _maple_packages(db)} == first
    assert await db.scalar(select(func.count()).select_from(Package)) == len(first)


async def test_seeded_residents_see_packages_by_window_and_by_name(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    resident1 = await _membership(db, "resident1@example.test")

    visible = list(await db.scalars(visible_packages(ctx_of(resident1, Role.RESIDENT))))

    named = [p for p in visible if p.recipient_membership_id == resident1.id]
    by_window = [p for p in visible if p.recipient_membership_id is None]
    assert named and by_window
