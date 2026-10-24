"""Who may see which notice: `visible_notices(ctx)`, the one place that rule lives (CLAUDE.md
rule 3).

Endpoints, counts and the attachment hook build on this query (narrow it with `.where`, wrap it in a
subquery, test `.exists()`), never on their own filter.
"""

from sqlalchemy import ColumnElement, Select, and_, func, or_, select, true

from app.memberships.enums import Role
from app.notices.enums import NoticeStatus
from app.notices.models import Notice
from app.tenancy.context import TenantContext


def visible_notices(ctx: TenantContext) -> Select[Notice]:
    """The notices of `ctx.building_id` the caller may see; a multi-role caller gets the union.

    - property management: every notice of the building, drafts, expired and archived ones too
    - every other member (resident, security, council): published notices that haven't expired, by
      the database clock. Notices are for the whole building, not a unit, so no occupancy window:
      a resident who moved in later sees what was published before.
    """
    return select(Notice).where(Notice.building_id == ctx.building_id, _grant(ctx))


def live() -> ColumnElement[bool]:
    """Published and not expired, by the database clock: what every member but the manager sees,
    and what the unread summary counts for every member (P6-01c)."""
    # `now()` is the transaction's start, so one request's reads agree with each other.
    return and_(
        Notice.status == NoticeStatus.PUBLISHED,
        or_(Notice.expires_at.is_(None), Notice.expires_at > func.now()),
    )


def _grant(ctx: TenantContext) -> ColumnElement[bool]:
    if ctx.has_any(Role.PROPERTY_MANAGEMENT):
        return true()
    return live()
