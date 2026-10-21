from typing import Annotated, Self
from uuid import UUID

from pydantic import AfterValidator, Field, StringConstraints, model_validator
from pydantic_core import PydanticCustomError

from app.core.schemas import APIModel, InputModel
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.onboarding.schemas import Reason
from app.units.schemas import printable

# A query parameter matched inside names and emails (P4-06a); the LIKE wildcards are escaped.
MemberSearch = Annotated[str, StringConstraints(max_length=100), AfterValidator(printable)]


class MemberOut(APIModel):
    """A membership as property management sees it, with the member's current unit, if any."""

    membership_id: UUID
    user_id: UUID
    full_name: str
    email: str
    status: MembershipStatus
    # Why it was suspended; null otherwise.
    status_reason: str | None
    # Sorted by value.
    roles: list[Role]
    unit_id: UUID | None
    unit_label: str | None
    tower: str | None
    relationship: OccupancyRelationship | None


class MemberRolesIn(InputModel):
    """Roles to give and to take away. A role already held (add) or not held (remove) is ignored."""

    add: Annotated[list[Role], Field(default_factory=list, max_length=len(Role))]
    remove: Annotated[list[Role], Field(default_factory=list, max_length=len(Role))]

    @model_validator(mode="after")
    def _a_change(self) -> Self:
        if not self.add and not self.remove:
            raise PydanticCustomError("no_change", "add or remove at least one role")
        if set(self.add) & set(self.remove):
            raise PydanticCustomError("role_in_both", "a role can't be both added and removed")
        return self


class MemberSuspendIn(InputModel):
    """Managers see the reason in the member list; the member doesn't."""

    reason: Reason


class MemberDeactivateIn(InputModel):
    """Move-out. Managers see the reason in the member list; the member doesn't."""

    reason: Reason


class MemberTransferIn(InputModel):
    """The member's new unit, in this building. No time: the move happens now (ADR-0016)."""

    unit_id: UUID
    relationship: OccupancyRelationship
