from datetime import datetime
from typing import Annotated, Any
from uuid import UUID

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints, field_validator
from pydantic_core import PydanticCustomError

from app.core.schemas import APIModel, EmailAddress, InputModel
from app.core.security import PASSWORD_MAX_LENGTH
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.units.schemas import printable


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


def _storable(value: str) -> str:
    # Postgres text can't hold NUL or a lone surrogate: a lookup would fail with a 500 (CLAUDE.md
    # lesson). Rejecting them depends on the input only, never on an account.
    if "\x00" in value:
        raise ValueError("must not contain NUL characters")
    try:
        value.encode()
    except UnicodeEncodeError:
        raise ValueError("must be valid Unicode") from None
    return value


class PasswordResetRequestIn(InputModel):
    # A plain string, as LoginIn: a malformed address is an unknown one, with the same 202.
    email: str = Field(min_length=1, max_length=320)

    _email_storable = field_validator("email")(_storable)


def password_not_too_long(password: str) -> str:
    """For a password a new account sets. The policy's own error type, not pydantic's
    `string_too_long`, so a client sees one set of password errors (P4-02b review round 1, F4);
    checked in the schema so no over-long value reaches argon2. The rest of the policy is the
    service's (`check_password_policy`)."""
    if len(password) > PASSWORD_MAX_LENGTH:
        raise PydanticCustomError("password_too_long", "must be at most 128 characters")
    return password


def _printable_before_strip(value: Any) -> Any:
    # Before the strip: a control character at either end (`"Rosa\n"`) would otherwise be stripped,
    # not refused (P4-05a review round 1, F3). A non-string is left to the type check.
    return printable(value) if isinstance(value, str) else value


# A person's name as a new account stores it: `users.full_name` is varchar(200). No control
# characters anywhere (NUL fails at flush), then stripped.
FullName = Annotated[
    str,
    BeforeValidator(_printable_before_strip),
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
]


class SignupIn(InputModel):
    email: EmailAddress
    full_name: FullName
    # Not stripped, as LoginIn.
    password: Annotated[
        str, StringConstraints(strip_whitespace=False), AfterValidator(password_not_too_long)
    ]


class PasswordResetRequestedOut(APIModel):
    detail: str


class PasswordResetConfirmIn(InputModel):
    # Any short string: one of the wrong shape is an invalid token (400), as an unknown one is.
    token: str = Field(max_length=200)
    # Not stripped, as LoginIn; the policy (12-128 characters, not common) is the service's.
    new_password: Annotated[
        str,
        StringConstraints(strip_whitespace=False, min_length=1, max_length=PASSWORD_MAX_LENGTH),
    ]


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
