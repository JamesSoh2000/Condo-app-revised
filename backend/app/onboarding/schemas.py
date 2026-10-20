from datetime import datetime
from uuid import UUID

from app.core.schemas import APIModel, InputModel
from app.memberships.enums import MembershipStatus, OccupancyRelationship
from app.onboarding.models import OnboardingStatus


class JoinBuildingOut(APIModel):
    """What the join link shows before signup: the building's name, nothing about its people."""

    building_id: UUID
    building_name: str


class JoinRequestCreate(InputModel):
    """No role or status: a join request is always for a `pending` resident (extra fields are a
    422)."""

    unit_id: UUID
    relationship: OccupancyRelationship


class OnboardingRequestOut(APIModel):
    id: UUID
    building_id: UUID
    status: OnboardingStatus
    unit_id: UUID
    unit_label: str
    tower: str | None
    relationship: OccupancyRelationship
    submitted_at: datetime


class OnboardingMeOut(APIModel):
    """The caller's membership status, and the unit, relationship and decision reason of their
    latest join request; the request fields are null when there is none (an invited member)."""

    status: MembershipStatus
    unit_label: str | None
    tower: str | None
    relationship: OccupancyRelationship | None
    decision_reason: str | None
