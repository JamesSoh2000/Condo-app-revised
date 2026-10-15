from functools import cache
from zoneinfo import available_timezones


@cache
def _known_timezones() -> frozenset[str]:
    # available_timezones() scans the tz database on disk on every call.
    return frozenset(available_timezones())


def validate_timezone(tz: str) -> str:
    """Return `tz` unchanged if it is an IANA zone name this system knows, else raise ValueError."""
    if tz not in _known_timezones():
        raise ValueError(f"unknown timezone: {tz!r}")
    return tz
