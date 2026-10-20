from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import BeforeValidator, StringConstraints

from app.core.schemas import APIModel, InputModel
from app.memberships.enums import MembershipStatus, OccupancyRelationship
from app.onboarding.models import OnboardingStatus
from app.units.schemas import printable_before_strip


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


class OnboardingDecisionIn(InputModel):
    """A denial's reason, which the resident sees (`/onboarding/me`, the notification and email)."""

    # `onboarding_requests.decision_reason` is varchar(500). No control characters, checked before
    # the strip (tests/test_architecture.py, fitness test 6).
    reason: Annotated[
        str,
        StringConstraints(strip_whitespace=True, min_length=3, max_length=500),
        BeforeValidator(printable_before_strip),
    ]


class OnboardingRequestManagerOut(APIModel):
    """A join request as property management sees it: who asked, for which unit, the decision."""

    id: UUID
    full_name: str
    email: str
    unit_id: UUID
    unit_label: str
    tower: str | None
    relationship: OccupancyRelationship
    status: OnboardingStatus
    submitted_at: datetime
    # Null while pending.
    decided_at: datetime | None
    # A denial's reason; null otherwise.
    decision_reason: str | None


class OnboardingSummary(APIModel):
    """What the pending list shows, counted (the managers' badge)."""

    pending_onboarding_count: int
