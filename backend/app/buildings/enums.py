from enum import StrEnum


class Feature(StrEnum):
    """A module a building can switch on (`building_features.feature`)."""

    PACKAGES = "packages"
    NOTICES = "notices"
    MAINTENANCE = "maintenance"
    AMENITIES = "amenities"
    MOVES = "moves"
    VISITORS = "visitors"
    REPORTS = "reports"
    FINANCIALS = "financials"
