from datetime import datetime
from uuid import UUID

from app.core.schemas import APIModel


class NotificationOut(APIModel):
    id: UUID
    kind: str
    title: str
    body: str
    # An app path to open; null when there is nothing to open.
    link: str | None
    entity_type: str | None
    entity_id: UUID | None
    # Null while unread.
    read_at: datetime | None
    created_at: datetime


class NotificationSummary(APIModel):
    unread_count: int
