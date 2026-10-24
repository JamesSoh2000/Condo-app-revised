"""P6-01a criteria 5 and 5a: which notice status may follow which."""

import itertools

import pytest

from app.core.errors import Conflict
from app.notices.enums import NoticeStatus
from app.notices.state import ALLOWED, InvalidTransition, assert_transition, sources

DRAFT, PUBLISHED, ARCHIVED = NoticeStatus.DRAFT, NoticeStatus.PUBLISHED, NoticeStatus.ARCHIVED
LEGAL = {(DRAFT, PUBLISHED), (DRAFT, ARCHIVED), (PUBLISHED, ARCHIVED)}


def test_allowed_is_exactly_the_tickets_moves():
    assert {(f, t) for f, targets in ALLOWED.items() for t in targets} == LEGAL


@pytest.mark.parametrize(("from_", "to"), list(itertools.product(NoticeStatus, repeat=2)))
def test_every_pair_is_allowed_or_a_409_invalid_transition(from_, to):
    if (from_, to) in LEGAL:
        assert_transition(from_, to)
        return
    with pytest.raises(InvalidTransition) as raised:
        assert_transition(from_, to)
    assert isinstance(raised.value, Conflict)
    assert raised.value.code == "invalid_transition"
    assert raised.value.status == 409


def test_archived_is_final():
    for to in NoticeStatus:
        with pytest.raises(InvalidTransition):
            assert_transition(ARCHIVED, to)


@pytest.mark.parametrize("to", list(NoticeStatus))
def test_sources_match_allowed(to):
    assert set(sources(to)) == {f for f, t in LEGAL if t == to}
