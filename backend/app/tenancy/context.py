"""What a building-scoped request may do: the caller's active membership in the URL's building."""

from dataclasses import dataclass
from uuid import UUID

from app.buildings.enums import Feature
from app.memberships.enums import STAFF_ROLES, Role


@dataclass(frozen=True, slots=True)
class TenantContext:
    """Built by `get_tenant_context` on every request from the database, never from the client.

    Services filter every query by `building_id` (CLAUDE.md rule 1).
    """

    user_id: UUID
    building_id: UUID
    membership_id: UUID
    roles: frozenset[Role]
    # Only the enabled ones.
    features: frozenset[Feature]

    def has_any(self, *roles: Role) -> bool:
        return not self.roles.isdisjoint(roles)

    @property
    def is_staff(self) -> bool:
        return not self.roles.isdisjoint(STAFF_ROLES)
