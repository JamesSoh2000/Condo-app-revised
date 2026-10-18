"""The `files` table's constraints (P3-04a): a ready file has a version, attachments need ready."""

import uuid

import pytest

from app.files.models import File, FilePurpose, FileStatus
from tests.helpers.db import assert_integrity_error

pytestmark = pytest.mark.anyio


def a_file(world, **overrides) -> File:
    file_id = uuid.uuid4()
    values = {
        "id": file_id,
        "building_id": world.a.id,
        "uploaded_by_user_id": world.a_security.user.id,
        "purpose": FilePurpose.PACKAGE_PHOTO,
        "s3_key": f"b/{world.a.id}/package_photo/{file_id}",
        "content_type": "image/png",
        "size_bytes": 10,
        "original_name": "box.png",
        "status": FileStatus.PENDING,
        **overrides,
    }
    return File(**values)


async def insert(db, file: File) -> None:
    db.add(file)
    await db.flush()


async def test_a_valid_pending_and_ready_file_are_accepted(db, world):
    await insert(db, a_file(world))
    await insert(db, a_file(world, status=FileStatus.READY, s3_version_id="v1"))
    await insert(
        db,
        a_file(
            world,
            status=FileStatus.READY,
            s3_version_id="v2",
            attached_type="package",
            attached_id=uuid.uuid4(),
        ),
    )


async def test_ready_needs_a_version_and_pending_has_none(db, world):
    await assert_integrity_error(
        db,
        insert(db, a_file(world, status=FileStatus.READY)),
        constraint="ck_files_version_iff_ready",
    )
    await assert_integrity_error(
        db,
        insert(db, a_file(world, s3_version_id="v1")),
        constraint="ck_files_version_iff_ready",
    )


async def test_attachment_columns_go_together_and_need_ready(db, world):
    ready = {"status": FileStatus.READY, "s3_version_id": "v1"}
    await assert_integrity_error(
        db,
        insert(db, a_file(world, **ready, attached_type="package")),
        constraint="ck_files_attachment_complete",
    )
    await assert_integrity_error(
        db,
        insert(db, a_file(world, **ready, attached_id=uuid.uuid4())),
        constraint="ck_files_attachment_complete",
    )
    await assert_integrity_error(
        db,
        insert(db, a_file(world, attached_type="package", attached_id=uuid.uuid4())),
        constraint="ck_files_attached_only_when_ready",
    )


async def test_size_must_be_positive(db, world):
    await assert_integrity_error(
        db, insert(db, a_file(world, size_bytes=0)), constraint="ck_files_size_positive"
    )


async def test_keys_are_unique(db, world):
    first = a_file(world)
    await insert(db, first)
    await assert_integrity_error(
        db, insert(db, a_file(world, s3_key=first.s3_key)), constraint="uq_files_s3_key"
    )


async def test_building_and_uploader_must_exist(db, world):
    await assert_integrity_error(
        db,
        insert(db, a_file(world, building_id=uuid.uuid4())),
        constraint="fk_files_building_id_buildings",
    )
    await assert_integrity_error(
        db,
        insert(db, a_file(world, uploaded_by_user_id=uuid.uuid4())),
        constraint="fk_files_uploaded_by_user_id_users",
    )


async def test_purpose_and_status_are_checked(db, world):
    from sqlalchemy import text

    await insert(db, a_file(world))
    await assert_integrity_error(
        db,
        db.execute(text("UPDATE files SET purpose = 'avatar'")),
        constraint="ck_files_file_purpose",
    )
    await assert_integrity_error(
        db,
        db.execute(text("UPDATE files SET status = 'deleted'")),
        constraint="ck_files_file_status",
    )
