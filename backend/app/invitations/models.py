from datetime import datetime
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Uuid,
)
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.orm import Mapped, mapped_column

from app.memberships.enums import OccupancyRelationship, Role
from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum

_ROLE_VALUES = ", ".join(f"'{role.value}'" for role in Role)


class Invitation(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """An emailed offer to join a building with preassigned roles (P4-02a); accepted in P4-02b.

    Only the token's sha256 is stored; the token itself is in the email alone. The status is read
    from the timestamps (`app.invitations.service.status_of`): accepted, revoked, expired or pending.
    """

    __tablename__ = "invitations"
    __table_args__ = (
        # Composite, so the unit is in the invitation's building (ADR-0005). RESTRICT: units are
        # deactivated, not deleted.
        ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            ondelete="RESTRICT",
            name="fk_invitations_building_id_unit_id",
        ),
        # The enums here are non-native (`database_enum`), so an array of them is varchar[] with
        # its values checked here.
        CheckConstraint("cardinality(roles) > 0", name="roles_not_empty"),
        CheckConstraint(f"roles <@ ARRAY[{_ROLE_VALUES}]::varchar[]", name="roles_known"),
        CheckConstraint("(unit_id IS NULL) = (relationship IS NULL)", name="unit_with_relationship"),
        CheckConstraint("email = lower(email)", name="email_lowercase"),
        # The one-pending-per-email check in `create_invitation`.
        Index("ix_invitations_building_id_email", "building_id", "email"),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    email: Mapped[str] = mapped_column(String(254))
    roles: Mapped[list[str]] = mapped_column(ARRAY(String(32)))
    unit_id: Mapped[UUID | None] = mapped_column(Uuid(as_uuid=True))
    relationship: Mapped[OccupancyRelationship | None] = mapped_column(
        database_enum(OccupancyRelationship, name="relationship")
    )
    token_hash: Mapped[str] = mapped_column(String(64), unique=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True))
    accepted_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    accepted_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    revoked_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    created_by_user_id: Mapped[UUID] = mapped_column(ForeignKey("users.id", ondelete="RESTRICT"))
