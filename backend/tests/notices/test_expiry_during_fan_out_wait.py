"""WF-02 criterion 7: the P6-01c case, written with `act_blocked_on_lock`.

A deliberate restatement of `test_concurrency.py::
test_a_notice_expiring_while_its_fan_out_waits_is_not_published` (which waits with an `INSERT`
event hook), beside it, to prove the helper on a known case; it adds no coverage.
"""

from datetime import timedelta

import pytest
from sqlalchemy import func, select, text, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs.models import Job
from app.memberships.models import BuildingMembership
from app.notices.enums import NoticePriority, NoticeStatus
from app.notices.models import Notice
from app.notifications.models import Notification
from tests.email.conftest import point_settings_at
from tests.helpers.lock_wait import act_blocked_on_lock
from tests.notices.test_concurrency import Sessions, _act, _audits, _row, _run
from tests.world import World


@pytest.mark.parametrize("priority", [NoticePriority.NORMAL, NoticePriority.URGENT])
def test_a_notice_expiring_while_its_fan_out_waits_on_a_membership_lock_is_not_published(
    scratch_database_url: str, monkeypatch: pytest.MonkeyPatch, priority: NoticePriority
) -> None:
    point_settings_at(monkeypatch, 1025)

    async def body(sessions: Sessions, world: World, notice: Notice) -> None:
        async with sessions() as setup:
            await setup.execute(
                update(Notice)
                .where(Notice.id == notice.id)
                .values(priority=priority, expires_at=func.clock_timestamp() + timedelta(seconds=1))
            )
            await setup.commit()

        async def hold(db: AsyncSession) -> None:
            # The fan-out's notifications INSERT takes KEY SHARE on each recipient's membership.
            await db.execute(
                select(BuildingMembership.id)
                .where(BuildingMembership.id == world.a_resident1.membership.id)
                .with_for_update()
            )

        async def expire(db: AsyncSession) -> None:
            # Time passing, on the database's clock: sleep until the expiry is behind it.
            await db.execute(
                text(
                    "SELECT pg_sleep(EXTRACT(EPOCH FROM expires_at - clock_timestamp()) + 0.05)"
                    " FROM notices WHERE id = :id"
                ),
                {"id": notice.id},
            )
            assert await db.scalar(
                text("SELECT expires_at <= clock_timestamp() FROM notices WHERE id = :id"),
                {"id": notice.id},
            )

        outcome = await act_blocked_on_lock(
            sessions,
            hold=hold,
            act=lambda: _act(sessions, world, notice, "publish"),
            change=expire,
        )

        assert outcome == "422 notice_expired"
        assert (await _row(sessions, notice)).status is NoticeStatus.DRAFT
        assert await _audits(sessions, notice) == []
        async with sessions() as db:
            told = await db.scalar(select(func.count()).select_from(Notification))
            jobs = await db.scalar(select(func.count()).select_from(Job))
        assert (told, jobs) == (0, 0)

    _run(scratch_database_url, body)
