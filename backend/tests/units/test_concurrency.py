"""Races on units: deactivating while an occupancy starts (P4-01 criterion 3, tenant row 10), and
the CSV import meeting an API create of the same unit (P4-01b F1).

On real connections: the test harness runs on one, so this uses a scratch database of its own
(`scratch_database_url`), migrated here and dropped after the test.
"""

import asyncio
import contextlib
from typing import Any

import pytest
from sqlalchemy import insert, select
from sqlalchemy import update as sql_update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.memberships.enums import OccupancyRelationship
from app.memberships.models import UnitOccupancy
from app.memberships.occupancy import start_occupancy
from app.tenancy.context import TenantContext
from app.units import service
from app.units.models import Unit
from app.units.schemas import UnitUpdate
from tests.factories import make_unit
from tests.notifications.test_concurrency import migrate
from tests.world import World, build_world


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


@pytest.mark.parametrize("api_commits", [True, False], ids=["commits", "rolls-back"])
def test_import_waits_for_a_concurrent_api_create_of_the_same_unit(
    scratch_database_url: str, api_commits: bool
) -> None:
    # P4-01b F1: the API creates (A, 9) and hasn't committed when the import reaches the same row.
    # The import's insert waits on the unique constraint; after a commit it updates the floor, after
    # a rollback it creates the unit. Never an IntegrityError.
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                await db.commit()
            parsed = service.parse_units_csv("tower,label,floor\nA,9,4\n")

            async with sessions() as api:
                await api.execute(
                    insert(Unit).values(building_id=world.a.id, tower="A", label="9", floor=1)
                )

                async def run_import() -> service.ImportReport:
                    async with sessions() as db:
                        report = await service.import_units(db, world.a.id, parsed, dry_run=False)
                        await db.commit()
                        return report

                task = asyncio.create_task(run_import())
                await asyncio.sleep(0.5)
                assert not task.done(), "the import did not wait for the open API insert"
                if api_commits:
                    await api.commit()
                else:
                    await api.rollback()
                report = await asyncio.wait_for(task, timeout=10)

            async with sessions() as db:
                floors = list(
                    await db.scalars(
                        select(Unit.floor).where(
                            Unit.building_id == world.a.id, Unit.tower == "A", Unit.label == "9"
                        )
                    )
                )
            counts = (report.created, report.updated, report.unchanged)
            assert counts == ((0, 1, 0) if api_commits else (1, 0, 0))
            assert floors == [4]
        finally:
            await engine.dispose()

    asyncio.run(check())


def _ctx(world: World) -> TenantContext:
    return TenantContext(
        user_id=world.a_manager.user.id,
        building_id=world.a.id,
        membership_id=world.a_manager.membership.id,
        roles=frozenset(),
        features=frozenset(),
    )


def test_import_is_not_lost_when_the_api_renames_the_unit_between_statements(
    scratch_database_url: str,
) -> None:
    # Review round 1 (Codex, High): with INSERT … DO NOTHING then a separate UPDATE, a rename of
    # (A, x) between the two made the UPDATE match nothing: "unchanged", the floor never written.
    # The hook renames right after the import's first statement returns.
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                original = await make_unit(db, world.a, tower="A", label="x", floor=1)
                await db.commit()

            class RenameAfterFirstStatement(AsyncSession):
                renamed = False

                async def _rename_once(self, statement: Any) -> None:
                    if not getattr(statement, "is_insert", False) or self.renamed:
                        return
                    self.renamed = True
                    async with sessions() as api:
                        rename = service.update_unit(
                            api, _ctx(world), original.id, UnitUpdate(label="z")
                        )
                        # If the import holds the row's lock, the rename waits and times out.
                        with contextlib.suppress(TimeoutError):
                            await asyncio.wait_for(rename, timeout=0.5)

                async def scalar(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
                    result = await super().scalar(statement, *args, **kwargs)
                    await self._rename_once(statement)
                    return result

                async def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
                    result = await super().execute(statement, *args, **kwargs)
                    await self._rename_once(statement)
                    return result

            importing = async_sessionmaker(
                engine, class_=RenameAfterFirstStatement, expire_on_commit=False, autoflush=False
            )
            parsed = service.parse_units_csv("tower,label,floor\nA,x,5\n")
            async with importing() as db:
                report = await service.import_units(db, world.a.id, parsed, dry_run=False)
                await db.commit()

            async with sessions() as db:
                units = set(
                    await db.execute(
                        select(Unit.label, Unit.floor).where(
                            Unit.building_id == world.a.id, Unit.tower == "A"
                        )
                    )
                )
            assert (report.created, report.updated, report.unchanged) == (0, 1, 0)
            assert units == {("x", 5)}
        finally:
            await engine.dispose()

    asyncio.run(check())


def test_import_waits_for_a_concurrent_rename_then_creates_the_unit(
    scratch_database_url: str,
) -> None:
    # The neighbour of the case above: the API renames (A, x) to (A, z) first and holds the row.
    # The import's upsert waits for it, then finds no (A, x) and creates one; z keeps its floor.
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                original = await make_unit(db, world.a, tower="A", label="x", floor=1)
                await db.commit()
            parsed = service.parse_units_csv("tower,label,floor\nA,x,5\n")

            async with sessions() as api:
                await api.execute(
                    sql_update(Unit).where(Unit.id == original.id).values(label="z")
                )

                async def run_import() -> service.ImportReport:
                    async with sessions() as db:
                        report = await service.import_units(db, world.a.id, parsed, dry_run=False)
                        await db.commit()
                        return report

                task = asyncio.create_task(run_import())
                await asyncio.sleep(0.5)
                assert not task.done(), "the import did not wait for the open rename"
                await api.commit()
                report = await asyncio.wait_for(task, timeout=10)

            async with sessions() as db:
                units = set(
                    await db.execute(
                        select(Unit.label, Unit.floor).where(
                            Unit.building_id == world.a.id, Unit.tower == "A"
                        )
                    )
                )
            assert (report.created, report.updated, report.unchanged) == (1, 0, 0)
            assert units == {("x", 5), ("z", 1)}
        finally:
            await engine.dispose()

    asyncio.run(check())


def test_concurrent_imports_in_opposite_orders_both_finish(scratch_database_url: str) -> None:
    # Review round 1 (Codex): [x, y] and [y, x] each inserted their first unit, then waited on the
    # other's: "deadlock detected". Each session pauses after its first write until both have one.
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        both_wrote = asyncio.Event()
        first_writes = 0

        class PauseAfterFirstWrite(AsyncSession):
            first = True

            async def _pause_once(self, statement: Any) -> None:
                nonlocal first_writes
                if not self.first or not getattr(statement, "is_insert", False):
                    return
                self.first = False
                first_writes += 1
                if first_writes == 2:
                    both_wrote.set()
                # With one write order, the second import's first write waits on the first
                # import: let it go on after a grace period.
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(both_wrote.wait(), timeout=1)

            async def scalar(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
                result = await super().scalar(statement, *args, **kwargs)
                await self._pause_once(statement)
                return result

            async def execute(self, statement: Any, *args: Any, **kwargs: Any) -> Any:
                result = await super().execute(statement, *args, **kwargs)
                await self._pause_once(statement)
                return result

        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        pausing = async_sessionmaker(
            engine, class_=PauseAfterFirstWrite, expire_on_commit=False, autoflush=False
        )
        try:
            async with sessions() as db:
                world = await build_world(db)
                await db.commit()

            async def run(text: str) -> service.ImportReport:
                async with pausing() as db:
                    parsed = service.parse_units_csv(text)
                    report = await service.import_units(db, world.a.id, parsed, dry_run=False)
                    await db.commit()
                    return report

            results = await asyncio.wait_for(
                asyncio.gather(
                    run("tower,label,floor\nA,x,1\nA,y,2\n"),
                    run("tower,label,floor\nA,y,2\nA,x,1\n"),
                    return_exceptions=True,
                ),
                timeout=15,
            )
            assert not [r for r in results if isinstance(r, BaseException)], results
            async with sessions() as db:
                labels = set(
                    await db.scalars(select(Unit.label).where(Unit.building_id == world.a.id))
                )
            assert {"x", "y"} <= labels
        finally:
            await engine.dispose()

    asyncio.run(check())
