"""Packages (P5-02a): the desk logs a package, everyone reads what `visible_packages` lets them.

`create_package` is the reference slice's write: the package, its photo claim, the notifications
with their email jobs and the audit row commit together, once (CLAUDE.md rule 5, ADR-0002). Reads
go only through `visible_packages(ctx)` (CLAUDE.md rule 3).
"""

import hashlib
import json
import re
from dataclasses import dataclass
from uuid import UUID
from zoneinfo import ZoneInfo

from sqlalchemy import func, select, update
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
from app.packages.queries import visible_packages
from app.packages.schemas import PackageCreate, PackageOut, PackageSummary
from app.tenancy.context import TenantContext
from app.units.models import Unit
from app.units.service import UnitNotFound

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
        return _replay(existing, digest)

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
        return _replay(existing, digest)

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
    out = PackageOut.model_validate(package)
    await db.commit()
    return Created(out, replayed=False)


async def _by_key(db: AsyncSession, ctx: TenantContext, key: str) -> Package | None:
    return await db.scalar(
        visible_packages(ctx)
        .where(Package.idempotency_key == key)
        .execution_options(populate_existing=True)
    )


def _replay(existing: Package, digest: str) -> Created:
    if existing.request_hash != digest:
        raise IdempotencyKeyReused(detail="This Idempotency-Key was used with a different request.")
    return Created(PackageOut.model_validate(existing), replayed=True)


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
    status: PackageStatus | None,
    unit_id: UUID | None,
) -> Page[PackageOut]:
    stmt = visible_packages(ctx)
    if status is not None:
        stmt = stmt.where(Package.status == status)
    if unit_id is not None:
        stmt = stmt.where(Package.unit_id == unit_id)
    return await paginate(db, stmt, Package.id, params, PackageOut.model_validate)


async def get_package(db: AsyncSession, ctx: TenantContext, package_id: UUID) -> PackageOut:
    package = await db.scalar(visible_packages(ctx).where(Package.id == package_id))
    if package is None:
        # The same answer for someone else's, another building's and no package (ADR-0004).
        raise PackageNotFound(detail="Package not found.")
    return PackageOut.model_validate(package)


async def package_summary(db: AsyncSession, ctx: TenantContext) -> PackageSummary:
    waiting = visible_packages(ctx).where(Package.status == PackageStatus.RECEIVED).subquery()
    count = await db.scalar(select(func.count()).select_from(waiting))
    return PackageSummary(waiting=count or 0)
