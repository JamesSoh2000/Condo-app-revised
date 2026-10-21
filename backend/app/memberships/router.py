from typing import Annotated
from uuid import UUID

from fastapi import Depends, Query

from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.memberships import service
from app.memberships.enums import MembershipStatus, Role
from app.memberships.schemas import (
    MemberDeactivateIn,
    MemberOut,
    MemberRolesIn,
    MemberSearch,
    MemberSuspendIn,
    MemberTransferIn,
)
from app.tenancy.context import TenantContext
from app.tenancy.deps import DbSession, require_roles
from app.tenancy.router import building_router

router = building_router(tags=["members"])
Manager = Annotated[TenantContext, Depends(require_roles(Role.PROPERTY_MANAGEMENT))]


# `name=`: the operation ids are `members_list` and so on (app/main.py::operation_id), and a
# function named `list` would shadow the builtin in this module's annotations.
@router.get("/members", name="list", responses=problem_responses(400, 401, 403, 404))
async def list_members(
    ctx: Manager,
    db: DbSession,
    params: Annotated[CursorParams, Depends()],
    role: Role | None = None,
    status: MembershipStatus | None = None,
    search: Annotated[
        MemberSearch | None, Query(description="Part of the name or email, any case.")
    ] = None,
) -> Page[MemberOut]:
    """The building's members in any status, newest first, with their current unit."""
    return await service.list_members(db, ctx, params, role=role, status=status, search=search)


@router.post(
    "/members/{membership_id}/roles",
    name="roles_update",
    responses=problem_responses(401, 403, 404, 409),
)
async def roles_update(
    membership_id: UUID, body: MemberRolesIn, ctx: Manager, db: DbSession
) -> MemberOut:
    """Add and remove an active member's roles. 409 `membership_not_active`, `no_roles_left`,
    `resident_has_unit` or `last_manager` (the building would have no active manager)."""
    return await service.change_roles(db, ctx, membership_id, body)


@router.post(
    "/members/{membership_id}/suspend",
    name="suspend",
    responses=problem_responses(401, 403, 404, 409),
)
async def suspend(
    membership_id: UUID, body: MemberSuspendIn, ctx: Manager, db: DbSession
) -> MemberOut:
    """Suspend an active member: from their next request they can't act in this building. 409
    `cannot_target_self`, `invalid_transition` or `last_manager`."""
    return await service.suspend_member(db, ctx, membership_id, body)


@router.post(
    "/members/{membership_id}/reactivate",
    name="reactivate",
    responses=problem_responses(401, 403, 404, 409),
)
async def reactivate(membership_id: UUID, ctx: Manager, db: DbSession) -> MemberOut:
    """Lift a suspension. 409 `invalid_transition` unless the member is suspended."""
    return await service.reactivate_member(db, ctx, membership_id)


@router.post(
    "/members/{membership_id}/deactivate",
    name="deactivate",
    responses=problem_responses(401, 403, 404, 409),
)
async def deactivate(
    membership_id: UUID, body: MemberDeactivateIn, ctx: Manager, db: DbSession
) -> MemberOut:
    """Move an active or suspended member out: the membership `deactivated` and their current
    occupancy ended now. 409 `cannot_target_self`, `invalid_transition`, `last_manager` or
    `occupancy_changed`."""
    return await service.deactivate_member(db, ctx, membership_id, body)


@router.post(
    "/members/{membership_id}/transfer",
    name="transfer",
    responses=problem_responses(401, 403, 404, 409),
)
async def transfer(
    membership_id: UUID, body: MemberTransferIn, ctx: Manager, db: DbSession
) -> MemberOut:
    """Move an active resident to another unit of the building (or the same unit with a new
    relationship), keeping their history. 404 `member_not_found` or `unit_not_found`; 409
    `membership_not_active`, `not_a_resident`, `unit_inactive` or `occupancy_changed`."""
    return await service.transfer_member(db, ctx, membership_id, body)
