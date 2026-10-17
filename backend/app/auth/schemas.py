from datetime import datetime
from typing import Annotated
from uuid import UUID

from pydantic import Field, StringConstraints, field_validator

from app.core.schemas import APIModel, InputModel
from app.core.security import PASSWORD_MAX_LENGTH
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role


class LoginIn(InputModel):
    # A plain string: a malformed email is an unknown one (401), not a 422 that tells it apart.
    email: str = Field(min_length=1, max_length=320)
    # Not stripped (InputModel strips strings): spaces are part of a password. Capped before it
    # reaches argon2; no password over the policy's maximum can have been set.
    password: Annotated[
        str,
        StringConstraints(strip_whitespace=False, min_length=1, max_length=PASSWORD_MAX_LENGTH),
    ]

    @field_validator("email")
    @classmethod
    def _no_nul(cls, email: str) -> str:
        # Postgres text can't hold NUL: the lookup would fail with a 500 (P2-01b review round 1).
        if "\x00" in email:
            raise ValueError("must not contain NUL characters")
        return email


# Responses. Built field by field from the rows the service selects: never from a User or
# AuthSession, so password_hash, token_hash and ip can't reach a response.


class MeUserOut(APIModel):
    id: UUID
    email: str
    full_name: str
    phone: str | None
    locale: str


class MeBuildingOut(APIModel):
    id: UUID
    name: str
    slug: str
    timezone: str
    locale: str


class MeOccupancyOut(APIModel):
    unit_id: UUID
    unit_label: str
    tower: str | None
    relationship: OccupancyRelationship


class MeMembershipOut(APIModel):
    membership_id: UUID
    status: MembershipStatus
    roles: list[Role]
    building: MeBuildingOut
    occupancy: MeOccupancyOut | None


class MeOut(APIModel):
    user: MeUserOut
    memberships: list[MeMembershipOut]


class SessionOut(APIModel):
    id: UUID
    created_at: datetime
    last_seen_at: datetime
    user_agent: str | None
    current: bool
