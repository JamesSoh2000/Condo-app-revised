from datetime import datetime

from sqlalchemy import DateTime, Index, Integer, String
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base


class RateLimit(Base):
    """One fixed window's attempt count for one key (P2-05). Written only by
    `app.rate_limits.service.RateLimiter.hit`; old windows are deleted by
    `delete_expired_rate_limits`."""

    __tablename__ = "rate_limits"
    # Cleanup deletes by age across all keys.
    __table_args__ = (Index("ix_rate_limits_window_start", "window_start"),)

    # `login:ip:<ip or /64>` or `login:email:<sha256 hex>`: never a raw email.
    key: Mapped[str] = mapped_column(String(200), primary_key=True)
    window_start: Mapped[datetime] = mapped_column(DateTime(timezone=True), primary_key=True)
    count: Mapped[int] = mapped_column(Integer)
