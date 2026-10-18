"""In-app notifications (P3-03): `notify`, who to notify, and the recipient's own routes.

`notify` writes one row per recipient and queues each recipient's email in the caller's
transaction, so a package and its notifications commit or roll back together (ADR-0002). It and
the recipient helpers never commit (CLAUDE.md rule 5).
"""

import logging
import re
import time
from collections.abc import Iterable, Sequence
from typing import Any
from uuid import UUID, uuid7

from sqlalchemy import func, insert, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.core import clock
from app.core.config import is_email_address
from app.core.errors import NotFound
from app.core.pagination import CursorParams, Page, paginate
from app.email.service import queue_email
from app.email.templates import DEFAULT_LOCALE, SUPPORTED_LOCALES
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.notifications.kinds import KINDS
from app.notifications.models import Notification
from app.notifications.schemas import NotificationOut, NotificationSummary
from app.tenancy.context import TenantContext
from app.users.models import User

logger = logging.getLogger(__name__)

# The column lengths: a longer value would abort the caller's transaction in Postgres instead.
_MAX_LENGTHS = {"title": 200, "body": 1000, "link": 300, "entity_type": 40}
# An app path: one leading slash (not `//` or `/\`, which browsers read as another host), then no
# whitespace or control characters.
_APP_PATH = re.compile(r"/(?![/\\])[^\s\x00-\x1f\x7f]*")


class NotificationNotFound(NotFound):
    code = "notification_not_found"


async def notify(
    db: AsyncSession,
    *,
    building_id: UUID,
    recipient_user_ids: Iterable[UUID],
    kind: str,
    title: str,
    body: str,
    link: str | None,
    entity_type: str | None = None,
    entity_id: UUID | None = None,
    email_context: dict[str, Any] | None = None,
) -> None:
    """Notify each recipient in `building_id`: one row each, in one INSERT, and for an email kind
    an `email.send` job each. Never commits.

    Raises `ValueError`, writing nothing, for an unknown kind or a value its column can't hold. A
    recipient without a membership in the building fails the INSERT (`IntegrityError`). Only
    active users with an address `queue_email` accepts get the email; the rest get the row only.
    """
    started = time.perf_counter()
    spec = KINDS.get(kind)
    if spec is None:
        raise ValueError(f"unknown notification kind {kind!r}")
    _check_text(title=title, body=body, link=link, entity_type=entity_type)
    if not title:
        raise ValueError("`title` must not be empty")
    if link is not None and _APP_PATH.fullmatch(link) is None:
        raise ValueError("`link` must be an app path such as /packages")
    if (entity_type is None) != (entity_id is None):
        raise ValueError("pass both `entity_type` and `entity_id`, or neither")
    # In order, each once.
    recipients = list(dict.fromkeys(recipient_user_ids))
    if not recipients:
        return

    # Multi-row VALUES: one statement for any number of recipients (criterion 6).
    await db.execute(
        insert(Notification).values(
            [
                {
                    "id": uuid7(),
                    "building_id": building_id,
                    "recipient_user_id": user_id,
                    "kind": kind,
                    "title": title,
                    "body": body,
                    "link": link,
                    "entity_type": entity_type,
                    "entity_id": entity_id,
                }
                for user_id in recipients
            ]
        )
    )

    emailed = 0
    if spec.email_template is not None:
        users = await db.execute(
            select(User.id, User.email, User.locale, User.is_active).where(User.id.in_(recipients))
        )
        by_id = {row.id: row for row in users}
        # Set last, so the email says what the in-app row says.
        context = (email_context or {}) | {"title": title, "body": body, "link": link}
        for user_id in recipients:
            user = by_id[user_id]
            if not user.is_active or not is_email_address(user.email):
                # By id only: never log the address (CLAUDE.md rule 10).
                logger.info("notify: no email for user %s (inactive or unsendable address)", user_id)
                continue
            await queue_email(
                db,
                to=user.email,
                template=spec.email_template,
                context=context,
                locale=user.locale if user.locale in SUPPORTED_LOCALES else DEFAULT_LOCALE,
                # Without an entity there is nothing to tell two events apart by.
                dedupe_key=f"{kind}:{entity_id}:{user_id}" if entity_id is not None else None,
            )
            emailed += 1
    logger.info(
        "notify kind=%s recipients=%d emails=%d ms=%.1f",
        kind,
        len(recipients),
        emailed,
        (time.perf_counter() - started) * 1000,
    )


def _check_text(**values: str | None) -> None:
    for name, value in values.items():
        if value is None:
            continue
        if len(value) > _MAX_LENGTHS[name]:
            raise ValueError(f"`{name}` must be at most {_MAX_LENGTHS[name]} characters")
        if "\x00" in value:
            raise ValueError(f"`{name}` must not contain NUL characters")


async def staff_user_ids(db: AsyncSession, building_id: UUID, roles: Sequence[Role]) -> list[UUID]:
    """Users with an active membership in the building holding any of `roles`, each once."""
    if not roles:
        return []
    rows = await db.scalars(
        select(BuildingMembership.user_id)
        .where(
            BuildingMembership.building_id == building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            select(MembershipRole.membership_id)
            .where(
                MembershipRole.membership_id == BuildingMembership.id,
                MembershipRole.role.in_(roles),
            )
            .exists(),
        )
        .order_by(BuildingMembership.user_id)
    )
    return list(rows)


async def unit_resident_user_ids(db: AsyncSession, building_id: UUID, unit_id: UUID) -> list[UUID]:
    """Users with a current occupancy of the unit and an active membership, earliest start first.

    `current_occupants`' rows, kept to active memberships in the same query (the P1-03 carry): a
    suspended occupant is not told about the unit's packages.
    """
    rows = await db.scalars(
        select(BuildingMembership.user_id)
        .join(
            UnitOccupancy,
            (UnitOccupancy.membership_id == BuildingMembership.id)
            & (UnitOccupancy.building_id == BuildingMembership.building_id),
        )
        .where(
            UnitOccupancy.building_id == building_id,
            UnitOccupancy.unit_id == unit_id,
            UnitOccupancy.ended_at.is_(None),
            BuildingMembership.status == MembershipStatus.ACTIVE,
        )
        .order_by(UnitOccupancy.started_at, UnitOccupancy.membership_id)
    )
    return list(rows)


def _own(ctx: TenantContext) -> tuple[Any, ...]:
    """The caller's notifications in the URL's building: the filter of every route below."""
    return (
        Notification.building_id == ctx.building_id,
        Notification.recipient_user_id == ctx.user_id,
    )


async def list_notifications(
    db: AsyncSession, ctx: TenantContext, params: CursorParams, *, unread_only: bool
) -> Page[NotificationOut]:
    stmt = select(Notification).where(*_own(ctx))
    if unread_only:
        stmt = stmt.where(Notification.read_at.is_(None))
    return await paginate(db, stmt, Notification.id, params, NotificationOut.model_validate)


async def notification_summary(db: AsyncSession, ctx: TenantContext) -> NotificationSummary:
    count = await db.scalar(
        select(func.count()).where(*_own(ctx), Notification.read_at.is_(None))
    )
    return NotificationSummary(unread_count=count or 0)


async def mark_read(db: AsyncSession, ctx: TenantContext, notification_id: UUID) -> None:
    """Mark one of the caller's notifications read; again is a no-op, `read_at` is kept."""
    marked = await db.scalar(
        update(Notification)
        .where(Notification.id == notification_id, *_own(ctx))
        .values(read_at=func.coalesce(Notification.read_at, clock.now()))
        .returning(Notification.id)
    )
    if marked is None:
        # The same answer for another user's, another building's and no notification (ADR-0004).
        raise NotificationNotFound(detail="Notification not found.")
    await db.commit()


async def mark_all_read(db: AsyncSession, ctx: TenantContext) -> None:
    await db.execute(
        update(Notification)
        .where(*_own(ctx), Notification.read_at.is_(None))
        .values(read_at=clock.now())
    )
    await db.commit()
