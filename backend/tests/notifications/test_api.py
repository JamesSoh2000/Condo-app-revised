"""The notification routes (P3-03 criteria 2–5, 7–9) and the 10-case rows that apply to them."""

import uuid
from datetime import UTC, datetime, timedelta

import pytest
from httpx import AsyncClient
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.notifications.models import Notification
from tests.conftest import FrozenClock, UserClientFactory
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.notifications.conftest import make_notification
from tests.world import World

pytestmark = pytest.mark.anyio


def url(world: World, path: str = "", *, building: str = "a") -> str:
    building_id = world.a.id if building == "a" else world.b.id
    return f"/api/buildings/{building_id}/notifications{path}"


async def read_at(db: AsyncSession, notification: Notification) -> datetime | None:
    value: datetime | None = await db.scalar(
        select(Notification.read_at)
        .where(Notification.id == notification.id)
        .execution_options(populate_existing=True)
    )
    return value


# Criterion 2


async def test_resident_lists_only_own_notifications_newest_first(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    mine_old = await make_notification(db, world.a, world.a_resident1.user.id)
    await make_notification(db, world.a, world.a_resident2.user.id)
    entity = uuid.uuid4()
    mine_new = await make_notification(
        db,
        world.a,
        world.a_resident1.user.id,
        kind="package.picked_up",
        title="Picked up",
        body="",
        link=None,
        entity_type="package",
        entity_id=entity,
        read_at=datetime(2026, 1, 2, tzinfo=UTC),
    )
    client = await as_user(world.a_resident1.user)

    response = await client.get(url(world))

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["next_cursor"] is None
    assert [item["id"] for item in body["items"]] == [str(mine_new.id), str(mine_old.id)]
    assert body["items"][0] == {
        "id": str(mine_new.id),
        "kind": "package.picked_up",
        "title": "Picked up",
        "body": "",
        "link": None,
        "entity_type": "package",
        "entity_id": str(entity),
        "read_at": "2026-01-02T00:00:00Z",
        "created_at": body["items"][0]["created_at"],
    }
    assert body["items"][1]["read_at"] is None


async def test_unread_only_and_pagination(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    me = world.a_resident1.user.id
    first = await make_notification(db, world.a, me)
    await make_notification(db, world.a, me, read_at=datetime(2026, 1, 1, tzinfo=UTC))
    third = await make_notification(db, world.a, me)
    client = await as_user(world.a_resident1.user)

    unread = (await client.get(url(world), params={"unread_only": "true"})).json()
    assert [item["id"] for item in unread["items"]] == [str(third.id), str(first.id)]

    page1 = (await client.get(url(world), params={"limit": 2})).json()
    assert len(page1["items"]) == 2
    assert page1["next_cursor"] is not None
    page2 = (
        await client.get(url(world), params={"limit": 2, "cursor": page1["next_cursor"]})
    ).json()
    assert [item["id"] for item in page2["items"]] == [str(first.id)]
    assert page2["next_cursor"] is None

    unread_page = (
        await client.get(url(world), params={"unread_only": "true", "limit": 1})
    ).json()
    unread_rest = (
        await client.get(
            url(world),
            params={"unread_only": "true", "limit": 1, "cursor": unread_page["next_cursor"]},
        )
    ).json()
    assert [item["id"] for item in unread_rest["items"]] == [str(first.id)]


async def test_bad_cursor_is_400(as_user: UserClientFactory, world: World) -> None:
    client = await as_user(world.a_resident1.user)

    assert_problem(await client.get(url(world), params={"cursor": "nope"}), 400, "invalid_cursor")


async def test_multi_sees_each_buildings_notifications_on_its_route(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    in_a = await make_notification(db, world.a, world.multi.id)
    in_b = await make_notification(db, world.b, world.multi.id)
    client = await as_user(world.multi)

    listed_a = (await client.get(url(world))).json()["items"]
    listed_b = (await client.get(url(world, building="b"))).json()["items"]

    assert [item["id"] for item in listed_a] == [str(in_a.id)]
    assert [item["id"] for item in listed_b] == [str(in_b.id)]


# Criterion 8


async def test_summary_counts_own_unread_in_this_building(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    await make_notification(db, world.a, world.multi.id)
    await make_notification(db, world.a, world.multi.id)
    await make_notification(db, world.a, world.multi.id, read_at=datetime(2026, 1, 1, tzinfo=UTC))
    await make_notification(db, world.a, world.a_resident1.user.id)
    await make_notification(db, world.b, world.multi.id)
    client = await as_user(world.multi)

    response = await client.get(url(world, "/summary"))

    assert response.status_code == 200, response.text
    assert response.json() == {"unread_count": 2}
    assert (await client.get(url(world, "/summary", building="b"))).json() == {"unread_count": 1}


# Criteria 3 and 4


async def test_resident_cannot_mark_another_residents_notification_read(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    theirs = await make_notification(db, world.a, world.a_resident1.user.id)
    client = await as_user(world.a_resident2.user)

    hidden = await assert_not_visible(
        client, "POST", url(world, f"/{theirs.id}/read"), code="notification_not_found"
    )
    missing = await assert_not_visible(
        client, "POST", url(world, f"/{uuid.uuid4()}/read"), code="notification_not_found"
    )

    assert without_request_id(hidden) == without_request_id(missing)
    assert await read_at(db, theirs) is None


async def test_mark_read_twice_is_204_and_keeps_the_first_read_at(
    as_user: UserClientFactory, db: AsyncSession, world: World, frozen_clock: FrozenClock
) -> None:
    mine = await make_notification(db, world.a, world.a_resident1.user.id)
    client = await as_user(world.a_resident1.user)

    first = await client.post(url(world, f"/{mine.id}/read"))
    assert first.status_code == 204, first.text
    assert first.content == b""
    assert await read_at(db, mine) == frozen_clock.at

    frozen_clock.advance(minutes=5)
    second = await client.post(url(world, f"/{mine.id}/read"))
    assert second.status_code == 204, second.text
    assert await read_at(db, mine) == frozen_clock.at - timedelta(minutes=5)


# Criterion 9 (10-case row 7)


async def test_multi_cannot_mark_its_b_notification_read_through_a(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    in_b = await make_notification(db, world.b, world.multi.id)
    client = await as_user(world.multi)

    await assert_not_visible(
        client, "POST", url(world, f"/{in_b.id}/read"), code="notification_not_found"
    )

    assert await read_at(db, in_b) is None


# Criterion 5


async def test_read_all_marks_only_own_in_this_building(
    as_user: UserClientFactory, db: AsyncSession, world: World, frozen_clock: FrozenClock
) -> None:
    earlier = datetime(2026, 1, 1, tzinfo=UTC)
    mine = [await make_notification(db, world.a, world.multi.id) for _ in range(2)]
    already = await make_notification(db, world.a, world.multi.id, read_at=earlier)
    in_b = await make_notification(db, world.b, world.multi.id)
    someone_elses = await make_notification(db, world.a, world.a_resident1.user.id)
    client = await as_user(world.multi)

    response = await client.post(url(world, "/read-all"))

    assert response.status_code == 204, response.text
    assert [await read_at(db, n) for n in mine] == [frozen_clock.at, frozen_clock.at]
    assert await read_at(db, already) == earlier
    assert await read_at(db, in_b) is None
    assert await read_at(db, someone_elses) is None
    assert (await client.get(url(world, "/summary"))).json() == {"unread_count": 0}
    assert (await client.get(url(world, "/summary", building="b"))).json() == {"unread_count": 1}
    # Nothing left to mark: still 204.
    assert (await client.post(url(world, "/read-all"))).status_code == 204


# Criterion 7: the 10-case rows 2, 3 and 6 with each route's real request

ROUTES = [
    ("GET", ""),
    ("GET", "/summary"),
    ("POST", "/read-all"),
    ("POST", "/{id}/read"),
]


@pytest.mark.parametrize(("method", "path"), ROUTES)
async def test_routes_refuse_outsiders(
    as_user: UserClientFactory,
    client: AsyncClient,
    db: AsyncSession,
    world: World,
    method: str,
    path: str,
) -> None:
    # Each outsider has a notification in A, so a 404 isn't just "nothing to show".
    outsiders = [world.b_resident1, world.a_pending, world.a_suspended]
    rows = {
        member.user.id: await make_notification(db, world.a, member.user.id)
        for member in outsiders
        if member is not world.b_resident1
    }

    assert_problem(
        await client.request(method, url(world, path.replace("{id}", str(uuid.uuid4())))),
        401,
        "not_authenticated",
    )
    for member in outsiders:
        own = rows.get(member.user.id)
        target = url(world, path.replace("{id}", str(own.id if own else uuid.uuid4())))
        await assert_cross_building_404(await as_user(member.user), method, target)
    for row in rows.values():
        assert await read_at(db, row) is None


async def test_every_active_role_can_use_the_routes(
    as_user: UserClientFactory, db: AsyncSession, world: World
) -> None:
    for member in [world.a_manager, world.a_security, world.a_council, world.a_former]:
        mine = await make_notification(db, world.a, member.user.id)
        client = await as_user(member.user)

        listed = (await client.get(url(world))).json()["items"]
        assert [item["id"] for item in listed] == [str(mine.id)]
        assert (await client.get(url(world, "/summary"))).json() == {"unread_count": 1}
        assert (await client.post(url(world, f"/{mine.id}/read"))).status_code == 204
        assert (await client.post(url(world, "/read-all"))).status_code == 204
        assert (await client.get(url(world, "/summary"))).json() == {"unread_count": 0}
