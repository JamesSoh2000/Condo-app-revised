from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    UniqueConstraint,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, query_expression

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum
from app.notices.enums import NoticePriority, NoticeStatus

# The `attached_type` of a notice's attachment (`app.files.service.claim_file`,
# `app.notices.attachments`).
NOTICE_ATTACHED_TYPE = "notice"

_PUBLISH_COLUMNS = ("published_at", "published_by_membership_id")
_ARCHIVE_COLUMNS = ("archived_at", "archived_by_membership_id")


def _all(columns: tuple[str, ...], test: str) -> str:
    return " AND ".join(f"{column} {test}" for column in columns)


def _composite_fk(column: str, table: str) -> ForeignKeyConstraint:
    # Composite, so the referenced row is in the notice's building (ADR-0005). RESTRICT: notices
    # are history, so what they name isn't deleted.
    return ForeignKeyConstraint(
        ["building_id", column],
        [f"{table}.building_id", f"{table}.id"],
        ondelete="RESTRICT",
        name=f"fk_notices_building_id_{column}",
    )


class Notice(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A building notice written by the manager (P6-01a). Read it through `visible_notices(ctx)`.

    Each status's columns belong to it: a `draft` has no publish or archive columns, a `published`
    one its publisher and no archive columns, an `archived` one its archiver, and its publish
    columns only if it was published first (the checks below).
    """

    __tablename__ = "notices"
    __table_args__ = (
        _composite_fk("attachment_file_id", "files"),
        _composite_fk("author_membership_id", "building_memberships"),
        _composite_fk("published_by_membership_id", "building_memberships"),
        _composite_fk("archived_by_membership_id", "building_memberships"),
        # The target of P6-01c's composite FK from `notice_reads` (ADR-0005).
        UniqueConstraint("building_id", "id"),
        CheckConstraint(
            f"status <> 'draft' OR ({_all(_PUBLISH_COLUMNS + _ARCHIVE_COLUMNS, 'IS NULL')})",
            name="draft_state",
        ),
        CheckConstraint(
            f"status <> 'published' OR ({_all(_PUBLISH_COLUMNS, 'IS NOT NULL')}"
            f" AND {_all(_ARCHIVE_COLUMNS, 'IS NULL')})",
            name="published_state",
        ),
        CheckConstraint(
            f"status <> 'archived' OR ({_all(_ARCHIVE_COLUMNS, 'IS NOT NULL')}"
            " AND (published_at IS NULL) = (published_by_membership_id IS NULL))",
            name="archived_state",
        ),
        CheckConstraint("expires_at > published_at", name="expires_after_published"),
        CheckConstraint("archived_at >= published_at", name="archived_after_published"),
        # The API strips its strings, so `''` would otherwise pass the NOT NULLs (the P5-01 carry).
        CheckConstraint("btrim(title) <> ''", name="title_not_blank"),
        CheckConstraint("btrim(body, E' \\t\\n\\r') <> ''", name="body_not_blank"),
        # The lists by status, newest first: `paginate` orders by id (P6-01b, P6-01c).
        Index("ix_notices_building_id_status_id", "building_id", "status", text("id DESC")),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    title: Mapped[str] = mapped_column(String(200))
    # Markdown; P6-02 renders it without raw HTML.
    body: Mapped[str] = mapped_column(String(10_000))
    priority: Mapped[NoticePriority] = mapped_column(
        database_enum(NoticePriority, name="notice_priority")
    )
    status: Mapped[NoticeStatus] = mapped_column(database_enum(NoticeStatus, name="notice_status"))
    # Optional; after it, `visible_notices` hides the notice from everyone but the manager.
    expires_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    # A PDF or image of purpose `notice_attachment`, downloaded through the files API (ADR-0007).
    attachment_file_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    author_membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    published_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    published_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    archived_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    archived_by_membership_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    # The caller's `notice_reads.read_at`, loaded only by `with_expression` (P6-01c), else None.
    read_at: Mapped[datetime | None] = query_expression()


class NoticeRead(Base):
    """A member's "I've read it" for one notice (P6-01c): written once, by `INSERT … ON CONFLICT DO
    NOTHING`, so the first `read_at` stays. It belongs to a membership, not a user: a member of two
    buildings reads each building's notices as that building's member."""

    __tablename__ = "notice_reads"
    __table_args__ = (
        ForeignKeyConstraint(
            ["building_id", "notice_id"],
            ["notices.building_id", "notices.id"],
            ondelete="RESTRICT",
        ),
        ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            ondelete="RESTRICT",
        ),
    )

    # The primary key's order serves "this notice's reads"; the summary's anti-join looks up
    # (notice, the caller's membership), which it also serves.
    notice_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    read_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=text("now()"))
