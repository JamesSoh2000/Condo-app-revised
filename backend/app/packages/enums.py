from enum import StrEnum


class PackageStatus(StrEnum):
    """Where a package is (`packages.status`); `app.packages.state` says how it may move."""

    RECEIVED = "received"  # at the desk
    PICKED_UP = "picked_up"
    RETURNED = "returned"  # sent back to the carrier
