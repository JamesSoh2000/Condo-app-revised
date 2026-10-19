from enum import StrEnum
from uuid import UUID

from sqlalchemy import (
    BigInteger,
    CheckConstraint,
    ForeignKey,
    Index,
    String,
    UniqueConstraint,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum


class FilePurpose(StrEnum):
    """What a file is for; its rule in `app.files.purposes` sets the types, size and uploaders."""

    PACKAGE_PHOTO = "package_photo"
    MAINTENANCE_PHOTO = "maintenance_photo"
    NOTICE_ATTACHMENT = "notice_attachment"


class FileStatus(StrEnum):
    PENDING = "pending"  # the presigned POST was issued; nothing verified yet
    READY = "ready"  # the stored object was checked and its version pinned
    # Chosen by `files.cleanup` and committed before any object is deleted (P3-04c): never served,
    # claimed or completed again; `files.purge` deletes its objects, then the row.
    DELETING = "deleting"


class File(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A private object in the bucket, owned by the server (ADR-0007). Clients refer to it by `id`
    only; `s3_key` is generated here and never returned."""

    __tablename__ = "files"
    __table_args__ = (
        # Target for composite FKs (building_id, file_id) from domain tables (ADR-0005).
        UniqueConstraint("building_id", "id"),
        # `ready` means "this version was checked": exactly the rows with a pinned version. A
        # `deleting` row keeps whatever it had.
        CheckConstraint(
            "status = 'deleting' OR (status = 'ready') = (s3_version_id IS NOT NULL)",
            name="version_iff_ready",
        ),
        CheckConstraint(
            "(attached_type IS NULL) = (attached_id IS NULL)", name="attachment_complete"
        ),
        CheckConstraint("attached_id IS NULL OR status = 'ready'", name="attached_only_when_ready"),
        CheckConstraint("size_bytes > 0", name="size_positive"),
        # `files.cleanup` (P3-04c): every file it may delete is unattached.
        Index(
            "ix_files_unattached_created_at",
            "created_at",
            postgresql_where="attached_id IS NULL",
        ),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    uploaded_by_user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
    purpose: Mapped[FilePurpose] = mapped_column(database_enum(FilePurpose, name="file_purpose"))
    # b/{building_id}/{purpose}/{file_id}: 2 + 36 + 1 + 17 + 1 + 36 characters today.
    s3_key: Mapped[str] = mapped_column(String(200), unique=True)
    # S3 allows version IDs up to 1024 bytes.
    s3_version_id: Mapped[str | None] = mapped_column(String(1024))
    content_type: Mapped[str] = mapped_column(String(100))
    size_bytes: Mapped[int] = mapped_column(BigInteger)
    original_name: Mapped[str] = mapped_column(String(255))
    status: Mapped[FileStatus] = mapped_column(database_enum(FileStatus, name="file_status"))
    # Set by `claim_file` (P3-04b): the record that owns the file, e.g. ("package", package.id).
    attached_type: Mapped[str | None] = mapped_column(String(40))
    attached_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
