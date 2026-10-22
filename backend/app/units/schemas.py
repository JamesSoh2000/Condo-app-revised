import unicodedata
from typing import Annotated, Any
from uuid import UUID

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints, field_validator
from pydantic.json_schema import SkipJsonSchema
from pydantic_core import PydanticCustomError

from app.core.schemas import APIModel, InputModel
from app.memberships.enums import OccupancyRelationship

MIN_FLOOR, MAX_FLOOR = -20, 300


def printable(value: str) -> str:
    """Refuse control characters. Postgres refuses NUL at flush, not here (CLAUDE.md lesson), and a
    tab or newline makes two labels that look alike. Pydantic itself refuses lone surrogates
    (`string_unicode`, or `json_invalid` in a body) before this runs."""
    if any(unicodedata.category(char) == "Cc" for char in value):
        raise PydanticCustomError("control_characters", "must not contain control characters")
    return value


def printable_before_strip(value: Any) -> Any:
    """`printable` for a stripped string, as a `BeforeValidator`: on the raw value, since the strip
    would remove a control character at either end (`"101\n"`) instead of refusing it (P3-04a,
    P4-05a; tests/test_architecture.py checks no input field runs `printable` after the strip). A
    non-string is left to the type check."""
    return printable(value) if isinstance(value, str) else value


def _blank_to_none(value: Any) -> Any:
    # A blank tower is no tower (and a CSV's empty cell, P4-01b, means the same). Checked first, so
    # a tab or newline isn't taken for blank.
    value = printable_before_strip(value)
    return None if isinstance(value, str) and not value.strip() else value


# The column lengths (`units.tower`, `units.label` are varchar(20)). Stripped, as InputModel strips.
# A BeforeValidator runs before everything to its left, so it comes last: the constraints keep the
# string's own messages, and the check still sees the value before the strip.
Label = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=20),
    BeforeValidator(printable_before_strip),
]
Tower = Annotated[Label | None, BeforeValidator(_blank_to_none)]
# Strict: lax mode would store `true` as floor 1 and accept "3" (review round 1, Codex).
Floor = Annotated[int, Field(strict=True, ge=MIN_FLOOR, le=MAX_FLOOR)]
# A query parameter that reaches a LIKE or an equality: the same characters a label may hold.
SearchText = Annotated[str, StringConstraints(max_length=20), AfterValidator(printable)]


class UnitCreate(InputModel):
    tower: Tower = None
    label: Label
    floor: Floor | None = None


class UnitUpdate(InputModel):
    """Only the fields sent change; `tower: null` and `floor: null` clear them."""

    tower: Tower = None
    # Optional, never null: SkipJsonSchema keeps the None default out of the OpenAPI schema (review
    # round 2, Codex), and the validator below refuses an explicit null.
    label: Label | SkipJsonSchema[None] = None
    floor: Floor | None = None

    @field_validator("label", mode="before")
    @classmethod
    def _label_is_required_when_sent(cls, value: Any) -> Any:
        # Not called when label is left out (defaults aren't validated): only an explicit null.
        if value is None:
            raise PydanticCustomError("label_required", "a unit needs a label")
        return value


class UnitOut(APIModel):
    id: UUID
    tower: str | None
    label: str
    floor: int | None
    is_active: bool
    # Occupancies of the unit with `ended_at IS NULL`, whatever the membership's status.
    current_occupant_count: int


class UnitOption(APIModel):
    """What the join flow may show of a unit (P4-05): nothing about who lives there."""

    id: UUID
    tower: str | None
    label: str


class OccupantOut(APIModel):
    """A current occupant, for the desk's recipient and pickup forms (P5-02a)."""

    membership_id: UUID
    full_name: str
    relationship: OccupancyRelationship
