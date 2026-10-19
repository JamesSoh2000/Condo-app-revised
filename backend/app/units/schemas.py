import unicodedata
from typing import Annotated, Any
from uuid import UUID

from pydantic import AfterValidator, BeforeValidator, Field, StringConstraints, field_validator
from pydantic_core import PydanticCustomError

from app.core.schemas import APIModel, InputModel

MIN_FLOOR, MAX_FLOOR = -20, 300


def printable(value: str) -> str:
    """Refuse control characters and lone surrogates. Postgres refuses NUL and surrogates at flush,
    not here (CLAUDE.md lesson), and a tab or newline makes two labels that look alike."""
    if any(unicodedata.category(char) in {"Cc", "Cs"} for char in value):
        raise PydanticCustomError("control_characters", "must not contain control characters")
    return value


def _blank_to_none(value: Any) -> Any:
    # A blank tower is no tower: the CSV's empty cell, and the same in the API.
    return None if isinstance(value, str) and not value.strip() else value


# The column lengths (`units.tower`, `units.label` are varchar(20)). Stripped, as InputModel strips.
Label = Annotated[
    str,
    StringConstraints(strip_whitespace=True, min_length=1, max_length=20),
    AfterValidator(printable),
]
Tower = Annotated[Label | None, BeforeValidator(_blank_to_none)]
Floor = Annotated[int, Field(ge=MIN_FLOOR, le=MAX_FLOOR)]
# A query parameter that reaches a LIKE or an equality: the same characters a label may hold.
SearchText = Annotated[str, StringConstraints(max_length=20), AfterValidator(printable)]


class UnitCreate(InputModel):
    tower: Tower = None
    label: Label
    floor: Floor | None = None


class UnitUpdate(InputModel):
    """Only the fields sent change; `tower: null` and `floor: null` clear them."""

    tower: Tower = None
    label: Label | None = None
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
