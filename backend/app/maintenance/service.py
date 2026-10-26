"""Maintenance requests (P6-03b): a resident files one and may cancel it while it is `submitted`;
every member reads what `visible_maintenance` lets them.

`create_request` follows `app.packages.service.create_package`: the request, its photo claims and
rows, the managers' notifications and the audit row commit together, once (CLAUDE.md rule 5).
`cancel_request` is a conditional `UPDATE … WHERE status IN (…) RETURNING` that also names the
requester, so of two concurrent writes one wins and nobody else's request is cancelled (CLAUDE.md
rule 7). Reads go only through `visible_maintenance(ctx)` (CLAUDE.md rule 3).
"""

from collections.abc import Sequence
from dataclasses import dataclass
from uuid import UUID

from sqlalchemy import func, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.core.errors import Forbidden, NotFound, UnprocessableContent
from app.core.pagination import CursorParams, Page, paginate
from app.files.models import FilePurpose
from app.files.service import claim_file
from app.maintenance.enums import MaintenanceCategory, MaintenanceStatus
from app.maintenance.models import (
    MAINTENANCE_REQUEST_ATTACHED_TYPE,
    MaintenanceRequest,
    MaintenanceRequestPhoto,
)
from app.maintenance.queries import sees_requester_names, visible_maintenance
from app.maintenance.schemas import (
    MaintenanceRequestColumns,
    MaintenanceRequestCreate,
    MaintenanceRequestOut,
)
from app.maintenance.state import assert_transition, sources
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, UnitOccupancy
from app.notifications.service import notify, staff_user_ids
from app.packages.service import (
    IdempotencyKeyReused,
    UnitInactive,
    check_idempotency_key,
    request_hash,
)
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.service import UnitNotFound
from app.users.models import User

# `users.phone`'s length (ADR-0021).
MAX_EMERGENCY_PHONE = 32

# The notification's words for each category (P6-03b D5): fixed text, never the resident's.
_CATEGORY_NAMES = {
    MaintenanceCategory.PLUMBING: "Plumbing",
    MaintenanceCategory.ELECTRICAL: "Electrical",
    MaintenanceCategory.HEATING_COOLING: "Heating or cooling",
    MaintenanceCategory.APPLIANCE: "Appliance",
    MaintenanceCategory.DOORS_WINDOWS: "Doors or windows",
    MaintenanceCategory.PEST_CONTROL: "Pest control",
    MaintenanceCategory.OTHER: "Other",
    MaintenanceCategory.EMERGENCY: "Emergency",
}


class MaintenanceRequestNotFound(NotFound):
    code = "maintenance_request_not_found"


class UnitNotOccupied(UnprocessableContent):
    code = "unit_not_occupied"


class NotRequester(Forbidden):
    code = "not_requester"


@dataclass(frozen=True)
class Created:
    request: MaintenanceRequestOut
    # True when the key's request already existed: nothing was written.
    replayed: bool


async def create_request(
    db: AsyncSession,
    ctx: TenantContext,
    data: MaintenanceRequestCreate,
    idempotency_key: str | None,
) -> Created:
    """File a request once per key; a retry of the same request replays it, writing nothing."""
    key = check_idempotency_key(idempotency_key)
    digest = request_hash(data)
    # First, so a retry gets the original even if the unit was deactivated or the caller moved
    # since.
    existing = await _by_key(db, ctx, key)
    if existing is not None:
        return await _replay(db, ctx, existing, digest)
    unit_name = await _check_unit(db, ctx, data.unit_id) if data.unit_id is not None else None

    # DO NOTHING: a concurrent first request with this key waits here for the other to finish, then
    # finds its row. The photos are claimed below, by the request whose insert won.
    request_id = await db.scalar(
        insert(MaintenanceRequest)
        .values(
            building_id=ctx.building_id,
            requester_membership_id=ctx.membership_id,
            location=data.location,
            unit_id=data.unit_id,
            common_area=data.common_area,
            category=data.category,
            description=data.description,
            status=MaintenanceStatus.SUBMITTED,
            # After the occupancy check's lock, not the transaction's start (`now()`): the time
            # falls inside the occupancy the check found (the CLAUDE.md lesson).
            submitted_at=func.clock_timestamp(),
            idempotency_key=key,
            request_hash=digest,
        )
        .on_conflict_do_nothing(
            index_elements=[MaintenanceRequest.building_id, MaintenanceRequest.idempotency_key]
        )
        .returning(MaintenanceRequest.id)
    )
    if request_id is None:
        # READ COMMITTED: this statement sees the row the other request committed.
        existing = await _by_key(db, ctx, key)
        assert existing is not None  # noqa: S101 (the conflicting row is committed)
        return await _replay(db, ctx, existing, digest)

    # Both sides (the file's attachment and the photo row) must agree for the photo hook to grant
    # it (app.maintenance.photos); positions 0..n-1 in the order sent.
    for file_id in data.photo_file_ids:
        await claim_file(
            db,
            ctx,
            file_id,
            FilePurpose.MAINTENANCE_PHOTO,
            MAINTENANCE_REQUEST_ATTACHED_TYPE,
            request_id,
        )
    if data.photo_file_ids:
        await db.execute(
            insert(MaintenanceRequestPhoto).values(
                [
                    {
                        "building_id": ctx.building_id,
                        "request_id": request_id,
                        "position": position,
                        "file_id": file_id,
                    }
                    for position, file_id in enumerate(data.photo_file_ids)
                ]
            )
        )

    emergency = data.category == MaintenanceCategory.EMERGENCY
    managers = await staff_user_ids(db, ctx.building_id, [Role.PROPERTY_MANAGEMENT])
    where = f"unit {unit_name}" if unit_name is not None else "a common area"
    await notify(
        db,
        building_id=ctx.building_id,
        # Never the requester, who may also manage the building.
        recipient_user_ids=[user_id for user_id in managers if user_id != ctx.user_id],
        kind="maintenance.submitted_emergency" if emergency else "maintenance.submitted",
        # Fixed words and the unit's name only: no description or common-area text reaches an
        # email (D5).
        title="Emergency maintenance request" if emergency else "New maintenance request",
        body=f"{_CATEGORY_NAMES[data.category]} request for {where}.",
        link=f"/maintenance/{request_id}",
        entity_type=MAINTENANCE_REQUEST_ATTACHED_TYPE,
        entity_id=request_id,
    )
    await record_audit(
        db,
        action=actions.MAINTENANCE_SUBMITTED,
        entity_type=MAINTENANCE_REQUEST_ATTACHED_TYPE,
        entity_id=request_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata={
            "unit_id": data.unit_id,
            "category": data.category,
            "photo_file_ids": data.photo_file_ids,
        },
    )
    request = await db.scalar(select(MaintenanceRequest).where(MaintenanceRequest.id == request_id))
    assert request is not None  # noqa: S101 (inserted above)
    out = await _out(db, ctx, request)
    await db.commit()
    return Created(out, replayed=False)


async def _by_key(db: AsyncSession, ctx: TenantContext, key: str) -> MaintenanceRequest | None:
    """The caller's own request with this key; 409 if another member's holds it (the key is unique
    per building, D7), so their request is neither replayed nor hidden behind a 500."""
    own = await db.scalar(
        visible_maintenance(ctx)
        .where(
            MaintenanceRequest.idempotency_key == key,
            MaintenanceRequest.requester_membership_id == ctx.membership_id,
        )
        .execution_options(populate_existing=True)
    )
    if own is not None:
        return own
    taken = await db.scalar(
        select(MaintenanceRequest.id).where(
            MaintenanceRequest.building_id == ctx.building_id,
            MaintenanceRequest.idempotency_key == key,
        )
    )
    if taken is not None:
        raise IdempotencyKeyReused(detail="This Idempotency-Key was used with a different request.")
    return None


async def _replay(
    db: AsyncSession, ctx: TenantContext, existing: MaintenanceRequest, digest: str
) -> Created:
    if existing.request_hash != digest:
        raise IdempotencyKeyReused(detail="This Idempotency-Key was used with a different request.")
    return Created(await _out(db, ctx, existing), replayed=True)


async def _check_unit(db: AsyncSession, ctx: TenantContext, unit_id: UUID) -> str:
    """The unit's name, if the caller lives there now: 404 `unit_not_found`, 409 `unit_inactive`,
    422 `unit_not_occupied`. The occupancy stays locked until commit."""
    # FOR KEY SHARE (as `create_package`): a deactivation committing now makes this wait.
    unit = (
        await db.execute(
            select(Unit.label, Unit.tower, Unit.is_active)
            .where(Unit.id == unit_id, Unit.building_id == ctx.building_id)
            .with_for_update(read=True, key_share=True)
        )
    ).one_or_none()
    if unit is None:
        # One body for another building's unit and none (ADR-0004).
        raise UnitNotFound(detail="Unit not found.")
    if not unit.is_active:
        raise UnitInactive(detail="This unit is deactivated.")
    # FOR SHARE first: every occupancy write locks the membership FOR NO KEY UPDATE
    # (`app.memberships.occupancy._prepare`), so a move-out in flight finishes before the next
    # statement, which (READ COMMITTED) reads what it committed; one starting later waits for this
    # commit. FOR KEY SHARE would not conflict with it.
    await db.execute(
        select(BuildingMembership.id)
        .where(
            BuildingMembership.id == ctx.membership_id,
            BuildingMembership.building_id == ctx.building_id,
        )
        .with_for_update(read=True)
    )
    lives_there = await db.scalar(
        select(UnitOccupancy.id)
        .join(
            BuildingMembership,
            (BuildingMembership.id == UnitOccupancy.membership_id)
            & (BuildingMembership.building_id == UnitOccupancy.building_id),
        )
        .where(
            UnitOccupancy.building_id == ctx.building_id,
            UnitOccupancy.membership_id == ctx.membership_id,
            UnitOccupancy.unit_id == unit_id,
            UnitOccupancy.ended_at.is_(None),
            # Re-read after the lock: a suspension committed since the tenant context was built.
            BuildingMembership.status == MembershipStatus.ACTIVE,
        )
    )
    if lives_there is None:
        raise UnitNotOccupied(detail="You can file a request only for the unit you live in.")
    return f"{unit.tower} {unit.label}" if unit.tower else unit.label


async def emergency_phone(db: AsyncSession, building_id: UUID) -> str | None:
    """The building's emergency phone (ADR-0021): the maintenance feature's
    `config["emergency_phone"]`. Anything but a non-blank string of at most 32 characters reads as
    none: `config` is JSONB, which no column type checks."""
    config = await db.scalar(
        select(BuildingFeature.config).where(
            BuildingFeature.building_id == building_id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
    )
    phone = config.get("emergency_phone") if isinstance(config, dict) else None
    if not isinstance(phone, str) or not phone.strip() or len(phone) > MAX_EMERGENCY_PHONE:
        return None
    return phone.strip()


async def _outs(
    db: AsyncSession, ctx: TenantContext, requests: Sequence[MaintenanceRequestColumns]
) -> list[MaintenanceRequestOut]:
    """`requests` with their photos, their units' current tower and label, for staff their
    requesters' current names, and the emergency phone: four statements at most, however many."""
    if not requests:
        return []
    ids = [request.id for request in requests]
    photos: dict[UUID, list[UUID]] = {request_id: [] for request_id in ids}
    for request_id, file_id in await db.execute(
        select(MaintenanceRequestPhoto.request_id, MaintenanceRequestPhoto.file_id)
        .where(
            MaintenanceRequestPhoto.building_id == ctx.building_id,
            MaintenanceRequestPhoto.request_id.in_(ids),
        )
        .order_by(MaintenanceRequestPhoto.request_id, MaintenanceRequestPhoto.position)
    ):
        photos[request_id].append(file_id)
    unit_ids = {request.unit_id for request in requests if request.unit_id is not None}
    units = {}
    if unit_ids:
        units = {
            row.id: row
            for row in await db.execute(
                select(Unit.id, Unit.tower, Unit.label).where(
                    Unit.building_id == ctx.building_id, Unit.id.in_(unit_ids)
                )
            )
        }
    names: dict[UUID, str] = {}
    if sees_requester_names(ctx):
        rows = await db.execute(
            select(BuildingMembership.id, User.full_name)
            .join(User, User.id == BuildingMembership.user_id)
            .where(
                BuildingMembership.building_id == ctx.building_id,
                BuildingMembership.id.in_({r.requester_membership_id for r in requests}),
            )
        )
        names = {membership_id: full_name for membership_id, full_name in rows}
    phone = None
    if any(request.category == MaintenanceCategory.EMERGENCY for request in requests):
        phone = await emergency_phone(db, ctx.building_id)
    return [
        MaintenanceRequestOut(
            **request.model_dump(),
            photo_file_ids=photos[request.id],
            # The composite FK keeps the unit in the request's building, so the lookup finds it.
            unit_tower=units[request.unit_id].tower if request.unit_id is not None else None,
            unit_label=units[request.unit_id].label if request.unit_id is not None else None,
            requester_name=names.get(request.requester_membership_id),
            emergency_phone=phone if request.category == MaintenanceCategory.EMERGENCY else None,
        )
        for request in requests
    ]


async def _out(
    db: AsyncSession, ctx: TenantContext, request: MaintenanceRequest
) -> MaintenanceRequestOut:
    [out] = await _outs(db, ctx, [MaintenanceRequestColumns.model_validate(request)])
    return out


async def list_requests(
    db: AsyncSession, ctx: TenantContext, params: CursorParams, *, status: MaintenanceStatus | None
) -> Page[MaintenanceRequestOut]:
    stmt = visible_maintenance(ctx)
    if status is not None:
        stmt = stmt.where(MaintenanceRequest.status == status)
    # `id DESC` (uuid7: newest first): equal `submitted_at`s can't skip or repeat a row (D6).
    page = await paginate(
        db, stmt, MaintenanceRequest.id, params, MaintenanceRequestColumns.model_validate
    )
    return Page[MaintenanceRequestOut](
        items=await _outs(db, ctx, page.items), next_cursor=page.next_cursor
    )


async def get_request(
    db: AsyncSession, ctx: TenantContext, request_id: UUID
) -> MaintenanceRequestOut:
    return await _out(db, ctx, await _visible(db, ctx, request_id))


async def _visible(db: AsyncSession, ctx: TenantContext, request_id: UUID) -> MaintenanceRequest:
    request = await db.scalar(
        visible_maintenance(ctx)
        .where(MaintenanceRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    if request is None:
        # The same answer for someone else's, another building's and no request (ADR-0004).
        raise MaintenanceRequestNotFound(detail="Maintenance request not found.")
    return request


async def cancel_request(
    db: AsyncSession, ctx: TenantContext, request_id: UUID
) -> MaintenanceRequestOut:
    """Withdraw the caller's own `submitted` request. 404, 403 `not_requester` (a co-occupant's,
    D3), 409 `invalid_transition`."""
    # Read now: the UPDATE's RETURNING refreshes the same object.
    from_status = (await _for_cancel(db, ctx, request_id)).status
    # The requester is in the WHERE, not only checked above: the UPDATE decides (CLAUDE.md rule 7).
    # A concurrent start holding the row makes this wait; once it commits, Postgres re-checks the
    # WHERE on the row it wrote and updates nothing.
    cancelled = await db.scalar(
        update(MaintenanceRequest)
        .where(
            MaintenanceRequest.id == request_id,
            MaintenanceRequest.building_id == ctx.building_id,
            MaintenanceRequest.requester_membership_id == ctx.membership_id,
            MaintenanceRequest.status.in_(sources(MaintenanceStatus.CANCELLED)),
        )
        .values(
            status=MaintenanceStatus.CANCELLED,
            cancelled_at=func.clock_timestamp(),
            cancelled_by_membership_id=ctx.membership_id,
        )
        .returning(MaintenanceRequest)
        .execution_options(populate_existing=True)
    )
    if cancelled is None:
        # Zero rows: answer 404, 403 or 409 from the request as it is now.
        current = await _for_cancel(db, ctx, request_id)
        raise AssertionError(f"maintenance request {current.id} matched no cancel")
    await record_audit(
        db,
        action=actions.MAINTENANCE_CANCELLED,
        entity_type=MAINTENANCE_REQUEST_ATTACHED_TYPE,
        entity_id=request_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        # The UPDATE matched, so the request was still in a status it may be cancelled from.
        metadata={"from_status": from_status},
    )
    out = await _out(db, ctx, cancelled)
    await db.commit()
    return out


async def _for_cancel(db: AsyncSession, ctx: TenantContext, request_id: UUID) -> MaintenanceRequest:
    """The request as it is now, if the caller may cancel it: 404 unless visible, 403 unless
    theirs, else 409 unless `submitted`. An early answer only; the UPDATE decides."""
    request = await _visible(db, ctx, request_id)
    if request.requester_membership_id != ctx.membership_id:
        raise NotRequester(detail="Only the resident who filed this request can cancel it.")
    assert_transition(request.status, MaintenanceStatus.CANCELLED)
    return request
