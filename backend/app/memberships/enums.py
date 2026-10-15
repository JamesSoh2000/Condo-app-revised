from enum import StrEnum


class MembershipStatus(StrEnum):
    """Where a user stands in one building (`building_memberships.status`)."""

    PENDING = "pending"
    ACTIVE = "active"
    DENIED = "denied"
    SUSPENDED = "suspended"
    DEACTIVATED = "deactivated"


class Role(StrEnum):
    """What a membership may do in its building (`membership_roles.role`)."""

    RESIDENT = "resident"
    SECURITY = "security"
    PROPERTY_MANAGEMENT = "property_management"
    COUNCIL = "council"


STAFF_ROLES: frozenset[Role] = frozenset({Role.SECURITY, Role.PROPERTY_MANAGEMENT, Role.COUNCIL})


class OccupancyRelationship(StrEnum):
    """How an occupant relates to a unit (`unit_occupancies.relationship`, ADR-0010)."""

    OWNER = "owner"
    TENANT = "tenant"
    HOUSEHOLD = "household"
