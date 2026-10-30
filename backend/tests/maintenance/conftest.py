"""Helpers for the maintenance tests: request, photo and comment factories, and each status's
columns."""

import uuid
from datetime import datetime, timedelta
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File, FilePurpose, FileStatus
from app.maintenance.enums import MaintenanceCategory, MaintenanceLocation, MaintenanceStatus
from app.maintenance.models import (
    MaintenanceComment,
    MaintenanceRequest,
    MaintenanceRequestPhoto,
)
from app.memberships.models import BuildingMembership
from app.units.models import Unit


def status_columns(status: MaintenanceStatus, at: datetime, by: uuid.UUID) -> dict[str, Any]:
    """The columns a row of `status` must carry (P6-03a D3), its `*_at` 1-2 h after `at`."""
    started = {"started_at": at + timedelta(hours=1), "started_by_membership_id": by}
    match status:
        case MaintenanceStatus.SUBMITTED:
            return {}
        case MaintenanceStatus.IN_PROGRESS:
            return started
        case MaintenanceStatus.ON_HOLD:
            return started | {"on_hold_at": at + timedelta(hours=2), "on_hold_by_membership_id": by}
        case MaintenanceStatus.RESOLVED:
            return started | {
                "resolved_at": at + timedelta(hours=2),
                "resolved_by_membership_id": by,
            }
        case MaintenanceStatus.CANCELLED:
            return {"cancelled_at": at + timedelta(hours=1), "cancelled_by_membership_id": by}


async def make_maintenance_request(
    db: AsyncSession,
    requester: BuildingMembership,
    unit: Unit | None,
    *,
    submitted_at: datetime | None = None,
    status: MaintenanceStatus = MaintenanceStatus.SUBMITTED,
    acted_by: BuildingMembership | None = None,
    **overrides: Any,
) -> MaintenanceRequest:
    """A request by `requester` for `unit` (a common-area one if `unit` is None), with `status`'s
    columns set by `acted_by` (the requester if omitted); flushed, never committed.

    `submitted_at` None means the database's `now()`; the status columns then hang off Python's
    clock, so pass `submitted_at` when the order of times matters. Builds the row inside the
    coroutine, so `assert_integrity_error` sees the violation.
    """
    at = submitted_at or datetime.now().astimezone()
    values: dict[str, Any] = {
        "building_id": requester.building_id,
        "requester_membership_id": requester.id,
        "location": MaintenanceLocation.UNIT if unit else MaintenanceLocation.COMMON_AREA,
        "unit_id": unit.id if unit else None,
        "common_area": None if unit else "Lobby",
        "category": MaintenanceCategory.PLUMBING,
        "description": "The kitchen tap drips.",
        "status": status,
        "idempotency_key": f"test-{uuid.uuid4()}",
        "request_hash": "0" * 64,
        **status_columns(status, at, (acted_by or requester).id),
    }
    if submitted_at is not None:
        values["submitted_at"] = submitted_at
    values.update(overrides)
    request = MaintenanceRequest(**values)
    db.add(request)
    await db.flush()
    return request


async def make_maintenance_file(
    db: AsyncSession, building_id: uuid.UUID, uploader_id: uuid.UUID
) -> File:
    """A `ready`, unattached maintenance photo row, as `complete_file` leaves it (no S3 object)."""
    file_id = uuid.uuid7()
    file = File(
        id=file_id,
        building_id=building_id,
        uploaded_by_user_id=uploader_id,
        purpose=FilePurpose.MAINTENANCE_PHOTO,
        s3_key=f"b/{building_id}/maintenance_photo/{file_id}",
        s3_version_id="v1",
        content_type="image/png",
        size_bytes=64,
        original_name="tap.png",
        status=FileStatus.READY,
    )
    db.add(file)
    await db.flush()
    return file


async def make_maintenance_photo(
    db: AsyncSession,
    request: MaintenanceRequest,
    file_id: uuid.UUID,
    position: int = 0,
    **overrides: Any,
) -> MaintenanceRequestPhoto:
    """A photo row listing `file_id` on `request`; flushed, never committed."""
    values: dict[str, Any] = {
        "building_id": request.building_id,
        "request_id": request.id,
        "file_id": file_id,
        "position": position,
        **overrides,
    }
    photo = MaintenanceRequestPhoto(**values)
    db.add(photo)
    await db.flush()
    return photo


async def make_maintenance_comment(
    db: AsyncSession,
    request: MaintenanceRequest,
    author: BuildingMembership,
    *,
    internal: bool = False,
    author_is_staff: bool | None = None,
    **overrides: Any,
) -> MaintenanceComment:
    """A comment by `author` on `request` (staff if `internal`, unless `author_is_staff` says);
    flushed, never committed. Pass `created_at` (and its uuid7 `id` order) when times matter."""
    values: dict[str, Any] = {
        "building_id": request.building_id,
        "request_id": request.id,
        "author_membership_id": author.id,
        "author_is_staff": internal if author_is_staff is None else author_is_staff,
        "body": "Internal note." if internal else "On it this afternoon.",
        "is_internal": internal,
        **overrides,
    }
    comment = MaintenanceComment(**values)
    db.add(comment)
    await db.flush()
    return comment
