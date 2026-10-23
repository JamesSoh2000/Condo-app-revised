"""Packages (P5-02a, P5-02b): the desk logs a package and hands it out or returns it; everyone
reads what `visible_packages` lets them.

`create_package` is the reference slice's write: the package, its photo claim, the notifications
with their email jobs and the audit row commit together, once (CLAUDE.md rule 5, ADR-0002).
`pickup_package` and `return_package` are its reference transitions: a conditional
`UPDATE … WHERE status IN (…) RETURNING` decides which of two concurrent ones wins (CLAUDE.md
rule 7). Reads go only through `visible_packages(ctx)` (CLAUDE.md rule 3).
"""

import hashlib
import json
import re
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, or_, select, update
from sqlalchemy.dialects.postgresql import insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.buildings.models import Building
from app.core.errors import BadRequest, Conflict, NotFound, UnprocessableContent
from app.core.pagination import CursorParams, Page, paginate
from app.files.models import FilePurpose
from app.files.service import claim_file
from app.memberships.enums import MembershipStatus
from app.memberships.models import BuildingMembership, UnitOccupancy
from app.notifications.service import notify, unit_resident_user_ids
from app.packages.enums import PackageStatus
from app.packages.models import PACKAGE_ATTACHED_TYPE, Package
from app.packages.queries import sees_recipient_names, visible_packages
from app.packages.schemas import (
    Carrier,
    PackageColumns,
    PackageCreate,
    PackageOut,
    PackagePickup,
    PackageReturn,
    PackageSummary,
)
from app.packages.state import assert_transition, sources
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.service import UnitNotFound
from app.users.models import User

# Visible ASCII, no spaces: what a client generates (a UUID, a ULID) and repeats byte for byte.
_IDEMPOTENCY_KEY = re.compile(r"[!-~]{8,80}")


class IdempotencyKeyRequired(BadRequest):
    code = "idempotency_key_required"


class InvalidIdempotencyKey(BadRequest):
    code = "invalid_idempotency_key"


class IdempotencyKeyReused(Conflict):
    code = "idempotency_key_reused"


class PackageNotFound(NotFound):
    code = "package_not_found"


class UnitInactive(Conflict):
    code = "unit_inactive"


class InvalidRecipient(UnprocessableContent):
    code = "invalid_recipient"


class InvalidPickupMember(UnprocessableContent):
    code = "invalid_pickup_member"


@dataclass(frozen=True)
class Created:
    package: PackageOut
    # True when the key's package already existed: nothing was written.
    replayed: bool


def check_idempotency_key(key: str | None) -> str:
    if key is None:
        raise IdempotencyKeyRequired(detail="Send an Idempotency-Key header (8-80 characters).")
    if _IDEMPOTENCY_KEY.fullmatch(key) is None:
        raise InvalidIdempotencyKey(
            detail="The Idempotency-Key must be 8-80 visible ASCII characters, without spaces."
        )
    return key


def request_hash(data: PackageCreate) -> str:
    """sha256 of the validated body: every field, keys sorted, so a retry that spells the same
    request differently (key order, spacing, an explicit null) is the same request."""
    canonical = json.dumps(data.model_dump(mode="json"), sort_keys=True, separators=(",", ":"))
    return hashlib.sha256(canonical.encode()).hexdigest()


async def create_package(
    db: AsyncSession, ctx: TenantContext, data: PackageCreate, idempotency_key: str | None
) -> Created:
    """Log a package once per key; a retry of the same request replays it, writing nothing."""
    key = check_idempotency_key(idempotency_key)
    digest = request_hash(data)
    # First, so a retry gets the original even if the unit was deactivated or the photo attached
    # (to this package) since.
    existing = await _by_key(db, ctx, key)
    if existing is not None:
        return await _replay(db, ctx, existing, digest)

    # FOR KEY SHARE (the P4-01a carry, as P4-05a's join): a deactivation committing now makes this
    # wait, and `is_active` is then read from the row it committed.
    unit = (
        await db.execute(
            select(Unit.label, Unit.tower, Unit.is_active)
            .where(Unit.id == data.unit_id, Unit.building_id == ctx.building_id)
            .with_for_update(read=True, key_share=True)
        )
    ).one_or_none()
    if unit is None:
        # One body for another building's unit and none (ADR-0004).
        raise UnitNotFound(detail="Unit not found.")
    if not unit.is_active:
        raise UnitInactive(detail="This unit is deactivated.")
    recipient_user_id = None
    if data.recipient_membership_id is not None:
        recipient_user_id = await _recipient_user_id(db, ctx, data)

    # DO NOTHING: a concurrent first request with this key waits here for the other to finish, then
    # finds its row. The photo is attached below, by the request whose insert won.
    package_id = await db.scalar(
        insert(Package)
        .values(
            building_id=ctx.building_id,
            unit_id=data.unit_id,
            recipient_membership_id=data.recipient_membership_id,
            carrier=data.carrier,
            description=data.description,
            tracking_last4=data.tracking_last4,
            status=PackageStatus.RECEIVED,
            received_by_membership_id=ctx.membership_id,
            idempotency_key=key,
            request_hash=digest,
        )
        .on_conflict_do_nothing(index_elements=[Package.building_id, Package.idempotency_key])
        .returning(Package.id)
    )
    if package_id is None:
        # READ COMMITTED: this statement sees the row the other request committed.
        existing = await _by_key(db, ctx, key)
        assert existing is not None  # noqa: S101 (the conflicting row is committed)
        return await _replay(db, ctx, existing, digest)

    if data.photo_file_id is not None:
        # Both sides (the file's attachment and the package's column) must agree for the photo
        # hook to grant it (app.packages.photos, the P5-01 carry).
        await claim_file(
            db,
            ctx,
            data.photo_file_id,
            FilePurpose.PACKAGE_PHOTO,
            PACKAGE_ATTACHED_TYPE,
            package_id,
        )
        await db.execute(
            update(Package).where(Package.id == package_id).values(photo_file_id=data.photo_file_id)
        )
    package = await db.scalar(select(Package).where(Package.id == package_id))
    assert package is not None  # noqa: S101 (inserted above)

    building = (
        await db.execute(
            select(Building.name, Building.timezone).where(Building.id == ctx.building_id)
        )
    ).one()
    unit_name = f"{unit.tower} {unit.label}" if unit.tower else unit.label
    received_at = package.received_at.astimezone(ZoneInfo(building.timezone))
    await notify(
        db,
        building_id=ctx.building_id,
        # The named recipient, or else whoever lives there now with an active membership (the
        # P1-03 carry): a former or suspended occupant isn't told.
        recipient_user_ids=(
            [recipient_user_id]
            if recipient_user_id is not None
            else await unit_resident_user_ids(db, ctx.building_id, data.unit_id)
        ),
        kind="package.arrived",
        # Fixed: the carrier is the only staff text in it, and at most 50 characters.
        title="A package is waiting at the desk",
        body=f"{data.carrier} delivered a package for unit {unit_name}.",
        link=f"/packages/{package_id}",
        entity_type=PACKAGE_ATTACHED_TYPE,
        entity_id=package_id,
        email_context={
            "building_name": building.name,
            "carrier": data.carrier,
            "unit": unit_name,
            "received_at": received_at.strftime("%Y-%m-%d %H:%M %Z"),
        },
    )
    await record_audit(
        db,
        action=actions.PACKAGE_RECEIVED,
        entity_type=PACKAGE_ATTACHED_TYPE,
        entity_id=package_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata={
            "unit_id": data.unit_id,
            "recipient_membership_id": data.recipient_membership_id,
            "photo_file_id": data.photo_file_id,
        },
    )
    out = await _out(db, ctx, package)
    await db.commit()
    return Created(out, replayed=False)


async def _by_key(db: AsyncSession, ctx: TenantContext, key: str) -> Package | None:
    return await db.scalar(
        visible_packages(ctx)
        .where(Package.idempotency_key == key)
        .execution_options(populate_existing=True)
    )


async def _replay(db: AsyncSession, ctx: TenantContext, existing: Package, digest: str) -> Created:
    if existing.request_hash != digest:
        raise IdempotencyKeyReused(detail="This Idempotency-Key was used with a different request.")
    return Created(await _out(db, ctx, existing), replayed=True)


async def _outs(
    db: AsyncSession, ctx: TenantContext, packages: Sequence[PackageColumns]
) -> list[PackageOut]:
    """`packages` with their units' current tower and label and, for the desk, their recipients'
    current names (P5-03a): two statements at most, however many packages."""
    if not packages:
        return []
    units = {
        row.id: row
        for row in await db.execute(
            select(Unit.id, Unit.tower, Unit.label).where(
                Unit.building_id == ctx.building_id,
                Unit.id.in_({package.unit_id for package in packages}),
            )
        )
    }
    recipient_ids = {
        package.recipient_membership_id
        for package in packages
        if package.recipient_membership_id is not None
    }
    names: dict[UUID, str] = {}
    if recipient_ids and sees_recipient_names(ctx):
        rows = await db.execute(
            select(BuildingMembership.id, User.full_name)
            .join(User, User.id == BuildingMembership.user_id)
            .where(
                BuildingMembership.building_id == ctx.building_id,
                BuildingMembership.id.in_(recipient_ids),
            )
        )
        names = {membership_id: full_name for membership_id, full_name in rows}
    return [
        PackageOut(
            **package.model_dump(),
            # The composite FKs keep both in the package's building, so the lookups find them.
            unit_tower=units[package.unit_id].tower,
            unit_label=units[package.unit_id].label,
            recipient_name=(
                None
                if package.recipient_membership_id is None
                else names.get(package.recipient_membership_id)
            ),
        )
        for package in packages
    ]


async def _out(db: AsyncSession, ctx: TenantContext, package: Package) -> PackageOut:
    [out] = await _outs(db, ctx, [PackageColumns.model_validate(package)])
    return out


async def _recipient_user_id(db: AsyncSession, ctx: TenantContext, data: PackageCreate) -> UUID:
    """The recipient's user: an active membership of this building with a current occupancy of the
    package's unit. One answer for every refusal, so another building's id looks unknown."""
    user_id = await db.scalar(
        select(BuildingMembership.user_id)
        .join(
            UnitOccupancy,
            (UnitOccupancy.membership_id == BuildingMembership.id)
            & (UnitOccupancy.building_id == BuildingMembership.building_id),
        )
        .where(
            BuildingMembership.id == data.recipient_membership_id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            UnitOccupancy.unit_id == data.unit_id,
            UnitOccupancy.ended_at.is_(None),
        )
    )
    if user_id is None:
        raise InvalidRecipient(detail="The recipient must currently live in this unit.")
    return user_id


async def list_packages(
    db: AsyncSession,
    ctx: TenantContext,
    params: CursorParams,
    *,
    status: Sequence[PackageStatus] | None,
    unit_id: UUID | None,
    carrier: Carrier | None,
) -> Page[PackageOut]:
    stmt = visible_packages(ctx)
    if status:
        stmt = stmt.where(Package.status.in_(status))
    if unit_id is not None:
        stmt = stmt.where(Package.unit_id == unit_id)
    if carrier is not None:
        # Both sides lower-cased by Postgres: Python's `str.lower` differs for some letters.
        stmt = stmt.where(func.lower(Package.carrier) == func.lower(carrier))
    page = await paginate(db, stmt, Package.id, params, PackageColumns.model_validate)
    return Page[PackageOut](items=await _outs(db, ctx, page.items), next_cursor=page.next_cursor)


async def get_package(db: AsyncSession, ctx: TenantContext, package_id: UUID) -> PackageOut:
    package = await db.scalar(visible_packages(ctx).where(Package.id == package_id))
    if package is None:
        # The same answer for someone else's, another building's and no package (ADR-0004).
        raise PackageNotFound(detail="Package not found.")
    return await _out(db, ctx, package)


async def package_summary(db: AsyncSession, ctx: TenantContext) -> PackageSummary:
    waiting = visible_packages(ctx).where(Package.status == PackageStatus.RECEIVED).subquery()
    count = await db.scalar(select(func.count()).select_from(waiting))
    return PackageSummary(waiting=count or 0)


async def pickup_package(
    db: AsyncSession, ctx: TenantContext, package_id: UUID, data: PackagePickup
) -> PackageOut:
    """Hand a `received` package out, to a member who may collect it or a name typed at the desk,
    and tell its recipient (in-app). 404, 409 `invalid_transition`, 422 `invalid_pickup_member`."""
    package = await _for_transition(db, ctx, package_id, PackageStatus.PICKED_UP)
    member_id = data.picked_up_by_membership_id
    if member_id is not None:
        # Before the UPDATE: an unchecked id of another building would fail its composite FK there.
        await _check_pickup_member(db, ctx, package, member_id)
    picked_up = await _transition(
        db,
        ctx,
        package_id,
        PackageStatus.PICKED_UP,
        picked_up_at=func.clock_timestamp(),
        picked_up_by_membership_id=member_id,
        picked_up_by_name=data.picked_up_by_name,
        handed_out_by_membership_id=ctx.membership_id,
    )
    await notify(
        db,
        building_id=ctx.building_id,
        recipient_user_ids=await _recipient_user_ids(db, ctx, picked_up),
        kind="package.picked_up",
        title="Your package was picked up",
        body=f"The {picked_up.carrier} package at the desk was picked up.",
        link=f"/packages/{package_id}",
        entity_type=PACKAGE_ATTACHED_TYPE,
        entity_id=package_id,
    )
    await record_audit(
        db,
        action=actions.PACKAGE_PICKED_UP,
        entity_type=PACKAGE_ATTACHED_TYPE,
        entity_id=package_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        # Field names only: the typed name stays out of the audit (CLAUDE.md rule 10).
        metadata={
            "unit_id": picked_up.unit_id,
            "picked_up_by_membership_id": member_id,
            "picked_up_by": "member" if member_id is not None else "name",
        },
    )
    out = await _out(db, ctx, picked_up)
    await db.commit()
    return out


async def return_package(
    db: AsyncSession, ctx: TenantContext, package_id: UUID, data: PackageReturn
) -> PackageOut:
    """Send a `received` package back to the carrier. 404, 409 `invalid_transition`."""
    await _for_transition(db, ctx, package_id, PackageStatus.RETURNED)
    returned = await _transition(
        db,
        ctx,
        package_id,
        PackageStatus.RETURNED,
        returned_at=func.clock_timestamp(),
        return_reason=data.reason,
    )
    await record_audit(
        db,
        action=actions.PACKAGE_RETURNED,
        entity_type=PACKAGE_ATTACHED_TYPE,
        entity_id=package_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata={"unit_id": returned.unit_id},
    )
    out = await _out(db, ctx, returned)
    await db.commit()
    return out


async def _for_transition(
    db: AsyncSession, ctx: TenantContext, package_id: UUID, to: PackageStatus
) -> Package:
    """The package as it is now, if it may become `to`: 404, else 409 `invalid_transition`. An
    early answer only; the conditional UPDATE in `_transition` decides."""
    package = await db.scalar(
        visible_packages(ctx)
        .where(Package.id == package_id)
        .execution_options(populate_existing=True)
    )
    if package is None:
        # The same answer for another building's package and none (ADR-0004).
        raise PackageNotFound(detail="Package not found.")
    assert_transition(package.status, to)
    return package


async def _transition(
    db: AsyncSession, ctx: TenantContext, package_id: UUID, to: PackageStatus, **values: Any
) -> Package:
    """Move the package to `to` if it is still in a status that may (CLAUDE.md rule 7).

    Under READ COMMITTED a concurrent transition holding the row makes this UPDATE wait; once it
    commits, Postgres re-checks the WHERE on the row it wrote, finds another status and updates
    nothing. Zero rows: re-read to answer 404 or 409 `invalid_transition` from the current status.
    """
    package = await db.scalar(
        update(Package)
        .where(
            Package.id == package_id,
            Package.building_id == ctx.building_id,
            Package.status.in_(sources(to)),
        )
        .values(status=to, **values)
        .returning(Package)
        .execution_options(populate_existing=True)
    )
    if package is not None:
        return package
    current = await _for_transition(db, ctx, package_id, to)
    # Unreachable: the UPDATE would have matched a package that may still become `to`.
    raise AssertionError(f"package {current.id} matched no transition to {to}")


async def _check_pickup_member(
    db: AsyncSession, ctx: TenantContext, package: Package, membership_id: UUID
) -> None:
    """422 `invalid_pickup_member` unless the membership may collect `package`: an active member
    of this building who is its named recipient or lives in its unit now (PRODUCT_SCOPE "Package
    pickup", the P1-03 carry). One answer for every refusal, so another building's id looks
    unknown."""
    # FOR SHARE first: status and occupancy writes lock the membership row FOR NO KEY UPDATE
    # (app.memberships), so one in flight finishes before the next statement, which (READ
    # COMMITTED) then reads what it committed. Locking within one joined SELECT would re-check only
    # the membership's new row, not the occupancy joined to it.
    await db.execute(
        select(BuildingMembership.id)
        .where(
            BuildingMembership.id == membership_id,
            BuildingMembership.building_id == ctx.building_id,
        )
        .with_for_update(read=True)
    )
    lives_there = (
        select(UnitOccupancy.id)
        .where(
            UnitOccupancy.building_id == ctx.building_id,
            UnitOccupancy.membership_id == BuildingMembership.id,
            UnitOccupancy.unit_id == package.unit_id,
            UnitOccupancy.ended_at.is_(None),
        )
        .exists()
    )
    may_collect = await db.scalar(
        select(BuildingMembership.id).where(
            BuildingMembership.id == membership_id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            or_(BuildingMembership.id == package.recipient_membership_id, lives_there),
        )
    )
    if may_collect is None:
        raise InvalidPickupMember(
            detail="Only the recipient or someone who lives in the unit can collect this package."
        )


async def _recipient_user_ids(db: AsyncSession, ctx: TenantContext, package: Package) -> list[UUID]:
    """Who hears of the pickup: the named recipient while their membership is active, or for a
    package addressed to the unit, its current active occupants (as at arrival)."""
    if package.recipient_membership_id is None:
        return await unit_resident_user_ids(db, ctx.building_id, package.unit_id)
    user_id = await db.scalar(
        select(BuildingMembership.user_id).where(
            BuildingMembership.id == package.recipient_membership_id,
            BuildingMembership.building_id == ctx.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
        )
    )
    return [user_id] if user_id is not None else []
