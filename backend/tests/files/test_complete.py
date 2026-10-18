"""`POST /files/{id}/complete` (P3-04a criteria 4, 5, 12-16): verify the object, pin its version."""

import uuid
from dataclasses import dataclass
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import update

from app.files import service, storage
from app.files.models import File, FileStatus
from tests.files.conftest import pdf, png, post_form
from tests.helpers.tenancy import assert_not_visible, assert_problem, without_request_id

pytestmark = pytest.mark.anyio


@dataclass
class Created:
    client: AsyncClient
    file_id: uuid.UUID
    key: str
    upload: dict[str, Any]
    url: str


async def create(client: AsyncClient, building_id: uuid.UUID, **overrides: object) -> Created:
    payload = {
        "purpose": "maintenance_photo",
        "filename": "leak.png",
        "content_type": "image/png",
        "size_bytes": 64,
        **overrides,
    }
    r = await client.post(f"/api/buildings/{building_id}/files", json=payload)
    assert r.status_code == 201, r.text
    out = r.json()
    file_id = uuid.UUID(out["file_id"])
    return Created(
        client=client,
        file_id=file_id,
        key=out["upload"]["fields"]["key"],
        upload=out["upload"],
        url=f"/api/buildings/{building_id}/files/{file_id}/complete",
    )


@pytest.fixture
async def resident_file(as_user, world) -> Created:
    return await create(await as_user(world.a_resident1.user), world.a.id)


async def row(db, file_id):
    file = await db.get(File, file_id)
    assert file is not None
    await db.refresh(file)
    return file


async def test_complete_before_upload_is_409(db, resident_file):
    r = await resident_file.client.post(resident_file.url)

    assert_problem(r, 409, "upload_incomplete")
    file = await row(db, resident_file.file_id)
    assert (file.status, file.s3_version_id) == (FileStatus.PENDING, None)


async def test_png_declared_with_pdf_bytes_is_rejected_and_stays_pending(db, resident_file):
    assert (await post_form(resident_file.upload, pdf(64))).status_code == 204

    r = await resident_file.client.post(resident_file.url)

    assert_problem(r, 422, "file_type_mismatch")
    file = await row(db, resident_file.file_id)
    assert (file.status, file.s3_version_id) == (FileStatus.PENDING, None)


@pytest.mark.parametrize(
    ("content_type", "data"),
    [
        ("image/jpeg", b"\xff\xd8\xff\xe0" + b"\x00" * 60),
        ("image/png", png()),
        ("image/webp", b"RIFF\x38\x00\x00\x00WEBPVP8 " + b"\x00" * 48),
        ("image/heic", b"\x00\x00\x00\x18ftypheic" + b"\x00" * 52),
        ("image/heic", b"\x00\x00\x00\x18ftypmif1" + b"\x00" * 52),
    ],
)
async def test_each_image_type_passes_its_magic_check(as_user, world, content_type, data):
    created = await create(
        await as_user(world.a_resident1.user), world.a.id, content_type=content_type
    )
    assert (await post_form(created.upload, data)).status_code == 204

    r = await created.client.post(created.url)

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready"


@pytest.mark.parametrize(
    ("content_type", "data"),
    [
        ("image/jpeg", png()),
        ("image/png", b"\x89PNG\r\n\x1a" + b"\x00" * 57),  # the last signature byte is wrong
        ("image/webp", b"RIFF\x38\x00\x00\x00WAVEfmt " + b"\x00" * 48),
        ("image/heic", b"\x00\x00\x00\x18ftypisom" + b"\x00" * 52),
        ("image/heic", b"\x00\x00\x00\x18ftypavif" + b"\x00" * 52),  # AVIF is AV1, not HEIC
    ],
)
async def test_bytes_of_another_type_fail_the_magic_check(as_user, db, world, content_type, data):
    created = await create(
        await as_user(world.a_resident1.user), world.a.id, content_type=content_type
    )
    assert (await post_form(created.upload, data)).status_code == 204

    assert_problem(await created.client.post(created.url), 422, "file_type_mismatch")
    assert (await row(db, created.file_id)).status is FileStatus.PENDING


async def test_a_pdf_must_start_with_the_pdf_signature(as_user, db, world):
    created = await create(
        await as_user(world.a_manager.user),
        world.a.id,
        purpose="notice_attachment",
        content_type="application/pdf",
    )
    assert (await post_form(created.upload, b"<html>%PDF-" + b"\x00" * 53)).status_code == 204

    assert_problem(await created.client.post(created.url), 422, "file_type_mismatch")
    assert (await row(db, created.file_id)).status is FileStatus.PENDING


async def test_complete_pins_the_version_and_a_reupload_does_not_change_it(
    db, s3, s3_bucket, resident_file
):
    original = png(64, fill=b"\x01")
    assert (await post_form(resident_file.upload, original)).status_code == 204
    head_version = s3.head_object(Bucket=s3_bucket, Key=resident_file.key)["VersionId"]

    first = await resident_file.client.post(resident_file.url)

    assert first.status_code == 200, first.text
    file = await row(db, resident_file.file_id)
    assert (file.status, file.s3_version_id) == (FileStatus.READY, head_version)

    # The form is still valid: the same uploader POSTs other bytes to the same key.
    assert (await post_form(resident_file.upload, png(64, fill=b"\x02"))).status_code == 204
    versions = s3.list_object_versions(Bucket=s3_bucket, Prefix=resident_file.key)["Versions"]
    assert len(versions) == 2
    pinned = s3.get_object(Bucket=s3_bucket, Key=resident_file.key, VersionId=head_version)
    assert pinned["Body"].read() == original

    again = await resident_file.client.post(resident_file.url)

    assert again.json() == first.json()
    assert (await row(db, resident_file.file_id)).s3_version_id == head_version


async def test_someone_elses_file_is_404_like_a_missing_one(as_user, db, world, resident_file):
    assert (await post_form(resident_file.upload, png())).status_code == 204
    missing_url = resident_file.url.replace(str(resident_file.file_id), str(uuid.uuid4()))

    for persona in (world.a_resident2, world.a_manager, world.a_council):
        client = await as_user(persona.user)
        hidden = await assert_not_visible(client, "POST", resident_file.url, code="file_not_found")
        missing = await assert_not_visible(client, "POST", missing_url, code="file_not_found")
        assert without_request_id(hidden) == without_request_id(missing)

    assert (await row(db, resident_file.file_id)).status is FileStatus.PENDING


async def test_another_buildings_file_through_this_building_is_404(as_user, db, world):
    # multi is security in B (may upload package photos there) and a resident in A.
    client = await as_user(world.multi)
    in_b = await create(client, world.b.id, purpose="package_photo")
    assert (await post_form(in_b.upload, png())).status_code == 204
    through_a = f"/api/buildings/{world.a.id}/files/{in_b.file_id}/complete"

    await assert_not_visible(client, "POST", through_a, code="file_not_found")

    assert (await row(db, in_b.file_id)).status is FileStatus.PENDING


async def test_completing_twice_returns_the_same_file_without_s3(monkeypatch, db, resident_file):
    assert (await post_form(resident_file.upload, png())).status_code == 204
    first = await resident_file.client.post(resident_file.url)
    assert first.status_code == 200

    async def no_s3(*args, **kwargs):
        raise AssertionError("a ready file is not checked again")

    monkeypatch.setattr(storage, "head", no_s3)
    monkeypatch.setattr(storage, "get_range", no_s3)

    second = await resident_file.client.post(resident_file.url)

    assert second.status_code == 200
    assert second.json() == first.json()


async def test_losing_a_concurrent_completion_returns_the_winner(monkeypatch, db, resident_file):
    assert (await post_form(resident_file.upload, png())).status_code == 204
    real_head = storage.head

    async def another_completion_wins(key: str) -> storage.ObjectHead | None:
        found = await real_head(key)
        # The other request's conditional update lands first (same connection, so visible).
        await db.execute(
            update(File)
            .where(File.id == resident_file.file_id)
            .values(status=FileStatus.READY, s3_version_id="winner-version")
        )
        return found

    monkeypatch.setattr(storage, "head", another_completion_wins)

    r = await resident_file.client.post(resident_file.url)

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready"
    assert (await row(db, resident_file.file_id)).s3_version_id == "winner-version"


async def test_a_failed_check_after_another_completion_won_returns_the_winner(
    monkeypatch, db, resident_file
):
    # Review round 1: this request reads `pending`; another completion commits `ready`; then the
    # uploader re-POSTs other bytes of the same size with the still-valid form. This request's
    # checks see the new bytes and fail, but the file is ready: it answers with the winner.
    assert (await post_form(resident_file.upload, png())).status_code == 204
    real_head = storage.head

    async def winner_then_reupload(key: str) -> storage.ObjectHead | None:
        await db.execute(
            update(File)
            .where(File.id == resident_file.file_id)
            .values(status=FileStatus.READY, s3_version_id="winner-version")
        )
        assert (await post_form(resident_file.upload, pdf(64))).status_code == 204
        return await real_head(key)

    monkeypatch.setattr(storage, "head", winner_then_reupload)

    r = await resident_file.client.post(resident_file.url)

    # The body comes from the reloaded row; without the fix this is a 422. (The row itself can't
    # be checked afterwards: in this one-connection harness the simulated winner's update ran
    # inside this request's savepoint, which a read-only answer rolls back. A real winner
    # commits in its own transaction.)
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready"


@pytest.mark.parametrize("outcome", ["missing", "size", "type"])
async def test_every_failed_check_after_a_winner_returns_the_winner(
    monkeypatch, db, resident_file, outcome
):
    # The same race for each other check that can fail (neighbours of the round 1 fix).
    real_head = storage.head
    if outcome != "missing":
        assert (await post_form(resident_file.upload, png())).status_code == 204

    async def winner_then_other_object(key: str) -> storage.ObjectHead | None:
        await db.execute(
            update(File)
            .where(File.id == resident_file.file_id)
            .values(status=FileStatus.READY, s3_version_id="winner-version")
        )
        found = await real_head(key)
        if outcome == "missing":
            return found
        assert found is not None
        if outcome == "size":
            return storage.ObjectHead(found.size + 1, found.content_type, found.version_id)
        return storage.ObjectHead(found.size, "image/jpeg", found.version_id)

    monkeypatch.setattr(storage, "head", winner_then_other_object)

    r = await resident_file.client.post(resident_file.url)

    # As above: the reloaded winner, not the 409/422.
    assert r.status_code == 200, r.text
    assert r.json()["status"] == "ready"


async def test_magic_check_reads_the_version_head_returned(
    monkeypatch, db, s3, s3_bucket, resident_file
):
    assert (await post_form(resident_file.upload, png())).status_code == 204
    real_head = storage.head

    async def reupload_after_head(key: str) -> storage.ObjectHead | None:
        found = await real_head(key)
        # A second POST with the same form lands between the HEAD and the read of the first bytes.
        assert (await post_form(resident_file.upload, pdf(64))).status_code == 204
        return found

    monkeypatch.setattr(storage, "head", reupload_after_head)

    r = await resident_file.client.post(resident_file.url)

    assert r.status_code == 200, r.text
    versions = s3.list_object_versions(Bucket=s3_bucket, Prefix=resident_file.key)["Versions"]
    latest = next(v["VersionId"] for v in versions if v["IsLatest"])
    stored = (await row(db, resident_file.file_id)).s3_version_id
    assert stored != latest
    body = s3.get_object(Bucket=s3_bucket, Key=resident_file.key, VersionId=stored)["Body"]
    assert body.read() == png()


@pytest.mark.parametrize(
    ("data", "content_type", "code"),
    [
        (png(65), "image/png", "file_size_mismatch"),
        (png(63), "image/png", "file_size_mismatch"),
        (png(64), "image/jpeg", "file_type_mismatch"),
        (png(64), "image/png; charset=binary", "file_type_mismatch"),
    ],
)
async def test_size_or_content_type_mismatch_is_422_and_stays_pending(
    db, s3, s3_bucket, resident_file, data, content_type, code
):
    # Put outside the presigned form, whose policy would refuse both.
    s3.put_object(Bucket=s3_bucket, Key=resident_file.key, Body=data, ContentType=content_type)

    assert_problem(await resident_file.client.post(resident_file.url), 422, code)

    file = await row(db, resident_file.file_id)
    assert (file.status, file.s3_version_id) == (FileStatus.PENDING, None)


@pytest.mark.parametrize("version_id", [None, "", "null"])
async def test_an_unversioned_object_is_never_marked_ready(
    monkeypatch, db, resident_file, version_id
):
    assert (await post_form(resident_file.upload, png())).status_code == 204
    real_head = storage.head

    async def unversioned(key: str) -> storage.ObjectHead | None:
        found = await real_head(key)
        assert found is not None
        return storage.ObjectHead(found.size, found.content_type, version_id)

    monkeypatch.setattr(storage, "head", unversioned)

    with pytest.raises(service.UnversionedObjectError):
        await resident_file.client.post(resident_file.url)

    assert (await row(db, resident_file.file_id)).status is FileStatus.PENDING
