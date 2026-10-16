"""The current time, in one place, so tests can freeze it (`tests/conftest.py::frozen_clock`).

Call it as `clock.now()` (module attribute), not `from app.core.clock import now`, or a frozen clock
won't reach the caller.
"""

from datetime import UTC, datetime


def now() -> datetime:
    return datetime.now(UTC)
