"""Publish, archive and edit by status (P6-01b criteria 2-4, 9; tenant row 8)."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.notices.enums import NoticeStatus
from app.notices.models import Notice
from tests.helpers.tenancy import assert_problem
from tests.notices.conftest import archived, db_now, make_notice, published
from tests.world import World

pytestmark = pytest.mark.anyio

LONG_AGO = World.T0 + timedelta(days=1)


def _url(world: World, notice: Notice, action: str = "") -> str:
    return f"/api/buildings/{world.a.id}/notices/{notice.id}{action}"


async def _row(db: AsyncSession, notice: Notice) -> dict[str, Any]:
    row = await db.scalar(
        select(Notice).where(Notice.id == notice.id).execution_options(populate_existing=True)
    )
    assert row is not None
    return {column.key: getattr(row, column.key) for column in Notice.__table__.columns}


async def _audits(db: AsyncSession, notice: Notice) -> list[AuditEvent]:
    return list(
        await db.scalars(
            select(AuditEvent).where(AuditEvent.entity_id == notice.id).order_by(AuditEvent.id)
        )
    )


async def _in(db: AsyncSession, world: World, status: str) -> Notice:
    manager = world.a_manager.membership
    columns: dict[str, Any] = {
        "draft": {},
        "published": published(manager, LONG_AGO),
        "archived": archived(manager, LONG_AGO),
        "archived-after-publish": archived(
            manager,
            LONG_AGO + timedelta(days=1),
            published_at=LONG_AGO,
            published_by_membership_id=manager.id,
        ),
    }[status]
    return await make_notice(db, manager, **columns)


async def test_the_manager_publishes_a_draft(db: AsyncSession, as_user: Any, world: World) -> None:
    notice = await make_notice(db, world.a_manager.membership)
    client = await as_user(world.a_manager.user)
    before = await db_now(db)

    response = await client.post(_url(world, notice, "/publish"))

    assert response.status_code == 200, response.text
    row = await _row(db, notice)
    assert row["status"] is NoticeStatus.PUBLISHED
    assert row["published_by_membership_id"] == world.a_manager.membership.id
    assert row["published_at"] is not None and row["published_at"] >= before
    body = response.json()
    assert body["status"] == "published"
    assert body["published_by_membership_id"] == str(world.a_manager.membership.id)
    [audit] = await _audits(db, notice)
    assert (audit.action, audit.actor_user_id, audit.metadata_) == (
        "notice.published",
        world.a_manager.user.id,
        {},
    )
    resident = await as_user(world.a_resident1.user)
    assert (await resident.get(_url(world, notice))).status_code == 200


@pytest.mark.parametrize("status", ["draft", "published", "archived-after-publish"])
async def test_the_manager_archives_a_draft_or_published_notice(
    db: AsyncSession, as_user: Any, world: World, status: str
) -> None:
    notice = await _in(db, world, status)
    before = await _row(db, notice)
    client = await as_user(world.a_manager.user)

    response = await client.post(_url(world, notice, "/archive"))

    if status == "archived-after-publish":
        assert_problem(response, 409, "invalid_transition")
        assert await _row(db, notice) == before
        assert await _audits(db, notice) == []
        return
    assert response.status_code == 200, response.text
    row = await _row(db, notice)
    assert row["status"] is NoticeStatus.ARCHIVED
    assert row["archived_by_membership_id"] == world.a_manager.membership.id
    assert row["archived_at"] is not None
    # The publish columns are kept: the archived_state check allows both or neither.
    assert (row["published_at"], row["published_by_membership_id"]) == (
        before["published_at"],
        before["published_by_membership_id"],
    )
    [audit] = await _audits(db, notice)
    assert (audit.action, audit.metadata_) == ("notice.archived", {"from_status": status})


@pytest.mark.parametrize(
    ("status", "action", "code"),
    [
        ("published", "/publish", "invalid_transition"),
        ("archived", "/publish", "invalid_transition"),
        ("archived-after-publish", "/publish", "invalid_transition"),
        ("archived", "/archive", "invalid_transition"),
        ("published", "", "notice_not_editable"),
        ("archived", "", "notice_not_editable"),
        ("archived-after-publish", "", "notice_not_editable"),
    ],
)
async def test_a_move_the_state_machine_forbids_is_409_and_changes_nothing(
    db: AsyncSession, as_user: Any, world: World, status: str, action: str, code: str
) -> None:
    notice = await _in(db, world, status)
    before = await _row(db, notice)
    client = await as_user(world.a_manager.user)

    if action:
        response = await client.post(_url(world, notice, action))
    else:
        response = await client.patch(_url(world, notice), json={"title": "Changed"})

    assert_problem(response, 409, code)
    assert await _row(db, notice) == before
    assert await _audits(db, notice) == []


async def test_publishing_twice_is_409(db: AsyncSession, as_user: Any, world: World) -> None:
    notice = await make_notice(db, world.a_manager.membership)
    client = await as_user(world.a_manager.user)
    assert (await client.post(_url(world, notice, "/publish"))).status_code == 200
    before = await _row(db, notice)

    assert_problem(await client.post(_url(world, notice, "/publish")), 409, "invalid_transition")
    assert await _row(db, notice) == before


async def test_an_unknown_notice_is_404_on_every_write(as_user: Any, world: World) -> None:
    client = await as_user(world.a_manager.user)
    base = f"/api/buildings/{world.a.id}/notices/{uuid.uuid4()}"

    for method, url, json in [
        ("PATCH", base, {"title": "T"}),
        ("POST", f"{base}/publish", None),
        ("POST", f"{base}/archive", None),
    ]:
        assert_problem(await client.request(method, url, json=json), 404, "notice_not_found")


async def test_publishing_a_draft_whose_expiry_has_passed_is_422(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Criterion 9: the draft was valid when written; its expiry passed before publish. Without the
    # check the `expires_after_published` constraint would refuse the UPDATE as a 500.
    notice = await make_notice(db, world.a_manager.membership)
    await db.execute(
        update(Notice)
        .where(Notice.id == notice.id)
        .values(expires_at=func.now() - timedelta(seconds=1))
    )
    before = await _row(db, notice)
    client = await as_user(world.a_manager.user)

    response = await client.post(_url(world, notice, "/publish"))

    assert_problem(response, 422, "notice_expired")
    assert await _row(db, notice) == before
    assert await _audits(db, notice) == []


async def test_publishing_a_draft_expiring_later_keeps_its_expiry(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    expires = (await db_now(db)) + timedelta(hours=1)
    notice = await make_notice(db, world.a_manager.membership, expires_at=expires)
    client = await as_user(world.a_manager.user)

    response = await client.post(_url(world, notice, "/publish"))

    assert response.status_code == 200, response.text
    row = await _row(db, notice)
    assert row["expires_at"] == expires
    assert row["published_at"] < expires
