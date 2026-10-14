from datetime import datetime
from uuid import UUID, uuid4

from sqlalchemy import Boolean, DateTime, ForeignKey, Index, Integer, String, UniqueConstraint, func
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

# Current version
class Unit(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    ...




# Older version
# class Unit(Base):
#     __tablename__ = "units"
#     __table_args__ = (
#         UniqueConstraint("building_id", "tower", "unit_number", name="uq_units_building_id_tower_unit_number"),
#         Index("ix_units_building_id", "building_id"),
#         Index("ix_units_building_id_tower", "building_id", "tower"),
#     )

#     id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
#     building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="CASCADE"), nullable=False)
#     unit_number: Mapped[str] = mapped_column(String(50), nullable=False)
#     tower: Mapped[str | None] = mapped_column(String(50), nullable=True)
#     floor: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     is_active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
#     created_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), nullable=False)
#     updated_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now(), onupdate=func.now(), nullable=False)
    

#     building = relationship("Building")