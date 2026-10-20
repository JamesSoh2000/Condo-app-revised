"""Resident self-join (P4-05a): the join-code lookup, the unit options, the join request, and the
member's own onboarding status. Deciding a request is P4-05b's.

The join code in the path names the building, so these routes sit outside the building prefix; only
`/onboarding/me` is under it, guarded by `get_own_membership` (ADR-0004). `submit_request` commits
once (CLAUDE.md rule 5); the others only read.
"""

import re
from typing import NamedTuple
from uuid import UUID

from sqlalchemy import and_, delete, func, insert, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.buildings.models import Building
from app.core.config import settings
from app.core.errors import Conflict, NotFound
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.notifications.service import notify, staff_user_ids
from app.onboarding.models import OnboardingRequest, OnboardingStatus
from app.onboarding.schemas import (
    JoinBuildingOut,
    JoinRequestCreate,
    OnboardingMeOut,
    OnboardingRequestOut,
)
from app.rate_limits.service import RateLimiter, ip_key
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
    # FOR KEY SHARE (the P4-01a carry): `deactivate_unit` locks the unit FOR UPDATE, so a
    # deactivation committing now makes this wait, and `is_active` is then re-checked on the row
    # it committed.
    unit = (
        await db.execute(
            select(Unit.label, Unit.tower)
            .where(Unit.id == data.unit_id, Unit.building_id == building.id, Unit.is_active)
            .with_for_update(key_share=True)
        )
    ).one_or_none()
    if unit is None:
        # One body for another building's, an inactive and an unknown unit (ADR-0004).
        raise UnitNotFound(detail="Unit not found.")

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
    """The caller already has a membership here. Lock it (one submission at a time per membership),
    then: its pending request, if any, to return as is; or the membership's id once it is pending
    (reopened from `denied`, with exactly the role `resident`); or a refusal."""
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
            return membership_id
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
            # Pending grants nothing, but P4-05b's approval activates the membership's roles.
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
