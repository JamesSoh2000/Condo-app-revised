from datetime import datetime
from uuid import UUID

from sqlalchemy import CheckConstraint, DateTime, ForeignKey, Index, String, func, text
from sqlalchemy.dialects.postgresql import INET
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.mixins import UUIDPrimaryKeyMixin
from app.users.models import User


class AuthSession(UUIDPrimaryKeyMixin, Base):
    """A login (ADR-0003). The cookie holds a random token; this row holds only its sha256.

    Valid while `revoked_at` is NULL and the clock is before both `expires_at` (absolute) and
    `idle_expires_at` (moved forward by activity). Write it through `app.auth.service`.
    """

    __tablename__ = "sessions"
    __table_args__ = (
        # Only a hash fits: a raw token (43 URL-safe characters) can't be stored by mistake.
        CheckConstraint("token_hash ~ '^[0-9a-f]{64}$'", name="token_hash_is_sha256_hex"),
        # A user's live sessions (P2-02 lists and revokes them).
        Index("ix_sessions_user_id_live", "user_id", postgresql_where=text("revoked_at IS NULL")),
    )

    # CASCADE: a session is a credential, not history. Users are deactivated, not deleted (P1-02).
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="CASCADE"))
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    last_seen_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    idle_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    user_agent: Mapped[str | None] = mapped_column(String(300))
    ip: Mapped[str | None] = mapped_column(INET)

    # For flush order only (users before their sessions), as on BuildingMembership.
    user: Mapped[User] = relationship(lazy="raise")
