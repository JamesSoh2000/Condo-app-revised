"""The new-request notification (P6-03b criterion 8, D5): the building's active managers are told,
in-app; an emergency also emails them."""

import uuid
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.jobs.models import Job
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import MembershipRole
from app.notifications.models import Notification
from tests.factories import make_membership, make_user
from tests.maintenance.test_api import common_body, counts, create, unit_body
from tests.world import World

pytestmark = pytest.mark.anyio

LOCKBOX = "Lockbox code 4321"


async def _notifications(db: AsyncSession, request_id: str) -> list[Notification]:
    rows = await db.scalars(
        select(Notification)
        .where(Notification.entity_id == uuid.UUID(request_id))
        .order_by(Notification.recipient_user_id)
    )
    return list(rows)


async def _emails(db: AsyncSession, request_id: str) -> list[Job]:
    rows = await db.scalars(
        select(Job)
        .where(Job.kind == "email.send", Job.dedupe_key.like(f"%:{request_id}:%"))
        .order_by(Job.dedupe_key)
    )
    return list(rows)


async def test_a_new_request_tells_every_active_manager_in_app_only(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    second = await make_membership(await make_user(db), world.a, roles=(Role.PROPERTY_MANAGEMENT,))
    suspended = await make_membership(
        await make_user(db),
        world.a,
        roles=(Role.PROPERTY_MANAGEMENT,),
        status=MembershipStatus.SUSPENDED,
    )
    client = await as_user(world.a_resident1.user)

    response = await create(client, world, unit_body(world.a_101, description=LOCKBOX))

    assert response.status_code == 201, response.text
    rows = await _notifications(db, response.json()["id"])
    assert sorted(row.recipient_user_id for row in rows) == sorted(
        [world.a_manager.user.id, second.user_id]
    )
    assert suspended.user_id not in {row.recipient_user_id for row in rows}
    for row in rows:
        assert (row.kind, row.title, row.body, row.link, row.entity_type) == (
            "maintenance.submitted",
            "New maintenance request",
            "Plumbing request for unit 101.",
            f"/maintenance/{response.json()['id']}",
            "maintenance_request",
        )
        assert row.building_id == world.a.id
    assert await _emails(db, response.json()["id"]) == []


async def test_an_emergency_request_also_emails_the_managers(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)

    response = await create(
        client, world, unit_body(world.a_101, category="emergency", description=LOCKBOX)
    )

    assert response.status_code == 201, response.text
    [row] = await _notifications(db, response.json()["id"])
    assert (row.recipient_user_id, row.kind, row.title, row.body) == (
        world.a_manager.user.id,
        "maintenance.submitted_emergency",
        "Emergency maintenance request",
        "Emergency request for unit 101.",
    )
    [email] = await _emails(db, response.json()["id"])
    assert email.payload["template"] == "notification"
    assert LOCKBOX not in str(email.payload)


async def test_a_common_area_request_names_no_area_text(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident1.user)
    response = await create(
        client, world, common_body(common_area="Behind the lockbox 4321", category="pest_control")
    )
    [row] = await _notifications(db, response.json()["id"])
    assert row.body == "Pest control request for a common area."


async def test_unit_names_include_the_tower(as_user: Any, world: World, db: AsyncSession) -> None:
    world.a_101.tower = "B"
    await db.flush()
    client = await as_user(world.a_resident1.user)
    response = await create(client, world, unit_body(world.a_101, category="heating_cooling"))
    [row] = await _notifications(db, response.json()["id"])
    assert row.body == "Heating or cooling request for unit B 101."


async def test_security_council_and_residents_are_not_told(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    client = await as_user(world.a_resident2.user)
    response = await create(client, world, unit_body(world.a_102))
    recipients = {row.recipient_user_id for row in await _notifications(db, response.json()["id"])}
    assert recipients == {world.a_manager.user.id}


async def test_a_requester_who_also_manages_is_not_told_of_their_own_request(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    db.add(
        MembershipRole(
            building_id=world.a.id,
            membership_id=world.a_council.membership.id,
            role=Role.PROPERTY_MANAGEMENT,
        )
    )
    await db.flush()
    client = await as_user(world.a_council.user)
    response = await create(client, world, unit_body(world.a_201))
    assert response.status_code == 201, response.text
    recipients = {row.recipient_user_id for row in await _notifications(db, response.json()["id"])}
    assert recipients == {world.a_manager.user.id}


async def test_a_retry_notifies_no_one(as_user: Any, world: World, db: AsyncSession) -> None:
    client = await as_user(world.a_resident1.user)
    body = unit_body(world.a_101, category="emergency")
    first = await create(client, world, body, key="notify-key-0001")
    after = await counts(db)
    second = await create(client, world, body, key="notify-key-0001")
    assert second.headers["idempotent-replayed"] == "true"
    assert await counts(db) == after
    assert len(await _notifications(db, first.json()["id"])) == 1
