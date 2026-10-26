"""The maintenance state machine: which status may follow which (P6-03a).

The table's check constraints keep each row consistent with its status; these rules say which moves
are legal. P6-03b's cancel and P6-03c's actions check them, then write with a conditional
`UPDATE … WHERE status IN (…)` (CLAUDE.md rule 7).
"""

from collections.abc import Mapping

from app.core.errors import Conflict
from app.maintenance.enums import MaintenanceStatus

S = MaintenanceStatus

# Cancel only before work starts; after that the manager resolves it. `on_hold → in_progress` is a
# resume and `resolved → in_progress` a reopen (P6-03c). `cancelled` is final (ADR-0020).
ALLOWED: Mapping[MaintenanceStatus, frozenset[MaintenanceStatus]] = {
    S.SUBMITTED: frozenset({S.IN_PROGRESS, S.CANCELLED}),
    S.IN_PROGRESS: frozenset({S.ON_HOLD, S.RESOLVED}),
    S.ON_HOLD: frozenset({S.IN_PROGRESS, S.RESOLVED}),
    S.RESOLVED: frozenset({S.IN_PROGRESS}),
}


class InvalidTransition(Conflict):
    code = "invalid_transition"


def assert_transition(from_: MaintenanceStatus, to: MaintenanceStatus) -> None:
    """Raise `InvalidTransition` (409) unless a request may move from `from_` to `to`."""
    if to not in ALLOWED.get(from_, frozenset()):
        raise InvalidTransition(detail=f"A {from_} request can't become {to}.")


def sources(to: MaintenanceStatus) -> tuple[MaintenanceStatus, ...]:
    """The statuses a request may become `to` from: the conditional UPDATE's `status IN (…)`."""
    return tuple(from_ for from_, targets in ALLOWED.items() if to in targets)
