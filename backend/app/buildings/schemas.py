import json
from typing import Annotated
from uuid import UUID

from pydantic import AfterValidator, BeforeValidator, StringConstraints
from pydantic_core import PydanticCustomError

from app.audit.service import MAX_VALUE_BYTES
from app.buildings.enums import Feature
from app.core.schemas import APIModel, InputModel
from app.core.time import validate_timezone
from app.email.templates import SUPPORTED_LOCALES
from app.invitations.schemas import InvitationEmail
from app.memberships.enums import Role
from app.units.schemas import printable_before_strip


class BuildingOut(APIModel):
    """A building as its member sees it: the caller's roles there and its enabled features."""

    id: UUID
    name: str
    slug: str
    timezone: str
    locale: str
    my_roles: list[Role]
    features: list[Feature]


def _timezone(value: str) -> str:
    try:
        return validate_timezone(value)
    except ValueError:
        # Not the value: it is untrusted terminal input.
        raise PydanticCustomError("timezone", "must be an IANA timezone name") from None


def _locale(value: str) -> str:
    if value not in SUPPORTED_LOCALES:
        raise PydanticCustomError("locale", "must be " + " or ".join(SUPPORTED_LOCALES))
    return value


def _distinct_features(features: list[Feature]) -> list[Feature]:
    if len(set(features)) != len(features):
        raise PydanticCustomError("repeated_feature", "names a feature twice")
    return sorted(features)


def _fits_audit_value(value: str) -> str:
    # `record_audit` measures a metadata value as JSON (ensure_ascii=False) in UTF-8 bytes: a
    # reason it would refuse must fail here, before any write, not after (review round 1, F2).
    if len(json.dumps(value, ensure_ascii=False).encode()) > MAX_VALUE_BYTES:
        raise PydanticCustomError(
            "too_long", "must be at most {limit} bytes", {"limit": MAX_VALUE_BYTES}
        )
    return value


def _stripped(max_length: int) -> StringConstraints:
    return StringConstraints(strip_whitespace=True, min_length=1, max_length=max_length)


# The column lengths (`buildings.name` is varchar(200)); `address` is text, capped here. Control
# characters are refused before the strip (`printable_before_strip`).
_printable = BeforeValidator(printable_before_strip)
Name = Annotated[str, _stripped(200), _printable]
LongText = Annotated[str, _stripped(500), _printable]
Operator = Annotated[str, _stripped(64), _printable]


class BootstrapInput(InputModel):
    """`bootstrap-building`'s options (P4-03), checked before any database session."""

    # `ck_buildings_slug_format` and the column's length.
    slug: Annotated[str, StringConstraints(pattern=r"^[a-z0-9-]+$", min_length=1, max_length=63)]
    name: Name
    address: LongText
    timezone: Annotated[str, StringConstraints(max_length=64), AfterValidator(_timezone)]
    locale: Annotated[str, AfterValidator(_locale)] = "en"
    features: Annotated[list[Feature], AfterValidator(_distinct_features)]
    manager_email: InvitationEmail
    # Shown in the plan and summary only: invitations store no name (P4-03 F7).
    manager_name: Name | None = None
    # The operator's own words and name, for the audit event; `record_audit` caps a value at 1 KiB.
    reason: Annotated[LongText, AfterValidator(_fits_audit_value)]
    operator: Operator
