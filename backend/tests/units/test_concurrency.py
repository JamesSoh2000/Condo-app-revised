"""Deactivating a unit while an occupancy of it is being started (P4-01 criterion 3, tenant row 10).

On real connections: the test harness runs on one, so this uses a scratch database of its own
(`scratch_database_url`), migrated here and dropped after the test.
"""

import asyncio

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import async_sessionmaker, create_async_engine

from app.memberships.enums import OccupancyRelationship
from app.memberships.models import UnitOccupancy
from app.memberships.occupancy import start_occupancy
from app.tenancy.context import TenantContext
from app.units import service
from app.units.models import Unit
from tests.factories import make_unit
from tests.notifications.test_concurrency import migrate
from tests.world import build_world


@pytest.mark.parametrize("occupancy_commits", [True, False], ids=["commits", "rolls-back"])
def test_deactivate_waits_for_a_concurrent_occupancy_start(
    scratch_database_url: str, occupancy_commits: bool
) -> None:
    # An occupancy insert takes FOR KEY SHARE on the unit (its foreign key), which doesn't conflict
    # with a plain UPDATE of is_active: without the unit lock, deactivate would not wait, would not
    # see the uncommitted occupancy, and the unit would end up inactive and occupied.
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                unit = await make_unit(db, world.a, label="777")
                await db.commit()
            ctx = TenantContext(
                user_id=world.a_manager.user.id,
                building_id=world.a.id,
                membership_id=world.a_manager.membership.id,
                roles=frozenset(),
                features=frozenset(),
            )

            async with sessions() as joining:
                await start_occupancy(
                    joining,
                    building_id=world.a.id,
                    membership_id=world.a_pending.membership.id,
                    unit_id=unit.id,
                    relationship=OccupancyRelationship.TENANT,
                )

                async def deactivate() -> str:
                    async with sessions() as db:
                        try:
                            await service.deactivate_unit(db, ctx, unit.id)
                        except service.UnitHasOccupants:
                            return "unit_has_occupants"
                        return "deactivated"

                task = asyncio.create_task(deactivate())
                await asyncio.sleep(0.5)
                assert not task.done(), "deactivate did not wait for the open occupancy insert"
                if occupancy_commits:
                    await joining.commit()
                else:
                    await joining.rollback()
                outcome = await asyncio.wait_for(task, timeout=10)

            async with sessions() as db:
                active = await db.scalar(select(Unit.is_active).where(Unit.id == unit.id))
                occupied = await db.scalar(
                    select(UnitOccupancy.id).where(
                        UnitOccupancy.unit_id == unit.id, UnitOccupancy.ended_at.is_(None)
                    )
                )
            if occupancy_commits:
                assert (outcome, active, occupied is not None) == ("unit_has_occupants", True, True)
            else:
                assert (outcome, active, occupied) == ("deactivated", False, None)
        finally:
            await engine.dispose()

    asyncio.run(check())
