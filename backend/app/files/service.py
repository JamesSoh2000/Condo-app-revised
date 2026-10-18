"""File uploads (ADR-0007): issue a presigned POST, then verify the stored object and pin it.

`create_file` writes a `pending` row and signs a form for exactly the declared size and type.
`complete_file` checks what S3 holds (size, type, the magic number of the version it found) and
stores that version, so later uploads with the same form never change what the file serves.
"""

from datetime import timedelta
from uuid import UUID, uuid7

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.core.errors import Conflict, NotFound, UnprocessableContent
from app.files import storage
from app.files.models import File, FileStatus
from app.files.purposes import MAGIC_BYTES, PURPOSES, matches_magic
from app.files.schemas import FileCreate, FileOut, FileUploadOut, PresignedUpload
from app.tenancy.context import TenantContext
from app.tenancy.deps import ForbiddenRole

UPLOAD_EXPIRES = timedelta(minutes=5)


class FileNotFound(NotFound):
    code = "file_not_found"


class UploadIncomplete(Conflict):
    code = "upload_incomplete"


class FileTooLarge(UnprocessableContent):
    code = "file_too_large"


class FileTypeNotAllowed(UnprocessableContent):
    code = "file_type_not_allowed"


class FileSizeMismatch(UnprocessableContent):
    code = "file_size_mismatch"


class FileTypeMismatch(UnprocessableContent):
    code = "file_type_mismatch"


class UnversionedObjectError(RuntimeError):
    """S3 gave no version for an object, so there is nothing to pin: bucket versioning is off.

    A configuration error (a 500), never a `ready` file.
    """


async def create_file(db: AsyncSession, ctx: TenantContext, data: FileCreate) -> FileUploadOut:
    rule = PURPOSES[data.purpose]
    if not ctx.has_any(*rule.uploader_roles):
        raise ForbiddenRole(detail="Your role in this building may not upload this kind of file.")
    if data.content_type not in rule.content_types:
        allowed = ", ".join(sorted(rule.content_types))
        raise FileTypeNotAllowed(detail=f"A {data.purpose} must be one of: {allowed}.")
    if data.size_bytes > rule.max_bytes:
        raise FileTooLarge(detail=f"A {data.purpose} may be at most {rule.max_bytes} bytes.")

    file_id = uuid7()
    file = File(
        id=file_id,
        building_id=ctx.building_id,
        uploaded_by_user_id=ctx.user_id,
        purpose=data.purpose,
        s3_key=f"b/{ctx.building_id}/{data.purpose}/{file_id}",
        content_type=data.content_type,
        size_bytes=data.size_bytes,
        original_name=data.filename,
        status=FileStatus.PENDING,
    )
    db.add(file)
    # Before signing: the form's own expiry is then never earlier than the one reported.
    expires_at = clock.now() + UPLOAD_EXPIRES
    post = await storage.presign_post(
        file.s3_key,
        content_type=data.content_type,
        size_bytes=data.size_bytes,
        expires_in=int(UPLOAD_EXPIRES.total_seconds()),
    )
    await db.commit()
    return FileUploadOut(
        file_id=file_id,
        upload=PresignedUpload(url=post.url, fields=post.fields),
        expires_at=expires_at,
    )


async def complete_file(db: AsyncSession, ctx: TenantContext, file_id: UUID) -> FileOut:
    """Verify the uploader's object and mark the file `ready`; idempotent once it is."""
    file = await db.scalar(
        select(File).where(
            File.id == file_id,
            File.building_id == ctx.building_id,
            File.uploaded_by_user_id == ctx.user_id,
        )
    )
    if file is None:
        raise FileNotFound(detail="File not found.")
    if file.status is FileStatus.READY:
        # Never re-checked: its version is pinned, whatever was uploaded since.
        return FileOut.model_validate(file)

    found = await storage.head(file.s3_key)
    if found is None:
        raise UploadIncomplete(detail="Nothing has been uploaded for this file yet.")
    if found.size != file.size_bytes:
        raise FileSizeMismatch(detail="The uploaded file's size is not the declared size.")
    if found.content_type != file.content_type:
        raise FileTypeMismatch(detail="The uploaded file's type is not the declared type.")
    if not found.version_id or found.version_id == "null":
        raise UnversionedObjectError(f"no version for file {file.id}; is bucket versioning on?")
    # The version HEAD saw, not the latest: another POST with the same form may have landed since.
    first_bytes = await storage.get_range(file.s3_key, found.version_id, MAGIC_BYTES)
    if not matches_magic(file.content_type, first_bytes):
        raise FileTypeMismatch(detail="The uploaded file's content is not the declared type.")

    # Conditional: if a concurrent completion won, its pinned version stays and is returned.
    await db.execute(
        update(File)
        .where(
            File.id == file.id,
            File.building_id == ctx.building_id,
            File.status == FileStatus.PENDING,
        )
        .values(status=FileStatus.READY, s3_version_id=found.version_id)
    )
    await db.refresh(file)
    await db.commit()
    return FileOut.model_validate(file)
