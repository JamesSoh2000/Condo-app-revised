"""Notices (P6-01b): the manager writes, edits, publishes and archives them; every member reads
what `visible_notices` lets them.

Each write locks the notice row (`_locked`), checks the state machine, then writes with a
conditional `UPDATE … WHERE status IN (…) RETURNING` (CLAUDE.md rule 7); the attachment claim and
the audit row commit with it, once (CLAUDE.md rule 5). Reads go only through `visible_notices(ctx)`
(CLAUDE.md rule 3).
"""

from datetime import datetime
from typing import Any
from uuid import UUID, uuid7

from sqlalchemy import func, insert, or_, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.service import record_audit
from app.core.errors import Conflict, NotFound, UnprocessableContent
from app.core.pagination import CursorParams, Page, paginate
from app.files.models import FilePurpose
from app.files.service import claim_file
from app.notices.enums import NoticeStatus
from app.notices.models import NOTICE_ATTACHED_TYPE, Notice
from app.notices.queries import visible_notices
from app.notices.schemas import NoticeCreate, NoticeOut, NoticeUpdate
from app.notices.state import assert_transition, sources
from app.tenancy.context import TenantContext


class NoticeNotFound(NotFound):
    code = "notice_not_found"


class NoticeNotEditable(Conflict):
    code = "notice_not_editable"


class NoticeExpired(UnprocessableContent):
    code = "notice_expired"


# One value per statement, so a WHERE and a SET that both read it agree (`clock_timestamp()` is
# read per call), and read after any lock the statement's row needed (`now()` is the transaction's
# start).
_NOW = func.statement_timestamp()


async def create_notice(db: AsyncSession, ctx: TenantContext, data: NoticeCreate) -> NoticeOut:
    """Write a `draft`, with its attachment claimed for it."""
    notice_id = uuid7()
    if data.attachment_file_id is not None:
        # Before the insert: another building's file is a 404 here, not a composite-FK error.
        await _claim(db, ctx, data.attachment_file_id, notice_id)
    if data.expires_at is not None:
        # After the claim, which can wait on the file's lock (the P4-02b lesson; review round 1).
        await _check_future(db, data.expires_at)
    notice = await db.scalar(
        insert(Notice)
        .values(
            id=notice_id,
            building_id=ctx.building_id,
            title=data.title,
            body=data.body,
            priority=data.priority,
            status=NoticeStatus.DRAFT,
            expires_at=data.expires_at,
            attachment_file_id=data.attachment_file_id,
            author_membership_id=ctx.membership_id,
        )
        .returning(Notice)
    )
    assert notice is not None  # noqa: S101 (RETURNING the inserted row)
    await _audit(
        db,
        ctx,
        actions.NOTICE_CREATED,
        notice_id,
        {"attachment_file_id": data.attachment_file_id},
    )
    out = NoticeOut.model_validate(notice)
    await db.commit()
    return out


async def update_notice(
    db: AsyncSession, ctx: TenantContext, notice_id: UUID, data: NoticeUpdate
) -> NoticeOut:
    """Change the fields sent on a `draft`. 404, 409 `notice_not_editable`.

    A new attachment is claimed; the one it replaces (or a cleared one) keeps its claim but is no
    longer `attachment_file_id`, so `can_view_notice_attachment` grants it to no one.
    """
    notice = await _locked(db, ctx, notice_id)
    if notice.status is not NoticeStatus.DRAFT:
        raise NoticeNotEditable(detail=f"A {notice.status} notice can't be edited.")
    values: dict[str, Any] = {name: getattr(data, name) for name in data.model_fields_set}
    if "attachment_file_id" in values:
        file_id = values["attachment_file_id"]
        if file_id == notice.attachment_file_id:
            # The current attachment sent back: already claimed for this notice.
            del values["attachment_file_id"]
        elif file_id is not None:
            await _claim(db, ctx, file_id, notice_id)
    if values.get("expires_at") is not None:
        # After every wait (the row lock, the file claim), as in `create_notice`.
        await _check_future(db, values["expires_at"])
    if values:
        updated = await db.scalar(
            update(Notice)
            .where(
                Notice.id == notice_id,
                Notice.building_id == ctx.building_id,
                Notice.status == NoticeStatus.DRAFT,
            )
            .values(**values)
            .returning(Notice)
            .execution_options(populate_existing=True)
        )
        assert updated is not None  # noqa: S101 (the row is locked, and a draft)
        notice = updated
        await _audit(
            db,
            ctx,
            actions.NOTICE_UPDATED,
            notice_id,
            {"fields": sorted(values), "attachment_file_id": notice.attachment_file_id},
        )
    out = NoticeOut.model_validate(notice)
    await db.commit()
    return out


async def publish_notice(db: AsyncSession, ctx: TenantContext, notice_id: UUID) -> NoticeOut:
    """`draft → published`, by the caller, at the database's time. 404, 409 `invalid_transition`,
    422 `notice_expired` if its `expires_at` has passed."""
    notice = await _locked(db, ctx, notice_id)
    assert_transition(notice.status, NoticeStatus.PUBLISHED)
    published = await db.scalar(
        update(Notice)
        .where(
            Notice.id == notice_id,
            Notice.building_id == ctx.building_id,
            Notice.status.in_(sources(NoticeStatus.PUBLISHED)),
            # Here, not before the lock: a notice that expired while this waited stays a draft,
            # and `expires_after_published` never sees an expired one.
            or_(Notice.expires_at.is_(None), Notice.expires_at > _NOW),
        )
        .values(
            status=NoticeStatus.PUBLISHED,
            published_at=_NOW,
            published_by_membership_id=ctx.membership_id,
        )
        .returning(Notice)
        .execution_options(populate_existing=True)
    )
    if published is None:
        # The row is locked and a draft: only the expiry can have refused it.
        raise NoticeExpired(detail="This notice's expiry has passed; change it, then publish.")
    await _audit(db, ctx, actions.NOTICE_PUBLISHED, notice_id, {})
    out = NoticeOut.model_validate(published)
    await db.commit()
    return out


async def archive_notice(db: AsyncSession, ctx: TenantContext, notice_id: UUID) -> NoticeOut:
    """`draft` or `published → archived`; the publish columns are kept. 404, 409
    `invalid_transition`."""
    notice = await _locked(db, ctx, notice_id)
    from_status = notice.status
    assert_transition(from_status, NoticeStatus.ARCHIVED)
    archived = await db.scalar(
        update(Notice)
        .where(
            Notice.id == notice_id,
            Notice.building_id == ctx.building_id,
            Notice.status.in_(sources(NoticeStatus.ARCHIVED)),
        )
        .values(
            status=NoticeStatus.ARCHIVED,
            archived_at=_NOW,
            archived_by_membership_id=ctx.membership_id,
        )
        .returning(Notice)
        .execution_options(populate_existing=True)
    )
    assert archived is not None  # noqa: S101 (the row is locked, and may be archived)
    await _audit(db, ctx, actions.NOTICE_ARCHIVED, notice_id, {"from_status": from_status})
    out = NoticeOut.model_validate(archived)
    await db.commit()
    return out


async def list_notices(
    db: AsyncSession, ctx: TenantContext, params: CursorParams, *, status: NoticeStatus | None
) -> Page[NoticeOut]:
    stmt = visible_notices(ctx)
    if status is not None:
        stmt = stmt.where(Notice.status == status)
    return await paginate(db, stmt, Notice.id, params, NoticeOut.model_validate)


async def get_notice(db: AsyncSession, ctx: TenantContext, notice_id: UUID) -> NoticeOut:
    notice = await db.scalar(visible_notices(ctx).where(Notice.id == notice_id))
    if notice is None:
        # The same answer for a hidden notice, another building's and none (ADR-0004).
        raise NoticeNotFound(detail="Notice not found.")
    return NoticeOut.model_validate(notice)


async def _locked(db: AsyncSession, ctx: TenantContext, notice_id: UUID) -> Notice:
    """The notice, locked until commit. A concurrent write holding it makes this wait; READ
    COMMITTED then returns the row it committed, so the loser answers from the new status."""
    notice = await db.scalar(
        visible_notices(ctx)
        .where(Notice.id == notice_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if notice is None:
        # The same answer for another building's notice and none (ADR-0004).
        raise NoticeNotFound(detail="Notice not found.")
    return notice


async def _check_future(db: AsyncSession, expires_at: datetime) -> None:
    """422 `notice_expired` unless `expires_at` is later than this statement's clock. Call it after
    the last statement that can wait on a lock, so the clock isn't from before the wait."""
    now: datetime | None = await db.scalar(select(_NOW))
    assert now is not None  # noqa: S101 (one row, never null)
    if expires_at <= now:
        raise NoticeExpired(detail="expires_at must be in the future.")


async def _claim(db: AsyncSession, ctx: TenantContext, file_id: UUID, notice_id: UUID) -> None:
    # Both sides (the file's attachment and the notice's column) must agree for the hook to grant
    # it (app.notices.attachments).
    await claim_file(
        db, ctx, file_id, FilePurpose.NOTICE_ATTACHMENT, NOTICE_ATTACHED_TYPE, notice_id
    )


async def _audit(
    db: AsyncSession, ctx: TenantContext, action: str, notice_id: UUID, metadata: dict[str, Any]
) -> None:
    # IDs, field names and statuses only: no title or body text (CLAUDE.md rule 10).
    await record_audit(
        db,
        action=action,
        entity_type=NOTICE_ATTACHED_TYPE,
        entity_id=notice_id,
        building_id=ctx.building_id,
        actor_user_id=ctx.user_id,
        metadata=metadata,
    )
