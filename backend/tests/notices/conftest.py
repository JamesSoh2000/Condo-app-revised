"""Helpers for the notices tests: a notice factory, an attachment row and persona contexts."""

import uuid
from datetime import datetime
from typing import Any

from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File, FilePurpose, FileStatus
from app.memberships.enums import Role
from app.memberships.models import BuildingMembership
from app.notices.enums import NoticePriority, NoticeStatus
from app.notices.models import Notice
from app.tenancy.context import TenantContext
from tests.packages.conftest import PERSONA_ROLES, ctx_of
from tests.world import World


def persona_ctx(world: World, name: str) -> TenantContext:
    """The context the server builds for a world persona; `multi_in_a` is `multi` in A."""
    if name == "multi_in_a":
        return ctx_of(world.multi_in_a, Role.RESIDENT)
    return ctx_of(getattr(world, name).membership, *PERSONA_ROLES[name])


def published(by: BuildingMembership, at: datetime, **overrides: Any) -> dict[str, Any]:
    """The columns of a `published` notice, as P6-01b's publish writes them."""
    return {
        "status": NoticeStatus.PUBLISHED,
        "published_at": at,
        "published_by_membership_id": by.id,
        **overrides,
    }


def archived(by: BuildingMembership, at: datetime, **overrides: Any) -> dict[str, Any]:
    return {
        "status": NoticeStatus.ARCHIVED,
        "archived_at": at,
        "archived_by_membership_id": by.id,
        **overrides,
    }


async def make_notice(db: AsyncSession, author: BuildingMembership, **overrides: Any) -> Notice:
    """A `draft` notice by `author` in their building; flushed, never committed.

    Builds the row inside the coroutine, so `assert_integrity_error` sees the violation.
    """
    values: dict[str, Any] = {
        "building_id": author.building_id,
        "title": "Water shut-off",
        "body": "The water is off on **Tuesday** from 9 to 11.",
        "priority": NoticePriority.NORMAL,
        "status": NoticeStatus.DRAFT,
        "author_membership_id": author.id,
        **overrides,
    }
    notice = Notice(**values)
    db.add(notice)
    await db.flush()
    return notice


async def make_attachment(
    db: AsyncSession, building_id: uuid.UUID, uploader_id: uuid.UUID, *, content_type: str
) -> File:
    """A `ready`, unattached notice attachment row, as `complete_file` leaves it (no S3 object)."""
    file_id = uuid.uuid7()
    file = File(
        id=file_id,
        building_id=building_id,
        uploaded_by_user_id=uploader_id,
        purpose=FilePurpose.NOTICE_ATTACHMENT,
        s3_key=f"b/{building_id}/notice_attachment/{file_id}",
        s3_version_id="v1",
        content_type=content_type,
        size_bytes=64,
        original_name="notice.pdf",
        status=FileStatus.READY,
    )
    db.add(file)
    await db.flush()
    return file
