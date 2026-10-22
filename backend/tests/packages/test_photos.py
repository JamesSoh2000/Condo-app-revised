"""P5-01 criterion 6: a package photo is downloadable by exactly the package's viewers."""

import subprocess
import sys
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.files import purposes
from app.files.models import File, FilePurpose
from app.files.service import claim_file
from app.packages.models import PACKAGE_ATTACHED_TYPE, Package
from app.packages.photos import can_view_package_photo
from tests.helpers.tenancy import assert_not_visible, without_request_id
from tests.packages.conftest import make_package, make_photo, persona_ctx
from tests.packages.test_visibility import EXPECTED
from tests.world import World

pytestmark = pytest.mark.anyio

BACKEND_DIR = Path(__file__).resolve().parents[2]
DURING_FORMERS_101 = World.T0 + timedelta(days=1)
AFTER_RESIDENT1_MOVED_IN = World.T2 + timedelta(days=1)


async def photographed(db: AsyncSession, world: World, unit_label: str, received_at) -> File:
    """A package with a photo, attached the way P5-02a's create will: `claim_file` before commit."""
    security = world.a_security
    photo = await make_photo(db, world.a.id, security.user.id)
    unit = getattr(world, f"a_{unit_label}")
    package = await make_package(
        db, unit, security.membership, received_at=received_at, photo_file_id=photo.id
    )
    return await claim_file(
        db,
        persona_ctx(world, "a_security"),
        photo.id,
        FilePurpose.PACKAGE_PHOTO,
        PACKAGE_ATTACHED_TYPE,
        package.id,
    )


def test_importing_the_app_alone_registers_the_package_photo_hook():
    # A fresh interpreter, like the server: the hook must come from `app.main`'s imports, not from a
    # test importing `app.packages.photos` itself.
    code = (
        "import app.main\n"
        "from app.files.models import FilePurpose\n"
        "from app.files.purposes import can_view_hook\n"
        "hook = can_view_hook(FilePurpose.PACKAGE_PHOTO)\n"
        "print(hook.__module__, hook.__name__)\n"
    )
    result = subprocess.run(  # noqa: S603 (fixed code, this interpreter)
        [sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True, check=False
    )

    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.split() == ["app.packages.photos", "can_view_package_photo"]


def test_the_registered_hook_is_the_packages_one():
    assert purposes.can_view_hook(FilePurpose.PACKAGE_PHOTO) is can_view_package_photo


@pytest.mark.parametrize("persona", sorted(EXPECTED))
async def test_the_photo_follows_the_packages_visibility(
    db: AsyncSession, world: World, persona: str
):
    photos = {
        "p0": await photographed(db, world, "101", DURING_FORMERS_101),
        "p1": await photographed(db, world, "101", AFTER_RESIDENT1_MOVED_IN),
        "p2": await photographed(db, world, "102", DURING_FORMERS_101),
    }
    ctx = persona_ctx(world, persona)

    granted = {name for name, photo in photos.items() if await can_view_package_photo(ctx, photo, db)}

    # b_* personas see building B's package in EXPECTED; none of these A photos.
    assert granted == EXPECTED[persona] - {"pb"}


async def test_a_photo_attached_to_another_record_type_is_refused(db: AsyncSession, world: World):
    photo = await photographed(db, world, "101", AFTER_RESIDENT1_MOVED_IN)
    await db.execute(
        update(File).where(File.id == photo.id).values(attached_type="maintenance_request")
    )
    await db.refresh(photo)

    assert not await can_view_package_photo(persona_ctx(world, "a_security"), photo, db)


async def test_a_photo_its_package_doesnt_show_is_refused(db: AsyncSession, world: World):
    photo = await photographed(db, world, "101", AFTER_RESIDENT1_MOVED_IN)
    await db.execute(update(Package).where(Package.photo_file_id == photo.id).values(photo_file_id=None))

    assert not await can_view_package_photo(persona_ctx(world, "a_security"), photo, db)
    assert not await can_view_package_photo(persona_ctx(world, "a_resident1"), photo, db)


async def test_a_photo_attached_to_a_package_that_names_another_file_is_refused(
    db: AsyncSession, world: World
):
    # Attached to P (attached_id) while P shows a different photo: only P's own photo is P's.
    shown = await photographed(db, world, "101", AFTER_RESIDENT1_MOVED_IN)
    package_id = shown.attached_id
    stray = await make_photo(db, world.a.id, world.a_security.user.id)
    await db.execute(
        update(File)
        .where(File.id == stray.id)
        .values(attached_type=PACKAGE_ATTACHED_TYPE, attached_id=package_id)
    )
    await db.refresh(stray)

    assert not await can_view_package_photo(persona_ctx(world, "a_security"), stray, db)


async def test_download_url_follows_the_package(as_user, db: AsyncSession, world: World):
    photo = await photographed(db, world, "101", AFTER_RESIDENT1_MOVED_IN)
    url = f"/api/buildings/{world.a.id}/files/{{}}/download-url"
    viewer = await as_user(world.a_resident1.user)
    other = await as_user(world.a_resident2.user)

    granted = await viewer.get(url.format(photo.id))
    hidden = await assert_not_visible(other, "GET", url.format(photo.id), code="file_not_found")
    missing = await assert_not_visible(other, "GET", url.format(uuid.uuid4()), code="file_not_found")

    assert granted.status_code == 200, granted.text
    assert without_request_id(hidden) == without_request_id(missing)
