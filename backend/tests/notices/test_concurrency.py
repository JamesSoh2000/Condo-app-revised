"""Publish, archive and edit races (P6-01b criteria 2, 3 and 9, tenant row 10).

On real connections, as `tests/packages/test_concurrency.py`: a scratch database of its own,
migrated here and dropped after the test, and one session per request.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.audit.models import AuditEvent
from app.core.errors import DomainError
from app.notices import service
from app.notices.enums import NoticeStatus
from app.notices.models import Notice
from app.notices.schemas import NoticeUpdate
from tests.notices.conftest import make_notice, persona_ctx
from tests.notifications.test_concurrency import migrate
from tests.world import World, build_world

type Sessions = async_sessionmaker[AsyncSession]


def _run(url: str, body: Callable[[Sessions, World, Notice], Awaitable[None]]) -> None:
    migrate(url)

    async def check() -> None:
        engine = create_async_engine(url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        try:
            async with sessions() as db:
                world = await build_world(db)
                notice = await make_notice(db, world.a_manager.membership)
                await db.commit()
            await body(sessions, world, notice)
        finally:
            await engine.dispose()

    asyncio.run(check())


async def _act(sessions: Sessions, world: World, notice: Notice, action: str) -> str:
    """Run `action` in a session of its own as the manager; its outcome as a status and code."""
    async with sessions() as db:
        ctx = persona_ctx(world, "a_manager")
        try:
            if action == "publish":
                await service.publish_notice(db, ctx, notice.id)
            elif action == "archive":
                await service.archive_notice(db, ctx, notice.id)
            else:
                await service.update_notice(db, ctx, notice.id, NoticeUpdate(title="Edited"))
        except DomainError as exc:
            return f"{exc.status} {exc.code}"
        return "200"


async def _row(sessions: Sessions, notice: Notice) -> Notice:
    async with sessions() as db:
        row = await db.scalar(select(Notice).where(Notice.id == notice.id))
        assert row is not None
        return row


async def _audits(sessions: Sessions, notice: Notice) -> list[str]:
    async with sessions() as db:
        rows = await db.scalars(select(AuditEvent.action).where(AuditEvent.entity_id == notice.id))
        return sorted(rows)


def test_two_concurrent_publishes_have_one_winner(scratch_database_url: str) -> None:
    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        outcomes = await asyncio.gather(
            _act(sessions, world, notice, "publish"), _act(sessions, world, notice, "publish")
        )

        assert sorted(outcomes) == ["200", "409 invalid_transition"]
        assert (await _row(sessions, notice)).status is NoticeStatus.PUBLISHED
        assert await _audits(sessions, notice) == ["notice.published"]

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first", ["publish", "archive"])
def test_a_concurrent_publish_and_archive_of_a_draft_both_follow_the_state_machine(
    scratch_database_url: str, first: str
) -> None:
    # draft → published → archived is allowed, draft → archived → published is not: whichever
    # commits first decides whether the other succeeds.
    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        second = "archive" if first == "publish" else "publish"
        outcomes = await asyncio.gather(
            _act(sessions, world, notice, first), _act(sessions, world, notice, second)
        )

        row = await _row(sessions, notice)
        assert row.status is NoticeStatus.ARCHIVED
        audits = await _audits(sessions, notice)
        if row.published_at is None:
            assert sorted(outcomes) == ["200", "409 invalid_transition"]
            assert audits == ["notice.archived"]
        else:
            assert list(outcomes) == ["200", "200"]
            assert audits == ["notice.archived", "notice.published"]

    _run(scratch_database_url, body)


@pytest.mark.parametrize("first_commits", [True, False], ids=["commits", "rolls-back"])
@pytest.mark.parametrize("held", ["publish", "edit"])
def test_a_write_waits_for_a_held_one_and_answers_from_its_result(
    scratch_database_url: str, held: str, first_commits: bool
) -> None:
    # Criterion 3: the edit waits for an open publish and, after its commit, reads a published row
    # (409); a publish waits for an open edit and publishes the edited row.
    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        waiting = "edit" if held == "publish" else "publish"
        async with sessions() as first:
            values: dict[str, Any] = (
                {
                    "status": NoticeStatus.PUBLISHED,
                    "published_at": func.now(),
                    "published_by_membership_id": world.a_manager.membership.id,
                }
                if held == "publish"
                else {"title": "Held edit"}
            )
            await first.execute(update(Notice).where(Notice.id == notice.id).values(**values))
            task = asyncio.create_task(_act(sessions, world, notice, waiting))
            await asyncio.sleep(1.0)
            assert not task.done(), f"the {waiting} did not wait for the open {held}"
            if first_commits:
                await first.commit()
            else:
                await first.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        row = await _row(sessions, notice)
        if held == "publish" and first_commits:
            assert outcome == "409 notice_not_editable"
            assert row.title == notice.title
        elif held == "publish":
            assert (outcome, row.title, row.status) == ("200", "Edited", NoticeStatus.DRAFT)
        else:
            assert (outcome, row.status) == ("200", NoticeStatus.PUBLISHED)
            assert row.title == ("Held edit" if first_commits else notice.title)

    _run(scratch_database_url, body)


def test_a_notice_expiring_while_its_publish_waits_is_not_published(
    scratch_database_url: str,
) -> None:
    # Criterion 9, the P4-02b lesson: the expiry is read after the lock, with the clock of the
    # writing statement, not before the wait.
    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        async with sessions() as first:
            await first.execute(
                update(Notice)
                .where(Notice.id == notice.id)
                .values(expires_at=func.clock_timestamp() + timedelta(milliseconds=500))
            )
            task = asyncio.create_task(_act(sessions, world, notice, "publish"))
            await asyncio.sleep(1.0)
            assert not task.done(), "the publish did not wait for the open edit"
            await first.commit()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == "422 notice_expired"
        assert (await _row(sessions, notice)).status is NoticeStatus.DRAFT
        assert await _audits(sessions, notice) == []

    _run(scratch_database_url, body)
