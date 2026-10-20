from datetime import datetime
from enum import StrEnum
from typing import Annotated, Self
from uuid import UUID

from pydantic import AfterValidator, Field, StringConstraints, model_validator
from pydantic_core import PydanticCustomError

from app.core.config import MAX_EMAIL_ADDRESS_LENGTH, is_email_address
from app.core.schemas import APIModel, InputModel
from app.core.security import PASSWORD_MAX_LENGTH
from app.memberships.enums import OccupancyRelationship, Role
from app.units.schemas import printable


class InvitationStatus(StrEnum):
    """Read from the timestamps, not stored (`app.invitations.service.status_of`)."""

    PENDING = "pending"
    ACCEPTED = "accepted"
    REVOKED = "revoked"
    EXPIRED = "expired"


def _email(value: str) -> str:
    # One bare ASCII address `queue_email` will send to (P3-02), so the length limits are octets
    # and no NUL or lone surrogate reaches the database. Not stripped: a padded address is refused,
    # not silently changed (the P1-02 carry). Lowered once, here, as `users.email` is.
    if not is_email_address(value):
        raise PydanticCustomError("email_address", "must be one email address")
    return value.lower()


InvitationEmail = Annotated[
    str,
    StringConstraints(strip_whitespace=False, min_length=1, max_length=MAX_EMAIL_ADDRESS_LENGTH),
    AfterValidator(_email),
]


def _distinct_roles(roles: list[Role]) -> list[Role]:
    return sorted(set(roles))


class InvitationCreate(InputModel):
    email: InvitationEmail
    roles: Annotated[list[Role], Field(min_length=1, max_length=8), AfterValidator(_distinct_roles)]
    # A pre-approved resident's unit and how they relate to it: both or neither.
    unit_id: UUID | None = None
    relationship: OccupancyRelationship | None = None

    @model_validator(mode="after")
    def _unit_for_a_resident(self) -> Self:
        if (self.unit_id is None) != (self.relationship is None):
            raise PydanticCustomError(
                "unit_with_relationship", "unit_id and relationship go together"
            )
        if self.unit_id is not None and Role.RESIDENT not in self.roles:
            # An occupancy belongs to a resident membership (ADR-0010).
            raise PydanticCustomError("unit_needs_resident", "a unit needs the resident role")
        return self


class InvitationOut(APIModel):
    """Never the token or its hash: the token exists only in the email."""

    id: UUID
    email: str
    roles: list[Role]
    unit_id: UUID | None
    relationship: OccupancyRelationship | None
    status: InvitationStatus
    expires_at: datetime
    created_at: datetime


class InvitationPublicOut(APIModel):
    """What the invitee sees before accepting: never the token, its hash, ids or the full email."""

    building_name: str
    email_masked: str
    roles: list[Role]


class InvitationAccept(InputModel):
    """Both fields are for a new account only; an existing account's are ignored. No roles: they
    come from the invitation (extra fields are a 422)."""

    # `users.full_name` is varchar(200). Stripped, and no control characters (NUL fails at flush).
    full_name: (
        Annotated[
            str,
            StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
            AfterValidator(printable),
        ]
        | None
    ) = None
    # Not stripped, as `app.auth.schemas.LoginIn::password`; the policy runs in the service.
    password: (
        Annotated[str, StringConstraints(strip_whitespace=False, max_length=PASSWORD_MAX_LENGTH)]
        | None
    ) = None


class InvitationAcceptedOut(APIModel):
    building_id: UUID
    membership_id: UUID
    roles: list[Role]
