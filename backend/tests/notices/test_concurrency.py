"""Publish, archive and edit races (P6-01b criteria 2, 3 and 9, tenant row 10).

On real connections, as `tests/packages/test_concurrency.py`: a scratch database of its own,
migrated here and dropped after the test, and one session per request.
"""

import asyncio
from collections.abc import Awaitable, Callable
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import (
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.audit.models import AuditEvent
from app.core.errors import DomainError
from app.files.models import File
from app.jobs.models import Job
from app.memberships.models import BuildingMembership
from app.notices import service
from app.notices.enums import NoticePriority, NoticeStatus
from app.notices.models import Notice, NoticeRead
from app.notices.schemas import NoticeCreate, NoticeUpdate
from app.notifications.models import Notification
from tests.email.conftest import point_settings_at
from tests.helpers.lock_wait import act_blocked_on_lock
from tests.notices.conftest import make_attachment, make_notice, persona_ctx
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


def test_two_concurrent_publishes_tell_the_members_once(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    # P6-01c criterion 6: the loser waits on the row lock and 409s before its fan-out, so one set of
    # notifications and one set of email jobs.
    point_settings_at(monkeypatch, 1025)

    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        async with sessions() as db:
            await db.execute(
                update(Notice).where(Notice.id == notice.id).values(priority=NoticePriority.URGENT)
            )
            await db.commit()

        outcomes = await asyncio.gather(
            _act(sessions, world, notice, "publish"), _act(sessions, world, notice, "publish")
        )

        assert sorted(outcomes) == ["200", "409 invalid_transition"]
        async with sessions() as db:
            told = await db.scalar(
                select(func.count())
                .select_from(Notification)
                .where(Notification.entity_id == notice.id)
            )
            jobs = await db.scalar(
                select(func.count()).select_from(Job).where(Job.kind == "email.send")
            )
        # A's active members but the publisher, each with a sendable address.
        assert (told, jobs) == (6, 6)

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


@pytest.mark.parametrize("operation", ["create", "edit", "edit-no-file"])
def test_an_expiry_passing_while_the_attachment_claim_waits_is_refused(
    scratch_database_url: str, operation: str
) -> None:
    # Review round 1 (Codex, Medium): create and edit checked `expires_at` before `claim_file`,
    # whose UPDATE waits on a file row another transaction holds; an expiry passing during that
    # wait was saved (201/200) instead of 422.
    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        async with sessions() as setup:
            file = await make_attachment(
                setup, world.a.id, world.a_manager.user.id, content_type="application/pdf"
            )
            await setup.commit()

        async with sessions() as blocker:
            # The neighbour (edit-no-file): an edit waiting on the notice's own row lock.
            held = Notice if operation == "edit-no-file" else File
            held_id = notice.id if operation == "edit-no-file" else file.id
            await blocker.scalar(select(held).where(held.id == held_id).with_for_update())
            expires = await blocker.scalar(select(func.clock_timestamp() + timedelta(seconds=1)))
            assert expires is not None

            async def request() -> str:
                async with sessions() as db:
                    ctx = persona_ctx(world, "a_manager")
                    try:
                        if operation == "create":
                            data = NoticeCreate(
                                title="T", body="B", expires_at=expires, attachment_file_id=file.id
                            )
                            await service.create_notice(db, ctx, data)
                        elif operation == "edit-no-file":
                            update_ = NoticeUpdate(expires_at=expires)
                            await service.update_notice(db, ctx, notice.id, update_)
                        else:
                            update_ = NoticeUpdate(expires_at=expires, attachment_file_id=file.id)
                            await service.update_notice(db, ctx, notice.id, update_)
                    except DomainError as exc:
                        return f"{exc.status} {exc.code}"
                    return "2xx"

            task = asyncio.create_task(request())
            await asyncio.sleep(1.5)
            assert not task.done(), "the request did not wait for the held row"
            await blocker.rollback()
            outcome = await asyncio.wait_for(task, timeout=10)

        assert outcome == "422 notice_expired"
        async with sessions() as db:
            claimed = await db.scalar(select(File.attached_id).where(File.id == file.id))
            count = await db.scalar(select(func.count()).select_from(Notice))
        assert claimed is None
        assert count == 1  # only the fixture's draft
        assert (await _row(sessions, notice)).expires_at is None

    _run(scratch_database_url, body)


@pytest.mark.parametrize("priority", [NoticePriority.NORMAL, NoticePriority.URGENT])
def test_a_notice_expiring_while_its_fan_out_waits_is_not_published(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch, priority: NoticePriority
) -> None:
    # Review round 1 (Codex, Low): the expiry was checked by the publish UPDATE, before the fan-out,
    # whose notifications INSERT takes KEY SHARE on each recipient's membership and waits on a
    # transaction holding one FOR UPDATE. An expiry passing in that wait was published (200), with
    # its notifications and emails. The CLAUDE.md lesson: check after the *last* wait.
    point_settings_at(monkeypatch, 1025)

    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        # On `act_blocked_on_lock` (P6-03c, the ticket's first user): it proves the publish's own
        # backend waited on the holder's lock, where this test first used a statement event and a
        # sleep.
        async def hold(db: AsyncSession) -> None:
            # Expiring 1 s from now by the database clock, then the recipient's membership locked.
            async with sessions() as setup:
                await setup.execute(
                    update(Notice)
                    .where(Notice.id == notice.id)
                    .values(
                        priority=priority,
                        expires_at=func.clock_timestamp() + timedelta(seconds=1),
                    )
                )
                await setup.commit()
            await db.scalar(
                select(BuildingMembership)
                .where(BuildingMembership.id == world.a_resident1.membership.id)
                .with_for_update()
            )

        async def publish(db: AsyncSession) -> str:
            try:
                await service.publish_notice(db, persona_ctx(world, "a_manager"), notice.id)
            except DomainError as exc:
                return f"{exc.status} {exc.code}"
            return "200"

        async def outlast(db: AsyncSession) -> None:
            await db.execute(text("SELECT pg_sleep(1.2)"))

        outcome = await act_blocked_on_lock(sessions, hold=hold, act=publish, change=outlast)

        assert outcome == "422 notice_expired"
        assert (await _row(sessions, notice)).status is NoticeStatus.DRAFT
        assert await _audits(sessions, notice) == []
        async with sessions() as db:
            told = await db.scalar(select(func.count()).select_from(Notification))
            jobs = await db.scalar(select(func.count()).select_from(Job))
        assert (told, jobs) == (0, 0)

    _run(scratch_database_url, body)


def test_two_simultaneous_reads_keep_one_row_and_the_first_read_at(
    scratch_database_url: str,
) -> None:
    # Review round 1 (Codex's independent check, kept): the second read's INSERT waits on the
    # first's uncommitted row, then does nothing.
    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        async with sessions() as setup:
            await setup.execute(
                update(Notice)
                .where(Notice.id == notice.id)
                .values(
                    status=NoticeStatus.PUBLISHED,
                    published_at=func.now(),
                    published_by_membership_id=world.a_manager.membership.id,
                )
            )
            await setup.commit()
        first_inserted = asyncio.Event()
        second_started = asyncio.Event()
        first_times: list[Any] = []

        class PausedSession(AsyncSession):
            async def commit(self) -> None:
                task = asyncio.current_task()
                if task is not None and task.get_name() == "first-read":
                    first_times.append(await self.scalar(select(NoticeRead.read_at)))
                    first_inserted.set()
                    await second_started.wait()
                    await asyncio.sleep(0.1)
                await super().commit()

        readers = async_sessionmaker(
            sessions.kw["bind"], class_=PausedSession, expire_on_commit=False, autoflush=False
        )
        ctx = persona_ctx(world, "a_resident1")

        async def first() -> None:
            async with readers() as db:
                await service.mark_read(db, ctx, notice.id)

        async def second() -> None:
            await first_inserted.wait()
            second_started.set()
            async with readers() as db:
                await service.mark_read(db, ctx, notice.id)

        await asyncio.wait_for(
            asyncio.gather(
                asyncio.create_task(first(), name="first-read"),
                asyncio.create_task(second(), name="second-read"),
            ),
            timeout=10,
        )
        async with sessions() as verify:
            assert await verify.scalar(select(func.count()).select_from(NoticeRead)) == 1
            assert await verify.scalar(select(NoticeRead.read_at)) == first_times[0]

    _run(scratch_database_url, body)
