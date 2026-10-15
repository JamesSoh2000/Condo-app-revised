from functools import cache
from zoneinfo import available_timezones

# Files in the tz directory that aren't zones: `localtime` follows the host's /etc/localtime (so a
# stored value would mean different zones on different hosts); `Factory` and `posixrules` are
# placeholders.
_NOT_ZONES = frozenset({"localtime", "Factory", "posixrules"})


@cache
def _known_timezones() -> frozenset[str]:
    # available_timezones() scans the tz database on disk on every call.
    return frozenset(available_timezones()) - _NOT_ZONES


def validate_timezone(tz: str) -> str:
    """Return `tz` unchanged if it is an IANA zone name this system knows, else raise ValueError."""
    if tz not in _known_timezones():
        raise ValueError(f"unknown timezone: {tz!r}")
    return tz
