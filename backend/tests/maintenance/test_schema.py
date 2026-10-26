"""P6-03a criteria 1 to 5 and 12 to 14: what the maintenance tables refuse."""

import asyncio
import uuid
from datetime import timedelta
from pathlib import Path
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import func, inspect, select, text
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import MaintenanceRequest
from tests.helpers.db import assert_integrity_error
from tests.maintenance.conftest import (
    make_maintenance_file,
    make_maintenance_photo,
    make_maintenance_request,
    status_columns,
)
from tests.world import World

pytestmark = pytest.mark.anyio

BACKEND_DIR = Path(__file__).resolve().parents[2]
P6_03A_REVISION = "2cb174aca098"
P6_03A_DOWN_REVISION = "b006d25a3f56"
TABLES = {"maintenance_requests", "maintenance_request_photos"}

S = MaintenanceStatus
T = World.T2 + timedelta(days=3)

_COLUMNS = {
    "started": ("started_at", "started_by_membership_id"),
    "on_hold": ("on_hold_at", "on_hold_by_membership_id"),
    "resolved": ("resolved_at", "resolved_by_membership_id"),
    "cancelled": ("cancelled_at", "cancelled_by_membership_id"),
}
# Each status's own columns (P6-03a D3); every other status column must be NULL.
OWN: dict[MaintenanceStatus, tuple[str, ...]] = {
    S.SUBMITTED: (),
    S.IN_PROGRESS: _COLUMNS["started"],
    S.ON_HOLD: _COLUMNS["started"] + _COLUMNS["on_hold"],
    S.RESOLVED: _COLUMNS["started"] + _COLUMNS["resolved"],
    S.CANCELLED: _COLUMNS["cancelled"],
}
ALL_STATUS_COLUMNS = tuple(column for group in _COLUMNS.values() for column in group)


# --- criterion 1: the migration round-trips -------------------------------------------------------


async def _table_names(url: str) -> set[str]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return set(await conn.run_sync(lambda sync: inspect(sync).get_table_names()))
    finally:
        await engine.dispose()


def test_migration_downgrades_and_upgrades(scratch_database_url: str):
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = scratch_database_url
    cfg.attributes["configure_logger"] = False

    # Pinned revisions, so later migrations stacked on top don't change what this tests.
    command.upgrade(cfg, P6_03A_REVISION)
    assert asyncio.run(_table_names(scratch_database_url)) >= TABLES

    command.downgrade(cfg, P6_03A_DOWN_REVISION)
    tables = asyncio.run(_table_names(scratch_database_url))
    assert TABLES & tables == set()
    assert "notices" in tables  # only this revision was undone

    command.upgrade(cfg, "head")
    assert asyncio.run(_table_names(scratch_database_url)) >= TABLES
    command.check(cfg)  # raises if the models and the migrated schema differ


# --- criterion 2: every reference stays in the request's building ---------------------------------


@pytest.mark.parametrize(
    ("column", "status"),
    [
        ("requester_membership_id", S.SUBMITTED),
        ("unit_id", S.SUBMITTED),
        ("started_by_membership_id", S.IN_PROGRESS),
        ("on_hold_by_membership_id", S.ON_HOLD),
        ("resolved_by_membership_id", S.RESOLVED),
        ("cancelled_by_membership_id", S.CANCELLED),
    ],
)
async def test_a_reference_to_another_building_is_refused(
    db: AsyncSession, world: World, column: str, status: MaintenanceStatus
):
    b_id = world.b_101.id if column == "unit_id" else world.b_manager.membership.id

    await assert_integrity_error(
        db,
        make_maintenance_request(
            db,
            world.a_resident1.membership,
            world.a_101,
            submitted_at=T,
            status=status,
            acted_by=world.a_manager.membership,
            **{column: b_id},
        ),
        constraint=f"fk_maintenance_requests_building_id_{column}",
    )


@pytest.mark.parametrize("status", list(S))
async def test_references_in_the_requests_own_building_are_accepted(
    db: AsyncSession, world: World, status: MaintenanceStatus
):
    request = await make_maintenance_request(
        db,
        world.a_resident1.membership,
        world.a_101,
        submitted_at=T,
        status=status,
        acted_by=world.a_manager.membership,
    )
    file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    photo = await make_maintenance_photo(db, request, file.id)

    assert (request.status, photo.file_id) == (status, file.id)


async def test_a_photo_of_another_buildings_request_is_refused(db: AsyncSession, world: World):
    a_request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    a_file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)

    await assert_integrity_error(
        db,
        make_maintenance_photo(db, a_request, a_file.id, request_id=b_request.id),
        constraint="fk_maintenance_request_photos_building_id_request_id",
    )


async def test_a_photo_of_another_buildings_file_is_refused(db: AsyncSession, world: World):
    a_request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    b_file = await make_maintenance_file(db, world.b.id, world.b_resident1.user.id)

    await assert_integrity_error(
        db,
        make_maintenance_photo(db, a_request, b_file.id),
        constraint="fk_maintenance_request_photos_building_id_file_id",
    )


# --- criteria 3 and 14: the location --------------------------------------------------------------


@pytest.mark.parametrize(
    ("unit", "overrides"),
    [
        pytest.param(True, {"unit_id": None}, id="unit without a unit_id"),
        pytest.param(True, {"common_area": "Lobby"}, id="unit with a common area"),
        pytest.param(False, {"common_area": None}, id="common_area without its detail"),
        pytest.param(False, {"unit_id": "a_101"}, id="common_area with a unit_id"),
    ],
)
async def test_the_location_check_refuses_a_mismatched_row(
    db: AsyncSession, world: World, unit: bool, overrides: dict[str, Any]
):
    resolved = {
        k: getattr(world, v).id if k == "unit_id" and v else v for k, v in overrides.items()
    }

    await assert_integrity_error(
        db,
        make_maintenance_request(
            db, world.a_resident1.membership, world.a_101 if unit else None, **resolved
        ),
        constraint="ck_maintenance_requests_location_matches",
    )


async def test_a_common_area_request_is_accepted(db: AsyncSession, world: World):
    request = await make_maintenance_request(db, world.a_resident2.membership, None)

    assert (request.unit_id, request.common_area) == (None, "Lobby")


@pytest.mark.parametrize("blank", ["", "   ", " \t\n\r "])
async def test_a_blank_common_area_is_refused(db: AsyncSession, world: World, blank: str):
    await assert_integrity_error(
        db,
        make_maintenance_request(db, world.a_resident2.membership, None, common_area=blank),
        constraint="ck_maintenance_requests_common_area_not_blank",
    )


# --- criterion 4: each status's columns, text and enums -------------------------------------------


def _status_cases() -> list[Any]:
    """(status, column, "missing" or "extra") for every status and every status column."""
    return [
        pytest.param(
            status,
            column,
            id=f"{status}-{'without' if column in OWN[status] else 'with'}-{column}",
        )
        for status in S
        for column in ALL_STATUS_COLUMNS
    ]


@pytest.mark.parametrize(("status", "column"), _status_cases())
async def test_the_status_check_refuses_a_row_that_breaks_its_status(
    db: AsyncSession, world: World, status: MaintenanceStatus, column: str
):
    if column in OWN[status]:
        value: Any = None
    elif column.endswith("_at"):
        value = T + timedelta(hours=3)  # after every bound, so only the status check can fail
    else:
        value = world.a_manager.membership.id

    await assert_integrity_error(
        db,
        make_maintenance_request(
            db,
            world.a_resident1.membership,
            world.a_101,
            submitted_at=T,
            status=status,
            acted_by=world.a_manager.membership,
            **{column: value},
        ),
        constraint=f"ck_maintenance_requests_{status}_state",
    )


async def test_submitted_at_defaults_to_the_transactions_now(db: AsyncSession, world: World):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    await db.refresh(request)

    assert request.submitted_at == await db.scalar(select(func.now()))


@pytest.mark.parametrize("blank", ["", "   ", " \t\n\r "])
async def test_a_blank_description_is_refused(db: AsyncSession, world: World, blank: str):
    await assert_integrity_error(
        db,
        make_maintenance_request(db, world.a_resident1.membership, world.a_101, description=blank),
        constraint="ck_maintenance_requests_description_not_blank",
    )


async def test_a_description_keeps_its_newlines(db: AsyncSession, world: World):
    text_ = "Line one.\n\tLine two."
    request = await make_maintenance_request(
        db, world.a_resident1.membership, world.a_101, description=text_
    )
    await db.refresh(request)

    assert request.description == text_


@pytest.mark.parametrize(
    ("column", "enum_name"),
    [
        ("status", "maintenance_status"),
        ("location", "maintenance_location"),
        ("category", "maintenance_category"),
    ],
)
async def test_a_value_outside_the_enum_is_refused(
    db: AsyncSession, world: World, column: str, enum_name: str
):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)

    async def set_unknown() -> None:
        await db.execute(
            text(f"UPDATE maintenance_requests SET {column} = 'lost' WHERE id = :id"),  # noqa: S608
            {"id": request.id},
        )

    await assert_integrity_error(
        db, set_unknown(), constraint=f"ck_maintenance_requests_{enum_name}"
    )


async def test_record_times_are_timestamptz(db: AsyncSession):
    columns = ("submitted_at", "started_at", "on_hold_at", "resolved_at", "cancelled_at")
    types: dict[str, str] = dict(
        (
            await db.execute(
                text(
                    "SELECT column_name, data_type FROM information_schema.columns"
                    " WHERE table_schema = 'public' AND table_name = 'maintenance_requests'"
                    " AND column_name = ANY(:columns)"
                ),
                {"columns": list(columns)},
            )
        ).all()
    )

    assert types == dict.fromkeys(columns, "timestamp with time zone")


# --- criterion 5: times follow the submission -----------------------------------------------------


@pytest.mark.parametrize(
    ("status", "column", "constraint"),
    [
        (S.IN_PROGRESS, "started_at", "started_after_submitted"),
        # on_hold_at and resolved_at are bounded by started_at, itself bounded by submitted_at.
        (S.ON_HOLD, "on_hold_at", "on_hold_after_started"),
        (S.RESOLVED, "resolved_at", "resolved_after_started"),
        (S.CANCELLED, "cancelled_at", "cancelled_after_submitted"),
    ],
)
async def test_a_time_before_submitted_at_is_refused(
    db: AsyncSession, world: World, status: MaintenanceStatus, column: str, constraint: str
):
    early: dict[str, Any] = {column: T - timedelta(microseconds=1)}
    await assert_integrity_error(
        db,
        make_maintenance_request(
            db,
            world.a_resident1.membership,
            world.a_101,
            submitted_at=T,
            status=status,
            **early,
        ),
        constraint=f"ck_maintenance_requests_{constraint}",
    )


@pytest.mark.parametrize(
    ("status", "column"), [(S.ON_HOLD, "on_hold_at"), (S.RESOLVED, "resolved_at")]
)
async def test_a_time_before_started_at_is_refused(
    db: AsyncSession, world: World, status: MaintenanceStatus, column: str
):
    early: dict[str, Any] = {column: T + timedelta(hours=1) - timedelta(microseconds=1)}
    await assert_integrity_error(
        db,
        make_maintenance_request(
            db,
            world.a_resident1.membership,
            world.a_101,
            submitted_at=T,
            status=status,
            **early,
        ),
        constraint=f"ck_maintenance_requests_{column.removesuffix('_at')}_after_started",
    )


async def test_times_equal_to_their_bound_are_accepted(db: AsyncSession, world: World):
    me = world.a_resident1.membership
    cases: list[tuple[MaintenanceStatus, dict[str, Any]]] = [
        (S.IN_PROGRESS, {"started_at": T}),
        (S.ON_HOLD, {"started_at": T, "on_hold_at": T}),
        (S.RESOLVED, {"started_at": T, "resolved_at": T}),
        (S.CANCELLED, {"cancelled_at": T}),
    ]
    rows = [
        await make_maintenance_request(
            db, me, world.a_101, submitted_at=T, status=status, **overrides
        )
        for status, overrides in cases
    ]

    assert [r.status for r in rows] == [S.IN_PROGRESS, S.ON_HOLD, S.RESOLVED, S.CANCELLED]


def test_the_status_columns_helper_matches_own():
    # The factory and the schema tests must agree on D3, or a consistent row could be the bug.
    for status in S:
        assert tuple(status_columns(status, T, uuid.uuid4())) == OWN[status]


# --- criteria 12 and 13: the photo limit, one request per file, idempotency keys ------------------


async def test_five_photos_are_accepted_and_a_sixth_is_refused(db: AsyncSession, world: World):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    for position in range(5):
        file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
        await make_maintenance_photo(db, request, file.id, position)
    sixth = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)

    await assert_integrity_error(
        db,
        make_maintenance_photo(db, request, sixth.id, 5),
        constraint="ck_maintenance_request_photos_position_range",
    )


@pytest.mark.parametrize("position", [-1, 5, 2**31 - 1])
async def test_a_position_outside_the_limit_is_refused(
    db: AsyncSession, world: World, position: int
):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)

    await assert_integrity_error(
        db,
        make_maintenance_photo(db, request, file.id, position),
        constraint="ck_maintenance_request_photos_position_range",
    )


async def test_a_taken_position_is_refused(db: AsyncSession, world: World):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    first = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    second = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    await make_maintenance_photo(db, request, first.id, 0)

    await assert_integrity_error(
        db,
        make_maintenance_photo(db, request, second.id, 0),
        constraint="pk_maintenance_request_photos",
    )


@pytest.mark.parametrize("same_request", [True, False])
async def test_a_file_is_the_photo_of_one_request_only(
    db: AsyncSession, world: World, same_request: bool
):
    first = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    other = (
        first
        if same_request
        else await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    )
    file = await make_maintenance_file(db, world.a.id, world.a_resident1.user.id)
    await make_maintenance_photo(db, first, file.id, 0)

    await assert_integrity_error(
        db,
        make_maintenance_photo(db, other, file.id, 1),
        constraint="uq_maintenance_request_photos_building_id_file_id",
    )


async def test_idempotency_key_is_unique_per_building(db: AsyncSession, world: World):
    await make_maintenance_request(
        db, world.a_resident1.membership, world.a_101, idempotency_key="k-1"
    )

    await assert_integrity_error(
        db,
        make_maintenance_request(
            db, world.a_resident2.membership, world.a_102, idempotency_key="k-1"
        ),
        constraint="uq_maintenance_requests_building_id_idempotency_key",
    )


async def test_the_same_idempotency_key_in_two_buildings_is_accepted(
    db: AsyncSession, world: World
):
    await make_maintenance_request(
        db, world.a_resident1.membership, world.a_101, idempotency_key="k-1"
    )
    await make_maintenance_request(
        db, world.b_resident1.membership, world.b_101, idempotency_key="k-1"
    )

    buildings = await db.scalars(
        select(MaintenanceRequest.building_id).where(MaintenanceRequest.idempotency_key == "k-1")
    )
    assert set(buildings) == {world.a.id, world.b.id}
