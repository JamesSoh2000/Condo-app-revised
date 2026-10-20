from datetime import datetime
from enum import StrEnum
from uuid import UUID

from sqlalchemy import (
    CheckConstraint,
    DateTime,
    ForeignKey,
    ForeignKeyConstraint,
    Index,
    String,
    Uuid,
    text,
)
from sqlalchemy.orm import Mapped, mapped_column

from app.memberships.enums import OccupancyRelationship
from app.models.base import Base
from app.models.mixins import TimestampMixin, UUIDPrimaryKeyMixin
from app.models.types import database_enum


class OnboardingStatus(StrEnum):
    """Where a resident's join request stands (`onboarding_requests.status`)."""

    PENDING = "pending"
    APPROVED = "approved"
    DENIED = "denied"


class OnboardingRequest(UUIDPrimaryKeyMixin, TimestampMixin, Base):
    """A resident's request, through the building's join link, to live in a unit (P4-05).

    Submitted with the membership `pending` (P4-05a); a manager approves or denies it (P4-05b).
    Rows are history: a resubmission after a denial adds a new one. `created_at` is when it was
    submitted.
    """

    __tablename__ = "onboarding_requests"
    __table_args__ = (
        # Composite, so the membership and the unit are both in the request's building (ADR-0005).
        # RESTRICT: neither is deleted while it has history.
        ForeignKeyConstraint(
            ["building_id", "membership_id"],
            ["building_memberships.building_id", "building_memberships.id"],
            ondelete="RESTRICT",
            name="fk_onboarding_requests_building_id_membership_id",
        ),
        ForeignKeyConstraint(
            ["building_id", "unit_id"],
            ["units.building_id", "units.id"],
            ondelete="RESTRICT",
            name="fk_onboarding_requests_building_id_unit_id",
        ),
        CheckConstraint(
            "(status = 'pending') = (decided_at IS NULL)", name="decided_when_not_pending"
        ),
        CheckConstraint(
            "decision_reason IS NULL OR status = 'denied'", name="reason_only_when_denied"
        ),
        # At most one pending request per membership: a second submission returns it instead.
        Index(
            "uq_onboarding_requests_pending_membership",
            "membership_id",
            unique=True,
            postgresql_where=text("status = 'pending'"),
        ),
        # A membership's latest request (`/onboarding/me`).
        Index("ix_onboarding_requests_membership_id_id", "membership_id", "id"),
        # The managers' list by status, newest first (P4-05b).
        Index("ix_onboarding_requests_building_id_status_id", "building_id", "status", "id"),
    )

    building_id: Mapped[UUID] = mapped_column(ForeignKey("buildings.id", ondelete="RESTRICT"))
    membership_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    unit_id: Mapped[UUID] = mapped_column(Uuid(as_uuid=True))
    relationship: Mapped[OccupancyRelationship] = mapped_column(
        database_enum(OccupancyRelationship, name="relationship")
    )
    status: Mapped[OnboardingStatus] = mapped_column(
        database_enum(OnboardingStatus, name="onboarding_status"),
        default=OnboardingStatus.PENDING,
        server_default=OnboardingStatus.PENDING.value,
    )
    decided_by_user_id: Mapped[UUID | None] = mapped_column(
        ForeignKey("users.id", ondelete="RESTRICT")
    )
    decided_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True))
    decision_reason: Mapped[str | None] = mapped_column(String(500))
