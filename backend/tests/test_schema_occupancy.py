"""P1-03: constraints on unit_occupancies, enforced by the database.

Rows are inserted with raw SQL where the point is that the database alone rejects them, and through the
models elsewhere. Criterion numbers refer to the ticket.
"""

import asyncio
import re
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid7

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import delete, func, inspect, select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.buildings.models import Building
from app.core.config import settings
from app.memberships.enums import OccupancyRelationship
from app.memberships.models import BuildingMembership, UnitOccupancy
from app.units.models import Unit
from app.users.models import User
from tests.conftest import BACKEND_DIR, _recreate_test_schema, assert_safe_test_database_url

pytestmark = pytest.mark.anyio

P1_03_REVISION = "8887ac143e98"
P1_03_DOWN_REVISION = "2b2e5bcaf6b4"

T0 = datetime(2026, 1, 1, tzinfo=UTC)
T1 = T0 + timedelta(days=30)

INSERT_OCCUPANCY = text(
    "INSERT INTO unit_occupancies"
    " (id, building_id, unit_id, membership_id, relationship, started_at, ended_at)"
    " VALUES (gen_random_uuid(), :b, :u, :m, :rel, COALESCE(:start, now()), :end) RETURNING id"
)


async def _building(db: AsyncSession, slug: str) -> Building:
    building = Building(slug=slug, name=f"Building {slug}", address="1 Main St", timezone="UTC")
    db.add(building)
    await db.flush()
    return building


async def _unit(db: AsyncSession, building: Building, label: str) -> Unit:
    unit = Unit(building_id=building.id, label=label)
    db.add(unit)
    await db.flush()
    return unit


async def _member(db: AsyncSession, building: Building, email: str) -> BuildingMembership:
    user = User(email=email, full_name="Someone")
    db.add(user)
    await db.flush()
    membership = BuildingMembership(building_id=building.id, user_id=user.id)
    db.add(membership)
    await db.flush()
    return membership


async def _insert(
    db: AsyncSession,
    building_id: UUID,
    unit_id: UUID,
    membership_id: UUID,
    *,
    rel: str = "tenant",
    start: datetime | None = None,
    end: datetime | None = None,
) -> UUID:
    row_id = await db.scalar(
        INSERT_OCCUPANCY,
        {"b": building_id, "u": unit_id, "m": membership_id, "rel": rel, "start": start, "end": end},
    )
    assert isinstance(row_id, UUID)
    return row_id


async def _count(db: AsyncSession, membership_id: UUID) -> int:
    return int(
        await db.scalar(
            select(func.count())
            .select_from(UnitOccupancy)
            .where(UnitOccupancy.membership_id == membership_id)
        )
        or 0
    )


# --- 1: one current occupancy per membership ----------------------------------------------------


async def test_second_current_occupancy_of_a_membership_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    u101, u102 = await _unit(db, a, "101"), await _unit(db, a, "102")
    m = await _member(db, a, "alice@example.com")
    await _insert(db, a.id, u101.id, m.id)

    with pytest.raises(IntegrityError, match="uq_unit_occupancies_current_membership"):
        await _insert(db, a.id, u102.id, m.id)


async def test_second_current_occupancy_of_the_same_unit_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")
    await _insert(db, a.id, u101.id, m.id, rel="tenant")

    with pytest.raises(IntegrityError, match="uq_unit_occupancies_current_membership"):
        await _insert(db, a.id, u101.id, m.id, rel="owner")


# --- 2: after the current one ends, a new one may start; history keeps both ---------------------


async def test_new_occupancy_after_the_previous_ended_is_accepted_and_history_is_kept(
    db: AsyncSession,
):
    a = await _building(db, "a")
    u101, u102 = await _unit(db, a, "101"), await _unit(db, a, "102")
    m = await _member(db, a, "alice@example.com")
    first = await _insert(db, a.id, u101.id, m.id, start=T0)
    await db.execute(
        text("UPDATE unit_occupancies SET ended_at = :t WHERE id = :id"), {"t": T1, "id": first}
    )

    await _insert(db, a.id, u102.id, m.id, start=T1)

    rows = (
        await db.execute(
            select(UnitOccupancy.unit_id, UnitOccupancy.ended_at)
            .where(UnitOccupancy.membership_id == m.id)
            .order_by(UnitOccupancy.started_at)
        )
    ).all()
    assert [tuple(r) for r in rows] == [(u101.id, T1), (u102.id, None)]


# --- 3: composite FKs keep the unit, the membership and the occupancy in one building -----------


async def test_occupancy_of_a_unit_in_another_building_is_rejected(db: AsyncSession):
    a, b = await _building(db, "a"), await _building(db, "b")
    b_unit = await _unit(db, b, "101")
    m = await _member(db, a, "alice@example.com")

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_unit_id"):
        await _insert(db, a.id, b_unit.id, m.id)


async def test_occupancy_of_a_membership_in_another_building_is_rejected(db: AsyncSession):
    a, b = await _building(db, "a"), await _building(db, "b")
    b_unit = await _unit(db, b, "101")
    m = await _member(db, a, "alice@example.com")

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_membership_id"):
        await _insert(db, b.id, b_unit.id, m.id)


async def test_occupancy_within_one_building_is_accepted(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")

    await _insert(db, a.id, u101.id, m.id)

    assert await _count(db, m.id) == 1


async def test_model_occupancy_of_a_unit_in_another_building_is_rejected(db: AsyncSession):
    a, b = await _building(db, "a"), await _building(db, "b")
    b_unit = await _unit(db, b, "101")
    m = await _member(db, a, "alice@example.com")
    db.add(
        UnitOccupancy(
            building_id=a.id,
            unit_id=b_unit.id,
            membership_id=m.id,
            relationship=OccupancyRelationship.TENANT,
        )
    )

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_unit_id"):
        await db.flush()


# --- 4: check constraints -----------------------------------------------------------------------


async def test_ended_before_started_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")

    with pytest.raises(IntegrityError, match="ck_unit_occupancies_ended_after_started"):
        await _insert(db, a.id, u101.id, m.id, start=T1, end=T0)


async def test_ending_an_occupancy_before_it_started_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")
    row = await _insert(db, a.id, u101.id, m.id, start=T1)

    with pytest.raises(IntegrityError, match="ck_unit_occupancies_ended_after_started"):
        await db.execute(
            text("UPDATE unit_occupancies SET ended_at = :t WHERE id = :id"), {"t": T0, "id": row}
        )


async def test_ended_equal_to_started_is_accepted(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")

    await _insert(db, a.id, u101.id, m.id, start=T0, end=T0)

    assert await _count(db, m.id) == 1


async def test_relationship_outside_the_enum_is_rejected_by_the_database(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")

    with pytest.raises(IntegrityError, match="ck_unit_occupancies_relationship"):
        await _insert(db, a.id, u101.id, m.id, rel="landlord")


async def test_relationship_check_lists_exactly_the_enum_values(db: AsyncSession):
    definition = await db.scalar(
        text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :name"),
        {"name": "ck_unit_occupancies_relationship"},
    )
    assert definition is not None, "constraint ck_unit_occupancies_relationship is missing"

    assert set(re.findall(r"'([^']*)'", str(definition))) == {
        member.value for member in OccupancyRelationship
    }


def test_relationship_values_are_the_lowercase_ticket_list():
    assert [r.value for r in OccupancyRelationship] == ["owner", "tenant", "household"]


# --- 5: several memberships may occupy one unit at once -----------------------------------------


async def test_two_memberships_may_both_currently_occupy_one_unit(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    owner = await _member(db, a, "owner@example.com")
    child = await _member(db, a, "child@example.com")

    await _insert(db, a.id, u101.id, owner.id, rel="owner")
    await _insert(db, a.id, u101.id, child.id, rel="household")

    current = await db.scalar(
        select(func.count())
        .select_from(UnitOccupancy)
        .where(UnitOccupancy.unit_id == u101.id, UnitOccupancy.ended_at.is_(None))
    )
    assert current == 2


# --- 10: history is kept: no deletes, no moving to another building -----------------------------


async def test_deleting_a_unit_with_occupancies_is_restricted(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")
    await _insert(db, a.id, u101.id, m.id, start=T0, end=T1)

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_unit_id"):
        async with db.begin_nested():
            await db.execute(delete(Unit).where(Unit.id == u101.id))

    assert await _count(db, m.id) == 1


async def test_deleting_a_membership_with_occupancies_is_restricted(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")
    await _insert(db, a.id, u101.id, m.id, start=T0, end=T1)

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_membership_id"):
        async with db.begin_nested():
            await db.execute(delete(BuildingMembership).where(BuildingMembership.id == m.id))

    assert await _count(db, m.id) == 1


async def test_moving_an_occupied_unit_to_another_building_is_rejected(db: AsyncSession):
    a, b = await _building(db, "a"), await _building(db, "b")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")
    await _insert(db, a.id, u101.id, m.id)

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_unit_id"):
        await db.execute(
            text("UPDATE units SET building_id = :b WHERE id = :u"), {"b": b.id, "u": u101.id}
        )


async def test_moving_a_membership_with_occupancies_to_another_building_is_rejected(
    db: AsyncSession,
):
    a, b = await _building(db, "a"), await _building(db, "b")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")  # no roles: only the occupancy can object
    await _insert(db, a.id, u101.id, m.id)

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_membership_id"):
        await db.execute(
            text("UPDATE building_memberships SET building_id = :b WHERE id = :m"),
            {"b": b.id, "m": m.id},
        )


# --- 12: defaults, flush order, migration round-trip --------------------------------------------


async def test_raw_insert_starts_now_and_is_current(db: AsyncSession):
    a = await _building(db, "a")
    u101 = await _unit(db, a, "101")
    m = await _member(db, a, "alice@example.com")
    row = await db.scalar(
        text(
            "INSERT INTO unit_occupancies (id, building_id, unit_id, membership_id, relationship)"
            " VALUES (gen_random_uuid(), :b, :u, :m, 'owner') RETURNING id"
        ),
        {"b": a.id, "u": u101.id, "m": m.id},
    )

    stored = (
        await db.execute(
            text("SELECT started_at = now(), ended_at FROM unit_occupancies WHERE id = :id"),
            {"id": row},
        )
    ).one()
    assert tuple(stored) == (True, None)


async def test_new_unit_membership_and_occupancy_can_be_flushed_together(db: AsyncSession):
    a = await _building(db, "a")
    user = User(id=uuid7(), email="alice@example.com", full_name="Alice")
    unit = Unit(id=uuid7(), building_id=a.id, label="101")
    membership = BuildingMembership(id=uuid7(), building_id=a.id, user_id=user.id)
    # Occupancy first on purpose: the flush must still insert the unit and membership before it.
    db.add(
        UnitOccupancy(
            building_id=a.id,
            unit_id=unit.id,
            membership_id=membership.id,
            relationship=OccupancyRelationship.OWNER,
        )
    )
    db.add_all([membership, unit, user])

    await db.flush()

    assert await _count(db, membership.id) == 1


async def _table_names(url: str) -> set[str]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return set(await conn.run_sync(lambda sync: inspect(sync).get_table_names()))
    finally:
        await engine.dispose()


def test_migration_upgrades_downgrades_and_upgrades_again():
    # A scratch database, so dropping tables never disturbs the session's test schema.
    url = make_url(settings.test_database_url).set(database="condo_migrations_test")
    scratch = url.render_as_string(hide_password=False)
    assert_safe_test_database_url(scratch, settings.database_url)
    asyncio.run(_recreate_test_schema(scratch))

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = scratch
    cfg.attributes["configure_logger"] = False

    # Pinned revisions, not `-1`: later migrations stack on top and must not change what this tests.
    command.upgrade(cfg, P1_03_REVISION)
    assert "unit_occupancies" in asyncio.run(_table_names(scratch))

    command.downgrade(cfg, P1_03_DOWN_REVISION)
    tables = asyncio.run(_table_names(scratch))
    assert "unit_occupancies" not in tables
    assert "building_memberships" in tables  # only this revision was undone

    command.upgrade(cfg, "head")
    assert "unit_occupancies" in asyncio.run(_table_names(scratch))
    command.check(cfg)  # raises if the models and the migrated schema differ
