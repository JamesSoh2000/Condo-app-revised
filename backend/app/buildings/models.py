from typing import Any
from uuid import UUID

from sqlalchemy import Boolean, CheckConstraint, ForeignKey, String, Text, text
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, validates

from app.buildings.enums import Feature
from app.core.time import validate_timezone
from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum


class Building(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "buildings"
    __table_args__ = (CheckConstraint("slug ~ '^[a-z0-9-]+$'", name="slug_format"),)

    slug: Mapped[str] = mapped_column(String(63), unique=True)
    name: Mapped[str] = mapped_column(String(200))
    address: Mapped[str] = mapped_column(Text)
    # IANA name, checked in Python (validate_timezone): the tz database lives on the app host, not in a
    # constraint.
    timezone: Mapped[str] = mapped_column(String(64))
    locale: Mapped[str] = mapped_column(String(10), default="en", server_default="en")
    # NULL disables resident self-join.
    join_code: Mapped[str | None] = mapped_column(String(16), unique=True)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))

    @validates("timezone")
    def _validate_timezone(self, _key: str, value: str) -> str:
        return validate_timezone(value)


class BuildingFeature(TimestampMixin, Base):
    __tablename__ = "building_features"

    # Features go with their building: they are settings, not records anyone needs afterwards.
    building_id: Mapped[UUID] = mapped_column(
        ForeignKey("buildings.id", ondelete="CASCADE"), primary_key=True
    )
    feature: Mapped[Feature] = mapped_column(database_enum(Feature, name="feature"), primary_key=True)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
    config: Mapped[dict[str, Any]] = mapped_column(
        JSONB, default=dict, server_default=text("'{}'::jsonb")
    )
