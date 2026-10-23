"""Who may see which package: `visible_packages(ctx)`, the one place that rule lives (CLAUDE.md
rule 3).

Endpoints, counts and the photo hook build on this query (narrow it with `.where`, wrap it in a
subquery, test `.exists()`), never on their own filter.
"""

from sqlalchemy import ColumnElement, Select, false, or_, select, true

from app.memberships.enums import Role
from app.memberships.occupancy import occupancy_window_clause
from app.packages.models import Package
from app.tenancy.context import TenantContext

# Not `STAFF_ROLES`: council is staff elsewhere but sees no packages (aggregates only, later).
_SEE_ALL = (Role.SECURITY, Role.PROPERTY_MANAGEMENT)


def visible_packages(ctx: TenantContext) -> Select[Package]:
    """The packages of `ctx.building_id` the caller may see; a multi-role caller gets the union.

    - security, property management: every package of the building
    - resident: the packages naming them as recipient, and those received at their unit while they
      lived there (`occupancy_window`, ADR-0016): history follows the person, not the unit
    - any other role (council alone): none
    """
    return select(Package).where(Package.building_id == ctx.building_id, _grant(ctx))


def _grant(ctx: TenantContext) -> ColumnElement[bool]:
    if ctx.has_any(*_SEE_ALL):
        return true()
    if ctx.has_any(Role.RESIDENT):
        # Always the context's own membership, never a value from the request.
        return or_(
            Package.recipient_membership_id == ctx.membership_id,
            occupancy_window_clause(ctx.membership_id, Package.unit_id, Package.received_at),
        )
    return false()


def sees_recipient_names(ctx: TenantContext) -> bool:
    """True if the caller is shown the names of the packages' recipients: the desk only (P5-03a).
    A resident sees packages addressed to a co-occupant, and no other route shows them that name."""
    return ctx.has_any(*_SEE_ALL)
