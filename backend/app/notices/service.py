"""Notices (P6-01b): the manager writes, edits, publishes and archives them; every member reads
what `visible_notices` lets them.

Each write locks the notice row (`_locked`), checks the state machine, then writes with a
conditional `UPDATE … WHERE status IN (…) RETURNING` (CLAUDE.md rule 7); the attachment claim and
the audit row commit with it, once (CLAUDE.md rule 5). Reads go only through `visible_notices(ctx)`
(CLAUDE.md rule 3).

P6-01c adds the member's side: `mark_read` (one `notice_reads` row, kept once), `notice_summary`,
each `NoticeOut`'s caller `read_at`, and the publish's fan-out (`_tell_members`): one notification
INSERT and, for an urgent notice, one email-job INSERT, in the publish's transaction.
"""

from datetime import datetime
from typing import Any
from uuid import UUID, uuid7

from sqlalchemy import ScalarSelect, func, insert, or_, select, update
from sqlalchemy.dialects.postgresql import insert as pg_insert
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import with_expression

from app.audit import actions
from app.audit.service import record_audit
from app.core.errors import Conflict, NotFound, UnprocessableContent
from app.core.pagination import CursorParams, Page, paginate
from app.files.models import File, FilePurpose
from app.files.service import claim_file
from app.notices.enums import NoticePriority, NoticeStatus
from app.notices.models import NOTICE_ATTACHED_TYPE, Notice, NoticeRead
from app.notices.queries import live, visible_notices
from app.notices.schemas import NoticeCreate, NoticeOut, NoticeSummary, NoticeUpdate
from app.notices.state import assert_transition, sources
from app.notifications.service import active_member_user_ids, notify
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
    # As every write's answer: with the attachment's type (P6-02b).
    out = await _out(db, ctx, notice)
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
    out = await _out(db, ctx, notice)
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
    # After the UPDATE that won the row, before the audit: one transaction (the P6-01b carry).
    await _tell_members(db, ctx, published)
    await _audit(db, ctx, actions.NOTICE_PUBLISHED, notice_id, {})
    out = await _out(db, ctx, published)
    if published.expires_at is not None:
        # Again after the last statement that can wait: the fan-out's INSERTs wait on a membership
        # or a dedupe key another transaction holds, and the expiry may pass meanwhile (review
        # round 1, Codex). The flush sends the pending audit row first (autoflush is off). Raising
        # rolls the publish, the notifications and the jobs back.
        await db.flush()
        await _check_future(db, published.expires_at)
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
    out = await _out(db, ctx, archived)
    await db.commit()
    return out


async def list_notices(
    db: AsyncSession,
    ctx: TenantContext,
    params: CursorParams,
    *,
    status: NoticeStatus | None,
    live_only: bool = False,
    priority: NoticePriority | None = None,
    unread_only: bool = False,
) -> Page[NoticeOut]:
    stmt = visible_notices(ctx).options(*_expressions(ctx))
    if status is not None:
        stmt = stmt.where(Notice.status == status)
    if live_only:
        stmt = stmt.where(live())
    if priority is not None:
        stmt = stmt.where(Notice.priority == priority)
    if unread_only:
        # The caller's own reads, as the summary counts them.
        stmt = stmt.where(_read_at(ctx).is_(None))
    return await paginate(db, stmt, Notice.id, params, NoticeOut.model_validate)


async def get_notice(db: AsyncSession, ctx: TenantContext, notice_id: UUID) -> NoticeOut:
    notice = await db.scalar(
        visible_notices(ctx).where(Notice.id == notice_id).options(*_expressions(ctx))
    )
    if notice is None:
        # The same answer for a hidden notice, another building's and none (ADR-0004).
        raise NoticeNotFound(detail="Notice not found.")
    return NoticeOut.model_validate(notice)


async def mark_read(db: AsyncSession, ctx: TenantContext, notice_id: UUID) -> None:
    """Mark a notice the caller sees read, as their membership; again keeps the first `read_at`.
    404 for any other, as `get_notice`."""
    seen = await db.scalar(select(visible_notices(ctx).where(Notice.id == notice_id).exists()))
    if not seen:
        raise NoticeNotFound(detail="Notice not found.")
    # A notice archived or expiring after the check keeps the read: harmless, and the composite FK
    # still keeps it in this building. No audit row: a read is the member's own bookkeeping.
    await db.execute(
        pg_insert(NoticeRead)
        .values(building_id=ctx.building_id, notice_id=notice_id, membership_id=ctx.membership_id)
        .on_conflict_do_nothing(index_elements=[NoticeRead.notice_id, NoticeRead.membership_id])
    )
    await db.commit()


async def notice_summary(db: AsyncSession, ctx: TenantContext) -> NoticeSummary:
    """The caller's unread live notices, and how many of them are urgent: one query."""
    unread = (
        visible_notices(ctx)
        .where(live(), _read_at(ctx).is_(None))
        .with_only_columns(Notice.priority)
        .subquery()
    )
    urgent = func.count().filter(unread.c.priority == NoticePriority.URGENT)
    total, urgent_total = (await db.execute(select(func.count(), urgent).select_from(unread))).one()
    return NoticeSummary(unread=total, urgent_unread=urgent_total)


def _read_at(ctx: TenantContext) -> ScalarSelect[Any]:
    """The caller's `read_at` of the notice in the enclosing query: null if they haven't read it."""
    return (
        select(NoticeRead.read_at)
        .where(NoticeRead.notice_id == Notice.id, NoticeRead.membership_id == ctx.membership_id)
        .scalar_subquery()
    )


def _attachment_content_type() -> ScalarSelect[Any]:
    """The content type of the enclosing query's notice's attachment, in its building; null without
    one (P6-02b)."""
    return (
        select(File.content_type)
        .where(File.building_id == Notice.building_id, File.id == Notice.attachment_file_id)
        .scalar_subquery()
    )


def _expressions(ctx: TenantContext) -> tuple[Any, ...]:
    """The answer's per-query columns: the caller's `read_at` and the attachment's type."""
    return (
        with_expression(Notice.read_at, _read_at(ctx)),
        with_expression(Notice.attachment_content_type, _attachment_content_type()),
    )


async def _out(db: AsyncSession, ctx: TenantContext, notice: Notice) -> NoticeOut:
    """A written notice's answer, with the caller's own `read_at` and the attachment's type (one
    more SELECT)."""
    read_at, content_type = (
        await db.execute(
            select(
                select(NoticeRead.read_at)
                .where(
                    NoticeRead.notice_id == notice.id,
                    NoticeRead.membership_id == ctx.membership_id,
                )
                .scalar_subquery(),
                select(File.content_type)
                .where(File.building_id == notice.building_id, File.id == notice.attachment_file_id)
                .scalar_subquery(),
            )
        )
    ).one()
    return NoticeOut.model_validate(notice).model_copy(
        update={"read_at": read_at, "attachment_content_type": content_type}
    )


async def _tell_members(db: AsyncSession, ctx: TenantContext, notice: Notice) -> None:
    """Notify every active member but the publisher, in one INSERT; an urgent notice also queues
    each one's email, in one more (P6-01c D1, D2, D4). The statements don't grow with the number of
    members."""
    urgent = notice.priority is NoticePriority.URGENT
    members = await active_member_user_ids(db, ctx.building_id)
    await notify(
        db,
        building_id=ctx.building_id,
        recipient_user_ids=[user_id for user_id in members if user_id != ctx.user_id],
        kind="notice.published_urgent" if urgent else "notice.published",
        # Fixed; the notice's title (at most 200 characters) fits the notification's body.
        title="Urgent notice" if urgent else "New notice",
        body=notice.title,
        link=f"/notices/{notice.id}",
        entity_type=NOTICE_ATTACHED_TYPE,
        entity_id=notice.id,
    )


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
