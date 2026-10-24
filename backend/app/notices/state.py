"""The notice state machine: which status may follow which (P6-01a).

The table's check constraints keep each row consistent with its status; these rules say which moves
are legal. P6-01b's actions check them, then write with a conditional `UPDATE … WHERE status IN (…)`
(CLAUDE.md rule 7).
"""

from collections.abc import Mapping

from app.core.errors import Conflict
from app.notices.enums import NoticeStatus

# No `published → draft`: a published notice isn't edited; archive it and publish a new one (the
# stub's default). A draft may be archived, since there is no delete; `archived` is final.
ALLOWED: Mapping[NoticeStatus, frozenset[NoticeStatus]] = {
    NoticeStatus.DRAFT: frozenset({NoticeStatus.PUBLISHED, NoticeStatus.ARCHIVED}),
    NoticeStatus.PUBLISHED: frozenset({NoticeStatus.ARCHIVED}),
}


class InvalidTransition(Conflict):
    code = "invalid_transition"


def assert_transition(from_: NoticeStatus, to: NoticeStatus) -> None:
    """Raise `InvalidTransition` (409) unless a notice may move from `from_` to `to`."""
    if to not in ALLOWED.get(from_, frozenset()):
        raise InvalidTransition(detail=f"A {from_} notice can't become {to}.")


def sources(to: NoticeStatus) -> tuple[NoticeStatus, ...]:
    """The statuses a notice may become `to` from: the conditional UPDATE's `status IN (…)`."""
    return tuple(from_ for from_, targets in ALLOWED.items() if to in targets)
