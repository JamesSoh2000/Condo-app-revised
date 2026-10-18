from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Uuid,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class Notification(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """One in-app notification for one recipient in one building. Written by
    `app.notifications.service.notify`; read and marked read only by its recipient."""

    __tablename__ = "notifications"
    __table_args__ = (
        # The recipient has a membership in this building, of any status: a denied applicant is
        # still told (ADR-0005). Memberships aren't deleted, so RESTRICT never fires in practice.
        ForeignKeyConstraint(
            ["building_id", "recipient_user_id"],
            ["building_memberships.building_id", "building_memberships.user_id"],
            ondelete="RESTRICT",
            name="fk_notifications_building_id_recipient_user_id",
        ),
        CheckConstraint("(entity_type IS NULL) = (entity_id IS NULL)", name="entity_complete"),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    recipient_user_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    # A name from `app.notifications.kinds.KINDS`.
    kind: Mapped[str] = mapped_column(String(64))
    title: Mapped[str] = mapped_column(String(200))
    body: Mapped[str] = mapped_column(String(1000))
    # An app path ("/packages"), never a full URL; the email adds APP_BASE_URL.
    link: Mapped[str | None] = mapped_column(String(300))
    # What it is about, e.g. ("package", package.id); both or neither.
    entity_type: Mapped[str | None] = mapped_column(String(40))
    entity_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    read_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))


# The list (with or without `unread_only`), the unread count and read-all: one user's rows in one
# building, newest first.
Index(
    "ix_notifications_recipient_user_id_building_id_read_at_id",
    Notification.recipient_user_id,
    Notification.building_id,
    Notification.read_at,
    Notification.id.desc(),
)
