"""P6-03a criteria 9, 10 and 11: a maintenance photo is downloadable by its request's viewers."""

import subprocess
import sys
import uuid
from datetime import timedelta
from pathlib import Path

import pytest
from httpx import AsyncClient
from sqlalchemy import update
from sqlalchemy.ext.asyncio import AsyncSession

from app.files import purposes
from app.files.models import File, FilePurpose
from app.files.service import claim_file
from app.maintenance.models import MAINTENANCE_REQUEST_ATTACHED_TYPE, MaintenanceRequest
from app.maintenance.photos import can_view_maintenance_photo
from app.memberships.enums import Role
from app.memberships.models import BuildingMembership
from app.units.models import Unit
from tests.helpers.tenancy import assert_not_visible, assert_problem, without_request_id
from tests.maintenance.conftest import (
    make_maintenance_file,
    make_maintenance_photo,
    make_maintenance_request,
)
from tests.packages.conftest import ctx_of, persona_ctx
from tests.world import World

pytestmark = pytest.mark.anyio

BACKEND_DIR = Path(__file__).resolve().parents[2]
AFTER = World.T2 + timedelta(days=1)
ALL = ("a_manager", "a_security", "a_resident1", "a_resident2", "a_former", "a_council", "multi")


def url(world: World, file_id: uuid.UUID) -> str:
    return f"/api/buildings/{world.a.id}/files/{file_id}/download-url"


async def photographed(
    db: AsyncSession, requester: BuildingMembership, unit: Unit | None, position: int = 0
) -> tuple[MaintenanceRequest, File]:
    """A request with one photo, attached the way P6-03b's create will: the request row, then
    `claim_file` and a photo row, before commit."""
    request = await make_maintenance_request(db, requester, unit, submitted_at=AFTER)
    file = await make_maintenance_file(db, requester.building_id, requester.user_id)
    claimed = await claim_file(
        db,
        ctx_of(requester, Role.RESIDENT),
        file.id,
        FilePurpose.MAINTENANCE_PHOTO,
        MAINTENANCE_REQUEST_ATTACHED_TYPE,
        request.id,
    )
    await make_maintenance_photo(db, request, file.id, position)
    return request, claimed


def user_of(world: World, persona: str):
    return world.multi if persona == "multi" else getattr(world, persona).user


# Who sees each photo's request (criterion 7): r1 is a_resident1's for 101, r2 a_resident2's for
# 102 (a_former lives there too), common a_resident2's for a common area.
SEES = {
    "r1": {"a_manager", "a_security", "a_resident1"},
    "r2": {"a_manager", "a_security", "a_resident2", "a_former"},
    "common": {"a_manager", "a_security", "a_resident2"},
}


@pytest.mark.parametrize("persona", ALL)
async def test_the_download_url_follows_the_requests_visibility(
    as_user, db: AsyncSession, world: World, persona: str
):
    r1, r2 = world.a_resident1.membership, world.a_resident2.membership
    photos = {
        "r1": (await photographed(db, r1, world.a_101))[1],
        "r2": (await photographed(db, r2, world.a_102))[1],
        "common": (await photographed(db, r2, None))[1],
    }
    client = await as_user(user_of(world, persona))
    missing = await assert_not_visible(
        client, "GET", url(world, uuid.uuid4()), code="file_not_found"
    )

    for name, file in photos.items():
        if persona in SEES[name]:
            response = await client.get(url(world, file.id))
            assert response.status_code == 200, (name, response.text)
        else:
            hidden = await assert_not_visible(
                client, "GET", url(world, file.id), code="file_not_found"
            )
            assert without_request_id(hidden) == without_request_id(missing), name


async def _refused_for_everyone(as_user, world: World, file_id: uuid.UUID) -> None:
    for persona in ("a_manager", "a_security", "a_resident1"):
        client = await as_user(user_of(world, persona))
        await assert_not_visible(client, "GET", url(world, file_id), code="file_not_found")


async def test_a_file_attached_to_a_request_but_not_in_its_photo_rows_is_refused(
    as_user, db: AsyncSession, world: World
):
    resident = world.a_resident1.membership
    request = await make_maintenance_request(db, resident, world.a_101, submitted_at=AFTER)
    file = await make_maintenance_file(db, world.a.id, resident.user_id)
    await claim_file(
        db,
        ctx_of(resident, Role.RESIDENT),
        file.id,
        FilePurpose.MAINTENANCE_PHOTO,
        MAINTENANCE_REQUEST_ATTACHED_TYPE,
        request.id,
    )

    await _refused_for_everyone(as_user, world, file.id)


async def test_a_photo_row_whose_file_is_attached_to_another_request_is_refused(
    as_user, db: AsyncSession, world: World
):
    resident = world.a_resident1.membership
    listed_on, file = await photographed(db, resident, world.a_101)
    other = await make_maintenance_request(db, resident, world.a_101, submitted_at=AFTER)
    await db.execute(update(File).where(File.id == file.id).values(attached_id=other.id))
    assert listed_on.id != other.id

    await _refused_for_everyone(as_user, world, file.id)


async def test_a_file_of_another_attached_type_is_refused(as_user, db: AsyncSession, world: World):
    # Listed in the request's photo rows and attached to its id, but as another record type.
    _, file = await photographed(db, world.a_resident1.membership, world.a_101)
    await db.execute(update(File).where(File.id == file.id).values(attached_type="package"))

    await _refused_for_everyone(as_user, world, file.id)


async def test_the_hook_refuses_another_attached_type_directly(db: AsyncSession, world: World):
    _, file = await photographed(db, world.a_resident1.membership, world.a_101)
    for attached_type in ("package", "maintenance_comment", "notice"):
        await db.execute(update(File).where(File.id == file.id).values(attached_type=attached_type))
        await db.refresh(file)
        manager = persona_ctx(world, "a_manager")

        assert not await can_view_maintenance_photo(manager, file, db), attached_type


@pytest.mark.parametrize("persona", ["a_pending", "a_suspended", "b_manager"])
async def test_download_url_is_404_building_not_found_for_non_members(
    as_user, db: AsyncSession, world: World, persona: str
):
    _, file = await photographed(db, world.a_resident1.membership, world.a_101)
    client = await as_user(getattr(world, persona).user)

    assert_problem(await client.get(url(world, file.id)), 404, "building_not_found")


async def test_download_url_signed_out_is_401(client: AsyncClient, db: AsyncSession, world: World):
    _, file = await photographed(db, world.a_resident1.membership, world.a_101)

    assert_problem(await client.get(url(world, file.id)), 401, "not_authenticated")


def test_importing_the_app_alone_registers_the_maintenance_photo_hook():
    # A fresh interpreter, like the server: the hook must come from `app.main`'s imports, not from a
    # test importing `app.maintenance.photos` itself.
    code = (
        "import app.main\n"
        "from app.files.models import FilePurpose\n"
        "from app.files.purposes import can_view_hook\n"
        "hook = can_view_hook(FilePurpose.MAINTENANCE_PHOTO)\n"
        "print(hook.__module__, hook.__name__)\n"
    )
    result = subprocess.run(  # noqa: S603 (fixed code, this interpreter)
        [sys.executable, "-c", code], cwd=BACKEND_DIR, capture_output=True, text=True, check=False
    )

    assert result.returncode == 0, result.stderr[-2000:]
    assert result.stdout.split() == ["app.maintenance.photos", "can_view_maintenance_photo"]


def test_the_registered_hook_is_the_maintenance_one():
    assert purposes.can_view_hook(FilePurpose.MAINTENANCE_PHOTO) is can_view_maintenance_photo
