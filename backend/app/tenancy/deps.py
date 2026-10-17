"""The tenant guards (ADR-0004): who may act in the building named by the URL.

`get_tenant_context` runs on every request under `building_router()`; nothing about a membership is
cached in the session, so a role, status or feature change applies to the next request.
"""

from collections.abc import Awaitable, Callable
from typing import Annotated, Any
from uuid import UUID

from fastapi import Depends, Request
from sqlalchemy import ColumnElement, Text, cast, func, select
from sqlalchemy.dialects.postgresql import ARRAY
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth.deps import get_current_user
from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.core.dependencies import get_db_session
from app.core.errors import Forbidden, NotFound
from app.logging_config import building_id_ctx, user_id_ctx
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.tenancy.context import TenantContext
from app.users.models import User

# After the user: get_current_user's activity refresh commits (app/auth/deps.py).
CurrentUser = Annotated[User, Depends(get_current_user)]
DbSession = Annotated[AsyncSession, Depends(get_db_session)]


class BuildingNotFound(NotFound):
    code = "building_not_found"


class ForbiddenRole(Forbidden):
    code = "forbidden_role"


class FeatureDisabled(Forbidden):
    code = "feature_disabled"


def _not_found() -> BuildingNotFound:
    # One body for "no such building", "not a member", "not active" and "building inactive": the
    # answer must not tell them apart (ADR-0004).
    return BuildingNotFound(detail="Building not found.")


def _text_array(column: Any, *where: ColumnElement[bool]) -> ColumnElement[list[str]]:
    # ARRAY(SELECT …): an empty array, not NULL, when nothing matches. Text, so the values come
    # back as plain strings for the enums to parse.
    subquery = select(cast(column, Text)).where(*where).scalar_subquery()
    return func.array(subquery, type_=ARRAY(Text))


async def get_tenant_context(
    request: Request, building_id: UUID, user: CurrentUser, db: DbSession
) -> TenantContext:
    """The caller's active membership in `building_id`, with its roles and the building's enabled
    features, in one query; otherwise 404 `building_not_found`."""
    # For the request log (another task: it reads request.state) and for logs in this request. The
    # user is known either way, so a refused request still says who tried; the building only once
    # the caller may act there.
    request.state.user_id = user.id
    user_id_ctx.set(str(user.id))
    row = (
        await db.execute(
            select(
                BuildingMembership.id,
                _text_array(
                    MembershipRole.role, MembershipRole.membership_id == BuildingMembership.id
                ).label("roles"),
                _text_array(
                    BuildingFeature.feature,
                    BuildingFeature.building_id == Building.id,
                    BuildingFeature.enabled.is_(True),
                ).label("features"),
            )
            .join(Building, Building.id == BuildingMembership.building_id)
            .where(
                BuildingMembership.building_id == building_id,
                BuildingMembership.user_id == user.id,
                BuildingMembership.status == MembershipStatus.ACTIVE,
                Building.is_active,
            )
        )
    ).one_or_none()
    if row is None:
        raise _not_found()
    request.state.building_id = building_id
    building_id_ctx.set(str(building_id))
    return TenantContext(
        user_id=user.id,
        building_id=building_id,
        membership_id=row.id,
        roles=frozenset(Role(r) for r in row.roles),
        features=frozenset(Feature(f) for f in row.features),
    )


Ctx = Annotated[TenantContext, Depends(get_tenant_context)]


def require_roles(*roles: Role) -> Callable[[TenantContext], Awaitable[TenantContext]]:
    """A dependency: the caller has at least one of `roles` in this building, or 403
    `forbidden_role`. Tenancy runs first, so a non-member still gets the 404."""
    if not roles:
        raise ValueError("require_roles needs at least one role")

    async def has_role(ctx: Ctx) -> TenantContext:
        if not ctx.has_any(*roles):
            raise ForbiddenRole(detail="Your role in this building does not allow this.")
        return ctx

    return has_role


def require_feature(feature: Feature) -> Callable[[TenantContext], Awaitable[TenantContext]]:
    """A dependency: `feature` is enabled for this building, or 403 `feature_disabled`."""

    async def feature_enabled(ctx: Ctx) -> TenantContext:
        if feature not in ctx.features:
            raise FeatureDisabled(detail="This feature is not enabled for this building.")
        return ctx

    return feature_enabled


async def get_own_membership(
    building_id: UUID, user: CurrentUser, db: DbSession
) -> BuildingMembership:
    """Onboarding routes only (ADR-0004): the caller's membership in `building_id` in any status but
    deactivated, so a pending member can see where they stand. Not a `TenantContext`: it grants no
    operational access. Otherwise the same 404 as `get_tenant_context`."""
    membership = await db.scalar(
        select(BuildingMembership)
        .join(Building, Building.id == BuildingMembership.building_id)
        .where(
            BuildingMembership.building_id == building_id,
            BuildingMembership.user_id == user.id,
            BuildingMembership.status != MembershipStatus.DEACTIVATED,
            Building.is_active,
        )
    )
    if membership is None:
        raise _not_found()
    return membership
