"""P5-01 criterion 3: the package state machine, pure logic."""

from itertools import product

import pytest

from app.core.errors import Conflict
from app.packages.enums import PackageStatus
from app.packages.state import ALLOWED, InvalidTransition, assert_transition

RECEIVED, PICKED_UP, RETURNED = (
    PackageStatus.RECEIVED,
    PackageStatus.PICKED_UP,
    PackageStatus.RETURNED,
)
LEGAL = {(RECEIVED, PICKED_UP), (RECEIVED, RETURNED)}


def test_allowed_is_received_to_picked_up_or_returned():
    assert ALLOWED == {RECEIVED: frozenset({PICKED_UP, RETURNED})}


@pytest.mark.parametrize(("from_", "to"), sorted(LEGAL))
def test_legal_transitions_pass(from_: PackageStatus, to: PackageStatus):
    assert_transition(from_, to)


@pytest.mark.parametrize(
    ("from_", "to"), [pair for pair in product(PackageStatus, repeat=2) if pair not in LEGAL]
)
def test_every_other_transition_is_invalid(from_: PackageStatus, to: PackageStatus):
    with pytest.raises(InvalidTransition) as raised:
        assert_transition(from_, to)

    assert isinstance(raised.value, Conflict)
    assert (raised.value.status, raised.value.code) == (409, "invalid_transition")


def test_picked_up_back_to_received_is_invalid():
    # The ticket's own example.
    with pytest.raises(InvalidTransition):
        assert_transition(PICKED_UP, RECEIVED)
