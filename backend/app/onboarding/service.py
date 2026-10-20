"""Resident self-join (P4-05a): the join-code lookup, the unit options, the join request, and the
member's own onboarding status. Property management's list, count and decisions (P4-05b).

The join code in the path names the building, so those routes sit outside the building prefix;
`/onboarding/me` is under it, guarded by `get_own_membership` (ADR-0004), and the managers' routes
by `get_tenant_context`. `submit_request`, `approve_request` and `deny_request` commit once
(CLAUDE.md rule 5); the others only read.
"""

import re
from typing import NamedTuple
from uuid import UUID

from sqlalchemy import ColumnElement, and_, delete, exists, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.buildings.models import Building
from app.core.config import settings
from app.core.errors import Conflict, NotFound
from app.core.pagination import CursorParams, Page, paginate
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.memberships.occupancy import start_occupancy
from app.notifications.service import notify, staff_user_ids
from app.onboarding.models import OnboardingRequest, OnboardingStatus
from app.onboarding.schemas import (
    JoinBuildingOut,
    JoinRequestCreate,
    OnboardingDecisionIn,
    OnboardingMeOut,
    OnboardingRequestManagerOut,
    OnboardingRequestOut,
    OnboardingSummary,
)
from app.rate_limits.service import RateLimiter, ip_key
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.schemas import UnitOption
from app.units.service import UnitNotFound, search_unit_options
from app.users.models import User

# Anything a join code can be (`app.buildings.service._join_code` makes `XXXXX-XXXXX`; the column is
# varchar(16)). Anything else is refused before the query: a NUL would fail in Postgres.
_JOIN_CODE = re.compile(r"[A-Za-z0-9-]{1,16}")


class JoinCodeInvalid(NotFound):
    code = "join_code_invalid"


class AlreadyMember(Conflict):
    code = "already_member"


class MembershipNotEligible(Conflict):
    code = "membership_not_eligible"


class Submitted(NamedTuple):
    out: OnboardingRequestOut
    # False when the caller's pending request already existed (200, not 201).
    created: bool


class _JoinBuilding(NamedTuple):
    id: UUID
    name: str


def _invalid() -> JoinCodeInvalid:
    # One body for unknown, malformed and inactive buildings' codes.
    return JoinCodeInvalid(detail="This join link is not valid.")


async def _find_building(db: AsyncSession, join_code: str, *, lock: bool = False) -> _JoinBuilding:
    """The active building the code names, or `JoinCodeInvalid`. `lock`: FOR SHARE, so a
    deactivation of the building waits for the caller's transaction, or is seen once committed."""
    if not _JOIN_CODE.fullmatch(join_code):
        raise _invalid()
    stmt = select(Building.id, Building.name).where(
        Building.join_code == join_code, Building.is_active
    )
    if lock:
        stmt = stmt.with_for_update(read=True)
    row = (await db.execute(stmt)).one_or_none()
    if row is None:
        raise _invalid()
    return _JoinBuilding(*row)


async def lookup(
    db: AsyncSession, limiter: RateLimiter, join_code: str, *, ip: str | None
) -> JoinBuildingOut:
    """The building a join link names. Counts against the IP before the lookup (P2-05)."""
    await limiter.enforce(ip_key("join", ip), settings.rate_limit_join_ip)
    building = await _find_building(db, join_code)
    return JoinBuildingOut(building_id=building.id, building_name=building.name)


async def unit_options(db: AsyncSession, join_code: str, search: str) -> list[UnitOption]:
    """The building's active units for the join form (P4-01a `search_unit_options`). The route
    counts the request against the IP first (`join_units_limit`)."""
    building = await _find_building(db, join_code)
    return await search_unit_options(db, building.id, search)


def _request_out(
    request: OnboardingRequest, unit_label: str, tower: str | None
) -> OnboardingRequestOut:
    return OnboardingRequestOut(
        id=request.id,
        building_id=request.building_id,
        status=request.status,
        unit_id=request.unit_id,
        unit_label=unit_label,
        tower=tower,
        relationship=request.relationship,
        submitted_at=request.created_at,
    )


async def submit_request(
    db: AsyncSession, user_id: UUID, join_code: str, data: JoinRequestCreate
) -> Submitted:
    """Ask to join the code's building as a resident of `data.unit_id`: the membership `pending`
    (created, or reopened from `denied`), a `pending` request, an in-app notification to each
    active property manager, and the audit event, in one commit.

    A pending request already there is returned unchanged and nothing is written (idempotent).
    `active` → 409 `already_member`; `suspended` or `deactivated` → 409 `membership_not_eligible`
    (D4). The unit must be active and the building's, else 404 `unit_not_found`.
    """
    building = await _find_building(db, join_code, lock=True)
    membership_id = await db.scalar(
        pg_insert(BuildingMembership)
        .values(
            building_id=building.id,
            user_id=user_id,
            status=MembershipStatus.PENDING,
            status_changed_by_user_id=user_id,
        )
        # A concurrent first submission's uncommitted row makes this wait, then do nothing.
        .on_conflict_do_nothing(index_elements=["building_id", "user_id"])
        .returning(BuildingMembership.id)
    )
    if membership_id is None:
        # Before the unit is checked: a retry returns the pending request even if its unit was
        # deactivated since, or the retry names another unit (criterion 7; review round 1, F1).
        existing = await _reopen_or_refuse(db, building.id, user_id)
        if isinstance(existing, OnboardingRequestOut):
            return Submitted(existing, created=False)
        membership_id = existing
    else:
        await db.execute(
            insert(MembershipRole).values(
                building_id=building.id, membership_id=membership_id, role=Role.RESIDENT
            )
        )

    # FOR KEY SHARE (the P4-01a carry): `deactivate_unit` locks the unit FOR UPDATE, so a
    # deactivation committing now makes this wait, and `is_active` is then re-checked on the row
    # it committed. Join requests for one unit don't wait for each other.
    unit = (
        await db.execute(
            select(Unit.label, Unit.tower)
            .where(Unit.id == data.unit_id, Unit.building_id == building.id, Unit.is_active)
            .with_for_update(read=True, key_share=True)
        )
    ).one_or_none()
    if unit is None:
        # One body for another building's, an inactive and an unknown unit (ADR-0004). Raising
        # rolls back the membership written above: nothing is kept.
        raise UnitNotFound(detail="Unit not found.")

    request = OnboardingRequest(
        building_id=building.id,
        membership_id=membership_id,
        unit_id=data.unit_id,
        relationship=data.relationship,
        status=OnboardingStatus.PENDING,
    )
    db.add(request)
    await db.flush()
    await db.refresh(request, ["created_at"])
    full_name = await db.scalar(select(User.full_name).where(User.id == user_id))
    unit_name = f"{unit.tower} {unit.label}" if unit.tower else unit.label
    await notify(
        db,
        building_id=building.id,
        recipient_user_ids=await staff_user_ids(db, building.id, [Role.PROPERTY_MANAGEMENT]),
        kind="onboarding.submitted",
        title="New resident join request",
        body=f"{full_name} asked to join unit {unit_name} as {data.relationship.value}.",
        # The manager screens are P4-08's: the entity says what it is about, no path yet.
        link=None,
        entity_type="onboarding_request",
        entity_id=request.id,
    )
    await record_audit(
        db,
        action=actions.ONBOARDING_SUBMITTED,
        entity_type="onboarding_request",
        entity_id=request.id,
        building_id=building.id,
        actor_user_id=user_id,
        metadata={"membership_id": membership_id, "unit_id": data.unit_id},
    )
    out = _request_out(request, unit.label, unit.tower)
    await db.commit()
    return Submitted(out, created=True)


async def _reopen_or_refuse(
    db: AsyncSession, building_id: UUID, user_id: UUID
) -> UUID | OnboardingRequestOut:
    """The caller already has a membership here. Lock it (FOR NO KEY UPDATE: one submission at a
    time per membership), then: its pending request, if any, to return as is; or a refusal; or the
    membership's id once it is pending (reopened from `denied`) with exactly the role `resident`."""
    row = (
        await db.execute(
            select(BuildingMembership.id, BuildingMembership.status)
            .where(
                BuildingMembership.building_id == building_id,
                BuildingMembership.user_id == user_id,
            )
            .with_for_update(key_share=True)
        )
    ).one()
    membership_id: UUID = row.id
    match row.status:
        case MembershipStatus.ACTIVE:
            raise AlreadyMember(detail="You are already a member of this building.")
        case MembershipStatus.SUSPENDED | MembershipStatus.DEACTIVATED:
            raise MembershipNotEligible(
                detail="Your membership here can't be renewed by a join request; contact the "
                "building's management."
            )
        case MembershipStatus.PENDING:
            pending = (
                await db.execute(
                    select(OnboardingRequest, Unit.label, Unit.tower)
                    .join(
                        Unit,
                        and_(
                            Unit.building_id == OnboardingRequest.building_id,
                            Unit.id == OnboardingRequest.unit_id,
                        ),
                    )
                    .where(
                        OnboardingRequest.membership_id == membership_id,
                        OnboardingRequest.status == OnboardingStatus.PENDING,
                    )
                )
            ).one_or_none()
            if pending is not None:
                return _request_out(*pending)
        case MembershipStatus.DENIED:
            # Conditional (CLAUDE.md rule 7); the row lock above makes it match.
            await db.execute(
                update(BuildingMembership)
                .where(
                    BuildingMembership.id == membership_id,
                    BuildingMembership.status == MembershipStatus.DENIED,
                )
                .values(
                    status=MembershipStatus.PENDING,
                    status_changed_at=func.now(),
                    status_changed_by_user_id=user_id,
                )
            )
    # A new request is coming, from a pending or a reopened membership: exactly the role
    # `resident`. Pending grants nothing, but P4-05b's approval activates the membership's roles
    # (review round 1, L4: a pending membership without a request kept its roles).
    await db.execute(
        delete(MembershipRole).where(
            MembershipRole.building_id == building_id,
            MembershipRole.membership_id == membership_id,
        )
    )
    await db.execute(
        insert(MembershipRole).values(
            building_id=building_id, membership_id=membership_id, role=Role.RESIDENT
        )
    )
    return membership_id


async def my_status(db: AsyncSession, membership: BuildingMembership) -> OnboardingMeOut:
    """`membership` is the caller's, from `get_own_membership`."""
    latest = (
        await db.execute(
            select(
                OnboardingRequest.relationship,
                OnboardingRequest.decision_reason,
                Unit.label,
                Unit.tower,
            )
            .join(
                Unit,
                and_(
                    Unit.building_id == OnboardingRequest.building_id,
                    Unit.id == OnboardingRequest.unit_id,
                ),
            )
            .where(
                OnboardingRequest.building_id == membership.building_id,
                OnboardingRequest.membership_id == membership.id,
            )
            # uuid7: the newest request has the greatest id.
            .order_by(OnboardingRequest.id.desc())
            .limit(1)
        )
    ).one_or_none()
    return OnboardingMeOut(
        status=membership.status,
        unit_label=latest.label if latest else None,
        tower=latest.tower if latest else None,
        relationship=latest.relationship if latest else None,
        decision_reason=latest.decision_reason if latest else None,
    )


# Property management's routes (P4-05b).


class OnboardingRequestNotFound(NotFound):
    code = "onboarding_request_not_found"


class AlreadyDecided(Conflict):
    code = "already_decided"


class MembershipNotPending(Conflict):
    code = "membership_not_pending"


class UnitInactive(Conflict):
    code = "unit_inactive"


class _Details(NamedTuple):
    full_name: str
    email: str
    unit_label: str
    tower: str | None


def _membership_pending() -> ColumnElement[bool]:
    """The request's membership is still `pending`. An invitation accept (P4-02b) can activate it
    while its request stays pending; such a request can't be decided, so it isn't listed (D1)."""
    return exists().where(
        BuildingMembership.building_id == OnboardingRequest.building_id,
        BuildingMembership.id == OnboardingRequest.membership_id,
        BuildingMembership.status == MembershipStatus.PENDING,
    )


def _listed(ctx: TenantContext, status: OnboardingStatus) -> tuple[ColumnElement[bool], ...]:
    where = (OnboardingRequest.building_id == ctx.building_id, OnboardingRequest.status == status)
    return (*where, _membership_pending()) if status == OnboardingStatus.PENDING else where


async def _details(
    db: AsyncSession, building_id: UUID, request_ids: list[UUID]
) -> dict[UUID, _Details]:
    """Who asked and for which unit, for each request, in one query."""
    rows = await db.execute(
        select(OnboardingRequest.id, User.full_name, User.email, Unit.label, Unit.tower)
        .join(
            BuildingMembership,
            and_(
                BuildingMembership.building_id == OnboardingRequest.building_id,
                BuildingMembership.id == OnboardingRequest.membership_id,
            ),
        )
        .join(User, User.id == BuildingMembership.user_id)
        .join(
            Unit,
            and_(
                Unit.building_id == OnboardingRequest.building_id,
                Unit.id == OnboardingRequest.unit_id,
            ),
        )
        .where(OnboardingRequest.building_id == building_id, OnboardingRequest.id.in_(request_ids))
    )
    return {row.id: _Details(*row[1:]) for row in rows}


def _manager_out(request: OnboardingRequest, details: _Details) -> OnboardingRequestManagerOut:
    return OnboardingRequestManagerOut(
        id=request.id,
        full_name=details.full_name,
        email=details.email,
        unit_id=request.unit_id,
        unit_label=details.unit_label,
        tower=details.tower,
        relationship=request.relationship,
        status=request.status,
        submitted_at=request.created_at,
        decided_at=request.decided_at,
        decision_reason=request.decision_reason,
    )


async def list_requests(
    db: AsyncSession, ctx: TenantContext, params: CursorParams, status: OnboardingStatus
) -> Page[OnboardingRequestManagerOut]:
    page = await paginate(
        db,
        select(OnboardingRequest).where(*_listed(ctx, status)),
        OnboardingRequest.id,
        params,
        lambda request: request,
    )
    details = await _details(db, ctx.building_id, [request.id for request in page.items])
    return Page(
        items=[_manager_out(request, details[request.id]) for request in page.items],
        next_cursor=page.next_cursor,
    )


async def pending_summary(db: AsyncSession, ctx: TenantContext) -> OnboardingSummary:
    count = await db.scalar(
        select(func.count()).where(*_listed(ctx, OnboardingStatus.PENDING))
    )
    return OnboardingSummary(pending_onboarding_count=count or 0)


async def _decide(
    db: AsyncSession,
    ctx: TenantContext,
    request_id: UUID,
    decision: OnboardingStatus,
    reason: str | None,
) -> tuple[OnboardingRequest, UUID]:
    """Decide a pending request of the building, then move its membership out of `pending`; return
    the request and the member's user id. Never commits.

    Both are conditional UPDATEs (CLAUDE.md rule 7). Of two concurrent decisions the second waits on
    the request's row and then matches nothing: 409 `already_decided`. A membership that is no
    longer pending (D1) is 409 `membership_not_pending`, and raising rolls the request back too.
    """
    request = await db.scalar(
        update(OnboardingRequest)
        .where(
            OnboardingRequest.id == request_id,
            OnboardingRequest.building_id == ctx.building_id,
            OnboardingRequest.status == OnboardingStatus.PENDING,
        )
        .values(
            status=decision,
            decided_at=func.now(),
            decided_by_user_id=ctx.user_id,
            decision_reason=reason,
        )
        .returning(OnboardingRequest)
    )
    if request is None:
        found = await db.scalar(
            select(OnboardingRequest.id).where(
                OnboardingRequest.id == request_id,
                OnboardingRequest.building_id == ctx.building_id,
            )
        )
        if found is None:
            # The same answer for another building's request and none at all (ADR-0004).
            raise OnboardingRequestNotFound(detail="Join request not found.")
        raise AlreadyDecided(detail="This join request has already been decided.")
    user_id = await db.scalar(
        update(BuildingMembership)
        .where(
            BuildingMembership.id == request.membership_id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.PENDING,
        )
        .values(
            status=(
                MembershipStatus.ACTIVE
                if decision == OnboardingStatus.APPROVED
                else MembershipStatus.DENIED
            ),
            status_changed_at=func.now(),
            status_changed_by_user_id=ctx.user_id,
        )
        .returning(BuildingMembership.user_id)
    )
    if user_id is None:
        raise MembershipNotPending(
            detail="This person's membership changed since they asked to join; reload the list."
        )
    return request, user_id


async def _decided_out(
    db: AsyncSession, ctx: TenantContext, request: OnboardingRequest
) -> tuple[OnboardingRequestManagerOut, _Details, str]:
    details = (await _details(db, ctx.building_id, [request.id]))[request.id]
    building_name = await db.scalar(select(Building.name).where(Building.id == ctx.building_id))
    assert building_name is not None  # noqa: S101 (the tenant context's building)
    return _manager_out(request, details), details, building_name


def _unit_name(details: _Details) -> str:
    return f"{details.tower} {details.unit_label}" if details.tower else details.unit_label


async def approve_request(
    db: AsyncSession, ctx: TenantContext, request_id: UUID
) -> OnboardingRequestManagerOut:
    """Approve a pending join request: the request `approved`, the membership `active` (its role is
    `resident`, set by the submission), a current occupancy of the request's unit with its
    relationship, the resident notified in-app and by email, and two audit events, in one commit.

    409 `unit_inactive` if the unit was deactivated since the request: the manager denies it then.
    """
    request, user_id = await _decide(db, ctx, request_id, OnboardingStatus.APPROVED, None)
    # FOR KEY SHARE (the P4-01a carry), as the submission: `deactivate_unit` locks the unit FOR
    # UPDATE, so a deactivation committing now makes this wait, and `is_active` is then read from
    # the row it committed; a deactivation after this commit sees the occupancy and is refused.
    unit_active = await db.scalar(
        select(Unit.is_active)
        .where(Unit.building_id == ctx.building_id, Unit.id == request.unit_id)
        .with_for_update(read=True, key_share=True)
    )
    if not unit_active:
        raise UnitInactive(detail="This unit is deactivated: deny the request instead.")
    await start_occupancy(
        db,
        building_id=ctx.building_id,
        membership_id=request.membership_id,
        unit_id=request.unit_id,
        relationship=request.relationship,
    )
    out, details, building_name = await _decided_out(db, ctx, request)
    await notify(
        db,
        building_id=ctx.building_id,
        recipient_user_ids=[user_id],
        kind="membership.approved",
        # Fixed: `title` is at most 200 characters, a building's name alone can be.
        title="Your join request was approved",
        body=f"{building_name} approved your request to join unit {_unit_name(details)} as "
        f"{request.relationship.value}.",
        link=None,
        entity_type="onboarding_request",
        entity_id=request.id,
    )
    await record_audit(
        db,
        action=actions.ONBOARDING_APPROVED,
        entity_type="onboarding_request",
        entity_id=request.id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata={"membership_id": request.membership_id, "unit_id": request.unit_id},
    )
    await record_audit(
        db,
        action=actions.MEMBERSHIP_ACTIVATED,
        entity_type="membership",
        entity_id=request.membership_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata={"onboarding_request_id": request.id},
    )
    await db.commit()
    return out


async def deny_request(
    db: AsyncSession, ctx: TenantContext, request_id: UUID, data: OnboardingDecisionIn
) -> OnboardingRequestManagerOut:
    """Deny a pending join request with a reason: the request `denied`, the membership `denied`, the
    resident notified in-app and by email with the reason, and the audit event (IDs only), in one
    commit. The resident may then submit a new request (`submit_request` reopens the membership)."""
    request, user_id = await _decide(db, ctx, request_id, OnboardingStatus.DENIED, data.reason)
    out, details, building_name = await _decided_out(db, ctx, request)
    await notify(
        db,
        building_id=ctx.building_id,
        recipient_user_ids=[user_id],
        kind="membership.denied",
        title="Your join request was declined",
        body=f"{building_name} declined your request to join unit {_unit_name(details)}. "
        f"Reason: {data.reason}",
        link=None,
        entity_type="onboarding_request",
        entity_id=request.id,
    )
    await record_audit(
        db,
        action=actions.ONBOARDING_DENIED,
        entity_type="onboarding_request",
        entity_id=request.id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        # Never the reason: audit metadata holds IDs only (CLAUDE.md rule 10).
        metadata={"membership_id": request.membership_id, "unit_id": request.unit_id},
    )
    await db.commit()
    return out
