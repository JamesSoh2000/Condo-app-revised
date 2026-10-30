"""Status-change notifications (P6-03c criteria 6 and 6a): the requester is told of each manager
move, in-app and by email, with fixed words; the actor never; nobody who can't see the request."""

import uuid
from datetime import datetime, timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs.models import Job
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import MaintenanceRequest, MaintenanceStatusEvent
from app.maintenance.state import MOVES
from app.memberships.enums import MembershipStatus
from app.memberships.models import BuildingMembership
from app.memberships.occupancy import end_occupancy
from app.notifications.models import Notification
from tests.maintenance.conftest import make_maintenance_request
from tests.maintenance.test_api import base
from tests.world import World

pytestmark = pytest.mark.anyio

S = MaintenanceStatus
LOCKBOX = "The lockbox code is 4471"
# The fixed words of each move's notification (framing, criterion 6).
TEXT = {
    "start": ("Maintenance request in progress", "Your Plumbing request is in progress."),
    "hold": ("Maintenance request on hold", "Your Plumbing request is on hold."),
    "resolve": ("Maintenance request resolved", "Your Plumbing request is resolved."),
    "reopen": ("Maintenance request reopened", "Your Plumbing request was reopened."),
}


async def _notifications(db: AsyncSession) -> list[Notification]:
    rows = await db.scalars(
        select(Notification)
        .where(Notification.kind == "maintenance.status_changed")
        .order_by(Notification.id)
    )
    return list(rows)


async def _emails(db: AsyncSession) -> list[Job]:
    rows = await db.scalars(
        select(Job)
        .where(Job.kind == "email.send", Job.dedupe_key.like("maintenance.status_changed:%"))
        .order_by(Job.id)
    )
    return list(rows)


async def _now(db: AsyncSession) -> datetime:
    now: datetime | None = await db.scalar(select(func.clock_timestamp()))
    assert now is not None
    return now


async def _request(
    db: AsyncSession, world: World, status: MaintenanceStatus, requester: Any = None, unit: Any = ""
) -> MaintenanceRequest:
    return await make_maintenance_request(
        db,
        (requester or world.a_resident1).membership,
        world.a_101 if unit == "" else unit,
        submitted_at=await _now(db) - timedelta(days=2),
        status=status,
        acted_by=world.a_manager.membership,
        description=LOCKBOX,
    )


async def _move(as_user: Any, world: World, request_id: uuid.UUID, verb: str) -> None:
    client = await as_user(world.a_manager.user)
    response = await client.post(f"{base(world)}/{request_id}/{verb}")
    assert response.status_code == 200, response.text


@pytest.mark.parametrize("verb", list(MOVES))
async def test_each_move_tells_the_requester_in_app_and_by_email(
    as_user: Any, world: World, db: AsyncSession, verb: str
) -> None:
    request = await _request(db, world, MOVES[verb][1][0])

    await _move(as_user, world, request.id, verb)

    event = await db.scalar(
        select(MaintenanceStatusEvent).where(MaintenanceStatusEvent.request_id == request.id)
    )
    assert event is not None
    [row] = await _notifications(db)
    title, body = TEXT[verb]
    assert (
        row.building_id,
        row.recipient_user_id,
        row.title,
        row.body,
        row.link,
        row.entity_type,
        row.entity_id,
    ) == (
        world.a.id,
        world.a_resident1.user.id,
        title,
        body,
        f"/maintenance/{request.id}",
        "maintenance_status_event",
        event.id,
    )
    [email] = await _emails(db)
    assert email.payload["template"] == "notification"
    assert email.payload["to"] == world.a_resident1.user.email
    assert email.dedupe_key == f"maintenance.status_changed:{event.id}:{world.a_resident1.user.id}"
    # No resident's words, no internal detail: only the fixed text, the category and the link.
    assert LOCKBOX not in str(email.payload)
    assert LOCKBOX not in row.title + row.body


async def test_repeated_moves_of_one_kind_each_email(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # Criterion 6a: hold, start, hold again; resolve, reopen, resolve again.
    request = await _request(db, world, S.IN_PROGRESS)
    verbs = ["hold", "start", "hold", "resolve", "reopen", "resolve"]
    for verb in verbs:
        await _move(as_user, world, request.id, verb)

    rows = await _notifications(db)
    assert [row.title for row in rows] == [TEXT[verb][0] for verb in verbs]
    emails = await _emails(db)
    assert len(emails) == len(verbs)
    assert len({email.dedupe_key for email in emails}) == len(verbs)


async def test_a_manager_moving_their_own_request_is_not_told(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # The actor is never told, even when they filed it (a common-area request of their own).
    request = await _request(db, world, S.SUBMITTED, requester=world.a_manager, unit=None)

    await _move(as_user, world, request.id, "start")

    assert await _notifications(db) == []
    assert await _emails(db) == []


async def test_a_suspended_requester_is_not_told(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await _request(db, world, S.SUBMITTED)
    await db.execute(
        update(BuildingMembership)
        .where(BuildingMembership.id == world.a_resident1.membership.id)
        .values(status=MembershipStatus.SUSPENDED)
    )

    await _move(as_user, world, request.id, "start")

    assert await _notifications(db) == []
    assert await _emails(db) == []


async def test_a_requester_who_moved_out_is_still_told(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # They still see their own request (`visible_maintenance`), so they are told.
    request = await _request(db, world, S.SUBMITTED)
    await end_occupancy(db, building_id=world.a.id, membership_id=world.a_resident1.membership.id)

    await _move(as_user, world, request.id, "start")

    assert [row.recipient_user_id for row in await _notifications(db)] == [
        world.a_resident1.user.id
    ]


async def test_co_occupants_are_not_told(as_user: Any, world: World, db: AsyncSession) -> None:
    # 201: a_council filed it; multi_in_a lives there and sees it but didn't file it.
    request = await _request(db, world, S.SUBMITTED, requester=world.a_council, unit=world.a_201)

    await _move(as_user, world, request.id, "start")

    assert [row.recipient_user_id for row in await _notifications(db)] == [world.a_council.user.id]
