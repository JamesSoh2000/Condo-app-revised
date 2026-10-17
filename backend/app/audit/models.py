from datetime import datetime
from typing import Any
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, Index, String, Uuid, func, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.mixins import UUIDPrimaryKeyMixin


class AuditEvent(UUIDPrimaryKeyMixin, Base):
    """Who did what, when (P2-04). Append-only: write it with `app.audit.service.record_audit`;
    nothing updates or deletes one (fitness test 5 in tests/test_architecture.py)."""

    __tablename__ = "audit_events"
    __table_args__ = (
        Index("ix_audit_events_building_id_created_at", "building_id", text("created_at DESC")),
        Index("ix_audit_events_entity_type_entity_id", "entity_type", "entity_id"),
        Index("ix_audit_events_actor_user_id_created_at", "actor_user_id", text("created_at DESC")),
    )

    # Null for identity events (login, logout), which belong to no building.
    building_id: Mapped[UUID | None] = mapped_column(ForeignKey("buildings.id"))
    # Null for the system, an operator, or a login that matched no one.
    actor_user_id: Mapped[UUID | None] = mapped_column(ForeignKey("users.id"))
    action: Mapped[str] = mapped_column(String(64))
    entity_type: Mapped[str] = mapped_column(String(40))
    entity_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    # As long as RequestLoggingMiddleware lets a client's X-Request-ID be; null outside a request.
    request_id: Mapped[str | None] = mapped_column(String(128))
    # `metadata` is taken on declarative classes, hence the attribute name.
    metadata_: Mapped[dict[str, Any]] = mapped_column(
        "metadata", JSONB, server_default=text("'{}'::jsonb")
    )
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
