"""`POST /files` (P3-04a criteria 1-3, 9-11, 16): the presigned POST and the pending row."""

import base64
import json
import uuid
from datetime import datetime, timedelta

import pytest
from sqlalchemy import func, select

from app.core import clock
from app.core.config import settings
from app.files.models import File, FilePurpose, FileStatus
from app.files.purposes import MAX_IMAGE_BYTES, MAX_PDF_BYTES
from tests.files.conftest import pdf, png, post_form
from tests.helpers.tenancy import assert_cross_building_404, assert_forbidden_role, assert_problem

pytestmark = pytest.mark.anyio


def files_url(building_id: uuid.UUID) -> str:
    return f"/api/buildings/{building_id}/files"


def body(**overrides: object) -> dict[str, object]:
    return {
        "purpose": "package_photo",
        "filename": "box.png",
        "content_type": "image/png",
        "size_bytes": 64,
        **overrides,
    }


async def file_count(db):
    return await db.scalar(select(func.count()).select_from(File))


def policy_of(upload):
    return json.loads(base64.b64decode(upload["fields"]["policy"]))


def settings_public_endpoint() -> str:
    endpoint = settings.s3_public_endpoint_url or settings.s3_endpoint_url
    assert endpoint is not None
    return endpoint


async def test_create_returns_presigned_post_and_pending_row(as_user, db, world, s3_bucket):
    client = await as_user(world.a_security.user)
    before = clock.now()

    r = await client.post(files_url(world.a.id), json=body(filename="Box 12.png"))

    assert r.status_code == 201, r.text
    out = r.json()
    assert set(out) == {"file_id", "upload", "expires_at"}
    file_id = uuid.UUID(out["file_id"])
    key = f"b/{world.a.id}/package_photo/{file_id}"
    upload = out["upload"]
    assert upload["url"].startswith(settings_public_endpoint())
    assert upload["fields"]["key"] == key
    assert upload["fields"]["Content-Type"] == "image/png"
    policy = policy_of(upload)
    conditions = policy["conditions"]
    # The signed policy itself expires within the 5 minutes too (review round 2 note).
    signed_expiry = datetime.fromisoformat(policy["expiration"])
    assert (
        before + timedelta(minutes=4)
        < signed_expiry
        <= clock.now() + timedelta(minutes=5, seconds=1)
    )
    assert ["content-length-range", 64, 64] in conditions
    assert {"Content-Type": "image/png"} in conditions
    assert {"bucket": s3_bucket} in conditions
    assert {"key": key} in conditions
    expires_at = datetime.fromisoformat(out["expires_at"])
    assert before + timedelta(minutes=4) < expires_at <= clock.now() + timedelta(minutes=5)

    row = await db.get(File, file_id)
    assert row is not None
    assert row.building_id == world.a.id
    assert row.uploaded_by_user_id == world.a_security.user.id
    assert row.purpose is FilePurpose.PACKAGE_PHOTO
    assert row.status is FileStatus.PENDING
    assert row.s3_key == key
    assert row.s3_version_id is None
    assert (row.content_type, row.size_bytes, row.original_name) == ("image/png", 64, "Box 12.png")
    assert (row.attached_type, row.attached_id) == (None, None)


@pytest.mark.parametrize("field", ["s3_key", "key", "s3_version_id", "status"])
async def test_create_refuses_a_client_key(as_user, db, world, field):
    client = await as_user(world.a_security.user)

    r = await client.post(files_url(world.a.id), json=body(**{field: "b/x/package_photo/y"}))

    assert_problem(r, 422, "validation_error")
    assert await file_count(db) == 0


@pytest.mark.parametrize(
    ("purpose", "content_type", "limit"),
    [
        ("package_photo", "image/jpeg", MAX_IMAGE_BYTES),
        ("maintenance_photo", "image/png", MAX_IMAGE_BYTES),
        ("notice_attachment", "application/pdf", MAX_PDF_BYTES),
        # P6-01a: notice images keep ADR-0007's image limit, not the PDF one.
        ("notice_attachment", "image/png", MAX_IMAGE_BYTES),
        ("notice_attachment", "image/jpeg", MAX_IMAGE_BYTES),
        ("notice_attachment", "image/webp", MAX_IMAGE_BYTES),
        ("notice_attachment", "image/heic", MAX_IMAGE_BYTES),
    ],
)
async def test_create_refuses_a_file_over_the_purpose_limit(
    as_user, db, world, purpose, content_type, limit
):
    client = await as_user(world.a_manager.user)
    over = body(purpose=purpose, content_type=content_type, size_bytes=limit + 1)

    assert_problem(await client.post(files_url(world.a.id), json=over), 422, "file_too_large")
    assert await file_count(db) == 0

    at_limit = body(purpose=purpose, content_type=content_type, size_bytes=limit)
    assert (await client.post(files_url(world.a.id), json=at_limit)).status_code == 201


@pytest.mark.parametrize(
    ("purpose", "content_type"),
    [
        ("package_photo", "application/pdf"),
        ("package_photo", "image/svg+xml"),
        ("package_photo", "image/gif"),
        ("maintenance_photo", "text/html"),
        # P6-01a allows notice images (PNG among them); GIF stays refused.
        ("notice_attachment", "image/gif"),
        ("notice_attachment", "application/octet-stream"),
    ],
)
async def test_create_refuses_a_type_the_purpose_does_not_allow(
    as_user, db, world, purpose, content_type
):
    client = await as_user(world.a_manager.user)

    r = await client.post(
        files_url(world.a.id), json=body(purpose=purpose, content_type=content_type)
    )

    assert_problem(r, 422, "file_type_not_allowed")
    assert await file_count(db) == 0


async def test_presigned_form_enforces_the_exact_size_and_type(as_user, s3, world, s3_bucket):
    client = await as_user(world.a_security.user)
    out = (await client.post(files_url(world.a.id), json=body(size_bytes=100))).json()
    upload, key = out["upload"], out["upload"]["fields"]["key"]

    too_big = await post_form(upload, png(101))
    assert too_big.status_code == 400
    assert "EntityTooLarge" in too_big.text
    too_small = await post_form(upload, png(99))
    assert too_small.status_code == 400
    assert "EntityTooSmall" in too_small.text
    other_type = await post_form(upload, png(100), **{"Content-Type": "text/html"})
    assert other_type.status_code == 403
    assert "Versions" not in s3.list_object_versions(Bucket=s3_bucket, Prefix=key)

    assert (await post_form(upload, png(100))).status_code == 204
    assert s3.head_object(Bucket=s3_bucket, Key=key)["ContentLength"] == 100


@pytest.mark.parametrize(
    ("persona", "purpose", "content_type", "data"),
    [
        ("a_security", "package_photo", "image/png", png()),
        ("a_manager", "package_photo", "image/png", png()),
        ("a_resident1", "maintenance_photo", "image/png", png()),
        ("a_manager", "maintenance_photo", "image/png", png()),
        ("a_manager", "notice_attachment", "application/pdf", pdf()),
        ("a_manager", "notice_attachment", "image/png", png()),
    ],
)
async def test_each_allowed_role_uploads_and_completes(
    as_user, db, world, persona, purpose, content_type, data
):
    client = await as_user(getattr(world, persona).user)
    created = await client.post(
        files_url(world.a.id),
        json=body(purpose=purpose, content_type=content_type, size_bytes=len(data)),
    )
    assert created.status_code == 201, created.text
    file_id = created.json()["file_id"]
    assert (await post_form(created.json()["upload"], data)).status_code == 204

    done = await client.post(f"{files_url(world.a.id)}/{file_id}/complete")

    assert done.status_code == 200, done.text
    out = done.json()
    assert out == {
        "id": file_id,
        "purpose": purpose,
        "status": "ready",
        "content_type": content_type,
        "size_bytes": len(data),
        "original_name": "box.png",
        "created_at": out["created_at"],
    }
    row = await db.get(File, uuid.UUID(file_id))
    await db.refresh(row)
    assert row.status is FileStatus.READY


@pytest.mark.parametrize(
    ("persona", "purpose", "content_type"),
    [
        ("a_resident1", "package_photo", "image/png"),
        ("a_security", "maintenance_photo", "image/png"),
        ("a_council", "notice_attachment", "application/pdf"),
        ("a_council", "package_photo", "image/png"),
        ("a_resident2", "notice_attachment", "application/pdf"),
        # P6-01a D1: security doesn't author notices, so doesn't attach to them either.
        ("a_security", "notice_attachment", "application/pdf"),
        ("a_security", "notice_attachment", "image/png"),
    ],
)
async def test_wrong_role_is_403(as_user, db, world, persona, purpose, content_type):
    client = await as_user(getattr(world, persona).user)

    await assert_forbidden_role(
        client,
        "POST",
        files_url(world.a.id),
        json=body(purpose=purpose, content_type=content_type),
    )
    assert await file_count(db) == 0


async def test_multi_role_comes_from_this_buildings_membership(as_user, db, world):
    # multi is security in B and only a resident in A.
    client = await as_user(world.multi)

    await assert_forbidden_role(client, "POST", files_url(world.a.id), json=body())
    assert await file_count(db) == 0
    assert (await client.post(files_url(world.b.id), json=body())).status_code == 201


async def test_unauthenticated_is_401(client, world):
    assert_problem(await client.post(files_url(world.a.id), json=body()), 401, "not_authenticated")
    assert_problem(
        await client.post(f"{files_url(world.a.id)}/{uuid.uuid4()}/complete"),
        401,
        "not_authenticated",
    )


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_non_member_pending_and_suspended_get_404(as_user, db, world, persona):
    owner = await as_user(world.a_resident1.user)
    created = await owner.post(files_url(world.a.id), json=body(purpose="maintenance_photo"))
    file_id = created.json()["file_id"]
    client = await as_user(getattr(world, persona).user)

    await assert_cross_building_404(
        client, "POST", files_url(world.a.id), json=body(purpose="maintenance_photo")
    )
    await assert_cross_building_404(client, "POST", f"{files_url(world.a.id)}/{file_id}/complete")
    assert await file_count(db) == 1


@pytest.mark.parametrize(
    "overrides",
    [
        {"filename": ""},
        {"filename": "   "},
        {"filename": "x" * 256},
        {"filename": "bad\nname.png"},
        {"filename": "nul\x00.png"},
        {"filename": "tab\t.png"},
        {"filename": "del\x7f.png"},
        # At either end, where whitespace stripping would remove them first (review round 1).
        {"filename": "box.png\n"},
        {"filename": "\tbox.png"},
        {"filename": "box.png\u2028"},
        {"filename": "\x1fbox.png"},
        {"size_bytes": 0},
        {"size_bytes": -1},
        {"purpose": "avatar"},
        {"content_type": "x" * 101},
    ],
)
async def test_invalid_filename_or_size_is_422(as_user, db, world, overrides):
    client = await as_user(world.a_security.user)

    r = await client.post(files_url(world.a.id), json=body(**overrides))

    assert_problem(r, 422, "validation_error")
    assert await file_count(db) == 0


async def test_a_255_character_unicode_filename_is_kept(as_user, db, world):
    client = await as_user(world.a_security.user)
    name = "é" * 251 + ".png"

    r = await client.post(files_url(world.a.id), json=body(filename=name))

    assert r.status_code == 201, r.text
    row = await db.get(File, uuid.UUID(r.json()["file_id"]))
    assert row.original_name == name


async def test_a_notice_image_over_the_image_limit_is_refused_though_under_the_pdf_one(
    as_user, db, world
):
    # P6-01a criterion 8: a per-type limit, not the purpose's largest.
    client = await as_user(world.a_manager.user)
    over = body(purpose="notice_attachment", content_type="image/png", size_bytes=MAX_IMAGE_BYTES + 1)

    r = await client.post(files_url(world.a.id), json=over)

    assert MAX_IMAGE_BYTES + 1 < MAX_PDF_BYTES
    problem = assert_problem(r, 422, "file_too_large")
    assert str(MAX_IMAGE_BYTES) in problem["detail"]
    assert await file_count(db) == 0
