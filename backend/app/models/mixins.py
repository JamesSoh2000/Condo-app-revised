from uuid import UUID
# built-in uuid requires python 3.14+ but this project is 3.12. So we need to install uuid6 package to use uuid7
from uuid6 import uuid7

from datetime import datetime
from sqlalchemy import Uuid,DateTime, func
from sqlalchemy.orm import Mapped, mapped_column

class UUIDPrimaryKeyMixin:
    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid7,
    )

class TimestampMixin:
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
    )

    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )