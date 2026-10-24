"""P6-01a criteria 6b, 9, 9a and 10: a notice attachment is downloadable by exactly the notice's
viewers."""

import subprocess
import sys
import uuid
from datetime import datetime, timedelta
from pathlib import Path

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.files import purposes
from app.files.models import File, FilePurpose
from app.files.service import claim_file
from app.notices.attachments import can_view_notice_attachment
from app.notices.models import NOTICE_ATTACHED_TYPE, Notice
from tests.helpers.tenancy import assert_not_visible, assert_problem, without_request_id
from tests.notices.conftest import archived, make_attachment, make_notice, persona_ctx, published
from tests.world import World

pytestmark = pytest.mark.anyio

BACKEND_DIR = Path(__file__).resolve().parents[2]
LONG_AGO = World.T0 + timedelta(days=1)


async def attached(db: AsyncSession, world: World, **notice: object) -> File:
    """A notice with an attachment, claimed the way P6-01b's create will: `claim_file` before
    commit."""
    manager = world.a_manager
    file = await make_attachment(db, world.a.id, manager.user.id, content_type="application/pdf")
    row = await make_notice(db, manager.membership, attachment_file_id=file.id, **notice)
    return await claim_file(
        db,
        persona_ctx(world, "a_manager"),
        file.id,
        FilePurpose.NOTICE_ATTACHMENT,
        NOTICE_ATTACHED_TYPE,
        row.id,
    )


async def attachments(db: AsyncSession, world: World) -> dict[str, File]:
    now: datetime = await db.scalar(select(func.now()))
    manager = world.a_manager.membership
    return {
        "draft": await attached(db, world),
        "live": await attached(db, world, **published(manager, LONG_AGO)),
        "expired": await attached(
            db, world, **published(manager, LONG_AGO, expires_at=now - timedelta(seconds=1))
        ),
        "archived": await attached(db, world, **archived(manager, LONG_AGO)),
    }


EXPECTED = {
    "a_manager": {"draft", "live", "expired", "archived"},
    "a_security": {"live"},
    "a_resident1": {"live"},
    "a_council": {"live"},
    "a_former": {"live"},
    "multi_in_a": {"live"},
    "b_manager": set(),
    "b_resident1": set(),
}


def test_importing_the_app_alone_registers_the_notice_attachment_hook():
    # A fresh interpreter, like the server: the hook must come from `app.main`'s imports.
    code = (
        "import app.main\n"
        "from app.files.models import FilePurpose\n"
        "from app.files.purposes import can_view_hook\n"
        "hook = can_view_hook(FilePurpose.NOTICE_ATTACHMENT)\n"
        "print(hook.__module__, hook.__name__)\n"
    )
    result = subprocess.run(  # noqa: S603 (fixed code, this interpreter)
        [sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True, check=False
    )

    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.split() == ["app.notices.attachments", "can_view_notice_attachment"]


def test_the_registered_hook_is_the_notices_one():
    assert purposes.can_view_hook(FilePurpose.NOTICE_ATTACHMENT) is can_view_notice_attachment


@pytest.mark.parametrize("persona", sorted(EXPECTED))
async def test_the_attachment_follows_the_notices_visibility(
    db: AsyncSession, world: World, persona: str
):
    files = await attachments(db, world)
    ctx = persona_ctx(world, persona)

    granted = {
        name for name, file in files.items() if await can_view_notice_attachment(ctx, file, db)
    }

    assert granted == EXPECTED[persona]


async def test_a_file_attached_to_another_record_type_is_refused(db: AsyncSession, world: World):
    file = await attached(db, world, **published(world.a_manager.membership, LONG_AGO))
    await db.execute(update(File).where(File.id == file.id).values(attached_type="package"))
    await db.refresh(file)

    assert not await can_view_notice_attachment(persona_ctx(world, "a_manager"), file, db)


async def test_a_file_its_notice_doesnt_show_is_refused(db: AsyncSession, world: World):
    file = await attached(db, world, **published(world.a_manager.membership, LONG_AGO))
    await db.execute(
        update(Notice).where(Notice.attachment_file_id == file.id).values(attachment_file_id=None)
    )

    assert not await can_view_notice_attachment(persona_ctx(world, "a_manager"), file, db)
    assert not await can_view_notice_attachment(persona_ctx(world, "a_resident1"), file, db)


async def test_a_file_attached_to_a_notice_that_names_another_file_is_refused(
    db: AsyncSession, world: World
):
    shown = await attached(db, world, **published(world.a_manager.membership, LONG_AGO))
    stray = await make_attachment(
        db, world.a.id, world.a_manager.user.id, content_type="image/png"
    )
    await db.execute(
        update(File)
        .where(File.id == stray.id)
        .values(attached_type=NOTICE_ATTACHED_TYPE, attached_id=shown.attached_id)
    )
    await db.refresh(stray)

    assert not await can_view_notice_attachment(persona_ctx(world, "a_manager"), stray, db)
    assert not await can_view_notice_attachment(persona_ctx(world, "a_resident1"), stray, db)


def url(world: World, file_id: uuid.UUID) -> str:
    return f"/api/buildings/{world.a.id}/files/{file_id}/download-url"


async def test_download_url_follows_the_notice(as_user, db: AsyncSession, world: World):
    files = await attachments(db, world)
    resident = await as_user(world.a_resident1.user)
    manager = await as_user(world.a_manager.user)

    for name, file in files.items():
        r = await manager.get(url(world, file.id))
        assert r.status_code == 200, (name, r.text)
    assert (await resident.get(url(world, files["live"].id))).status_code == 200
    missing = await assert_not_visible(
        resident, "GET", url(world, uuid.uuid4()), code="file_not_found"
    )
    for name in ("draft", "expired", "archived"):
        hidden = await assert_not_visible(
            resident, "GET", url(world, files[name].id), code="file_not_found"
        )
        assert without_request_id(hidden) == without_request_id(missing), name


@pytest.mark.parametrize("persona", ["a_pending", "a_suspended", "b_manager"])
async def test_download_url_is_404_building_not_found_for_non_members(
    as_user, db: AsyncSession, world: World, persona: str
):
    files = await attachments(db, world)
    client = await as_user(getattr(world, persona).user)

    assert_problem(await client.get(url(world, files["live"].id)), 404, "building_not_found")


async def test_download_url_signed_out_is_401(client, db: AsyncSession, world: World):
    files = await attachments(db, world)

    assert_problem(await client.get(url(world, files["live"].id)), 401, "not_authenticated")
