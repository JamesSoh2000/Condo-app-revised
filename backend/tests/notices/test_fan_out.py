"""The publish fan-out (P6-01c criteria 3, 3a, 4, 5): who is told, in how many statements, and that
it commits or rolls back with the publish."""

import logging
import time
from typing import Any
from uuid import uuid7

import pytest
from sqlalchemy import event, func, insert, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.audit.models import AuditEvent
from app.jobs.models import Job
from app.memberships.models import BuildingMembership
from app.notices import service
from app.notices.enums import NoticePriority, NoticeStatus
from app.notices.models import Notice
from app.notifications.models import Notification
from app.notifications.service import notify
from app.users.models import User
from tests.email.conftest import point_settings_at
from tests.notices.conftest import make_notice
from tests.world import World

pytestmark = pytest.mark.anyio

logger = logging.getLogger(__name__)


@pytest.fixture(autouse=True)
def _email_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    point_settings_at(monkeypatch, 1025)


def _told(world: World) -> list[Any]:
    """The users a publish by `a_manager` tells: A's active members but the publisher."""
    return sorted(
        [
            world.a_security.user.id,
            world.a_resident1.user.id,
            world.a_resident2.user.id,
            world.a_council.user.id,
            world.a_former.user.id,
            world.multi.id,
        ]
    )


async def _publish(as_user: Any, world: World, notice: Notice) -> None:
    client = await as_user(world.a_manager.user)
    response = await client.post(f"/api/buildings/{world.a.id}/notices/{notice.id}/publish")
    assert response.status_code == 200, response.text


async def _notifications(db: AsyncSession, notice: Notice) -> list[Notification]:
    return list(
        await db.scalars(
            select(Notification)
            .where(Notification.entity_id == notice.id)
            .order_by(Notification.recipient_user_id)
        )
    )


async def _jobs(db: AsyncSession) -> list[Job]:
    return list(
        await db.scalars(select(Job).where(Job.kind == "email.send").order_by(Job.dedupe_key))
    )


def _inserts(statements: list[str], table: str) -> list[str]:
    return [s for s in statements if s.startswith(f"INSERT INTO {table} ")]


# --- Criterion 3: who is told, and how -----------------------------------------------------------


async def test_a_normal_notice_tells_every_other_active_member_in_app_only(
    db: AsyncSession, as_user: Any, world: World, statements: list[str]
) -> None:
    notice = await make_notice(db, world.a_manager.membership)
    statements.clear()

    await _publish(as_user, world, notice)

    rows = await _notifications(db, notice)
    # Not the publisher, a_pending, a_suspended, nor anyone in B.
    assert [row.recipient_user_id for row in rows] == _told(world)
    assert {
        (row.building_id, row.kind, row.title, row.body, row.link, row.entity_type) for row in rows
    } == {
        (
            world.a.id,
            "notice.published",
            "New notice",
            notice.title,
            f"/notices/{notice.id}",
            "notice",
        )
    }
    assert len(_inserts(statements, "notifications")) == 1
    assert _inserts(statements, "jobs") == []
    assert await _jobs(db) == []


async def test_an_urgent_notice_also_emails_each_sendable_active_member_in_one_insert(
    db: AsyncSession, as_user: Any, world: World, statements: list[str]
) -> None:
    inactive, odd = world.a_resident2.user, world.a_council.user
    inactive.is_active = False
    odd.email = "josé@example.com"  # P3-02: ASCII addresses only
    notice = await make_notice(db, world.a_manager.membership, priority=NoticePriority.URGENT)
    statements.clear()

    await _publish(as_user, world, notice)

    rows = await _notifications(db, notice)
    assert [row.recipient_user_id for row in rows] == _told(world)
    assert {(row.kind, row.title) for row in rows} == {("notice.published_urgent", "Urgent notice")}
    jobs = await _jobs(db)
    emailed = [u for u in _told(world) if u not in (inactive.id, odd.id)]
    assert [job.dedupe_key for job in jobs] == [
        f"notice.published_urgent:{notice.id}:{user_id}" for user_id in emailed
    ]
    assert {job.payload["template"] for job in jobs} == {"notification"}
    assert jobs[0].payload["context"] == {
        "title": "Urgent notice",
        "body": notice.title,
        "link": f"/notices/{notice.id}",
    }
    assert len(_inserts(statements, "notifications")) == 1
    [job_insert] = _inserts(statements, "jobs")
    assert "ON CONFLICT" in job_insert


async def test_the_email_jobs_are_inserted_in_recipient_id_order(
    db: AsyncSession, as_user: Any, world: World, engine: AsyncEngine
) -> None:
    # The P3-03 carry: concurrent inserts of one entity's dedupe keys must take them in one order,
    # or they deadlock; within one multi-row INSERT that is the VALUES order.
    notice = await make_notice(db, world.a_manager.membership, priority=NoticePriority.URGENT)
    keys: list[list[str]] = []

    def record(_conn: Any, _cursor: Any, statement: str, parameters: Any, *_args: Any) -> None:
        if statement.startswith("INSERT INTO jobs "):
            values = parameters if isinstance(parameters, tuple | list) else [parameters]
            keys.append([str(v) for v in values if str(v).startswith("notice.published_urgent:")])

    event.listen(engine.sync_engine, "before_cursor_execute", record)
    try:
        await _publish(as_user, world, notice)
    finally:
        event.remove(engine.sync_engine, "before_cursor_execute", record)

    [sent] = keys
    assert sent == [f"notice.published_urgent:{notice.id}:{user_id}" for user_id in _told(world)]


async def test_a_building_with_nobody_else_publishes_without_notifications(
    db: AsyncSession, as_user: Any, world: World, statements: list[str]
) -> None:
    # B's only active members are b_manager, b_resident1 and multi (security): suspend them.
    for membership in (world.b_resident1.membership, world.multi_in_b):
        membership.status = "suspended"  # type: ignore[assignment]
    await db.flush()
    notice = await make_notice(db, world.b_manager.membership, priority=NoticePriority.URGENT)
    client = await as_user(world.b_manager.user)
    statements.clear()

    response = await client.post(f"/api/buildings/{world.b.id}/notices/{notice.id}/publish")

    assert response.status_code == 200, response.text
    assert await _notifications(db, notice) == []
    assert _inserts(statements, "notifications") == []
    assert _inserts(statements, "jobs") == []


# --- Criterion 4: 600 recipients ----------------------------------------------------------------


async def _add_members(db: AsyncSession, world: World, count: int) -> None:
    user_ids = [uuid7() for _ in range(count)]
    await db.execute(
        insert(User).values(
            [
                {"id": uid, "email": f"bulk{n}@example.com", "full_name": "x"}
                for n, uid in enumerate(user_ids)
            ]
        )
    )
    await db.execute(
        insert(BuildingMembership).values(
            [
                {"id": uuid7(), "building_id": world.a.id, "user_id": uid, "status": "active"}
                for uid in user_ids
            ]
        )
    )


async def test_the_publish_runs_the_same_statements_for_6_and_606_recipients(
    db: AsyncSession, as_user: Any, world: World, statements: list[str]
) -> None:
    urgent = {"priority": NoticePriority.URGENT}
    small = await make_notice(db, world.a_manager.membership, **urgent)
    large = await make_notice(db, world.a_manager.membership, **urgent)
    await as_user(world.a_manager.user)  # log in before counting
    statements.clear()
    await _publish(as_user, world, small)
    few = list(statements)

    await _add_members(db, world, 600)
    statements.clear()
    started = time.perf_counter()
    await _publish(as_user, world, large)
    elapsed = time.perf_counter() - started
    many = list(statements)

    logger.warning(
        "urgent publish to %d recipients: %d statements, %.0f ms (6 recipients: %d statements)",
        len(await _notifications(db, large)),
        len(many),
        elapsed * 1000,
        len(few),
    )
    assert len(await _notifications(db, large)) == 606
    # Both publishes' jobs: every user here has a sendable address.
    assert len(await _jobs(db)) == 6 + 606
    assert len(many) == len(few), "\n".join(many)
    assert len(_inserts(many, "notifications")) == len(_inserts(many, "jobs")) == 1


# --- Criterion 5: it all rolls back together -----------------------------------------------------


async def test_a_failure_after_the_fan_out_leaves_nothing(
    db: AsyncSession, as_user: Any, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    notice = await make_notice(db, world.a_manager.membership, priority=NoticePriority.URGENT)
    reached: list[str] = []
    original = notify

    async def notify_then_record(*args: Any, **kwargs: Any) -> None:
        await original(*args, **kwargs)
        reached.append("notified")

    async def failing_audit(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(service, "notify", notify_then_record)
    monkeypatch.setattr(service, "record_audit", failing_audit)
    client = await as_user(world.a_manager.user)
    audits = await db.scalar(select(func.count()).select_from(AuditEvent))

    with pytest.raises(RuntimeError, match="simulated failure"):
        await client.post(f"/api/buildings/{world.a.id}/notices/{notice.id}/publish")

    assert reached == ["notified"]
    row = await db.scalar(
        select(Notice).where(Notice.id == notice.id).execution_options(populate_existing=True)
    )
    assert row is not None and row.status is NoticeStatus.DRAFT
    assert await db.scalar(select(func.count()).select_from(Notification)) == 0
    assert await db.scalar(select(func.count()).select_from(Job)) == 0
    assert await db.scalar(select(func.count()).select_from(AuditEvent)) == audits
