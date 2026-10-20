"""Migration `f727e687ccf2` (P3-04c): up, check, down with `deleting` rows, up again."""

import asyncio
import uuid

from alembic import command
from alembic.config import Config
from sqlalchemy import text
from sqlalchemy.ext.asyncio import create_async_engine

from app.buildings.models import Building
from app.core.database import AsyncSessionLocal
from app.files.models import File, FilePurpose, FileStatus
from app.users.models import User
from tests.conftest import BACKEND_DIR


def _config(url: str) -> Config:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = url
    cfg.attributes["configure_logger"] = False
    return cfg


async def _add_deleting_files(url: str) -> dict[str, uuid.UUID]:
    engine = create_async_engine(url)
    try:
        async with AsyncSessionLocal(bind=engine) as s:
            building = Building(slug="mig", name="Mig", address="1 Main St", timezone="UTC")
            user = User(email="mig@x.io", full_name="Someone")
            s.add_all([building, user])
            await s.flush()
            ids = {}
            for name, version in (("was_ready", "v1"), ("was_pending", None)):
                file_id = uuid.uuid4()
                s.add(
                    File(
                        id=file_id,
                        building_id=building.id,
                        uploaded_by_user_id=user.id,
                        purpose=FilePurpose.MAINTENANCE_PHOTO,
                        s3_key=f"b/{building.id}/maintenance_photo/{file_id}",
                        s3_version_id=version,
                        content_type="image/png",
                        size_bytes=1,
                        original_name="x.png",
                        status=FileStatus.DELETING,
                    )
                )
                ids[name] = file_id
            await s.commit()
            return ids
    finally:
        await engine.dispose()


async def _state(url: str, ids: dict[str, uuid.UUID]) -> tuple[bool, dict[str, str]]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            index = await conn.scalar(
                text("SELECT to_regclass('ix_files_unattached_created_at') IS NOT NULL")
            )
            statuses = {
                name: await conn.scalar(
                    text("SELECT status FROM files WHERE id = :id"), {"id": file_id}
                )
                for name, file_id in ids.items()
            }
            return bool(index), statuses
    finally:
        await engine.dispose()


def test_upgrade_check_downgrade_with_deleting_rows_and_upgrade_again(scratch_database_url):
    cfg = _config(scratch_database_url)
    command.upgrade(cfg, "head")
    command.check(cfg)
    ids = asyncio.run(_add_deleting_files(scratch_database_url))

    # To the revision before f727e687ccf2 by name, not "-1": later migrations sit on top (P4-02a).
    command.downgrade(cfg, "05c58ec89743")
    # The old constraints are back and hold: each file is what its version says it was.
    assert asyncio.run(_state(scratch_database_url, ids)) == (
        False,
        {"was_ready": "ready", "was_pending": "pending"},
    )

    command.upgrade(cfg, "head")
    command.check(cfg)
    assert asyncio.run(_state(scratch_database_url, ids))[0] is True
