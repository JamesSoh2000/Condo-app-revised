"""`GET /files/{id}/download-url` (P3-04b criteria 5, 6, 17-22): who may download, and what."""

import uuid
from datetime import datetime, timedelta
from urllib.parse import parse_qs, unquote, urlsplit

import httpx
import pytest
from sqlalchemy import update

from app.core import clock
from app.files import purposes
from app.files.models import File, FilePurpose
from tests.files.conftest import pdf, png, post_form, upload_ready
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_not_visible,
    assert_problem,
    without_request_id,
)

pytestmark = pytest.mark.anyio


def url(building_id: uuid.UUID, file_id: uuid.UUID) -> str:
    return f"/api/buildings/{building_id}/files/{file_id}/download-url"


async def fetch(link: str) -> httpx.Response:
    """GET a presigned URL as the browser does."""
    async with httpx.AsyncClient() as browser:
        return await browser.get(link)


async def attach(db, file_id: uuid.UUID) -> None:
    """What `claim_file` leaves behind; these tests are about the download rule only."""
    await db.execute(
        update(File)
        .where(File.id == file_id)
        .values(attached_type="maintenance_request", attached_id=uuid.uuid4())
    )


@pytest.fixture
def hooks(monkeypatch) -> dict[FilePurpose, purposes.CanView]:
    """An empty `can_view` registry for the test; register hooks into it as a domain would."""
    registry: dict[FilePurpose, purposes.CanView] = {}
    monkeypatch.setattr(purposes, "_CAN_VIEW", registry)
    return registry


def recording_hook(grants: set[uuid.UUID], calls: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID]]):
    async def hook(ctx, file, db) -> bool:
        calls.append((ctx.building_id, ctx.user_id, file.id))
        return ctx.user_id in grants

    return hook


async def test_uploader_downloads_an_unattached_file(as_user, db, world):
    resident = await as_user(world.a_resident1.user)
    data = png(64, b"\x07")
    uploaded = await upload_ready(resident, world.a.id, data)

    before = clock.now()
    r = await resident.get(url(world.a.id, uploaded.file_id))

    assert r.status_code == 200, r.text
    body = r.json()
    assert set(body) == {"url", "expires_at"}
    expires_at = datetime.fromisoformat(body["expires_at"])
    assert before + timedelta(seconds=55) < expires_at <= clock.now() + timedelta(seconds=60)
    file = await db.get(File, uploaded.file_id)
    await db.refresh(file)
    query = parse_qs(urlsplit(body["url"]).query)
    assert query["versionId"] == [file.s3_version_id]
    assert query["X-Amz-Expires"] == ["60"]
    got = await fetch(body["url"])
    assert got.status_code == 200
    assert got.content == data
    assert got.headers["content-disposition"].startswith('inline; filename="leak.png"; ')


async def test_pdf_downloads_as_an_attachment(as_user, world):
    manager = await as_user(world.a_manager.user)
    uploaded = await upload_ready(
        manager,
        world.a.id,
        pdf(64),
        purpose="notice_attachment",
        filename="rules.pdf",
        content_type="application/pdf",
    )

    r = await manager.get(url(world.a.id, uploaded.file_id))

    assert r.status_code == 200, r.text
    got = await fetch(r.json()["url"])
    assert got.headers["content-disposition"].startswith('attachment; filename="rules.pdf"; ')


async def test_download_after_a_reposted_form_returns_the_original_bytes(as_user, world):
    resident = await as_user(world.a_resident1.user)
    original = png(64, b"\x01")
    uploaded = await upload_ready(resident, world.a.id, original)
    # The form is still valid: S3 stores these bytes as a newer version of the same key.
    assert (await post_form(uploaded.upload, png(64, b"\x02"))).status_code == 204

    r = await resident.get(url(world.a.id, uploaded.file_id))

    assert r.status_code == 200, r.text
    assert (await fetch(r.json()["url"])).content == original


async def test_another_resident_gets_the_same_404_as_a_random_id(as_user, world):
    uploaded = await upload_ready(await as_user(world.a_resident1.user), world.a.id, png())
    other = await as_user(world.a_resident2.user)

    body = await assert_not_visible(
        other, "GET", url(world.a.id, uploaded.file_id), code="file_not_found"
    )

    random = assert_problem(await other.get(url(world.a.id, uuid.uuid4())), 404, "file_not_found")
    assert without_request_id(body) == without_request_id(random)


async def test_the_manager_cannot_download_a_residents_unattached_file(as_user, world):
    uploaded = await upload_ready(await as_user(world.a_resident1.user), world.a.id, png())

    await assert_not_visible(
        await as_user(world.a_manager.user),
        "GET",
        url(world.a.id, uploaded.file_id),
        code="file_not_found",
    )


async def test_unauthenticated_is_401(as_user, client, world):
    uploaded = await upload_ready(await as_user(world.a_resident1.user), world.a.id, png())

    assert_problem(await client.get(url(world.a.id, uploaded.file_id)), 401, "not_authenticated")


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_cross_building_and_inactive_members_get_404(as_user, world, persona):
    uploaded = await upload_ready(await as_user(world.a_resident1.user), world.a.id, png())

    await assert_cross_building_404(
        await as_user(getattr(world, persona).user), "GET", url(world.a.id, uploaded.file_id)
    )


async def test_another_buildings_file_is_404_even_if_the_hook_grants(as_user, db, world, hooks):
    # `multi` is security in B and a resident in A: its own B file, through A's URL.
    multi = await as_user(world.multi)
    uploaded = await upload_ready(multi, world.b.id, png(), purpose="package_photo")
    calls: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID]] = []
    purposes.register_can_view(FilePurpose.PACKAGE_PHOTO, recording_hook({world.multi.id}, calls))

    assert_problem(await multi.get(url(world.a.id, uploaded.file_id)), 404, "file_not_found")
    await attach(db, uploaded.file_id)
    assert_problem(await multi.get(url(world.a.id, uploaded.file_id)), 404, "file_not_found")

    assert calls == []
    # Through its own building, the same caller is granted: the 404 above was the building's.
    assert (await multi.get(url(world.b.id, uploaded.file_id))).status_code == 200
    assert calls == [(world.b.id, world.multi.id, uploaded.file_id)]


async def test_pending_file_is_404_and_the_hook_is_not_asked(as_user, world, hooks):
    resident = await as_user(world.a_resident1.user)
    calls: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID]] = []
    purposes.register_can_view(
        FilePurpose.MAINTENANCE_PHOTO, recording_hook({world.a_resident1.user.id}, calls)
    )
    r = await resident.post(
        f"/api/buildings/{world.a.id}/files",
        json={
            "purpose": "maintenance_photo",
            "filename": "leak.png",
            "content_type": "image/png",
            "size_bytes": 64,
        },
    )
    file_id = uuid.UUID(r.json()["file_id"])
    # Uploaded but not completed: S3 holds bytes, the file is still `pending`.
    assert (await post_form(r.json()["upload"], png())).status_code == 204

    assert_problem(await resident.get(url(world.a.id, file_id)), 404, "file_not_found")
    assert calls == []


async def test_hook_grants_and_refuses_an_attached_file(as_user, db, world, hooks):
    data = png(64, b"\x05")
    uploaded = await upload_ready(await as_user(world.a_resident1.user), world.a.id, data)
    await attach(db, uploaded.file_id)
    calls: list[tuple[uuid.UUID, uuid.UUID, uuid.UUID]] = []
    granted = {world.a_resident2.user.id, world.a_manager.user.id}
    purposes.register_can_view(FilePurpose.MAINTENANCE_PHOTO, recording_hook(granted, calls))
    link = url(world.a.id, uploaded.file_id)

    for persona in (world.a_resident2, world.a_manager):
        r = await (await as_user(persona.user)).get(link)
        assert r.status_code == 200, r.text
        assert (await fetch(r.json()["url"])).content == data
    for persona in (world.a_council, world.a_resident1):
        await assert_not_visible(await as_user(persona.user), "GET", link, code="file_not_found")

    assert calls == [
        (world.a.id, persona.user.id, uploaded.file_id)
        for persona in (world.a_resident2, world.a_manager, world.a_council, world.a_resident1)
    ]


async def test_attached_file_without_a_hook_is_hidden_from_its_uploader(as_user, db, world, hooks):
    resident = await as_user(world.a_resident1.user)
    uploaded = await upload_ready(resident, world.a.id, png())
    # A hook for another purpose doesn't apply.
    purposes.register_can_view(
        FilePurpose.PACKAGE_PHOTO, recording_hook({world.a_resident1.user.id}, [])
    )
    await attach(db, uploaded.file_id)

    assert_problem(await resident.get(url(world.a.id, uploaded.file_id)), 404, "file_not_found")


async def test_registering_a_second_hook_is_an_error(hooks):
    first = recording_hook(set(), [])
    purposes.register_can_view(FilePurpose.PACKAGE_PHOTO, first)

    with pytest.raises(ValueError, match="package_photo"):
        purposes.register_can_view(FilePurpose.PACKAGE_PHOTO, recording_hook(set(), []))

    assert purposes.can_view_hook(FilePurpose.PACKAGE_PHOTO) is first


async def test_quoted_and_non_ascii_filename_round_trips_through_s3(as_user, world):
    resident = await as_user(world.a_resident1.user)
    name = 'say "hi" \\ café 文件.png'
    uploaded = await upload_ready(resident, world.a.id, png(), filename=name)

    r = await resident.get(url(world.a.id, uploaded.file_id))

    header = (await fetch(r.json()["url"])).headers["content-disposition"]
    fallback, encoded = header.removeprefix("inline; ").split("; ")
    assert fallback == 'filename="say _hi_ _ caf_ __.png"'
    assert encoded.startswith("filename*=UTF-8''")
    assert unquote(encoded.removeprefix("filename*=UTF-8''"), encoding="utf-8") == name
