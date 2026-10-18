from typing import Any
from uuid import UUID, uuid7

from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings.models import Building
from app.notifications.models import Notification


async def make_notification(
    db: AsyncSession, building: Building, user_id: UUID, **overrides: Any
) -> Notification:
    """One notification row, flushed; later calls get later (larger) uuid7 ids."""
    values: dict[str, Any] = {
        "id": uuid7(),
        "building_id": building.id,
        "recipient_user_id": user_id,
        "kind": "package.arrived",
        "title": "A package arrived",
        "body": "At the front desk.",
        "link": "/packages",
    }
    notification = Notification(**(values | overrides))
    db.add(notification)
    await db.flush()
    return notification
