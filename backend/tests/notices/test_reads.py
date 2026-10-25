"""Reads and the unread summary (P6-01c criteria 1, 1a, 2, 2a): `POST /notices/{id}/read`,
`GET /notices/summary` and `NoticeOut.read_at`, with the tenant table (ENGINEERING_PRACTICES §7)."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.notices.enums import NoticePriority
from app.notices.models import Notice, NoticeRead
from app.notifications.models import Notification
from tests.helpers.db import assert_integrity_error
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.notices.conftest import archived, db_now, make_notice, published
from tests.notifications.conftest import make_notification
from tests.world import World

pytestmark = pytest.mark.anyio

LONG_AGO = World.T0 + timedelta(days=1)
# Every member of A who sees a live published notice; `multi` is a resident in A.
READERS = ["a_manager", "a_security", "a_resident1", "a_council", "a_former", "multi"]


def _base(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/notices"


def _read_url(world: World, notice: Notice) -> str:
    return f"{_base(world)}/{notice.id}/read"


async def _live(db: AsyncSession, world: World, **overrides: Any) -> Notice:
    manager = world.a_manager.membership
    return await make_notice(db, manager, **published(manager, LONG_AGO, **overrides))


async def _reads(db: AsyncSession, notice: Notice) -> list[NoticeRead]:
    return list(
        await db.scalars(
            select(NoticeRead)
            .where(NoticeRead.notice_id == notice.id)
            .execution_options(populate_existing=True)
        )
    )


async def _client(as_user: Any, world: World, persona: str) -> AsyncClient:
    member = getattr(world, persona)
    client: AsyncClient = await as_user(member if persona == "multi" else member.user)
    return client


async def _summary(client: AsyncClient, world: World, building: Any = None) -> dict[str, int]:
    response = await client.get(f"{_base(world, building)}/summary")
    assert response.status_code == 200, response.text
    body: dict[str, int] = response.json()
    return body


# --- Criterion 1: who may mark a notice read ---------------------------------------------------


@pytest.mark.parametrize("persona", READERS)
async def test_every_member_who_sees_the_notice_marks_it_read(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    notice = await _live(db, world)
    client = await _client(as_user, world, persona)
    before = await db_now(db)

    response = await client.post(_read_url(world, notice))

    assert response.status_code == 204, response.text
    assert response.content == b""
    [read] = await _reads(db, notice)
    membership = world.multi_in_a if persona == "multi" else getattr(world, persona).membership
    assert (read.building_id, read.membership_id) == (world.a.id, membership.id)
    assert read.read_at >= before


async def test_marking_read_twice_keeps_one_row_and_the_first_read_at(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    notice = await _live(db, world)
    client = await as_user(world.a_resident1.user)
    assert (await client.post(_read_url(world, notice))).status_code == 204
    [first] = await _reads(db, notice)
    first_at = first.read_at
    # Back-date it, so a second write of `read_at` would show.
    await db.execute(
        update(NoticeRead)
        .where(NoticeRead.notice_id == notice.id)
        .values(read_at=first_at - timedelta(hours=1))
    )
    # A value, not the row: `_reads` refreshes the same identity-mapped object.
    [backdated] = await _reads(db, notice)
    backdated_at = backdated.read_at
    assert backdated_at < first_at

    second = await client.post(_read_url(world, notice))

    assert second.status_code == 204, second.text
    [kept] = await _reads(db, notice)
    assert kept.read_at == backdated_at


async def test_a_read_writes_no_audit_row_and_changes_no_notification(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Criterion 1a. The reader's notification of this notice stays unread (review round 1, Codex:
    # counting rows alone would miss a change to an existing one).
    notice = await _live(db, world)
    told = await make_notification(
        db,
        world.a,
        world.a_resident1.user.id,
        kind="notice.published",
        entity_type="notice",
        entity_id=notice.id,
    )
    client = await as_user(world.a_resident1.user)
    audits = await db.scalar(select(func.count()).select_from(AuditEvent))
    before = await _notification_rows(db)

    assert (await client.post(_read_url(world, notice))).status_code == 204

    assert await db.scalar(select(func.count()).select_from(AuditEvent)) == audits
    after = await _notification_rows(db)
    assert after == before
    assert after[told.id]["read_at"] is None


async def _notification_rows(db: AsyncSession) -> dict[Any, dict[str, Any]]:
    rows = await db.scalars(select(Notification).execution_options(populate_existing=True))
    return {
        row.id: {column.key: getattr(row, column.key) for column in Notification.__table__.columns}
        for row in rows
    }


@pytest.mark.parametrize("state", ["draft", "archived", "expired"])
@pytest.mark.parametrize("persona", ["a_resident1", "a_security", "a_council"])
async def test_a_notice_hidden_from_a_member_is_404_like_an_unknown_one(
    db: AsyncSession, as_user: Any, world: World, persona: str, state: str
) -> None:
    manager = world.a_manager.membership
    columns: dict[str, Any] = {
        "draft": {},
        "archived": archived(
            manager,
            LONG_AGO + timedelta(days=1),
            published_at=LONG_AGO,
            published_by_membership_id=manager.id,
        ),
        "expired": published(manager, LONG_AGO, expires_at=LONG_AGO + timedelta(days=1)),
    }[state]
    notice = await make_notice(db, manager, **columns)
    client = await _client(as_user, world, persona)
    missing = await assert_not_visible(
        client, "POST", f"{_base(world)}/{uuid.uuid4()}/read", code="notice_not_found"
    )

    refused = await assert_not_visible(
        client, "POST", _read_url(world, notice), code="notice_not_found"
    )

    assert without_request_id(refused) == without_request_id(missing)
    assert await _reads(db, notice) == []


@pytest.mark.parametrize("state", ["draft", "archived"])
async def test_the_manager_may_mark_any_notice_they_see_read(
    db: AsyncSession, as_user: Any, world: World, state: str
) -> None:
    manager = world.a_manager.membership
    columns = {} if state == "draft" else archived(manager, LONG_AGO)
    notice = await make_notice(db, manager, **columns)
    client = await as_user(world.a_manager.user)

    assert (await client.post(_read_url(world, notice))).status_code == 204

    assert [read.membership_id for read in await _reads(db, notice)] == [manager.id]


async def test_another_buildings_notice_is_404_through_this_building(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    other = await make_notice(
        db, world.b_manager.membership, **published(world.b_manager.membership, LONG_AGO)
    )
    client = await as_user(world.a_manager.user)

    await assert_not_visible(
        client, "POST", f"{_base(world)}/{other.id}/read", code="notice_not_found"
    )

    assert await _reads(db, other) == []


def _routes(world: World, notice: Notice) -> list[tuple[str, str]]:
    return [("POST", _read_url(world, notice)), ("GET", f"{_base(world)}/summary")]


@pytest.mark.parametrize("persona", ["b_manager", "b_resident1", "a_pending", "a_suspended"])
async def test_non_members_get_404_on_read_and_summary(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    notice = await _live(db, world)
    client = await as_user(getattr(world, persona).user)

    for method, url in _routes(world, notice):
        await assert_cross_building_404(client, method, url)

    assert await _reads(db, notice) == []


async def test_read_and_summary_are_401_without_a_session(
    db: AsyncSession, client: AsyncClient, world: World
) -> None:
    notice = await _live(db, world)

    for method, url in _routes(world, notice):
        assert_problem(await client.request(method, url), 401, "not_authenticated")


async def test_read_and_summary_are_403_when_the_feature_is_off(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    notice = await _live(db, world)
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id, BuildingFeature.feature == Feature.NOTICES
        )
        .values(enabled=False)
    )
    client = await as_user(world.a_resident1.user)

    for method, url in _routes(world, notice):
        assert_problem(await client.request(method, url), 403, "feature_disabled")

    assert await _reads(db, notice) == []


# --- Criterion 2: the summary -------------------------------------------------------------------


async def test_reading_the_urgent_notice_takes_it_out_of_both_counts(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await _live(db, world)
    urgent = await _live(db, world, priority=NoticePriority.URGENT)
    reader = await as_user(world.a_resident1.user)
    other = await as_user(world.a_resident2.user)
    assert await _summary(reader, world) == {"unread": 2, "urgent_unread": 1}
    assert await _summary(other, world) == {"unread": 2, "urgent_unread": 1}

    assert (await reader.post(_read_url(world, urgent))).status_code == 204

    assert await _summary(reader, world) == {"unread": 1, "urgent_unread": 0}
    assert await _summary(other, world) == {"unread": 2, "urgent_unread": 1}


async def test_the_summary_counts_only_live_published_notices_for_every_role(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    manager = world.a_manager.membership
    urgent = {"priority": NoticePriority.URGENT}
    await make_notice(db, manager, **urgent)  # a draft
    await make_notice(db, manager, **archived(manager, LONG_AGO, **urgent))
    await _live(db, world, expires_at=LONG_AGO + timedelta(days=1), **urgent)  # expired
    live = await _live(db, world, **urgent)

    for persona in ("a_manager", "a_resident1"):
        client = await as_user(getattr(world, persona).user)
        assert await _summary(client, world) == {"unread": 1, "urgent_unread": 1}, persona

    # A notice that expires drops out, read or not.
    await db.execute(
        update(Notice)
        .where(Notice.id == live.id)
        .values(expires_at=func.now() - timedelta(seconds=1))
    )
    client = await as_user(world.a_resident1.user)
    assert await _summary(client, world) == {"unread": 0, "urgent_unread": 0}


async def test_a_read_in_one_building_does_not_count_in_another(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # multi is a resident in A and security in B: each membership has its own reads.
    notice = await _live(db, world)
    await make_notice(
        db, world.b_manager.membership, **published(world.b_manager.membership, LONG_AGO)
    )
    client = await as_user(world.multi)

    assert (await client.post(_read_url(world, notice))).status_code == 204

    assert await _summary(client, world) == {"unread": 0, "urgent_unread": 0}
    assert await _summary(client, world, world.b) == {"unread": 1, "urgent_unread": 0}


# --- Criterion 2a: `read_at` on every NoticeOut -------------------------------------------------


async def test_list_and_get_show_the_callers_own_read_at(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    read, unread = await _live(db, world), await _live(db, world)
    reader = await as_user(world.a_resident1.user)
    other = await as_user(world.a_resident2.user)
    assert (await reader.post(_read_url(world, read))).status_code == 204
    [row] = await _reads(db, read)

    listed = {
        item["id"]: item["read_at"] for item in (await reader.get(_base(world))).json()["items"]
    }
    assert listed[str(unread.id)] is None
    assert listed[str(read.id)] is not None
    got = (await reader.get(f"{_base(world)}/{read.id}")).json()
    assert got["read_at"] == listed[str(read.id)]
    assert got["read_at"].startswith(row.read_at.strftime("%Y-%m-%dT%H:%M:%S"))

    # Another member's read never shows.
    others = (await other.get(_base(world))).json()["items"]
    assert {item["read_at"] for item in others} == {None}
    assert (await other.get(f"{_base(world)}/{read.id}")).json()["read_at"] is None


async def test_the_write_answers_show_the_managers_own_read_at(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    draft = await make_notice(db, world.a_manager.membership)
    manager = await as_user(world.a_manager.user)
    resident = await as_user(world.a_resident1.user)

    created = await manager.post(_base(world), json={"title": "T", "body": "B"})
    assert created.status_code == 201, created.text
    assert created.json()["read_at"] is None

    assert (await manager.post(_read_url(world, draft))).status_code == 204
    edited = await manager.patch(f"{_base(world)}/{draft.id}", json={"title": "Edited"})
    assert edited.json()["read_at"] is not None
    published_ = await manager.post(f"{_base(world)}/{draft.id}/publish")
    assert published_.json()["read_at"] == edited.json()["read_at"]
    # A resident's read of the published notice is not the manager's.
    assert (await resident.post(_read_url(world, draft))).status_code == 204
    archived_ = await manager.post(f"{_base(world)}/{draft.id}/archive")
    assert archived_.json()["read_at"] == edited.json()["read_at"]

    other = await make_notice(db, world.a_manager.membership)
    assert (await manager.post(f"{_base(world)}/{other.id}/publish")).json()["read_at"] is None


@pytest.mark.parametrize("reference", ["notice", "membership"])
async def test_the_table_refuses_a_read_across_buildings(
    db: AsyncSession, world: World, reference: str
) -> None:
    # Review round 1 (Codex's independent check, kept): the composite FKs (ADR-0005).
    author = world.b_manager if reference == "notice" else world.a_manager
    notice = await make_notice(db, author.membership)
    member = world.b_resident1 if reference == "membership" else world.a_resident1

    async def insert() -> None:
        db.add(
            NoticeRead(
                building_id=world.a.id, notice_id=notice.id, membership_id=member.membership.id
            )
        )
        await db.flush()

    target = "notice_id_notices" if reference == "notice" else "membership_id_building_memberships"
    await assert_integrity_error(db, insert(), constraint=f"fk_notice_reads_building_id_{target}")


# --- P6-02b criterion 11: the banner's filters on the list ------------------------------------


async def test_priority_and_unread_keep_the_callers_own_unread_urgent_live_notices(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    urgent = {"priority": NoticePriority.URGENT}
    wanted = await _live(db, world, **urgent)
    read = await _live(db, world, **urgent)
    await _live(db, world)  # normal and unread
    await _live(db, world, expires_at=LONG_AGO + timedelta(days=1), **urgent)  # expired
    manager = world.a_manager.membership
    await make_notice(db, manager, priority=NoticePriority.URGENT)  # a draft
    await make_notice(
        db, world.b_manager.membership, **published(world.b_manager.membership, LONG_AGO, **urgent)
    )
    reader = await as_user(world.a_resident1.user)
    other = await as_user(world.a_resident2.user)
    assert (await reader.post(_read_url(world, read))).status_code == 204
    # Another member's read hides nothing from the reader.
    assert (await other.post(_read_url(world, wanted))).status_code == 204

    query = "?live=true&priority=urgent&unread=true"
    response = await reader.get(f"{_base(world)}{query}")
    assert response.status_code == 200, response.text
    assert [item["id"] for item in response.json()["items"]] == [str(wanted.id)]
    assert (await _summary(reader, world))["urgent_unread"] == 1
    # The other resident read `wanted` and not `read`.
    others = (await other.get(f"{_base(world)}{query}")).json()["items"]
    assert [item["id"] for item in others] == [str(read.id)]


async def test_each_filter_narrows_on_its_own(db: AsyncSession, as_user: Any, world: World) -> None:
    normal = await _live(db, world)
    urgent = await _live(db, world, priority=NoticePriority.URGENT)
    reader = await as_user(world.a_resident1.user)
    assert (await reader.post(_read_url(world, urgent))).status_code == 204

    def ids(response: Any) -> set[str]:
        assert response.status_code == 200, response.text
        return {item["id"] for item in response.json()["items"]}

    assert ids(await reader.get(f"{_base(world)}?priority=urgent")) == {str(urgent.id)}
    assert ids(await reader.get(f"{_base(world)}?priority=normal")) == {str(normal.id)}
    assert ids(await reader.get(f"{_base(world)}?unread=true")) == {str(normal.id)}
    assert ids(await reader.get(f"{_base(world)}?unread=false")) == {str(normal.id), str(urgent.id)}


async def test_the_manager_filters_inside_everything_they_see(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    manager = world.a_manager.membership
    draft = await make_notice(db, manager, priority=NoticePriority.URGENT)
    client = await as_user(world.a_manager.user)
    items = (await client.get(f"{_base(world)}?priority=urgent&unread=true")).json()["items"]
    assert [item["id"] for item in items] == [str(draft.id)]
    # `live=true` still drops the draft.
    live = (await client.get(f"{_base(world)}?priority=urgent&unread=true&live=true")).json()
    assert live["items"] == []


@pytest.mark.parametrize("query", ["priority=high", "priority=", "unread=maybe"])
async def test_a_bad_filter_is_422(as_user: Any, world: World, query: str) -> None:
    client = await as_user(world.a_resident1.user)
    response = await client.get(f"{_base(world)}?{query}")
    assert_problem(response, 422, "validation_error")
