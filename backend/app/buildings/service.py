"""Reading a building for its members (the tenant context has already authorized the caller), and
provisioning a new one for the operator command `bootstrap-building` (P4-03)."""

import secrets
from dataclasses import dataclass, field
from uuid import UUID

from sqlalchemy import insert, select
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.buildings.schemas import BootstrapInput, BuildingOut
from app.core import clock
from app.invitations.service import add_invitation
from app.memberships.enums import Role
from app.tenancy.context import TenantContext
from app.units.service import ParsedUnits, import_units

# No 0, O, 1, I or L, which read alike when a resident types the code.
JOIN_CODE_ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ"
_JOIN_CODE_GROUP = 5


async def get_building(db: AsyncSession, ctx: TenantContext) -> BuildingOut:
    building = (
        await db.execute(select(Building).where(Building.id == ctx.building_id))
    ).scalar_one()
    return BuildingOut(
        id=building.id,
        name=building.name,
        slug=building.slug,
        timezone=building.timezone,
        locale=building.locale,
        # Sorted by value, as /api/auth/me sorts roles.
        my_roles=sorted(ctx.roles),
        features=sorted(ctx.features),
    )


class SlugExists(ValueError):
    """Another building has the slug."""


@dataclass(frozen=True)
class BootstrapResult:
    # None in a dry run, which writes nothing.
    building_id: UUID | None
    join_code: str | None
    unit_count: int
    invitation_id: UUID | None
    # The accept link's token, for the CLI to print once. Kept out of repr, so a log line or a
    # traceback that shows the result doesn't show it.
    token: str | None = field(repr=False)


def _join_code() -> str:
    chars = "".join(secrets.choice(JOIN_CODE_ALPHABET) for _ in range(2 * _JOIN_CODE_GROUP))
    return f"{chars[:_JOIN_CODE_GROUP]}-{chars[_JOIN_CODE_GROUP:]}"


def _slug_exists(slug: str) -> SlugExists:
    return SlugExists(f"slug already exists: {slug}")


async def bootstrap_building(
    db: AsyncSession, data: BootstrapInput, units: ParsedUnits | None, *, dry_run: bool
) -> BootstrapResult:
    """Create the building, its features and units, and a `property_management` invitation for
    its first manager (with the email queued), and record `building.bootstrapped`. A dry run only
    checks the slug. Flushes, never commits: the CLI commits once, so a failure writes nothing.

    `units` must hold no invalid rows (the CLI refuses them first, P4-03 D3).
    """
    unit_count = 0 if units is None else len(units.rows)
    if dry_run:
        if await db.scalar(select(Building.id).where(Building.slug == data.slug)) is not None:
            raise _slug_exists(data.slug)
        return BootstrapResult(None, None, unit_count, None, None)
    join_code = _join_code()
    # ON CONFLICT: a concurrent bootstrap of the slug makes this wait, then return nothing,
    # instead of an IntegrityError.
    building_id = await db.scalar(
        pg_insert(Building)
        .values(
            slug=data.slug,
            name=data.name,
            address=data.address,
            timezone=data.timezone,
            locale=data.locale,
            join_code=join_code,
        )
        .on_conflict_do_nothing(index_elements=["slug"])
        .returning(Building.id)
    )
    if building_id is None:
        raise _slug_exists(data.slug)
    if data.features:
        await db.execute(
            insert(BuildingFeature),
            [
                {
                    "building_id": building_id,
                    "feature": feature,
                    # The feature's settings (ADR-0022): only maintenance has one yet.
                    "config": {"emergency_phone": data.emergency_phone}
                    if feature == Feature.MAINTENANCE and data.emergency_phone is not None
                    else {},
                }
                for feature in data.features
            ],
        )
    if units is not None:
        report = await import_units(db, building_id, units, dry_run=False, audit=False)
        unit_count = report.created
    building = await db.get_one(Building, building_id)
    invitation, token = await add_invitation(
        db,
        building,
        email=data.manager_email,
        roles=[Role.PROPERTY_MANAGEMENT],
        created_by_user_id=None,
        now=clock.now(),
    )
    await record_audit(
        db,
        action=actions.BUILDING_BOOTSTRAPPED,
        entity_type="building",
        entity_id=building_id,
        building_id=building_id,
        metadata={
            "operator": data.operator,
            "reason": data.reason,
            "invitation_id": invitation.id,
            "units": unit_count,
        },
    )
    await db.flush()
    return BootstrapResult(building_id, join_code, unit_count, invitation.id, token)


def render_bootstrap(data: BootstrapInput, result: BootstrapResult, *, dry_run: bool) -> str:
    """The plan or the summary; never the accept URL, which the CLI prints on its own line."""
    lines = ["dry run: nothing was written"] if dry_run else []
    lines += [
        f"slug: {data.slug}",
        f"name: {data.name}",
        f"timezone: {data.timezone}",
        f"locale: {data.locale}",
        f"features: {', '.join(data.features) or 'none'}",
        f"units: {result.unit_count}",
        f"invitation: {data.manager_email} ({Role.PROPERTY_MANAGEMENT})",
    ]
    if data.manager_name is not None:
        lines.append(f"manager name: {data.manager_name}")
    if data.emergency_phone is not None:
        lines.append(f"emergency phone: {data.emergency_phone}")
    if result.building_id is not None:
        lines += [f"building id: {result.building_id}", f"join code: {result.join_code}"]
    return "\n".join(lines)
