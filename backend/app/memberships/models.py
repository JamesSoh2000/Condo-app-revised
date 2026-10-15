from datetime import datetime
from uuid import UUID

from sqlalchemy import DateTime, ForeignKey, ForeignKeyConstraint, UniqueConstraint, Uuid, func
from sqlalchemy.orm import Mapped, mapped_column

from app.memberships.enums import MembershipStatus, Role
from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum


class BuildingMembership(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A user's place in one building: its status there and, through `membership_roles`, roles."""

    __tablename__ = "building_memberships"
    __table_args__ = (
        UniqueConstraint("building_id", "user_id"),
        # Target for composite FKs (building_id, membership_id) from tenant tables (ADR-0005).
        UniqueConstraint("building_id", "id"),
    )

    # RESTRICT: memberships carry history (occupancies, packages, audit), so users and buildings
    # are deactivated, not deleted.
    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"), index=True)
    status: Mapped[MembershipStatus] = mapped_column(
        database_enum(MembershipStatus, name="status"),
        default=MembershipStatus.PENDING,
        server_default=MembershipStatus.PENDING.value,
    )
    status_changed_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), server_default=func.now()
    )
    status_changed_by_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )


class MembershipRole(TimestampMixin, Base):
    __tablename__ = "membership_roles"
    __table_args__ = (
        # Composite, so a role can't name a membership in another building (ADR-0005). ON UPDATE
        # stays NO ACTION: a membership with roles can't be moved to another building either.
        ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            ondelete="CASCADE",
            name="fk_membership_roles_building_id_membership_id",
        ),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True), primary_key=True)
    role: Mapped[Role] = mapped_column(database_enum(Role, name="role"), primary_key=True)
