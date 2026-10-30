"""What `maintenance_comments` refuses (P6-03d test plan; as P6-03a criteria 1 and 2)."""

import asyncio
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy.ext.asyncio import AsyncSession

from tests.helpers.db import assert_integrity_error
from tests.maintenance.conftest import make_maintenance_comment, make_maintenance_request
from tests.maintenance.test_schema import _table_names
from tests.world import World

pytestmark = pytest.mark.anyio

BACKEND_DIR = Path(__file__).resolve().parents[2]
P6_03D_REVISION = "27ffbfae7d14"
P6_03D_DOWN_REVISION = "2cb174aca098"


def test_migration_downgrades_and_upgrades(scratch_database_url: str):
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = scratch_database_url
    cfg.attributes["configure_logger"] = False

    command.upgrade(cfg, P6_03D_REVISION)
    assert "maintenance_comments" in asyncio.run(_table_names(scratch_database_url))

    command.downgrade(cfg, P6_03D_DOWN_REVISION)
    tables = asyncio.run(_table_names(scratch_database_url))
    assert "maintenance_comments" not in tables
    assert "maintenance_requests" in tables  # only this revision was undone

    command.upgrade(cfg, "head")
    assert "maintenance_comments" in asyncio.run(_table_names(scratch_database_url))
    command.check(cfg)


async def test_a_comment_on_another_buildings_request_is_refused(db: AsyncSession, world: World):
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)

    await assert_integrity_error(
        db,
        make_maintenance_comment(db, b_request, world.a_manager.membership, building_id=world.a.id),
        constraint="fk_maintenance_comments_building_id_request_id",
    )


async def test_an_author_of_another_building_is_refused(db: AsyncSession, world: World):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)

    await assert_integrity_error(
        db,
        make_maintenance_comment(db, request, world.b_manager.membership),
        constraint="fk_maintenance_comments_building_id_author_membership_id",
    )


@pytest.mark.parametrize("body", ["", " ", "\n\t\r "])
async def test_a_blank_body_is_refused(db: AsyncSession, world: World, body: str):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)

    await assert_integrity_error(
        db,
        make_maintenance_comment(db, request, world.a_resident1.membership, body=body),
        constraint="ck_maintenance_comments_body_not_blank",
    )


async def test_an_internal_comment_by_a_non_staff_author_is_refused(db: AsyncSession, world: World):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)

    await assert_integrity_error(
        db,
        make_maintenance_comment(
            db, request, world.a_resident1.membership, internal=True, author_is_staff=False
        ),
        constraint="ck_maintenance_comments_internal_needs_staff",
    )


async def test_a_comment_in_its_requests_building_by_staff_is_accepted(
    db: AsyncSession, world: World
):
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)

    comment = await make_maintenance_comment(db, request, world.a_manager.membership, internal=True)

    assert (comment.is_internal, comment.author_is_staff) == (True, True)
