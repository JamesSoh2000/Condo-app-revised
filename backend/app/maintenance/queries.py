"""Who may see which maintenance request: `visible_maintenance(ctx)`, the one place that rule lives
(CLAUDE.md rule 3).

Endpoints, counts, comments and the photo hook build on this query (narrow it with `.where`, wrap
it in a subquery, test `.exists()`), never on their own filter.
"""

from sqlalchemy import ColumnElement, Select, false, or_, select, true

from app.maintenance.models import MaintenanceRequest
from app.memberships.enums import Role
from app.memberships.occupancy import occupancy_window_clause
from app.tenancy.context import TenantContext

# Not `STAFF_ROLES`: council is staff elsewhere but sees no requests (P6-05's counts summarize).
_SEE_ALL = (Role.SECURITY, Role.PROPERTY_MANAGEMENT)


def visible_maintenance(ctx: TenantContext) -> Select[MaintenanceRequest]:
    """The requests of `ctx.building_id` the caller may see; a multi-role caller gets the union.

    - security, property management: every request of the building
    - resident: their own requests, and those filed for a unit while they lived there
      (`occupancy_window`, ADR-0016), whoever filed them: history follows the person. A
      common-area request has no unit, so only its requester sees it.
    - any other role (council alone): none
    """
    return select(MaintenanceRequest).where(
        MaintenanceRequest.building_id == ctx.building_id, _grant(ctx)
    )


def _grant(ctx: TenantContext) -> ColumnElement[bool]:
    if ctx.has_any(*_SEE_ALL):
        return true()
    if ctx.has_any(Role.RESIDENT):
        # Always the context's own membership, never a value from the request.
        return or_(
            MaintenanceRequest.requester_membership_id == ctx.membership_id,
            occupancy_window_clause(
                ctx.membership_id, MaintenanceRequest.unit_id, MaintenanceRequest.submitted_at
            ),
        )
    return false()


def sees_requester_names(ctx: TenantContext) -> bool:
    """True if the caller is shown who filed each request: staff only, as packages' recipients
    (P6-03b D8). A resident sees a co-occupant's request but not who filed it."""
    return ctx.has_any(*_SEE_ALL)
