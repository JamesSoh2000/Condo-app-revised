"""Comment notifications (P6-03d criteria 2's notification half, 4 and 5; D2).

A staff author's public comment tells the requester, in-app and by email; a resident author's tells
the building's active managers, in-app only; an internal comment tells no one. The author is never
told, and neither is anyone who can't see the request.
"""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import delete, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs.models import Job
from app.maintenance.models import MaintenanceRequest
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.notifications.models import Notification
from tests.factories import make_membership, make_user
from tests.maintenance.conftest import make_maintenance_request
from tests.maintenance.test_comments_api import comments_url
from tests.world import World

pytestmark = pytest.mark.anyio

LOCKBOX = "Lockbox code 4321"


async def _notifications(db: AsyncSession) -> list[Notification]:
    rows = await db.scalars(
        select(Notification)
        .where(Notification.kind.like("maintenance.%commented"))
        .order_by(Notification.id)
    )
    return list(rows)


async def _emails(db: AsyncSession) -> list[Job]:
    rows = await db.scalars(
        select(Job)
        .where(Job.kind == "email.send", Job.dedupe_key.like("maintenance.%commented:%"))
        .order_by(Job.id)
    )
    return list(rows)


async def _comment(
    as_user: Any, world: World, user: Any, request: MaintenanceRequest, **body: Any
) -> dict[str, Any]:
    client = await as_user(user)
    response = await client.post(
        comments_url(world, request.id), json={"body": LOCKBOX} | body
    )
    assert response.status_code == 201, response.text
    result: dict[str, Any] = response.json()
    return result


@pytest.fixture
async def request_101(db: AsyncSession, world: World) -> MaintenanceRequest:
    return await make_maintenance_request(db, world.a_resident1.membership, world.a_101)


@pytest.mark.parametrize("persona", ["a_manager", "a_security"])
async def test_a_staff_public_comment_tells_the_requester_in_app_and_by_email(
    as_user: Any, world: World, db: AsyncSession, request_101: Any, persona: str
) -> None:
    comment = await _comment(as_user, world, getattr(world, persona).user, request_101)

    [row] = await _notifications(db)
    assert (
        row.building_id,
        row.recipient_user_id,
        row.kind,
        row.title,
        row.body,
        row.link,
        row.entity_type,
        row.entity_id,
    ) == (
        world.a.id,
        world.a_resident1.user.id,
        "maintenance.staff_commented",
        "New reply on your maintenance request",
        "Building management replied to your Plumbing request.",
        f"/maintenance/{request_101.id}",
        "maintenance_comment",
        uuid.UUID(comment["id"]),
    )
    [email] = await _emails(db)
    assert email.payload["template"] == "notification"
    assert email.payload["to"] == world.a_resident1.user.email
    assert LOCKBOX not in str(email.payload)


async def test_two_staff_replies_in_a_row_both_email(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    # P6-03c criterion 6a: the dedupe key names the comment, so the second isn't swallowed.
    first = await _comment(as_user, world, world.a_manager.user, request_101)
    second = await _comment(as_user, world, world.a_manager.user, request_101)

    emails = await _emails(db)
    assert len(emails) == 2
    assert [email.dedupe_key for email in emails] == [
        f"maintenance.staff_commented:{first['id']}:{world.a_resident1.user.id}",
        f"maintenance.staff_commented:{second['id']}:{world.a_resident1.user.id}",
    ]


async def test_a_staff_reply_does_not_tell_co_occupants(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # 201: a_council filed it; multi_in_a sees it but didn't file it.
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)

    await _comment(as_user, world, world.a_manager.user, request)

    assert [row.recipient_user_id for row in await _notifications(db)] == [world.a_council.user.id]


async def test_a_residents_comment_tells_the_active_managers_in_app_only(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    second = await make_membership(await make_user(db), world.a, roles=(Role.PROPERTY_MANAGEMENT,))
    await make_membership(
        await make_user(db),
        world.a,
        roles=(Role.PROPERTY_MANAGEMENT,),
        status=MembershipStatus.SUSPENDED,
    )

    comment = await _comment(as_user, world, world.a_resident1.user, request_101)

    rows = await _notifications(db)
    assert sorted(row.recipient_user_id for row in rows) == sorted(
        [world.a_manager.user.id, second.user_id]
    )
    for row in rows:
        assert (row.kind, row.title, row.body, row.link, row.entity_type, row.entity_id) == (
            "maintenance.resident_commented",
            "New comment on a maintenance request",
            "A resident commented on a Plumbing request.",
            f"/maintenance/{request_101.id}",
            "maintenance_comment",
            uuid.UUID(comment["id"]),
        )
    # Security sees the request but isn't told; nor is the requester, the author.
    assert world.a_security.user.id not in {row.recipient_user_id for row in rows}
    assert await _emails(db) == []


async def test_a_co_occupants_comment_tells_the_managers_not_the_requester(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)

    await _comment(as_user, world, world.multi, request)

    assert [row.recipient_user_id for row in await _notifications(db)] == [world.a_manager.user.id]


@pytest.mark.parametrize("persona", ["a_manager", "a_security"])
async def test_an_internal_comment_tells_no_one(
    as_user: Any, world: World, db: AsyncSession, request_101: Any, persona: str
) -> None:
    await _comment(as_user, world, getattr(world, persona).user, request_101, internal=True)

    assert await _notifications(db) == []
    assert await _emails(db) == []
    # No row of any kind names the requester or carries the note.
    rows = list(await db.scalars(select(Notification)))
    assert world.a_resident1.user.id not in {row.recipient_user_id for row in rows}
    jobs = list(await db.scalars(select(Job)))
    assert not any(LOCKBOX in str(job.payload) for job in jobs)


async def test_a_manager_replying_on_their_own_request_is_not_told(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # a_council also manages: their comment on their own request is a staff one, to themselves.
    db.add(
        MembershipRole(
            building_id=world.a.id,
            membership_id=world.a_council.membership.id,
            role=Role.PROPERTY_MANAGEMENT,
        )
    )
    await db.flush()
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)

    comment = await _comment(as_user, world, world.a_council.user, request)

    assert comment["author_is_staff"] is True
    assert await _notifications(db) == []
    assert await _emails(db) == []


async def test_a_requester_who_can_no_longer_see_the_request_is_not_told(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # a_council loses the resident role (council alone sees no request, P6-03a D8); a_resident2
    # is suspended. Neither is told of a staff reply on their request.
    council_request = await make_maintenance_request(db, world.a_council.membership, None)
    suspended_request = await make_maintenance_request(db, world.a_resident2.membership, None)
    await db.execute(
        delete(MembershipRole).where(
            MembershipRole.membership_id == world.a_council.membership.id,
            MembershipRole.role == Role.RESIDENT,
        )
    )
    await db.execute(
        update(BuildingMembership)
        .where(BuildingMembership.id == world.a_resident2.membership.id)
        .values(status=MembershipStatus.SUSPENDED)
    )

    await _comment(as_user, world, world.a_manager.user, council_request)
    await _comment(as_user, world, world.a_manager.user, suspended_request)

    assert await _notifications(db) == []
    assert await _emails(db) == []


async def test_a_moved_out_requester_is_still_told_and_former_co_occupants_are_not(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # Criterion 5: a_former filed for 101 in their time there, then moved to 102 at T1. They still
    # see the request (its requester), so a staff reply tells them; a_resident1, 101's occupant
    # now, can't see it and isn't told.
    request = await make_maintenance_request(
        db, world.a_former.membership, world.a_101, submitted_at=World.T0 + timedelta(days=1)
    )

    await _comment(as_user, world, world.a_manager.user, request)

    assert [row.recipient_user_id for row in await _notifications(db)] == [world.a_former.user.id]
