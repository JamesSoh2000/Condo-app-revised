from datetime import date, datetime
from decimal import Decimal
from uuid import UUID, uuid4

from sqlalchemy import Boolean, Date, DateTime, ForeignKey, Index, Integer, Numeric, String, Text, func
from sqlalchemy.dialects.postgresql import JSONB
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin

# current version
class Building(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    ...

class BuildingFeature(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    ...



# Older version
# class Building(Base):
#     __tablename__ = "buildings"

#     id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
#     name: Mapped[str] = mapped_column(String(255), nullable=False)
#     address: Mapped[str] = mapped_column(Text, nullable=False)
#     registration_number: Mapped[str] = mapped_column(String(100), nullable=False)
#     number_of_units: Mapped[int] = mapped_column(Integer, nullable=False)
#     total_units_sqft: Mapped[Decimal | None] = mapped_column(Numeric(12, 2), nullable=True)
#     fiscal_year_start: Mapped[date] = mapped_column(Date, nullable=False)
#     contact_email: Mapped[str | None] = mapped_column(String(255), nullable=True)
#     contact_phone: Mapped[str | None] = mapped_column(String(50), nullable=True)
#     date_created: Mapped[datetime] = mapped_column(
#         DateTime(timezone=True),
#         server_default=func.now(),
#         nullable=False,
#     )

#     features: Mapped[list["BuildingFeature"]] = relationship(
#         back_populates="building",
#         cascade="all, delete-orphan",
#     )


# class BuildingFeature(Base):
#     __tablename__ = "building_features"
#     __table_args__ = (
#         Index("ix_building_features_building_id", "building_id"),
#     )

#     id: Mapped[UUID] = mapped_column(primary_key=True, default=uuid4)
#     building_id: Mapped[UUID] = mapped_column(
#         ForeignKey("buildings.id", ondelete="CASCADE"),
#         nullable=False,
#     )

#     type: Mapped[str] = mapped_column(String(50), nullable=False)
#     name: Mapped[str] = mapped_column(String(255), nullable=False)
#     description_rules: Mapped[str | None] = mapped_column(Text, nullable=True)
#     photo_url: Mapped[str | None] = mapped_column(Text, nullable=True)
#     active: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)

#     booking_mode: Mapped[str] = mapped_column(String(50), nullable=False)
#     min_block: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     max_block: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     slot_length: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     buffer_mins: Mapped[int | None] = mapped_column(Integer, nullable=True)

#     day_hours: Mapped[dict] = mapped_column(JSONB, nullable=False)
#     blackouts: Mapped[list | None] = mapped_column(JSONB, nullable=True)
    
#     advance_notice_hours: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     horizon_days: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     per_unit_cap: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     cap_window: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     concurrent: Mapped[int] = mapped_column(Integer, nullable=False, default=1)

#     pricing_mode: Mapped[str] = mapped_column(String(50), nullable=False)
#     cost: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
#     guest_fee: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
#     deposit_amount: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)
#     deposit_refundable: Mapped[bool | None] = mapped_column(Boolean, nullable=True)

#     approval_required: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
#     notify: Mapped[str] = mapped_column(String(50), nullable=False)
#     waiver: Mapped[bool] = mapped_column(Boolean, nullable=False, default=True)
#     waiver_text: Mapped[str | None] = mapped_column(Text, nullable=True)

#     guest_limit: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     cancel_cutoff_hours: Mapped[int | None] = mapped_column(Integer, nullable=True)
#     cancel_penalty: Mapped[Decimal | None] = mapped_column(Numeric(10, 2), nullable=True)

#     building: Mapped["Building"] = relationship(back_populates="features")

