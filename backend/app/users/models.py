from datetime import datetime

from sqlalchemy import Boolean, DateTime, Index, String, func, text
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class User(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A person, across buildings. Roles live on their memberships, never here (ADR-0004)."""

    __tablename__ = "users"

    email: Mapped[str] = mapped_column(String(320))
    # NULL until the user sets one (invitation accept, password reset); until then, no login.
    password_hash: Mapped[str | None] = mapped_column(String(255))
    full_name: Mapped[str] = mapped_column(String(200))
    phone: Mapped[str | None] = mapped_column(String(32))
    locale: Mapped[str] = mapped_column(String(10), default="en", server_default="en")
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    email_verified_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    @validates("email")
    def _lower_email(self, _key: str, value: str) -> str:
        # Pydantic's EmailStr lower-cases only the domain, so the model does the whole address.
        return value.lower()


# Case-insensitive uniqueness, also for rows written without the model. Look users up with
# `func.lower(User.email) == ...` so the query can use this index.
Index("uq_users_lower_email", func.lower(User.email), unique=True)
