"""P5-01 criteria 1, 2, 9 (column types) and 10: what the `packages` table refuses."""

from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.packages.enums import PackageStatus
from app.packages.models import Package
from tests.helpers.db import assert_integrity_error
from tests.packages.conftest import make_package, make_photo
from tests.world import World

pytestmark = pytest.mark.anyio

RECEIVED, PICKED_UP, RETURNED = (
    PackageStatus.RECEIVED,
    PackageStatus.PICKED_UP,
    PackageStatus.RETURNED,
)
T = World.T2 + timedelta(days=3)


def picked_up(world: World, **overrides: Any) -> dict[str, Any]:
    """The columns of a valid `picked_up` package, as P5-02b will write them."""
    return {
        "status": PICKED_UP,
        "picked_up_at": T + timedelta(hours=1),
        "picked_up_by_membership_id": world.a_resident1.membership.id,
        "handed_out_by_membership_id": world.a_security.membership.id,
        **overrides,
    }


def returned(**overrides: Any) -> dict[str, Any]:
    return {
        "status": RETURNED,
        "returned_at": T + timedelta(days=1),
        "return_reason": "Refused by the resident",
        **overrides,
    }


# --- criterion 1: every reference stays in the package's building --------------------------------


@pytest.mark.parametrize(
    "column",
    [
        "unit_id",
        "recipient_membership_id",
        "received_by_membership_id",
        "picked_up_by_membership_id",
        "handed_out_by_membership_id",
        "photo_file_id",
    ],
)
async def test_a_reference_to_another_building_is_rejected(
    db: AsyncSession, world: World, column: str
):
    b_photo = await make_photo(db, world.b.id, world.b_manager.user.id)
    b_ids = {
        "unit_id": world.b_101.id,
        "recipient_membership_id": world.b_resident1.membership.id,
        "received_by_membership_id": world.b_manager.membership.id,
        "picked_up_by_membership_id": world.b_resident1.membership.id,
        "handed_out_by_membership_id": world.b_manager.membership.id,
        "photo_file_id": b_photo.id,
    }
    # A row that is valid in every other respect, so only the cross-building FK can fail.
    overrides = picked_up(world) if column.startswith(("picked_up", "handed_out")) else {}
    overrides[column] = b_ids[column]

    await assert_integrity_error(
        db,
        make_package(db, world.a_101, world.a_security.membership, received_at=T, **overrides),
        constraint=f"fk_packages_building_id_{column}",
    )


async def test_references_in_the_packages_own_building_are_accepted(db: AsyncSession, world: World):
    photo = await make_photo(db, world.a.id, world.a_security.user.id)

    package = await make_package(
        db,
        world.a_101,
        world.a_security.membership,
        received_at=T,
        recipient_membership_id=world.a_resident1.membership.id,
        photo_file_id=photo.id,
        **picked_up(world),
    )

    assert package.photo_file_id == photo.id


# --- criterion 2: each state's columns ------------------------------------------------------------


async def test_a_valid_row_of_each_state_is_accepted(db: AsyncSession, world: World):
    security = world.a_security.membership
    received = await make_package(db, world.a_101, security, received_at=T)
    by_name = await make_package(
        db,
        world.a_101,
        security,
        received_at=T,
        **picked_up(world, picked_up_by_membership_id=None, picked_up_by_name="Neighbour in 102"),
    )
    by_member = await make_package(db, world.a_101, security, received_at=T, **picked_up(world))
    back = await make_package(db, world.a_101, security, received_at=T, **returned())

    assert [p.status for p in (received, by_name, by_member, back)] == [
        RECEIVED,
        PICKED_UP,
        PICKED_UP,
        RETURNED,
    ]


async def test_received_at_defaults_to_the_transactions_now(db: AsyncSession, world: World):
    package = await make_package(db, world.a_101, world.a_security.membership)
    await db.refresh(package)

    assert package.received_at == await db.scalar(select(func.now()))


def _invalid_rows() -> list[Any]:
    """(state, overrides, constraint) for every way a row can break its state's check."""
    a_time = T + timedelta(hours=2)
    member = "a_resident1"
    rows: list[tuple[str, str, dict[str, Any], str]] = [
        # The ticket's own example.
        ("picked_up without picked_up_at", "picked_up", {"picked_up_at": None}, "picked_up_state"),
        (
            "picked_up without handed_out_by",
            "picked_up",
            {"handed_out_by_membership_id": None},
            "picked_up_state",
        ),
        (
            "picked_up without a pickup person",
            "picked_up",
            {"picked_up_by_membership_id": None, "picked_up_by_name": None},
            "picked_up_state",
        ),
        ("picked_up with returned_at", "picked_up", {"returned_at": a_time}, "picked_up_state"),
        ("picked_up with return_reason", "picked_up", {"return_reason": "x"}, "picked_up_state"),
        ("received with picked_up_at", "received", {"picked_up_at": a_time}, "received_state"),
        ("received with returned_at", "received", {"returned_at": a_time}, "received_state"),
        (
            "received with picked_up_by_name",
            "received",
            {"picked_up_by_name": "x"},
            "received_state",
        ),
        (
            "received with picked_up_by",
            "received",
            {"picked_up_by_membership_id": member},
            "received_state",
        ),
        (
            "received with handed_out_by",
            "received",
            {"handed_out_by_membership_id": "a_security"},
            "received_state",
        ),
        ("received with return_reason", "received", {"return_reason": "x"}, "received_state"),
        ("returned without returned_at", "returned", {"returned_at": None}, "returned_state"),
        ("returned without return_reason", "returned", {"return_reason": None}, "returned_state"),
        ("returned with picked_up_at", "returned", {"picked_up_at": a_time}, "returned_state"),
        (
            "returned with picked_up_by_name",
            "returned",
            {"picked_up_by_name": "x"},
            "returned_state",
        ),
        (
            "returned with picked_up_by",
            "returned",
            {"picked_up_by_membership_id": member},
            "returned_state",
        ),
        (
            "returned with handed_out_by",
            "returned",
            {"handed_out_by_membership_id": "a_security"},
            "returned_state",
        ),
        (
            "picked up before it was received",
            "picked_up",
            {"picked_up_at": T - timedelta(seconds=1)},
            "picked_up_after_received",
        ),
        (
            "returned before it was received",
            "returned",
            {"returned_at": T - timedelta(seconds=1)},
            "returned_after_received",
        ),
    ]
    return [
        pytest.param(state, overrides, constraint, id=name)
        for name, state, overrides, constraint in rows
    ]


@pytest.mark.parametrize(("state", "overrides", "constraint"), _invalid_rows())
async def test_state_checks_reject_a_row_that_breaks_its_state(
    db: AsyncSession, world: World, state: str, overrides: dict[str, Any], constraint: str
):
    # Persona names stand for their membership ids (the world isn't built at collection time).
    resolved = {
        key: getattr(world, value).membership.id
        if key.endswith("membership_id") and value
        else value
        for key, value in overrides.items()
    }
    base = {"received": {}, "picked_up": picked_up(world), "returned": returned()}[state]

    await assert_integrity_error(
        db,
        make_package(
            db, world.a_101, world.a_security.membership, received_at=T, **{**base, **resolved}
        ),
        constraint=f"ck_packages_{constraint}",
    )


async def test_status_outside_the_enum_is_rejected(db: AsyncSession, world: World):
    package = await make_package(db, world.a_101, world.a_security.membership)

    async def set_lost() -> None:
        await db.execute(
            text("UPDATE packages SET status = 'lost' WHERE id = :id"), {"id": package.id}
        )

    await assert_integrity_error(db, set_lost(), constraint="ck_packages_package_status")


# --- criterion 9 (carried from P1-03): the record times are timestamptz ---------------------------


async def test_record_times_are_timestamptz(db: AsyncSession):
    types: dict[str, str] = dict(
        (
            await db.execute(
                text(
                    "SELECT column_name, data_type FROM information_schema.columns"
                    " WHERE table_schema = 'public' AND table_name = 'packages'"
                    " AND column_name IN ('received_at', 'picked_up_at', 'returned_at')"
                )
            )
        ).all()
    )

    assert types == dict.fromkeys(
        ("received_at", "picked_up_at", "returned_at"), "timestamp with time zone"
    )


# --- criterion 10: idempotency keys ---------------------------------------------------------------


async def test_idempotency_key_is_unique_per_building(db: AsyncSession, world: World):
    await make_package(db, world.a_101, world.a_security.membership, idempotency_key="k-1")

    await assert_integrity_error(
        db,
        make_package(db, world.a_102, world.a_manager.membership, idempotency_key="k-1"),
        constraint="uq_packages_building_id_idempotency_key",
    )


async def test_the_same_idempotency_key_in_two_buildings_is_allowed(db: AsyncSession, world: World):
    await make_package(db, world.a_101, world.a_security.membership, idempotency_key="k-1")
    await make_package(db, world.b_101, world.b_manager.membership, idempotency_key="k-1")

    keys = await db.scalars(select(Package.building_id).where(Package.idempotency_key == "k-1"))
    assert set(keys) == {world.a.id, world.b.id}


async def test_idempotency_columns_are_required(db: AsyncSession):
    nullable: dict[str, str] = dict(
        (
            await db.execute(
                text(
                    "SELECT column_name, is_nullable FROM information_schema.columns"
                    " WHERE table_schema = 'public' AND table_name = 'packages'"
                    " AND column_name IN ('idempotency_key', 'request_hash')"
                )
            )
        ).all()
    )

    assert nullable == {"idempotency_key": "NO", "request_hash": "NO"}
