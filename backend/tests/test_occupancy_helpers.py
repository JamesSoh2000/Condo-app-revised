"""P1-03: the occupancy helpers and the occupancy-window clause.

Windows are half-open: an occupancy covers `started_at <= T < ended_at`. Criterion numbers refer to
the ticket.
"""

import asyncio
from collections.abc import AsyncIterator, Awaitable, Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import (
    Column,
    DateTime,
    MetaData,
    Table,
    Uuid,
    column,
    delete,
    func,
    literal,
    literal_column,
    null,
    quoted_name,
    select,
    text,
)
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.orm import aliased

from app.buildings.models import Building
from app.core.database import AsyncSessionLocal
from app.memberships import occupancy
from app.memberships.enums import OccupancyRelationship
from app.memberships.models import BuildingMembership, UnitOccupancy
from app.memberships.occupancy import (
    OccupancyTimeError,
    current_occupants,
    end_occupancy,
    occupancy_window_clause,
    start_occupancy,
    transfer_occupancy,
)
from app.units.models import Unit
from app.users.models import User

pytestmark = pytest.mark.anyio

OWNER, TENANT, HOUSEHOLD = (
    OccupancyRelationship.OWNER,
    OccupancyRelationship.TENANT,
    OccupancyRelationship.HOUSEHOLD,
)
T0 = datetime(2026, 1, 1, tzinfo=UTC)
T1 = T0 + timedelta(days=30)
T2 = T0 + timedelta(days=60)
T3 = T0 + timedelta(days=90)
SECOND = timedelta(seconds=1)


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


async def _history(db: AsyncSession, membership_id: UUID) -> list[tuple[Any, ...]]:
    """(unit_id, relationship, started_at, ended_at) of every occupancy, oldest first."""
    rows = await db.execute(
        select(
            UnitOccupancy.unit_id,
            UnitOccupancy.relationship,
            UnitOccupancy.started_at,
            UnitOccupancy.ended_at,
        )
        .where(UnitOccupancy.membership_id == membership_id)
        .order_by(UnitOccupancy.started_at, UnitOccupancy.ended_at.nulls_last())
    )
    return [tuple(r) for r in rows]


@dataclass
class Setup:
    a: Building
    u101: Unit
    u102: Unit
    m: BuildingMembership


@pytest.fixture
async def setup(db: AsyncSession) -> Setup:
    a = await _building(db, "a")
    return Setup(
        a, await _unit(db, a, "101"), await _unit(db, a, "102"), await _member(db, a, "m@x.io")
    )


# --- start_occupancy ----------------------------------------------------------------------------


async def test_start_occupancy_creates_a_current_row(db: AsyncSession, setup: Setup):
    row = await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    assert (row.unit_id, row.relationship, row.started_at, row.ended_at) == (
        setup.u101.id,
        TENANT,
        T0,
        None,
    )
    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T0, None)]


async def test_start_occupancy_defaults_to_the_transactions_now(db: AsyncSession, setup: Setup):
    row = await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=OWNER,
    )

    assert row.started_at == await db.scalar(select(func.now()))


async def test_start_occupancy_twice_is_rejected_by_the_current_index(
    db: AsyncSession, setup: Setup
):
    """Criterion 1, through the helper."""
    kwargs = {"building_id": setup.a.id, "membership_id": setup.m.id, "relationship": TENANT}
    await start_occupancy(db, unit_id=setup.u101.id, at=T0, **kwargs)

    with pytest.raises(IntegrityError, match="uq_unit_occupancies_current_membership"):
        await start_occupancy(db, unit_id=setup.u102.id, at=T1, **kwargs)


async def test_start_occupancy_of_another_buildings_unit_is_rejected(
    db: AsyncSession, setup: Setup
):
    """Criterion 3, through the helper."""
    b = await _building(db, "b")
    b_unit = await _unit(db, b, "101")

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_unit_id"):
        await start_occupancy(
            db,
            building_id=setup.a.id,
            membership_id=setup.m.id,
            unit_id=b_unit.id,
            relationship=TENANT,
        )


# --- 5: current_occupants -----------------------------------------------------------------------


async def test_current_occupants_lists_current_memberships_in_start_order(
    db: AsyncSession, setup: Setup
):
    a = setup.a
    former = await _member(db, a, "former@x.io")
    owner = await _member(db, a, "owner@x.io")
    child = await _member(db, a, "child@x.io")
    elsewhere = await _member(db, a, "elsewhere@x.io")
    await start_occupancy(
        db,
        building_id=a.id,
        membership_id=former.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )
    await end_occupancy(db, building_id=a.id, membership_id=former.id, at=T1)
    # Started later but added first: the order must come from started_at.
    await start_occupancy(
        db,
        building_id=a.id,
        membership_id=child.id,
        unit_id=setup.u101.id,
        relationship=HOUSEHOLD,
        at=T2,
    )
    await start_occupancy(
        db,
        building_id=a.id,
        membership_id=owner.id,
        unit_id=setup.u101.id,
        relationship=OWNER,
        at=T1,
    )
    await start_occupancy(
        db,
        building_id=a.id,
        membership_id=elsewhere.id,
        unit_id=setup.u102.id,
        relationship=OWNER,
        at=T0,
    )

    assert await current_occupants(db, a.id, setup.u101.id) == [owner.id, child.id]
    assert await current_occupants(db, a.id, setup.u102.id) == [elsewhere.id]


async def test_current_occupants_of_a_unit_in_another_building_is_empty(
    db: AsyncSession, setup: Setup
):
    b = await _building(db, "b")
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
    )

    assert await current_occupants(db, b.id, setup.u101.id) == []
    assert await current_occupants(db, setup.a.id, setup.u101.id) == [setup.m.id]  # control


# --- 8: end_occupancy and transfer_occupancy ----------------------------------------------------


async def test_end_occupancy_sets_ended_at_and_returns_the_row(db: AsyncSession, setup: Setup):
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    ended = await end_occupancy(db, building_id=setup.a.id, membership_id=setup.m.id, at=T1)

    assert ended is not None
    assert ended.ended_at == T1
    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T0, T1)]


async def test_end_occupancy_defaults_to_the_transactions_now(db: AsyncSession, setup: Setup):
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    ended = await end_occupancy(db, building_id=setup.a.id, membership_id=setup.m.id)

    assert ended is not None
    assert ended.ended_at == await db.scalar(select(func.now()))


async def test_end_occupancy_without_a_current_one_is_a_no_op(db: AsyncSession, setup: Setup):
    assert await end_occupancy(db, building_id=setup.a.id, membership_id=setup.m.id) is None

    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )
    await end_occupancy(db, building_id=setup.a.id, membership_id=setup.m.id, at=T1)

    assert await end_occupancy(db, building_id=setup.a.id, membership_id=setup.m.id, at=T2) is None
    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T0, T1)]  # T1 kept


async def test_end_occupancy_scoped_to_another_building_changes_nothing(
    db: AsyncSession, setup: Setup
):
    b = await _building(db, "b")
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    assert await end_occupancy(db, building_id=b.id, membership_id=setup.m.id, at=T1) is None
    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T0, None)]


async def test_transfer_ends_and_starts_at_the_same_instant(db: AsyncSession, setup: Setup):
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    new = await transfer_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        new_unit_id=setup.u102.id,
        relationship=OWNER,
        at=T1,
    )

    assert (new.unit_id, new.started_at, new.ended_at) == (setup.u102.id, T1, None)
    assert await _history(db, setup.m.id) == [
        (setup.u101.id, TENANT, T0, T1),
        (setup.u102.id, OWNER, T1, None),
    ]


async def test_transfer_by_default_shares_the_transactions_now(db: AsyncSession, setup: Setup):
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    new = await transfer_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        new_unit_id=setup.u102.id,
        relationship=TENANT,
    )

    now = await db.scalar(select(func.now()))
    old, current = await _history(db, setup.m.id)
    assert (old[3], current[2], new.started_at) == (now, now, now)


async def test_transfer_within_the_same_unit_changes_the_relationship(
    db: AsyncSession, setup: Setup
):
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    await transfer_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        new_unit_id=setup.u101.id,
        relationship=OWNER,
        at=T1,
    )

    assert await _history(db, setup.m.id) == [
        (setup.u101.id, TENANT, T0, T1),
        (setup.u101.id, OWNER, T1, None),
    ]


async def test_transfer_without_a_current_occupancy_just_starts_one(db: AsyncSession, setup: Setup):
    await transfer_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        new_unit_id=setup.u102.id,
        relationship=TENANT,
        at=T1,
    )

    assert await _history(db, setup.m.id) == [(setup.u102.id, TENANT, T1, None)]


# --- 6: a transfer failing midway leaves nothing behind -----------------------------------------


async def _committed_occupancy(db: AsyncSession, setup: Setup) -> None:
    await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )
    # As if an earlier request had created it: the transfer below runs in a transaction of its own.
    await db.commit()


async def test_transfer_failing_after_the_end_persists_neither_change(
    db: AsyncSession, setup: Setup, monkeypatch: pytest.MonkeyPatch
):
    await _committed_occupancy(db, setup)
    m_id, u101_id = setup.m.id, setup.u101.id  # rollback() expires the setup objects
    ended_before_failing: list[datetime | None] = []

    async def start_that_fails(session: AsyncSession, **_: object) -> UnitOccupancy:
        # Proves the failure comes after the end: the old row is already ended in this transaction.
        ended_before_failing.append(
            await session.scalar(
                select(UnitOccupancy.ended_at).where(UnitOccupancy.unit_id == setup.u101.id)
            )
        )
        raise RuntimeError("simulated failure between end and start")

    monkeypatch.setattr(occupancy, "start_occupancy", start_that_fails)
    with pytest.raises(RuntimeError, match="simulated"):
        await occupancy.transfer_occupancy(
            db,
            building_id=setup.a.id,
            membership_id=setup.m.id,
            new_unit_id=setup.u102.id,
            relationship=OWNER,
            at=T1,
        )
    await db.rollback()  # what the caller's transaction does on an exception

    assert ended_before_failing == [T1]
    assert await _history(db, m_id) == [(u101_id, TENANT, T0, None)]


async def test_transfer_hitting_a_constraint_after_the_end_persists_neither_change(
    db: AsyncSession, setup: Setup
):
    b = await _building(db, "b")
    b_unit = await _unit(db, b, "101")
    await _committed_occupancy(db, setup)
    m_id, u101_id = setup.m.id, setup.u101.id  # rollback() expires the setup objects

    with pytest.raises(IntegrityError, match="fk_unit_occupancies_building_id_unit_id"):
        await transfer_occupancy(
            db,
            building_id=setup.a.id,
            membership_id=setup.m.id,
            new_unit_id=b_unit.id,
            relationship=OWNER,
            at=T1,
        )
    await db.rollback()

    assert await _history(db, m_id) == [(u101_id, TENANT, T0, None)]


async def test_helpers_never_commit(
    db: AsyncSession, setup: Setup, monkeypatch: pytest.MonkeyPatch
):
    async def no_commit() -> None:
        raise AssertionError("a helper called commit()")

    monkeypatch.setattr(db, "commit", no_commit)
    ids = {"building_id": setup.a.id, "membership_id": setup.m.id}

    await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=T0, **ids)
    await transfer_occupancy(db, new_unit_id=setup.u102.id, relationship=TENANT, at=T1, **ids)
    await end_occupancy(db, at=T2, **ids)
    await current_occupants(db, setup.a.id, setup.u102.id)


# --- 9: a person's history can't overlap itself; times must be ordered and aware ----------------


async def test_start_before_an_earlier_occupancy_ended_is_refused(db: AsyncSession, setup: Setup):
    ids = {"building_id": setup.a.id, "membership_id": setup.m.id}
    await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=T0, **ids)
    await end_occupancy(db, at=T2, **ids)

    for at in (T1, T2 - SECOND, T0 - SECOND):
        with pytest.raises(OccupancyTimeError):
            await start_occupancy(db, unit_id=setup.u102.id, relationship=TENANT, at=at, **ids)

    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T0, T2)]
    await start_occupancy(db, unit_id=setup.u102.id, relationship=TENANT, at=T2, **ids)  # boundary
    assert len(await _history(db, setup.m.id)) == 2


async def test_end_before_the_current_occupancy_started_is_refused(db: AsyncSession, setup: Setup):
    ids = {"building_id": setup.a.id, "membership_id": setup.m.id}
    await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=T1, **ids)

    with pytest.raises(OccupancyTimeError):
        await end_occupancy(db, at=T1 - SECOND, **ids)

    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T1, None)]


async def test_transfer_before_the_current_occupancy_started_is_refused(
    db: AsyncSession, setup: Setup
):
    ids = {"building_id": setup.a.id, "membership_id": setup.m.id}
    await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=T1, **ids)

    with pytest.raises(OccupancyTimeError):
        await transfer_occupancy(db, new_unit_id=setup.u102.id, relationship=TENANT, at=T0, **ids)

    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T1, None)]


async def test_naive_times_are_refused_before_any_write(db: AsyncSession, setup: Setup):
    naive = datetime(2026, 1, 1)
    ids = {"building_id": setup.a.id, "membership_id": setup.m.id}

    with pytest.raises(ValueError, match="timezone-aware"):
        await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=naive, **ids)
    await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=T0, **ids)
    with pytest.raises(ValueError, match="timezone-aware"):
        await end_occupancy(db, at=naive, **ids)
    with pytest.raises(ValueError, match="timezone-aware"):
        await transfer_occupancy(
            db, new_unit_id=setup.u102.id, relationship=TENANT, at=naive, **ids
        )

    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T0, None)]


# --- 7: the occupancy-window clause -------------------------------------------------------------


@dataclass
class Turnover:
    """Unit 101: `former` from T0 to T1, `current` from T1 on (a transfer instant at T1)."""

    s: Setup
    former: BuildingMembership
    current: BuildingMembership


@pytest.fixture
async def turnover(db: AsyncSession, setup: Setup) -> Turnover:
    a = setup.a
    former, current = setup.m, await _member(db, a, "current@x.io")
    await start_occupancy(
        db,
        building_id=a.id,
        membership_id=former.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )
    await transfer_occupancy(
        db,
        building_id=a.id,
        membership_id=former.id,
        new_unit_id=setup.u102.id,
        relationship=TENANT,
        at=T1,
    )
    await start_occupancy(
        db,
        building_id=a.id,
        membership_id=current.id,
        unit_id=setup.u101.id,
        relationship=OWNER,
        at=T1,
    )
    return Turnover(setup, former, current)


async def _in_window(
    db: AsyncSession, membership_id: UUID | None, unit_id: UUID | None, at: datetime | None
) -> bool:
    clause = occupancy_window_clause(
        membership_id,  # type: ignore[arg-type]  # None on purpose: it must fail closed
        literal(unit_id, Uuid()),
        literal(at, DateTime(timezone=True)),
    )
    return bool(await db.scalar(select(clause)))


@pytest.mark.parametrize(
    ("who", "unit", "at", "expected"),
    [
        # Ticket cases: a record for 101 at T.
        ("former", "101", T2, False),  # former's window ended before T
        ("current", "101", T2, True),  # current's window started before T
        ("current", "101", T1 - SECOND, False),  # current started after T
        ("former", "101", T1 - SECOND, True),  # ...while the former still lived there
        # Half-open boundaries.
        ("former", "101", T0, True),  # T = started_at
        ("former", "101", T0 - SECOND, False),
        ("former", "101", T1, False),  # T = ended_at: the transfer instant
        ("current", "101", T1, True),  # ...belongs to the new occupant only
        ("former", "102", T1, True),  # and to the former's new unit
        # Another unit, another membership.
        ("former", "102", T1 - SECOND, False),  # former's 102 window hadn't started
        ("current", "102", T2, False),  # current never lived in 102
    ],
)
async def test_window_clause_against_literal_records(
    db: AsyncSession, turnover: Turnover, who: str, unit: str, at: datetime, expected: bool
):
    membership = turnover.former if who == "former" else turnover.current
    unit_id = (turnover.s.u101 if unit == "101" else turnover.s.u102).id

    assert await _in_window(db, membership.id, unit_id, at) is expected


async def test_window_clause_fails_closed_on_nulls(db: AsyncSession, turnover: Turnover):
    u101 = turnover.s.u101.id
    assert await _in_window(db, turnover.current.id, u101, T2) is True  # control

    assert await _in_window(db, turnover.current.id, None, T2) is False
    assert await _in_window(db, turnover.current.id, u101, None) is False
    assert await _in_window(db, None, u101, T2) is False


async def test_window_clause_correlates_with_an_outer_table_of_records(
    db: AsyncSession, turnover: Turnover
):
    # A stand-in for `packages`: a temporary table, dropped with the test's transaction.
    records = Table(
        "occupancy_test_records",
        MetaData(),
        Column("name", Uuid()),
        Column("unit_id", Uuid()),
        Column("created_at", DateTime(timezone=True)),
        prefixes=["TEMPORARY"],
    )
    await db.run_sync(lambda sync: records.create(sync.connection()))
    u101, u102 = turnover.s.u101.id, turnover.s.u102.id
    named = {
        "p0": (u101, T0 + SECOND),  # former's 101 time
        "p1": (u101, T2),  # current's 101 time
        "p2": (u102, T0 + SECOND),  # 102 before anyone in this test lived there
        "p3": (u102, T2),  # former's 102 time
        "p4": (u101, T1),  # the transfer instant
    }
    ids = {name: UUID(int=i) for i, name in enumerate(named)}
    await db.execute(
        records.insert(),
        [{"name": ids[n], "unit_id": u, "created_at": t} for n, (u, t) in named.items()],
    )

    async def visible_to(membership_id: UUID) -> set[str]:
        rows = await db.scalars(
            select(records.c.name).where(
                occupancy_window_clause(membership_id, records.c.unit_id, records.c.created_at)
            )
        )
        by_id = {v: k for k, v in ids.items()}
        return {by_id[r] for r in rows}

    assert await visible_to(turnover.former.id) == {"p0", "p3"}
    assert await visible_to(turnover.current.id) == {"p1", "p4"}


# --- 11: concurrent writes for one membership run one after the other ---------------------------


@pytest.fixture
async def committed(engine: AsyncEngine) -> AsyncIterator[dict[str, UUID]]:
    """Rows really committed (not in the test's rolled-back transaction), deleted afterwards."""
    async with AsyncSessionLocal(bind=engine) as s:
        a = await _building(s, "concurrency-a")
        ids = {
            "a": a.id,
            "u101": (await _unit(s, a, "101")).id,
            "u102": (await _unit(s, a, "102")).id,
            "u103": (await _unit(s, a, "103")).id,
            "m": (await _member(s, a, "concurrent@x.io")).id,
        }
        await start_occupancy(
            s,
            building_id=a.id,
            membership_id=ids["m"],
            unit_id=ids["u101"],
            relationship=TENANT,
            at=T0,
        )
        ids["user"] = (await s.get_one(BuildingMembership, ids["m"])).user_id
        await s.commit()
    try:
        yield ids
    finally:
        async with AsyncSessionLocal(bind=engine) as s:
            await s.execute(delete(UnitOccupancy).where(UnitOccupancy.building_id == ids["a"]))
            await s.execute(
                delete(BuildingMembership).where(BuildingMembership.building_id == ids["a"])
            )
            await s.execute(delete(User).where(User.id == ids["user"]))
            await s.execute(delete(Unit).where(Unit.building_id == ids["a"]))
            await s.execute(delete(Building).where(Building.id == ids["a"]))
            await s.commit()


async def _wait_until_blocked_on_a_lock(engine: AsyncEngine, pid: int) -> None:
    async with engine.connect() as conn:
        for _ in range(100):
            waiting = await conn.scalar(
                text("SELECT wait_event_type FROM pg_stat_activity WHERE pid = :pid"), {"pid": pid}
            )
            if waiting == "Lock":
                return
            await asyncio.sleep(0.05)
    raise AssertionError("the second writer never waited for the first one's lock")


async def _race(
    engine: AsyncEngine,
    first: Callable[[AsyncSession], Awaitable[object]],
    second: Callable[[AsyncSession], Awaitable[object]],
) -> None:
    """Run `first` (uncommitted), start `second`, check it waits, commit both in that order."""
    # Each session on a connection of its own: one from the pool could change between transactions,
    # and the lock check below watches the second one's backend.
    async with engine.connect() as c1, engine.connect() as c2:
        s1, s2 = AsyncSessionLocal(bind=c1), AsyncSessionLocal(bind=c2)
        pid = (await c2.execute(select(func.pg_backend_pid()))).scalar_one()
        await c2.commit()  # the pid query's transaction; `second` starts a fresh one

        await first(s1)

        async def run_second() -> None:
            await second(s2)
            await s2.commit()

        task = asyncio.create_task(run_second())
        try:
            await _wait_until_blocked_on_a_lock(engine, pid)
        finally:
            await s1.commit()
            await task


async def _current_and_history(
    engine: AsyncEngine, membership_id: UUID
) -> tuple[list[UUID], list[tuple[Any, ...]]]:
    async with AsyncSessionLocal(bind=engine) as s:
        current = await s.scalars(
            select(UnitOccupancy.unit_id).where(
                UnitOccupancy.membership_id == membership_id, UnitOccupancy.ended_at.is_(None)
            )
        )
        return list(current), await _history(s, membership_id)


async def test_concurrent_transfers_apply_one_after_the_other(
    engine: AsyncEngine, committed: dict[str, UUID]
):
    ids = {"building_id": committed["a"], "membership_id": committed["m"]}

    await _race(
        engine,
        lambda s: transfer_occupancy(s, new_unit_id=committed["u102"], relationship=TENANT, **ids),
        lambda s: transfer_occupancy(s, new_unit_id=committed["u103"], relationship=OWNER, **ids),
    )

    current, history = await _current_and_history(engine, committed["m"])
    assert current == [committed["u103"]]
    assert [(unit, rel) for unit, rel, _, _ in history] == [
        (committed["u101"], TENANT),
        (committed["u102"], TENANT),
        (committed["u103"], OWNER),
    ]
    # Back to back: each window ends exactly where the next one starts.
    assert [h[3] for h in history[:-1]] == [h[2] for h in history[1:]]


async def test_move_out_racing_a_transfer_ends_the_new_occupancy(
    engine: AsyncEngine, committed: dict[str, UUID]
):
    ids = {"building_id": committed["a"], "membership_id": committed["m"]}

    await _race(
        engine,
        lambda s: transfer_occupancy(s, new_unit_id=committed["u102"], relationship=TENANT, **ids),
        lambda s: end_occupancy(s, **ids),
    )

    current, history = await _current_and_history(engine, committed["m"])
    assert current == []
    assert [unit for unit, *_ in history] == [committed["u101"], committed["u102"]]


# --- review round 1 ------------------------------------------------------------------------------


async def test_future_times_are_refused(db: AsyncSession, setup: Setup):
    """Low 2: a future start would be listed as current before its window opens."""
    ids = {"building_id": setup.a.id, "membership_id": setup.m.id}
    future = await db.scalar(select(func.now() + timedelta(seconds=1)))
    assert future is not None

    with pytest.raises(OccupancyTimeError, match="future"):
        await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=future, **ids)
    await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=T0, **ids)
    with pytest.raises(OccupancyTimeError, match="future"):
        await end_occupancy(db, at=future, **ids)
    with pytest.raises(OccupancyTimeError, match="future"):
        await transfer_occupancy(
            db, new_unit_id=setup.u102.id, relationship=TENANT, at=future, **ids
        )

    assert await _history(db, setup.m.id) == [(setup.u101.id, TENANT, T0, None)]


async def test_window_clause_works_when_the_outer_query_joins_unit_occupancies(
    db: AsyncSession, turnover: Turnover
):
    """Low 3: the EXISTS must keep its own unit_occupancies, not correlate it away."""
    records = Table(
        "occupancy_join_records",
        MetaData(),
        Column("unit_id", Uuid()),
        Column("created_at", DateTime(timezone=True)),
        prefixes=["TEMPORARY"],
    )
    await db.run_sync(lambda sync: records.create(sync.connection()))
    await db.execute(
        records.insert(),
        [
            {"unit_id": turnover.s.u101.id, "created_at": T0 + SECOND},  # former's time
            {"unit_id": turnover.s.u101.id, "created_at": T2},  # current's time
        ],
    )
    # Records joined to every occupancy of their unit (an occupant list next to each record),
    # filtered to the records `current` may see.
    query = (
        select(records.c.created_at, UnitOccupancy.membership_id)
        .join(UnitOccupancy, UnitOccupancy.unit_id == records.c.unit_id)
        .where(
            occupancy_window_clause(turnover.current.id, records.c.unit_id, records.c.created_at)
        )
        .order_by(UnitOccupancy.started_at)
    )

    rows = [tuple(r) for r in await db.execute(query)]
    assert rows == [(T2, turnover.former.id), (T2, turnover.current.id)]


# --- review round 2 ------------------------------------------------------------------------------


# Outer table: plain; an anonymous alias; and named aliases, including names SQLAlchemy gives
# anonymous aliases and the names earlier versions of the clause used for their own alias (rounds 2
# and 3 found those shadowing an outer alias).
OUTER_ALIASES = [
    None,
    "",
    "unit_occupancies_1",
    "unit_occupancies_2",
    "anon_1",
    "unit_occupancies",
    "window_occupancy",
    "occupancy_window",
    "o",
]


@pytest.mark.parametrize("alias_outer", OUTER_ALIASES)
async def test_window_clause_uses_the_outer_queries_membership_column(
    db: AsyncSession, turnover: Turnover, alias_outer: str | None
):
    """Codex H1: a membership column from the outer query must stay an outer reference.

    With the clause correlating everything but `unit_occupancies`, an outer
    `UnitOccupancy.membership_id` became `membership_id = membership_id` inside the EXISTS (always
    true), and the newcomer was shown the former occupant's record.
    """
    records = Table(
        "occupancy_outer_member_records",
        MetaData(),
        Column("unit_id", Uuid()),
        Column("created_at", DateTime(timezone=True)),
        prefixes=["TEMPORARY"],
    )
    await db.run_sync(lambda sync: records.create(sync.connection()))
    await db.execute(
        records.insert(),
        [
            {"unit_id": turnover.s.u101.id, "created_at": T0 + SECOND},  # former's time
            {"unit_id": turnover.s.u101.id, "created_at": T2},  # current's time
        ],
    )
    occupant: Any = (
        UnitOccupancy if alias_outer is None else aliased(UnitOccupancy, name=alias_outer or None)
    )
    query = (
        select(records.c.created_at, occupant.membership_id)
        .join(occupant, occupant.unit_id == records.c.unit_id)
        .where(
            occupant.membership_id == turnover.current.id,
            occupancy_window_clause(
                occupant.membership_id, records.c.unit_id, records.c.created_at
            ),
        )
        .order_by(records.c.created_at)
    )

    assert [tuple(r) for r in await db.execute(query)] == [(T2, turnover.current.id)]


async def test_window_clause_with_every_argument_from_an_outer_unit_occupancies_query(
    db: AsyncSession, turnover: Turnover
):
    """Neighbour of H1: all three arguments are columns of the outer `unit_occupancies` rows."""
    query = (
        select(UnitOccupancy.membership_id)
        .where(
            UnitOccupancy.unit_id == turnover.s.u101.id,
            occupancy_window_clause(
                UnitOccupancy.membership_id,
                UnitOccupancy.unit_id,
                literal(T2, DateTime(timezone=True)),
            ),
        )
        .order_by(UnitOccupancy.started_at)
    )

    # Of 101's two occupants, only `current` occupied it at T2.
    assert list(await db.scalars(query)) == [turnover.current.id]


async def test_window_clause_with_an_outer_time_column_from_unit_occupancies(
    db: AsyncSession, turnover: Turnover
):
    """Neighbour of H1: the record's time is the outer occupancy's own start."""
    query = (
        select(UnitOccupancy.membership_id)
        .where(
            UnitOccupancy.unit_id == turnover.s.u101.id,
            occupancy_window_clause(
                turnover.former.id, UnitOccupancy.unit_id, UnitOccupancy.started_at
            ),
        )
        .order_by(UnitOccupancy.started_at)
    )

    # `former` held 101 at its own start (T0), not at `current`'s start (T1, the transfer instant).
    assert list(await db.scalars(query)) == [turnover.former.id]


async def test_start_occupancy_returns_a_fully_loaded_row(db: AsyncSession, setup: Setup):
    """Review round 2, L2: no attribute of the returned row needs a lazy load."""
    row = await start_occupancy(
        db,
        building_id=setup.a.id,
        membership_id=setup.m.id,
        unit_id=setup.u101.id,
        relationship=TENANT,
        at=T0,
    )

    assert row.created_at is not None
    assert row.updated_at is not None


async def test_start_occupancy_sees_the_callers_unflushed_rows(db: AsyncSession, setup: Setup):
    """The overlap check must see an earlier occupancy the caller added but hasn't flushed."""
    db.add(
        UnitOccupancy(
            building_id=setup.a.id,
            unit_id=setup.u101.id,
            membership_id=setup.m.id,
            relationship=TENANT,
            started_at=T0,
            ended_at=T2,
        )
    )

    with pytest.raises(OccupancyTimeError):
        await start_occupancy(
            db,
            building_id=setup.a.id,
            membership_id=setup.m.id,
            unit_id=setup.u102.id,
            relationship=TENANT,
            at=T1,
        )


async def test_the_membership_lock_leaves_fk_checks_on_the_membership_unblocked(
    engine: AsyncEngine, committed: dict[str, UUID]
):
    """ADR-0016: NO KEY UPDATE, so rows that reference the membership can still be written."""
    ids = {"building_id": committed["a"], "membership_id": committed["m"]}
    async with engine.connect() as c1, engine.connect() as c2:
        holder = AsyncSessionLocal(bind=c1)
        await transfer_occupancy(holder, new_unit_id=committed["u102"], relationship=TENANT, **ids)

        # Fails fast instead of hanging if the FK's KEY SHARE lock has to wait for the holder.
        await c2.execute(text("SET LOCAL lock_timeout = '2s'"))
        await c2.execute(
            text(
                "INSERT INTO membership_roles (building_id, membership_id, role)"
                " VALUES (:b, :m, 'resident')"
            ),
            {"b": committed["a"], "m": committed["m"]},
        )
        await c2.rollback()
        await holder.rollback()


# --- review round 4: names that resolve inside the window test ---------------------------------
# Rounds 2-4 each found an argument or query shape whose names resolved to the clause's own
# `unit_occupancies` instead of the caller's record, making it always true. The test now runs in a
# database function (`occupancy_window`), which gets its arguments as values: the shapes below must
# give exactly the turnover's answer. `current` may see only its own 101 record (T2); `former` its
# 101 record (T0 + 1s) and its 102 record (T2).


@pytest.fixture
async def window_records(db: AsyncSession, turnover: Turnover) -> Table:
    records = Table(
        "window_records",
        MetaData(),
        Column("unit_id", Uuid()),
        Column("created_at", DateTime(timezone=True)),
        prefixes=["TEMPORARY"],
    )
    await db.run_sync(lambda sync: records.create(sync.connection()))
    u101, u102 = turnover.s.u101.id, turnover.s.u102.id
    await db.execute(
        records.insert(),
        [
            {"unit_id": u101, "created_at": T0 + SECOND},  # former's
            {"unit_id": u101, "created_at": T2},  # current's
            {"unit_id": u102, "created_at": T2},  # former's, after the transfer
        ],
    )
    return records


def _expected(turnover: Turnover, who: str) -> set[tuple[UUID, datetime]]:
    u101, u102 = turnover.s.u101.id, turnover.s.u102.id
    if who == "current":
        return {(u101, T2)}
    return {(u101, T0 + SECOND), (u102, T2)}


@pytest.mark.parametrize("who", ["current", "former"])
@pytest.mark.parametrize("shape", ["column", "literal_column", "text"])
async def test_window_clause_with_unqualified_column_arguments(
    db: AsyncSession, turnover: Turnover, window_records: Table, who: str, shape: str
):
    """Round 4 (H1): an unqualified name used to resolve to the clause's own table."""
    membership = getattr(turnover, who).id
    make: Any = {"column": column, "literal_column": literal_column, "text": literal_column}[shape]
    unit, created = make("unit_id"), make("created_at")
    query = select(unit, created).where(occupancy_window_clause(membership, unit, created))
    query = (
        query.select_from(text("window_records"))
        if shape == "text"
        else query.select_from(window_records)
    )

    assert {tuple(r) for r in await db.execute(query)} == _expected(turnover, who)


@pytest.mark.parametrize(
    "name", ["OCCUPANCY_WINDOW", "UNIT_OCCUPANCIES", "occupancy_window", "o", "window_occupancy"]
)
async def test_window_clause_with_a_record_alias_of_any_name(
    db: AsyncSession, turnover: Turnover, window_records: Table, name: str
):
    """Round 4 (L1) and round 3: alias names, unquoted upper case included, can't collide."""
    records = window_records.alias(quoted_name(name, quote=False))
    query = select(records.c.unit_id, records.c.created_at).where(
        occupancy_window_clause(turnover.current.id, records.c.unit_id, records.c.created_at)
    )

    assert {tuple(r) for r in await db.execute(query)} == _expected(turnover, "current")


async def test_window_clause_ignores_an_outer_cte_named_unit_occupancies(
    db: AsyncSession, turnover: Turnover, window_records: Table
):
    """Round 4 (L2): a CTE of that name must not stand in for the real table."""
    fake = select(
        literal(turnover.current.id, Uuid()).label("membership_id"),
        literal(turnover.s.u101.id, Uuid()).label("unit_id"),
        literal(T0 - SECOND, DateTime(timezone=True)).label("started_at"),
        null().label("ended_at"),
    ).cte("unit_occupancies")
    query = (
        select(window_records.c.unit_id, window_records.c.created_at)
        .add_cte(fake)
        .where(
            occupancy_window_clause(
                turnover.current.id, window_records.c.unit_id, window_records.c.created_at
            )
        )
    )

    assert {tuple(r) for r in await db.execute(query)} == _expected(turnover, "current")


async def test_window_clause_ignores_a_temporary_table_named_unit_occupancies(
    db: AsyncSession, turnover: Turnover, window_records: Table
):
    """`pg_temp` comes first on the search path; the function's table is bound when it's created."""
    await db.execute(
        text(
            "CREATE TEMPORARY TABLE unit_occupancies AS SELECT CAST(:m AS uuid) AS membership_id,"
            " CAST(:u AS uuid) AS unit_id, CAST(:t AS timestamptz) AS started_at,"
            " CAST(NULL AS timestamptz) AS ended_at"
        ),
        {"m": turnover.current.id, "u": turnover.s.u101.id, "t": T0 - SECOND},
    )
    query = select(window_records.c.unit_id, window_records.c.created_at).where(
        occupancy_window_clause(
            turnover.current.id, window_records.c.unit_id, window_records.c.created_at
        )
    )

    assert {tuple(r) for r in await db.execute(query)} == _expected(turnover, "current")


async def test_window_function_is_stable_not_strict_and_bound_at_creation(db: AsyncSession):
    row = (
        await db.execute(
            text(
                "SELECT provolatile::text, proisstrict, prosqlbody IS NOT NULL, prosecdef,"
                " proconfig IS NULL FROM pg_proc"
                " WHERE proname = 'occupancy_window'"
            )
        )
    ).one()

    # STABLE: reads the table, same answer within a statement. Not STRICT: a NULL argument gives
    # false, not NULL. A SQL-standard body (prosqlbody) is parsed and bound when it's created. Not
    # SECURITY DEFINER and no SET clauses (review round 5, L1): it runs with the caller's rights.
    assert tuple(row) == ("s", False, True, False, True)


async def test_ending_at_the_instant_it_started_is_allowed(db: AsyncSession, setup: Setup):
    """Review round 3, L1: `started_at <= at`, not `<`; a zero-length occupancy is valid."""
    ids = {"building_id": setup.a.id, "membership_id": setup.m.id}
    await start_occupancy(db, unit_id=setup.u101.id, relationship=TENANT, at=T1, **ids)

    ended = await end_occupancy(db, at=T1, **ids)

    assert ended is not None
    assert ended.ended_at == T1


# --- review round 5 ------------------------------------------------------------------------------


@pytest.mark.parametrize("shadow", ["function", "table"])
async def test_window_clause_ignores_look_alikes_earlier_on_the_search_path(
    db: AsyncSession, turnover: Turnover, shadow: str
):
    """Codex round 5 (M1): an earlier schema on the search path must not replace the real test."""
    await db.execute(text("CREATE SCHEMA occupancy_shadow"))
    if shadow == "function":
        await db.execute(
            text(
                "CREATE FUNCTION occupancy_shadow.occupancy_window(uuid, uuid, timestamptz)"
                " RETURNS boolean LANGUAGE sql STABLE RETURN true"
            )
        )
    else:
        await db.execute(
            text(
                "CREATE TABLE occupancy_shadow.unit_occupancies AS SELECT"
                " CAST(:m AS uuid) AS membership_id, CAST(:u AS uuid) AS unit_id,"
                " '-infinity'::timestamptz AS started_at, NULL::timestamptz AS ended_at"
            ),
            {"m": turnover.current.id, "u": turnover.s.u101.id},
        )
    await db.execute(text("SET LOCAL search_path = occupancy_shadow, public"))

    u101 = turnover.s.u101.id
    assert await _in_window(db, turnover.current.id, u101, T1 - SECOND) is False  # before move-in
    assert await _in_window(db, turnover.current.id, u101, T2) is True
