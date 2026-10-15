from uuid import UUID

from sqlalchemy import Boolean, ForeignKey, Integer, String, UniqueConstraint, text
from sqlalchemy.orm import Mapped, mapped_column

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin


class Unit(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    __tablename__ = "units"
    __table_args__ = (
        # Target for composite FKs (building_id, unit_id) from tenant tables (ADR-0005).
        UniqueConstraint("building_id", "id"),
        # NULLS NOT DISTINCT: without it, two (NULL, '101') units in one building would both fit.
        UniqueConstraint("building_id", "tower", "label", postgresql_nulls_not_distinct=True),
    )

    # RESTRICT: units carry history (occupancies, packages), so a building with units isn't deleted.
    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    tower: Mapped[str | None] = mapped_column(String(20))
    label: Mapped[str] = mapped_column(String(20))
    floor: Mapped[int | None] = mapped_column(Integer)
    is_active: Mapped[bool] = mapped_column(Boolean, default=True, server_default=text("true"))
