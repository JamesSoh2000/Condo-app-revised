"""Unit input types refuse control characters before the strip (P4-05b criterion 16)."""

import pytest
from pydantic import ValidationError

from app.units.schemas import UnitCreate, UnitUpdate


@pytest.mark.parametrize(
    "fields",
    [
        {"label": "101\n"},
        {"label": "\t101"},
        {"label": "1\x0001"},
        {"label": "101", "tower": "A\n"},
        {"label": "101", "tower": "\tA"},
        {"label": "101", "tower": "\t"},
        {"label": "101", "tower": "\n\n"},
    ],
)
def test_control_characters_are_refused_even_at_the_ends(fields: dict[str, str]) -> None:
    with pytest.raises(ValidationError) as caught:
        UnitCreate(**fields)

    assert caught.value.errors()[0]["type"] == "control_characters"


def test_update_refuses_them_too() -> None:
    with pytest.raises(ValidationError):
        UnitUpdate(label="101\n")


def test_spaces_are_still_stripped_and_a_blank_tower_is_none() -> None:
    unit = UnitCreate(label=" 101 ", tower="   ")

    assert (unit.label, unit.tower) == ("101", None)
