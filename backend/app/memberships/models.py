from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    UniqueConstraint,
    Uuid,
    func,
    orm,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column, relationship

from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum
from app.units.models import Unit
from app.users.models import User


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

    # Declared so the unit of work orders a flush by these FKs: users before the memberships that
    # name them, roles deleted before their membership. Without relationships it orders tables by
    # class name. lazy="raise": load them explicitly; an implicit lazy load fails under asyncio.
    user: Mapped[User] = relationship(foreign_keys=[user_id], lazy="raise")
    status_changed_by: Mapped[User | None] = relationship(
        foreign_keys=[status_changed_by_user_id], lazy="raise"
    )
    # A role exists only as part of its membership: the ORM deletes loaded roles with it, and one
    # removed from `roles` (delete-orphan). passive_deletes leaves unloaded ones to the database's
    # cascade instead of loading them first.
    roles: Mapped[list[MembershipRole]] = relationship(
        cascade="all, delete-orphan", passive_deletes=True, lazy="raise"
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


class UnitOccupancy(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A membership's dated link to a unit (ADR-0010). Write it through `app.memberships.occupancy`.

    The window is half-open: the occupancy covers `started_at <= T < ended_at`, and is current while
    `ended_at` is NULL. Rows are history: they're ended, never deleted.
    """

    __tablename__ = "unit_occupancies"
    __table_args__ = (
        # Composite, so the unit and the membership are both in the occupancy's building (ADR-0005).
        # RESTRICT: occupied units and memberships with history aren't deleted. ON UPDATE stays NO
        # ACTION: neither can be moved to another building while it has occupancies.
        ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            ondelete="RESTRICT",
            name="fk_unit_occupancies_building_id_unit_id",
        ),
        ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            ondelete="RESTRICT",
            name="fk_unit_occupancies_building_id_membership_id",
        ),
        CheckConstraint("ended_at IS NULL OR ended_at >= started_at", name="ended_after_started"),
        # One current unit per membership. A plain unique constraint can't say "among current rows":
        # it would also forbid a second, ended row. Several current occupants per unit are fine.
        Index(
            "uq_unit_occupancies_current_membership",
            "membership_id",
            unique=True,
            postgresql_where=text("ended_at IS NULL"),
        ),
        # current_occupants(): a unit's current rows.
        Index(
            "ix_unit_occupancies_building_id_unit_id_ended_at", "building_id", "unit_id", "ended_at"
        ),
        # occupancy_window_clause(): one membership's rows for one unit; also the RESTRICT check.
        Index(
            "ix_unit_occupancies_membership_id_unit_id_started_at",
            "membership_id",
            "unit_id",
            "started_at",
        ),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    unit_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    relationship: Mapped[OccupancyRelationship] = mapped_column(
        database_enum(OccupancyRelationship, name="relationship")
    )
    # Timestamps, not dates, so the visibility window is exact (ADR-0010).
    started_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), server_default=func.now())
    ended_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))

    # For flush order only (units and memberships are inserted first), as on BuildingMembership.
    # `orm.relationship`: in this class body the bare name is the `relationship` column above. Both
    # copy building_id into this row; the composite FKs make the two agree, hence `overlaps`.
    unit: Mapped[Unit] = orm.relationship(lazy="raise", overlaps="membership")
    membership: Mapped[BuildingMembership] = orm.relationship(lazy="raise", overlaps="unit")
