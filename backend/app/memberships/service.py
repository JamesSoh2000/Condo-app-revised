"""Membership administration (P4-06a, P4-06b): the member list, role changes, suspend and
reactivate, move-out (deactivate) and transfer.

Every write takes the building row lock first (`_lock_building`), so these writes run one at a
time per building, and reads the caller again under it. It makes its change, then
`_check_managers` counts the building's active managers and refuses a caller who lost their
authority while waiting. A refusal raises, which rolls the change back. Every write commits once
(CLAUDE.md rule 5); `list_members` only reads.
"""

from collections import defaultdict
from collections.abc import Iterator, Sequence
from contextlib import contextmanager
from typing import Any, NamedTuple
from uuid import UUID

from sqlalchemy import and_, delete, exists, func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.auth.service import apply_role_change
from app.buildings.models import Building
from app.core import clock
from app.core.errors import Conflict, DomainError, NotFound
from app.core.pagination import CursorParams, Page, paginate
from app.invitations.models import Invitation
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.occupancy import OccupancyTimeError, end_occupancy, transfer_occupancy
from app.memberships.schemas import (
    MemberDeactivateIn,
    MemberOut,
    MemberRolesIn,
    MemberSuspendIn,
    MemberTransferIn,
)
from app.tenancy.context import TenantContext
from app.tenancy.deps import BuildingNotFound, ForbiddenRole
from app.units.models import Unit
from app.units.service import UnitNotFound
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


class NotAResident(Conflict):
    code = "not_a_resident"


class UnitInactive(Conflict):
    code = "unit_inactive"


class OccupancyChanged(Conflict):
    code = "occupancy_changed"


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


class Caller(NamedTuple):
    """The caller's membership as it stands once the building lock is held."""

    active: bool
    manager: bool


async def read_caller(db: AsyncSession, ctx: TenantContext) -> Caller:
    """The caller's membership read again, after the building lock. Their tenant context was read
    before they waited for it; a manager may have demoted or suspended them meanwhile (D2). Every
    manager write that takes the building lock reads it: these and the invitations' (review round
    1, F1)."""
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
    return Caller(active=caller.status == MembershipStatus.ACTIVE, manager=caller.manager)


def refuse_stale(caller: Caller) -> None:
    """What the caller's next request would get: 404 if no longer active, 403 without the role."""
    if not caller.active:
        raise BuildingNotFound(detail="Building not found.")
    if not caller.manager:
        raise ForbiddenRole(detail="Your role in this building does not allow this.")


@contextmanager
def _caller_first(caller: Caller) -> Iterator[None]:
    """A caller who lost their authority gets that refusal instead of any error about the target,
    so they learn nothing about a member of a building they can no longer manage (review round 1,
    F2). Their write itself still runs to the last-manager count: of two managers demoting each
    other, the second gets 409 `last_manager` (criterion 3), also when `change_roles` raises it
    early, inside this block (P4-06b, the open Medium of PR #93)."""
    try:
        yield
    except LastManager:
        raise
    except DomainError:
        refuse_stale(caller)
        raise


async def _lock_building(db: AsyncSession, ctx: TenantContext) -> Caller:
    """Lock the building row (NO KEY UPDATE, as the invitations' writes; foreign-key checks from
    other tables don't wait for it) until the transaction ends. Every write here takes it first:
    they run one at a time per building, and each reads what the previous one committed.

    Then `read_caller`: before this write's own change, so a manager may still drop their own
    role."""
    await db.execute(
        select(Building.id).where(Building.id == ctx.building_id).with_for_update(key_share=True)
    )
    return await read_caller(db, ctx)


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


async def _check_managers(db: AsyncSession, ctx: TenantContext, caller: Caller) -> None:
    """After the change: the building still has an active manager who can log in (409
    `last_manager`; an inactive user has no session, review round 1), checked first, so of two
    managers demoting each other the second gets that. Then the caller, as `_lock_building` read
    them (`refuse_stale`)."""
    await _require_a_manager(db, ctx)
    refuse_stale(caller)


async def _require_a_manager(
    db: AsyncSession, ctx: TenantContext, *, besides: UUID | None = None
) -> None:
    """409 `last_manager` unless the building has an active manager who can log in, other than the
    membership `besides`."""
    stmt = (
        select(func.count())
        .select_from(BuildingMembership)
        .join(User, User.id == BuildingMembership.user_id)
        .where(
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            User.is_active,
            _holds(Role.PROPERTY_MANAGEMENT),
        )
    )
    if besides is not None:
        stmt = stmt.where(BuildingMembership.id != besides)
    if not await db.scalar(stmt):
        raise LastManager(detail="The building must keep at least one active property manager.")


async def _revoke_invitations_of_former_manager(
    db: AsyncSession, ctx: TenantContext, target: Any
) -> None:
    """If the target is no longer an active manager here, revoke the open invitations they created
    in this building (P4-06b D1): an invitation carries its creator's authority. Under the building
    lock, which an accept also takes: an accept either committed first or sees the revocation."""
    still_manager = await db.scalar(
        select(BuildingMembership.id).where(
            BuildingMembership.id == target.id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            _holds(Role.PROPERTY_MANAGEMENT),
        )
    )
    if still_manager is not None:
        return
    revoked = await db.scalars(
        update(Invitation)
        .where(
            Invitation.building_id == ctx.building_id,
            Invitation.created_by_user_id == target.user_id,
            # Open, expired ones included: a resend would make them pending again.
            Invitation.accepted_at.is_(None),
            Invitation.revoked_at.is_(None),
        )
        .values(revoked_at=clock.now())
        .returning(Invitation.id)
    )
    for invitation_id in sorted(revoked):
        await record_audit(
            db,
            action=actions.INVITATION_REVOKED,
            entity_type="invitation",
            entity_id=invitation_id,
            building_id=ctx.building_id,
            actor_user_id=ctx.user_id,
            metadata={"membership_id": target.id},
        )


async def _finish(
    db: AsyncSession,
    ctx: TenantContext,
    caller: Caller,
    target: Any,
    action: str,
    metadata: dict[str, Any] | None = None,
) -> MemberOut:
    """The checks after a change, then the target's invitations if they stopped being a manager,
    the member's sessions follow the change (P4-02b), the audit event, and the one commit."""
    await _check_managers(db, ctx, caller)
    await _revoke_invitations_of_former_manager(db, ctx, target)
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
    with _caller_first(caller):
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
            refuse_stale(caller)
            [out] = await _members_out(db, ctx.building_id, [target.id])
            await db.commit()
            return out
        if not (held - set(removed)) | set(added):
            if Role.PROPERTY_MANAGEMENT in removed:
                # Criterion 4 names `last_manager` when both apply (review round 2, Codex M1).
                await _require_a_manager(db, ctx, besides=target.id)
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
    from_statuses: tuple[MembershipStatus, ...],
    to_status: MembershipStatus,
    reason: str | None,
    refusal: str,
) -> None:
    """The conditional status change (CLAUDE.md rule 7); 409 `invalid_transition` with the detail
    `refusal` if the member isn't in one of `from_statuses`."""
    changed = await db.scalar(
        update(BuildingMembership)
        .where(
            BuildingMembership.id == target.id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status.in_(from_statuses),
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
        raise InvalidTransition(detail=refusal)


async def suspend_member(
    db: AsyncSession, ctx: TenantContext, membership_id: UUID, data: MemberSuspendIn
) -> MemberOut:
    """Suspend an active member, with a reason managers see. Their next request in this building
    is a 404 (`get_tenant_context` reads the status on every request); their other buildings are
    unaffected. 409 `cannot_target_self`, `invalid_transition` or `last_manager`."""
    caller = await _lock_building(db, ctx)
    with _caller_first(caller):
        target = await _target(db, ctx, membership_id)
        if target.id == ctx.membership_id:
            raise CannotTargetSelf(detail="You can't suspend yourself.")
        await _transition(
            db,
            ctx,
            target,
            (MembershipStatus.ACTIVE,),
            MembershipStatus.SUSPENDED,
            data.reason,
            "Only an active member can be suspended.",
        )
    return await _finish(db, ctx, caller, target, actions.MEMBERSHIP_SUSPENDED)


async def reactivate_member(db: AsyncSession, ctx: TenantContext, membership_id: UUID) -> MemberOut:
    """Lift a suspension: the member is active again with the roles they had, and the reason is
    cleared. 409 `invalid_transition` unless suspended."""
    caller = await _lock_building(db, ctx)
    with _caller_first(caller):
        target = await _target(db, ctx, membership_id)
        await _transition(
            db,
            ctx,
            target,
            (MembershipStatus.SUSPENDED,),
            MembershipStatus.ACTIVE,
            None,
            "Only a suspended member can be reactivated.",
        )
    return await _finish(db, ctx, caller, target, actions.MEMBERSHIP_REACTIVATED)


@contextmanager
def _occupancy_changed() -> Iterator[None]:
    """The occupancy helpers' `OccupancyTimeError` as 409 `occupancy_changed` (P4-06b D2). This
    transaction's `now()` is from before it waited: a concurrent writer committed a newer
    occupancy for the member meanwhile. Raised inside `_caller_first`, so a stale caller still
    gets their own refusal first."""
    try:
        yield
    except OccupancyTimeError as exc:
        raise OccupancyChanged(
            detail="This member's unit changed while you were acting; reload and try again."
        ) from exc


async def deactivate_member(
    db: AsyncSession, ctx: TenantContext, membership_id: UUID, data: MemberDeactivateIn
) -> MemberOut:
    """Move-out: an active or suspended member becomes `deactivated`, with a reason managers see,
    and their current occupancy ends now (ADR-0010), so records for that unit from now on aren't
    theirs. Roles and history are kept. Their next request in this building is a 404; their other
    buildings are unaffected. 409 `cannot_target_self`, `invalid_transition`, `last_manager` or
    `occupancy_changed`."""
    caller = await _lock_building(db, ctx)
    with _caller_first(caller):
        target = await _target(db, ctx, membership_id)
        if target.id == ctx.membership_id:
            raise CannotTargetSelf(detail="You can't deactivate yourself.")
        await _transition(
            db,
            ctx,
            target,
            (MembershipStatus.ACTIVE, MembershipStatus.SUSPENDED),
            MembershipStatus.DEACTIVATED,
            data.reason,
            "Only an active or suspended member can be deactivated.",
        )
        with _occupancy_changed():
            # Never a client time (ADR-0016): the helper uses the transaction's now().
            ended = await end_occupancy(db, building_id=ctx.building_id, membership_id=target.id)
    return await _finish(
        db,
        ctx,
        caller,
        target,
        actions.MEMBERSHIP_DEACTIVATED,
        {"unit_id": ended.unit_id if ended is not None else None},
    )


async def transfer_member(
    db: AsyncSession, ctx: TenantContext, membership_id: UUID, data: MemberTransferIn
) -> MemberOut:
    """Move an active resident to `data.unit_id` with `data.relationship`: the current occupancy (if
    any) ends and the new one starts at the same instant, so history is kept. The same unit and
    relationship: 200, nothing written. 409 `membership_not_active`, `not_a_resident`,
    `unit_inactive`, `last_manager` or `occupancy_changed`; 404 `unit_not_found` for a unit that
    isn't this building's (CLAUDE.md rule 2)."""
    caller = await _lock_building(db, ctx)
    with _caller_first(caller):
        target = await _target(db, ctx, membership_id)
        if target.status != MembershipStatus.ACTIVE:
            raise MembershipNotActive(detail="Only an active member can be transferred.")
        if not await db.scalar(
            select(
                exists().where(
                    MembershipRole.building_id == ctx.building_id,
                    MembershipRole.membership_id == target.id,
                    MembershipRole.role == Role.RESIDENT,
                )
            )
        ):
            # ADR-0010: an occupancy belongs to a resident membership.
            raise NotAResident(detail="Only a resident can be given a unit.")
        # FOR KEY SHARE, as P4-05b's approve: a unit deactivation (FOR UPDATE) committing now makes
        # this wait and `is_active` is read as it committed; one after this sees the occupancy.
        unit_active = await db.scalar(
            select(Unit.is_active)
            .where(Unit.id == data.unit_id, Unit.building_id == ctx.building_id)
            .with_for_update(read=True, key_share=True)
        )
        if unit_active is None:
            raise UnitNotFound(detail="Unit not found.")
        if not unit_active:
            raise UnitInactive(detail="This unit is deactivated.")
        # Read after the target's lock: occupancy writes for the member lock it too.
        current = (
            await db.execute(
                select(UnitOccupancy.unit_id, UnitOccupancy.relationship).where(
                    UnitOccupancy.building_id == ctx.building_id,
                    UnitOccupancy.membership_id == target.id,
                    UnitOccupancy.ended_at.is_(None),
                )
            )
        ).one_or_none()
        if current is not None and tuple(current) == (data.unit_id, data.relationship):
            # Nothing to change, as `change_roles`; a stale manager still gets their refusal.
            refuse_stale(caller)
            [out] = await _members_out(db, ctx.building_id, [target.id])
            await db.commit()
            return out
        with _occupancy_changed():
            await transfer_occupancy(
                db,
                building_id=ctx.building_id,
                membership_id=target.id,
                new_unit_id=data.unit_id,
                relationship=data.relationship,
            )
    return await _finish(
        db,
        ctx,
        caller,
        target,
        actions.OCCUPANCY_TRANSFERRED,
        {
            "from_unit_id": current.unit_id if current is not None else None,
            "to_unit_id": data.unit_id,
        },
    )
