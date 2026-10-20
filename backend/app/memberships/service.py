"""Membership administration (P4-06a): the member list, role changes, suspend and reactivate.

Every write takes the building row lock first (`_lock_building`), so these writes run one at a
time per building, and reads the caller again under it. It makes its change, then
`_check_managers` counts the building's active managers and refuses a caller who lost their
authority while waiting. A refusal raises, which rolls the change back. `change_roles`,
`suspend_member` and `reactivate_member` commit once (CLAUDE.md rule 5); `list_members` only reads.
"""

from collections import defaultdict
from collections.abc import Sequence
from typing import Any, NamedTuple
from uuid import UUID

from sqlalchemy import and_, delete, exists, func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.auth.service import apply_role_change
from app.buildings.models import Building
from app.core.errors import Conflict, NotFound
from app.core.pagination import CursorParams, Page, paginate
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.schemas import MemberOut, MemberRolesIn, MemberSuspendIn
from app.tenancy.context import TenantContext
from app.tenancy.deps import BuildingNotFound, ForbiddenRole
from app.units.models import Unit
from app.users.models import User


class MemberNotFound(NotFound):
    code = "member_not_found"


class LastManager(Conflict):
    code = "last_manager"


class CannotTargetSelf(Conflict):
    code = "cannot_target_self"


class InvalidTransition(Conflict):
    code = "invalid_transition"


class MembershipNotActive(Conflict):
    code = "membership_not_active"


class NoRolesLeft(Conflict):
    code = "no_roles_left"


class ResidentHasUnit(Conflict):
    code = "resident_has_unit"


def _escape_like(text: str) -> str:
    return text.replace("\\", "\\\\").replace("%", "\\%").replace("_", "\\_")


def _holds(role: Role) -> Any:
    """The membership in the enclosing query holds `role`."""
    return exists().where(
        MembershipRole.building_id == BuildingMembership.building_id,
        MembershipRole.membership_id == BuildingMembership.id,
        MembershipRole.role == role,
    )


async def _members_out(
    db: AsyncSession, building_id: UUID, membership_ids: Sequence[UUID]
) -> list[MemberOut]:
    """The members, in the given order: two queries, read now (after any write in this
    transaction)."""
    if not membership_ids:
        return []
    rows = await db.execute(
        select(
            BuildingMembership.id,
            BuildingMembership.user_id,
            BuildingMembership.status,
            BuildingMembership.status_reason,
            User.full_name,
            User.email,
            UnitOccupancy.unit_id,
            UnitOccupancy.relationship,
            Unit.label,
            Unit.tower,
        )
        .join(User, User.id == BuildingMembership.user_id)
        # At most one current occupancy per membership (uq_unit_occupancies_current_membership).
        .outerjoin(
            UnitOccupancy,
            and_(
                UnitOccupancy.building_id == BuildingMembership.building_id,
                UnitOccupancy.membership_id == BuildingMembership.id,
                UnitOccupancy.ended_at.is_(None),
            ),
        )
        .outerjoin(
            Unit,
            and_(Unit.building_id == UnitOccupancy.building_id, Unit.id == UnitOccupancy.unit_id),
        )
        .where(
            BuildingMembership.building_id == building_id,
            BuildingMembership.id.in_(membership_ids),
        )
    )
    by_id = {row.id: row for row in rows}
    roles: defaultdict[UUID, list[Role]] = defaultdict(list)
    for membership_id, role in await db.execute(
        select(MembershipRole.membership_id, MembershipRole.role).where(
            MembershipRole.building_id == building_id,
            MembershipRole.membership_id.in_(membership_ids),
        )
    ):
        roles[membership_id].append(role)
    return [
        MemberOut(
            membership_id=row.id,
            user_id=row.user_id,
            full_name=row.full_name,
            email=row.email,
            status=row.status,
            status_reason=row.status_reason,
            # Sorted by value: Postgres would order the enum by declaration.
            roles=sorted(roles[row.id]),
            unit_id=row.unit_id,
            unit_label=row.label,
            tower=row.tower,
            relationship=row.relationship,
        )
        for row in (by_id[membership_id] for membership_id in membership_ids)
    ]


async def list_members(
    db: AsyncSession,
    ctx: TenantContext,
    params: CursorParams,
    *,
    role: Role | None,
    status: MembershipStatus | None,
    search: str | None,
) -> Page[MemberOut]:
    """The building's memberships in any status, newest first; the filters combine."""
    stmt = select(BuildingMembership).where(BuildingMembership.building_id == ctx.building_id)
    if role is not None:
        stmt = stmt.where(_holds(role))
    if status is not None:
        stmt = stmt.where(BuildingMembership.status == status)
    if search:
        pattern = f"%{_escape_like(search)}%"
        stmt = stmt.join(User, User.id == BuildingMembership.user_id).where(
            or_(User.full_name.ilike(pattern, escape="\\"), User.email.ilike(pattern, escape="\\"))
        )
    page = await paginate(db, stmt, BuildingMembership.id, params, lambda m: m.id)
    return Page(
        items=await _members_out(db, ctx.building_id, page.items), next_cursor=page.next_cursor
    )


class _Caller(NamedTuple):
    """The caller's membership as it stands once the building lock is held."""

    active: bool
    manager: bool


async def _lock_building(db: AsyncSession, ctx: TenantContext) -> _Caller:
    """Lock the building row (NO KEY UPDATE, as the invitations' writes; foreign-key checks from
    other tables don't wait for it) until the transaction ends. Every write here takes it first:
    they run one at a time per building, and each reads what the previous one committed.

    Then read the caller again. Their tenant context was read before they waited for the lock;
    another manager may have demoted or suspended them meanwhile (D2). Read before this write's own
    change, so a manager may still drop their own role."""
    await db.execute(
        select(Building.id).where(Building.id == ctx.building_id).with_for_update(key_share=True)
    )
    caller = (
        await db.execute(
            select(
                BuildingMembership.status, _holds(Role.PROPERTY_MANAGEMENT).label("manager")
            ).where(
                BuildingMembership.id == ctx.membership_id,
                BuildingMembership.building_id == ctx.building_id,
            )
        )
    ).one()
    return _Caller(active=caller.status == MembershipStatus.ACTIVE, manager=caller.manager)


async def _target(db: AsyncSession, ctx: TenantContext, membership_id: UUID) -> Any:
    """The building's membership `membership_id` (id, user_id, status), locked FOR NO KEY UPDATE
    after the building; 404 `member_not_found` for another building's and for none at all."""
    row = (
        await db.execute(
            select(BuildingMembership.id, BuildingMembership.user_id, BuildingMembership.status)
            .where(
                BuildingMembership.id == membership_id,
                BuildingMembership.building_id == ctx.building_id,
            )
            .with_for_update(key_share=True)
        )
    ).one_or_none()
    if row is None:
        raise MemberNotFound(detail="Member not found.")
    return row


async def _check_managers(db: AsyncSession, ctx: TenantContext, caller: _Caller) -> None:
    """After the change: the building still has an active manager (409 `last_manager`), checked
    first, so of two managers demoting each other the second gets that. Then the caller, as
    `_lock_building` read them: 404 if no longer active, 403 without the role, what their next
    request would get."""
    managers = await db.scalar(
        select(func.count()).where(
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            _holds(Role.PROPERTY_MANAGEMENT),
        )
    )
    if not managers:
        raise LastManager(detail="The building must keep at least one active property manager.")
    if not caller.active:
        raise BuildingNotFound(detail="Building not found.")
    if not caller.manager:
        raise ForbiddenRole(detail="Your role in this building does not allow this.")


async def _finish(
    db: AsyncSession,
    ctx: TenantContext,
    caller: _Caller,
    target: Any,
    action: str,
    metadata: dict[str, Any] | None = None,
) -> MemberOut:
    """The checks after a change, then the member's sessions follow it (P4-02b), the audit event,
    and the one commit."""
    await _check_managers(db, ctx, caller)
    await apply_role_change(db, target.user_id, active_session_id=None)
    await record_audit(
        db,
        action=action,
        entity_type="membership",
        entity_id=target.id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata=metadata,
    )
    [out] = await _members_out(db, ctx.building_id, [target.id])
    await db.commit()
    return out


async def change_roles(
    db: AsyncSession, ctx: TenantContext, membership_id: UUID, data: MemberRolesIn
) -> MemberOut:
    """Give an active member the roles in `add` they don't hold, and take away those in `remove`
    they do. Nothing to change: 200 and nothing written. 409 `membership_not_active`,
    `no_roles_left`, `resident_has_unit` (ADR-0010: a unit belongs to a resident; move them out or
    transfer them first, P4-06b) or `last_manager`."""
    caller = await _lock_building(db, ctx)
    target = await _target(db, ctx, membership_id)
    if target.status != MembershipStatus.ACTIVE:
        raise MembershipNotActive(detail="Only an active member's roles can be changed.")
    held = set(
        await db.scalars(
            select(MembershipRole.role).where(
                MembershipRole.building_id == ctx.building_id,
                MembershipRole.membership_id == target.id,
            )
        )
    )
    added = sorted(set(data.add) - held)
    removed = sorted(set(data.remove) & held)
    if not added and not removed:
        # Nothing written, but a stale manager still gets their refusal, not the member.
        await _check_managers(db, ctx, caller)
        [out] = await _members_out(db, ctx.building_id, [target.id])
        await db.commit()
        return out
    if not (held - set(removed)) | set(added):
        raise NoRolesLeft(detail="A member must keep at least one role.")
    if Role.RESIDENT in removed and await db.scalar(
        select(
            exists().where(
                UnitOccupancy.building_id == ctx.building_id,
                UnitOccupancy.membership_id == target.id,
                UnitOccupancy.ended_at.is_(None),
            )
        )
    ):
        raise ResidentHasUnit(
            detail="This member lives in a unit: move them out or transfer them first."
        )
    if removed:
        await db.execute(
            delete(MembershipRole).where(
                MembershipRole.building_id == ctx.building_id,
                MembershipRole.membership_id == target.id,
                MembershipRole.role.in_(removed),
            )
        )
    if added:
        await db.execute(
            insert(MembershipRole),
            [
                {"building_id": ctx.building_id, "membership_id": target.id, "role": role}
                for role in added
            ],
        )
    return await _finish(
        db,
        ctx,
        caller,
        target,
        actions.MEMBERSHIP_ROLES_CHANGED,
        {"added": [r.value for r in added], "removed": [r.value for r in removed]},
    )


async def _transition(
    db: AsyncSession,
    ctx: TenantContext,
    target: Any,
    from_status: MembershipStatus,
    to_status: MembershipStatus,
    reason: str | None,
) -> None:
    """The conditional status change (CLAUDE.md rule 7); 409 `invalid_transition` if the member
    isn't in `from_status`."""
    changed = await db.scalar(
        update(BuildingMembership)
        .where(
            BuildingMembership.id == target.id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == from_status,
        )
        .values(
            status=to_status,
            status_reason=reason,
            status_changed_at=func.now(),
            status_changed_by_user_id=ctx.user_id,
        )
        .returning(BuildingMembership.id)
    )
    if changed is None:
        raise InvalidTransition(
            detail=f"Only a {from_status.value} member can be {to_status.value}."
        )


async def suspend_member(
    db: AsyncSession, ctx: TenantContext, membership_id: UUID, data: MemberSuspendIn
) -> MemberOut:
    """Suspend an active member, with a reason managers see. Their next request in this building
    is a 404 (`get_tenant_context` reads the status on every request); their other buildings are
    unaffected. 409 `cannot_target_self`, `invalid_transition` or `last_manager`."""
    caller = await _lock_building(db, ctx)
    target = await _target(db, ctx, membership_id)
    if target.id == ctx.membership_id:
        raise CannotTargetSelf(detail="You can't suspend yourself.")
    await _transition(
        db, ctx, target, MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED, data.reason
    )
    return await _finish(db, ctx, caller, target, actions.MEMBERSHIP_SUSPENDED)


async def reactivate_member(db: AsyncSession, ctx: TenantContext, membership_id: UUID) -> MemberOut:
    """Lift a suspension: the member is active again with the roles they had, and the reason is
    cleared. 409 `invalid_transition` unless suspended."""
    caller = await _lock_building(db, ctx)
    target = await _target(db, ctx, membership_id)
    await _transition(db, ctx, target, MembershipStatus.SUSPENDED, MembershipStatus.ACTIVE, None)
    return await _finish(db, ctx, caller, target, actions.MEMBERSHIP_REACTIVATED)
