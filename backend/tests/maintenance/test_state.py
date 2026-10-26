"""P6-03a criterion 6: the maintenance state machine allows exactly `ALLOWED`."""

import itertools

import pytest

from app.maintenance.enums import MaintenanceStatus
from app.maintenance.state import ALLOWED, InvalidTransition, assert_transition, sources

S = MaintenanceStatus

# P6-03a D4, written out so a change to ALLOWED has to change this test too.
EXPECTED = {
    (S.SUBMITTED, S.IN_PROGRESS),  # start
    (S.SUBMITTED, S.CANCELLED),  # cancel
    (S.IN_PROGRESS, S.ON_HOLD),  # hold
    (S.IN_PROGRESS, S.RESOLVED),  # resolve
    (S.ON_HOLD, S.IN_PROGRESS),  # resume (P6-03c's /start)
    (S.ON_HOLD, S.RESOLVED),  # resolve
    (S.RESOLVED, S.IN_PROGRESS),  # reopen
}


def test_allowed_is_the_decided_map():
    assert {(f, t) for f, targets in ALLOWED.items() for t in targets} == EXPECTED


@pytest.mark.parametrize(("from_", "to"), list(itertools.product(S, S)))
def test_assert_transition_allows_exactly_the_map(from_: MaintenanceStatus, to: MaintenanceStatus):
    if (from_, to) in EXPECTED:
        assert_transition(from_, to)
        return
    with pytest.raises(InvalidTransition) as raised:
        assert_transition(from_, to)
    assert (raised.value.status, raised.value.code) == (409, "invalid_transition")


@pytest.mark.parametrize("to", list(S))
def test_sources_match_the_map(to: MaintenanceStatus):
    assert set(sources(to)) == {f for f, t in EXPECTED if t == to}


def test_cancelled_is_final():
    assert ALLOWED.get(S.CANCELLED, frozenset()) == frozenset()
