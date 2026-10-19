"""Private files (ADR-0007): upload, verify and pin, attach, download.

`create_file` writes a `pending` row and signs a form for exactly the declared size and type.
`complete_file` checks what S3 holds (size, type, the magic number of the version it found) and
stores that version, so later uploads with the same form never change what the file serves.
`claim_file` attaches a `ready` file to a domain record; from then on that record's `can_view`
hook decides who may `download_url` it.
"""

from datetime import timedelta
from urllib.parse import quote
from uuid import UUID, uuid7

from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.core.errors import Conflict, NotFound, UnprocessableContent
from app.files import storage
from app.files.models import File, FilePurpose, FileStatus
from app.files.purposes import (
    IMAGE_TYPES,
    MAGIC_BYTES,
    PURPOSES,
    can_view_hook,
    is_staff_purpose,
    matches_magic,
)
from app.files.schemas import FileCreate, FileDownloadOut, FileOut, FileUploadOut, PresignedUpload
from app.tenancy.context import TenantContext
from app.tenancy.deps import ForbiddenRole

UPLOAD_EXPIRES = timedelta(minutes=5)
DOWNLOAD_EXPIRES = timedelta(seconds=60)


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


class InvalidFile(UnprocessableContent):
    code = "invalid_file"


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

    try:
        version_id = await _verify(file)
    except UploadIncomplete, FileSizeMismatch, FileTypeMismatch:
        # A completion that committed while this one checked wins, whatever was uploaded since:
        # answer with it instead of the failure (review round 1).
        current = await db.scalar(
            select(File).where(File.id == file.id).execution_options(populate_existing=True)
        )
        if current is not None and current.status is FileStatus.READY:
            return FileOut.model_validate(current)
        raise

    # Conditional: if a concurrent completion won, its pinned version stays and is returned.
    await db.execute(
        update(File)
        .where(
            File.id == file.id,
            File.building_id == ctx.building_id,
            File.status == FileStatus.PENDING,
        )
        .values(status=FileStatus.READY, s3_version_id=version_id)
    )
    current = await db.scalar(
        select(File).where(File.id == file.id).execution_options(populate_existing=True)
    )
    if current is None:
        # `files.cleanup` deleted it meanwhile (P3-04c): it is not there any more.
        raise FileNotFound(detail="File not found.")
    await db.commit()
    return FileOut.model_validate(current)


async def _verify(file: File) -> str:
    """Check the object stored for `file` against its declaration; return the version checked."""
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
    return found.version_id


async def claim_file(
    db: AsyncSession,
    ctx: TenantContext,
    file_id: UUID,
    purpose: FilePurpose,
    attached_type: str,
    attached_id: UUID,
) -> File:
    """Attach the caller's `ready`, unattached `purpose` file to a record. Never commits.

    For a staff purpose, any of its uploader roles may attach another one's file. A file of
    another building, or none, is a 404; any other refusal a 422 `invalid_file`.
    """
    rule = PURPOSES[purpose]
    conditions = [
        File.id == file_id,
        File.building_id == ctx.building_id,
        File.status == FileStatus.READY,
        File.purpose == purpose,
        File.attached_id.is_(None),
    ]
    if not (is_staff_purpose(rule) and ctx.has_any(*rule.uploader_roles)):
        conditions.append(File.uploaded_by_user_id == ctx.user_id)
    # Conditional: a concurrent claim waits for this row's lock, then finds it attached.
    claimed = await db.scalar(
        update(File)
        .where(*conditions)
        .values(attached_type=attached_type, attached_id=attached_id)
        .returning(File)
        .execution_options(populate_existing=True)
    )
    if claimed is not None:
        return claimed
    exists = await db.scalar(
        select(File.id).where(File.id == file_id, File.building_id == ctx.building_id)
    )
    if exists is None:
        raise FileNotFound(detail="File not found.")
    raise InvalidFile(detail="This file can't be attached here.")


async def download_url(db: AsyncSession, ctx: TenantContext, file_id: UUID) -> FileDownloadOut:
    """A short-lived link to the file's pinned version, if the caller may see the file."""
    file = await db.scalar(
        select(File).where(
            File.id == file_id,
            File.building_id == ctx.building_id,
            File.status == FileStatus.READY,
        )
    )
    # `ready` always has a version (check constraint); the test only narrows the type.
    if file is None or file.s3_version_id is None or not await _may_view(db, ctx, file):
        # Pending, someone else's, or not there: one answer (CLAUDE.md rule 1).
        raise FileNotFound(detail="File not found.")
    # Before signing: the URL's own expiry is then never earlier than the one reported.
    expires_at = clock.now() + DOWNLOAD_EXPIRES
    url = await storage.presign_get(
        file.s3_key,
        file.s3_version_id,
        content_disposition(file.content_type, file.original_name),
        expires_in=int(DOWNLOAD_EXPIRES.total_seconds()),
    )
    return FileDownloadOut(url=url, expires_at=expires_at)


async def _may_view(db: AsyncSession, ctx: TenantContext, file: File) -> bool:
    if file.attached_id is None:
        return file.uploaded_by_user_id == ctx.user_id
    # Attached: a file is only as visible as its record (ADR-0007), which only its domain knows.
    hook = can_view_hook(file.purpose)
    return hook is not None and await hook(ctx, file, db)


def content_disposition(content_type: str, filename: str) -> str:
    """Images open in the browser, anything else downloads. The name goes in twice (RFC 6266):
    a quoted ASCII fallback without `"` or `\\`, and the exact name percent-encoded as UTF-8."""
    kind = "inline" if content_type in IMAGE_TYPES else "attachment"
    fallback = "".join(c if " " <= c <= "~" and c not in '"\\' else "_" for c in filename)
    return f"{kind}; filename=\"{fallback}\"; filename*=UTF-8''{quote(filename, safe='')}"
