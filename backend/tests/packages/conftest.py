"""Helpers for the packages tests: a package factory and a tenant context for a world persona."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File, FilePurpose, FileStatus
from app.memberships.enums import Role
from app.memberships.models import BuildingMembership
from app.packages.enums import PackageStatus
from app.packages.models import Package
from app.tenancy.context import TenantContext
from app.units.models import Unit
from tests.world import Member, World


def ctx_of(membership: BuildingMembership, *roles: Role) -> TenantContext:
    """What `get_tenant_context` builds for this membership with these roles."""
    return TenantContext(
        user_id=membership.user_id,
        building_id=membership.building_id,
        membership_id=membership.id,
        roles=frozenset(roles),
        features=frozenset(),
    )


def ctx_for(member: Member, *roles: Role) -> TenantContext:
    return ctx_of(member.membership, *roles)


# The world personas' roles (tests/world.py), so a context matches what the server would build.
PERSONA_ROLES: dict[str, tuple[Role, ...]] = {
    "a_manager": (Role.PROPERTY_MANAGEMENT,),
    "a_security": (Role.SECURITY,),
    "a_resident1": (Role.RESIDENT,),
    "a_resident2": (Role.RESIDENT,),
    "a_council": (Role.COUNCIL, Role.RESIDENT),
    "a_former": (Role.RESIDENT,),
    "b_manager": (Role.PROPERTY_MANAGEMENT,),
    "b_resident1": (Role.RESIDENT,),
}


def persona_ctx(world: World, name: str) -> TenantContext:
    member: Member = getattr(world, name)
    return ctx_for(member, *PERSONA_ROLES[name])


async def make_package(
    db: AsyncSession,
    unit: Unit,
    received_by: BuildingMembership,
    *,
    received_at: datetime | None = None,
    **overrides: Any,
) -> Package:
    """A `received` package for `unit`, logged by `received_by`; flushed, never committed.

    Builds the row inside the coroutine, so `assert_integrity_error` sees the violation.
    """
    values: dict[str, Any] = {
        "building_id": unit.building_id,
        "unit_id": unit.id,
        "carrier": "UPS",
        "description": "Small box",
        "status": PackageStatus.RECEIVED,
        "received_by_membership_id": received_by.id,
        "idempotency_key": f"test-{uuid.uuid4()}",
        "request_hash": "0" * 64,
    }
    if received_at is not None:
        values["received_at"] = received_at
    values.update(overrides)
    package = Package(**values)
    db.add(package)
    await db.flush()
    return package


async def make_photo(db: AsyncSession, building_id: uuid.UUID, uploader_id: uuid.UUID) -> File:
    """A `ready`, unattached package photo row, as `complete_file` leaves it (no S3 object)."""
    file_id = uuid.uuid7()
    file = File(
        id=file_id,
        building_id=building_id,
        uploaded_by_user_id=uploader_id,
        purpose=FilePurpose.PACKAGE_PHOTO,
        s3_key=f"b/{building_id}/package_photo/{file_id}",
        s3_version_id="v1",
        content_type="image/png",
        size_bytes=64,
        original_name="box.png",
        status=FileStatus.READY,
    )
    db.add(file)
    await db.flush()
    return file
