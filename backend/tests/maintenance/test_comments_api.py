"""The comment routes (P6-03d criteria 1, 2's list half, 3, 6 and 7), with the tenant table
(ENGINEERING_PRACTICES §7). Notifications are in `test_comments_notify.py`, atomicity in
`test_atomicity.py`, the concurrent pair in `test_concurrency.py`."""

import json
import uuid
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.jobs.models import Job
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import MaintenanceComment, MaintenanceRequest
from app.notifications.models import Notification
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.maintenance.conftest import make_maintenance_comment, make_maintenance_request
from tests.maintenance.test_api import base
from tests.world import World

pytestmark = pytest.mark.anyio

ROW_MODELS = (MaintenanceComment, Notification, Job, AuditEvent)


def comments_url(world: World, request_id: Any, building: Any = None) -> str:
    return f"{base(world, building)}/{request_id}/comments"


async def counts(db: AsyncSession) -> tuple[int, ...]:
    return tuple(
        [await db.scalar(select(func.count()).select_from(model)) or 0 for model in ROW_MODELS]
    )


async def all_pages(client: AsyncClient, url: str, limit: int) -> list[list[dict[str, Any]]]:
    pages, cursor = [], None
    while True:
        params: dict[str, Any] = {"limit": limit} | ({"cursor": cursor} if cursor else {})
        response = await client.get(url, params=params)
        assert response.status_code == 200, response.text
        pages.append(response.json()["items"])
        cursor = response.json()["next_cursor"]
        if cursor is None:
            return pages


@pytest.fixture
async def request_101(db: AsyncSession, world: World) -> MaintenanceRequest:
    return await make_maintenance_request(db, world.a_resident1.membership, world.a_101)


# --- criterion 1: who comments and lists ----------------------------------------------------------


@pytest.mark.parametrize(
    ("persona", "staff"),
    [("a_resident1", False), ("a_manager", True), ("a_security", True)],
)
async def test_members_who_see_the_request_comment_and_list(
    as_user: Any, world: World, db: AsyncSession, request_101: Any, persona: str, staff: bool
) -> None:
    member = getattr(world, persona)
    client = await as_user(member.user)

    response = await client.post(
        comments_url(world, request_101.id), json={"body": "  Tap still drips.\n\tSee photo.  "}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    row = await db.scalar(select(MaintenanceComment).where(MaintenanceComment.id == body["id"]))
    assert row is not None
    assert (row.building_id, row.author_membership_id, row.author_is_staff) == (
        world.a.id,
        member.membership.id,
        staff,
    )
    assert body == {
        "id": str(row.id),
        "request_id": str(request_101.id),
        "body": "Tap still drips.\n\tSee photo.",
        "is_internal": False,
        "created_at": body["created_at"],
        "author_name": member.user.full_name,
        "author_is_staff": staff,
    }
    listed = await client.get(comments_url(world, request_101.id))
    assert listed.status_code == 200, listed.text
    assert listed.json() == {"items": [body], "next_cursor": None}


async def test_a_co_occupant_who_sees_the_request_comments_on_it(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # 201's request by a_council: multi_in_a lives in 201 too and sees it (P6-03a).
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)
    client = await as_user(world.multi)

    response = await client.post(comments_url(world, request.id), json={"body": "Same here."})

    assert response.status_code == 201, response.text
    assert response.json()["author_is_staff"] is False
    listed = await client.get(comments_url(world, request.id))
    assert [item["id"] for item in listed.json()["items"]] == [response.json()["id"]]


async def test_the_council_member_comments_on_their_own_request_only(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    own = await make_maintenance_request(db, world.a_council.membership, None)
    other = await make_maintenance_request(db, world.a_resident2.membership, None)
    client = await as_user(world.a_council.user)

    assert (await client.post(comments_url(world, own.id), json={"body": "Hi"})).status_code == 201
    for method in ("POST", "GET"):
        await assert_not_visible(
            client,
            method,
            comments_url(world, other.id),
            code="maintenance_request_not_found",
            json={"body": "Hi"},
        )


async def test_another_residents_request_is_the_same_404_as_a_random_id(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    await make_maintenance_comment(db, request_101, world.a_manager.membership)
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    client = await as_user(world.a_resident2.user)
    before = await counts(db)

    for method in ("POST", "GET"):
        bodies = [
            without_request_id(
                await assert_not_visible(
                    client,
                    method,
                    comments_url(world, request_id),
                    code="maintenance_request_not_found",
                    json={"body": "Hi"},
                )
            )
            for request_id in (request_101.id, uuid.uuid4(), b_request.id)
        ]
        assert bodies[0] == bodies[1] == bodies[2]
    assert await counts(db) == before


async def test_a_b_request_on_as_url_is_404_for_as_manager(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    client = await as_user(world.a_manager.user)

    for method in ("POST", "GET"):
        await assert_cross_building_404(
            client,
            method,
            comments_url(world, b_request.id),
            json={"body": "Hi"},
            code="maintenance_request_not_found",
        )


async def test_signed_out_is_401_on_both_routes(
    client: AsyncClient, world: World, request_101: Any
) -> None:
    for method in ("POST", "GET"):
        assert_problem(
            await client.request(method, comments_url(world, request_101.id), json={"body": "x"}),
            401,
            "not_authenticated",
        )


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_outsiders_get_building_not_found_on_both_routes(
    as_user: Any, world: World, db: AsyncSession, request_101: Any, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    before = await counts(db)

    for method in ("POST", "GET"):
        await assert_cross_building_404(
            client, method, comments_url(world, request_101.id), json={"body": "Hi"}
        )
    assert await counts(db) == before


async def test_feature_off_is_403_on_both_routes_and_writes_nothing(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
        .values(enabled=False)
    )
    before = await counts(db)
    for persona in ("a_resident1", "a_manager"):
        client = await as_user(getattr(world, persona).user)
        for method in ("POST", "GET"):
            assert_problem(
                await client.request(
                    method, comments_url(world, request_101.id), json={"body": "Hi"}
                ),
                403,
                "feature_disabled",
            )
    assert await counts(db) == before


# --- criterion 2: the resident's list -------------------------------------------------------------


async def test_the_resident_lists_public_comments_only_with_no_gap_in_any_page(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    manager = world.a_manager.membership
    made = [
        await make_maintenance_comment(db, request_101, manager, internal=internal)
        for internal in (False, True, True, False, True, False)
    ]
    public = [str(comment.id) for comment in made if not comment.is_internal]
    resident = await as_user(world.a_resident1.user)

    for limit in (1, 2, 3):
        pages = await all_pages(resident, comments_url(world, request_101.id), limit)
        # Every page but the last is full: hidden rows leave no short page behind.
        assert all(len(page) == limit for page in pages[:-1]), (limit, pages)
        assert [item["id"] for page in pages for item in page] == public
        assert not any(item["is_internal"] for page in pages for item in page)

    staff = await as_user(world.a_manager.user)
    pages = await all_pages(staff, comments_url(world, request_101.id), 4)
    assert [item["id"] for page in pages for item in page] == [str(c.id) for c in made]


async def test_a_cursor_at_an_internal_comment_gives_the_next_public_one_only(
    as_user: Any, world: World, db: AsyncSession, request_101: Any
) -> None:
    # A staff cursor handed to a resident (or a guessed one) still shows public comments only.
    manager = world.a_manager.membership
    first = await make_maintenance_comment(db, request_101, manager, author_is_staff=True)
    hidden = await make_maintenance_comment(db, request_101, manager, internal=True)
    last = await make_maintenance_comment(db, request_101, manager, author_is_staff=True)
    staff = await as_user(world.a_manager.user)
    page = await staff.get(comments_url(world, request_101.id), params={"limit": 2})
    assert [item["id"] for item in page.json()["items"]] == [str(first.id), str(hidden.id)]
    resident = await as_user(world.a_resident1.user)

    response = await resident.get(
        comments_url(world, request_101.id), params={"cursor": page.json()["next_cursor"]}
    )

    assert response.json() == {
        "items": [
            {
                "id": str(last.id),
                "request_id": str(request_101.id),
                "body": last.body,
                "is_internal": False,
                "created_at": response.json()["items"][0]["created_at"],
                "author_name": None,
                "author_is_staff": True,
            }
        ],
        "next_cursor": None,
    }


async def test_authors_names_are_shown_to_staff_and_to_the_author_only(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # 201's request by a_council; multi_in_a is a co-occupant (D7, P6-03b D8).
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)
    await make_maintenance_comment(db, request, world.a_manager.membership, author_is_staff=True)
    await make_maintenance_comment(db, request, world.a_council.membership)
    await make_maintenance_comment(db, request, world.multi_in_a)

    names = {}
    for name, user in [
        ("a_manager", world.a_manager.user),
        ("a_security", world.a_security.user),
        ("a_council", world.a_council.user),
        ("multi", world.multi),
    ]:
        listed = await (await as_user(user)).get(comments_url(world, request.id))
        names[name] = [(i["author_name"], i["author_is_staff"]) for i in listed.json()["items"]]

    everyone = [("a manager", True), ("a council", False), ("multi", False)]
    assert names == {
        "a_manager": everyone,
        "a_security": everyone,
        "a_council": [(None, True), ("a council", False), (None, False)],
        "multi": [(None, True), (None, False), ("multi", False)],
    }


# --- criterion 3: who may write internal ----------------------------------------------------------


@pytest.mark.parametrize("persona", ["a_manager", "a_security"])
async def test_staff_write_an_internal_comment(
    as_user: Any, world: World, db: AsyncSession, request_101: Any, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)

    response = await client.post(
        comments_url(world, request_101.id), json={"body": "Key in lockbox.", "internal": True}
    )

    assert response.status_code == 201, response.text
    assert (response.json()["is_internal"], response.json()["author_is_staff"]) == (True, True)


@pytest.mark.parametrize("persona", ["a_resident1", "multi"])
async def test_a_resident_sending_internal_gets_403_and_nothing_is_written(
    as_user: Any, world: World, db: AsyncSession, persona: str
) -> None:
    # `multi` is security in B only: in A they are a resident (201's co-occupant).
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)
    request_101 = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    target = request_101 if persona == "a_resident1" else request
    user = world.a_resident1.user if persona == "a_resident1" else world.multi
    client = await as_user(user)
    before = await counts(db)

    assert_problem(
        await client.post(
            comments_url(world, target.id), json={"body": "Secret", "internal": True}
        ),
        403,
        "internal_comment_forbidden",
    )
    assert await counts(db) == before


async def test_multi_in_b_as_security_may_write_internal(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    client = await as_user(world.multi)

    response = await client.post(
        comments_url(world, b_request.id, world.b), json={"body": "Noted", "internal": True}
    )

    assert response.status_code == 201, response.text
    assert response.json()["is_internal"] is True


# --- criterion 6: closed requests -----------------------------------------------------------------


@pytest.mark.parametrize("status", [MaintenanceStatus.RESOLVED, MaintenanceStatus.CANCELLED])
@pytest.mark.parametrize("persona", ["a_resident1", "a_manager"])
async def test_a_closed_request_takes_comments_from_every_role(
    as_user: Any, world: World, db: AsyncSession, status: MaintenanceStatus, persona: str
) -> None:
    acted_by = world.a_resident1 if status == MaintenanceStatus.CANCELLED else world.a_manager
    request = await make_maintenance_request(
        db, world.a_resident1.membership, world.a_101, status=status, acted_by=acted_by.membership
    )
    client = await as_user(getattr(world, persona).user)

    response = await client.post(comments_url(world, request.id), json={"body": "Still drips."})

    assert response.status_code == 201, response.text


# --- criterion 7: input ---------------------------------------------------------------------------


@pytest.mark.parametrize(
    "body",
    [
        {"body": "a\x00b"},
        {"body": "a\ud800b"},
        {"body": "a\x07b"},
        {"body": "a\x1bb"},
        {"body": "x" * 2001},
        {"body": ""},
        {"body": "  \n\t "},
        {},
        {"body": None},
        {"body": "ok", "internal": "maybe"},
        {"body": "ok", "author_membership_id": str(uuid.uuid4())},
        {"body": "ok", "photo_file_ids": []},
    ],
    ids=[
        "nul",
        "surrogate",
        "bell",
        "escape",
        "too-long",
        "empty",
        "blank",
        "missing",
        "null",
        "internal-not-bool",
        "unknown-field",
        "photos-not-taken",
    ],
)
async def test_bad_input_is_422_and_writes_nothing(
    as_user: Any, world: World, db: AsyncSession, request_101: Any, body: dict[str, Any]
) -> None:
    client = await as_user(world.a_resident1.user)
    before = await counts(db)

    # `content`: json.dumps writes a lone surrogate as its `\ud800` escape, as a client would.
    response = await client.post(
        comments_url(world, request_101.id),
        content=json.dumps(body),
        headers={"content-type": "application/json"},
    )

    assert_problem(response, 422, "validation_error")
    assert await counts(db) == before


async def test_a_body_of_2000_characters_after_the_strip_is_kept(
    as_user: Any, world: World, request_101: Any
) -> None:
    client = await as_user(world.a_resident1.user)
    text = "\t" + "x\n" * 999 + "xy" + "  "

    response = await client.post(comments_url(world, request_101.id), json={"body": text})

    assert response.status_code == 201, response.text
    assert response.json()["body"] == "x\n" * 999 + "xy"
    assert len(response.json()["body"]) == 2000


async def test_a_bad_cursor_is_400(as_user: Any, world: World, request_101: Any) -> None:
    client = await as_user(world.a_resident1.user)

    assert_problem(
        await client.get(comments_url(world, request_101.id), params={"cursor": "nope"}),
        400,
        "invalid_cursor",
    )
