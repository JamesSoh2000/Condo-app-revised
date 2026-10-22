"""The package state machine: which status may follow which (P5-01).

The table's check constraints keep each row consistent with its status; these rules say which moves
between statuses are legal. Action services (P5-02b) check them, then write with a conditional
`UPDATE … WHERE status IN (…)` (CLAUDE.md rule 7), so a concurrent change can't slip between the two.
"""

from collections.abc import Mapping

from app.core.errors import Conflict
from app.packages.enums import PackageStatus

# `picked_up` and `returned` are final; undoing a pickup would need a new ADR (P5-02b).
ALLOWED: Mapping[PackageStatus, frozenset[PackageStatus]] = {
    PackageStatus.RECEIVED: frozenset({PackageStatus.PICKED_UP, PackageStatus.RETURNED}),
}


class InvalidTransition(Conflict):
    code = "invalid_transition"


def assert_transition(from_: PackageStatus, to: PackageStatus) -> None:
    """Raise `InvalidTransition` (409) unless a package may move from `from_` to `to`."""
    if to not in ALLOWED.get(from_, frozenset()):
        raise InvalidTransition(detail=f"A {from_} package can't become {to}.")
