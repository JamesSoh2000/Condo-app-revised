"""Concurrent `notify` and mark-read (P3-03, Codex review round 2), on real connections.

The test harness runs on one connection, so these use a scratch database of their own
(`scratch_database_url`), migrated here and dropped after the test.
"""

import asyncio
import contextlib
from collections import Counter
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession, async_sessionmaker, create_async_engine

from app.core import clock
from app.jobs.models import Job
from app.notifications import service
from app.notifications.models import Notification
from app.tenancy.context import TenantContext
from tests.conftest import BACKEND_DIR
from tests.email.conftest import point_settings_at
from tests.notifications.conftest import make_notification
from tests.notifications.test_notify import arrived
from tests.world import build_world


def migrate(url: str) -> None:
    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = url
    cfg.attributes["configure_logger"] = False
    command.upgrade(cfg, "head")


@pytest.mark.parametrize("first_commits", [True, False], ids=["both-commit", "first-rolls-back"])
def test_concurrent_notifies_of_one_entity_in_opposite_orders_both_finish(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch, first_commits: bool
) -> None:
    # Review round 2 (Medium): with recipients [A, B] and [B, A], each call held one dedupe key the
    # other needed next, and Postgres aborted one caller with "deadlock detected".
    point_settings_at(monkeypatch, 1025)
    migrate(scratch_database_url)
    original = service.queue_email

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        sessions = async_sessionmaker(engine, expire_on_commit=False, autoflush=False)
        both_queued_one = asyncio.Barrier(2)
        calls: Counter[asyncio.Task[Any] | None] = Counter()

        async def pause_after_the_first_email(*args: Any, **kwargs: Any) -> Any:
            job_id = await original(*args, **kwargs)
            task = asyncio.current_task()
            calls[task] += 1
            if calls[task] == 1:
                # Both callers hold one key here unless the second is already waiting on the
                # first's (the fixed order); then the first goes on after a moment.
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(both_queued_one.wait(), timeout=1)
            return job_id

        monkeypatch.setattr(service, "queue_email", pause_after_the_first_email)
        try:
            async with sessions() as db:
                world = await build_world(db)
                await db.commit()
            recipients = [world.a_resident1.user.id, world.a_resident2.user.id]

            async def run(ids: list[Any], *, commit: bool) -> None:
                async with sessions() as db:
                    await service.notify(db, **arrived(world, ids))
                    if commit:
                        await db.commit()
                    else:
                        # An abandoned caller: the other one's waiting inserts then go ahead.
                        await db.rollback()

            results = await asyncio.wait_for(
                asyncio.gather(
                    run(recipients, commit=first_commits),
                    run(recipients[::-1], commit=True),
                    return_exceptions=True,
                ),
                timeout=15,
            )
            assert results == [None, None], [str(result) for result in results]
            async with sessions() as db:
                rows = await db.scalar(select(func.count()).select_from(Notification))
                assert rows == (4 if first_commits else 2)
                # Each recipient's email exactly once, whichever caller queued it.
                assert await db.scalar(select(func.count()).select_from(Job)) == 2
        finally:
            await engine.dispose()

    asyncio.run(check())


@pytest.mark.parametrize("action", ["mark_read", "read_all"])
def test_concurrent_mark_reads_keep_the_first_read_at(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch, action: str
) -> None:
    migrate(scratch_database_url)

    async def check() -> None:
        engine = create_async_engine(scratch_database_url)
        first_updated = asyncio.Event()
        second_started = asyncio.Event()
        first_time = datetime(2026, 1, 15, 12, tzinfo=UTC)

        class PausedSession(AsyncSession):
            async def commit(self) -> None:
                # The first caller holds its row lock until the second has sent its UPDATE.
                if asyncio.current_task().get_name() == "first-read":  # type: ignore[union-attr]
                    first_updated.set()
                    await second_started.wait()
                    await asyncio.sleep(0.2)
                await super().commit()

        sessions = async_sessionmaker(
            engine, class_=PausedSession, expire_on_commit=False, autoflush=False
        )

        def per_task_clock() -> datetime:
            task = asyncio.current_task()
            later = task is not None and task.get_name() == "second-read"
            return first_time + timedelta(minutes=5 if later else 0)

        monkeypatch.setattr(clock, "now", per_task_clock)
        try:
            async with sessions() as db:
                world = await build_world(db)
                row = await make_notification(db, world.a, world.a_resident1.user.id)
                await db.commit()
            ctx = TenantContext(
                user_id=world.a_resident1.user.id,
                building_id=world.a.id,
                membership_id=world.a_resident1.membership.id,
                roles=frozenset(),
                features=frozenset(),
            )

            async def mark(db: AsyncSession) -> None:
                if action == "mark_read":
                    await service.mark_read(db, ctx, row.id)
                else:
                    await service.mark_all_read(db, ctx)

            async def first() -> None:
                async with sessions() as db:
                    await mark(db)

            async def second() -> None:
                await first_updated.wait()
                second_started.set()
                async with sessions() as db:
                    await mark(db)

            await asyncio.wait_for(
                asyncio.gather(
                    asyncio.create_task(first(), name="first-read"),
                    asyncio.create_task(second(), name="second-read"),
                ),
                timeout=15,
            )
            async with sessions() as db:
                read_at = await db.scalar(
                    select(Notification.read_at).where(Notification.id == row.id)
                )
                assert read_at == first_time
        finally:
            await engine.dispose()

    asyncio.run(check())
