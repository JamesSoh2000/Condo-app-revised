"""The notice routes (P6-01b): create, edit, list, get, the attachment, input and the tenant table
(ENGINEERING_PRACTICES §7). Publish and archive are in `test_transitions.py`, races in
`test_concurrency.py`."""

import uuid
from datetime import UTC, datetime, timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Response
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.enums import Feature
from app.buildings.models import BuildingFeature
from app.files.models import File
from app.notices import service
from app.notices.enums import NoticeStatus
from app.notices.models import Notice
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.notices.conftest import archived, db_now, make_attachment, make_notice, published
from tests.world import World

pytestmark = pytest.mark.anyio

BODY = {"title": "Water shut-off", "body": "The water is off on **Tuesday**.\n\n- 9 to 11"}
LONG_AGO = World.T0 + timedelta(days=1)


def _base(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/notices"


async def _counts(db: AsyncSession) -> tuple[int, int, int]:
    """Notices, audit rows and claimed files: what a refused or failed write must leave as it was."""
    notices = await db.scalar(select(func.count()).select_from(Notice)) or 0
    audits = await db.scalar(select(func.count()).select_from(AuditEvent)) or 0
    claims = (
        await db.scalar(
            select(func.count()).select_from(File).where(File.attached_id.is_not(None))
        )
        or 0
    )
    return notices, audits, claims


async def _notice(db: AsyncSession, notice_id: Any) -> Notice:
    notice = await db.scalar(
        select(Notice)
        .where(Notice.id == uuid.UUID(str(notice_id)))
        .execution_options(populate_existing=True)
    )
    assert notice is not None
    return notice


async def _file(db: AsyncSession, file_id: uuid.UUID) -> File:
    file = await db.scalar(
        select(File).where(File.id == file_id).execution_options(populate_existing=True)
    )
    assert file is not None
    return file


async def _audits(db: AsyncSession, notice_id: Any) -> list[AuditEvent]:
    rows = await db.scalars(
        select(AuditEvent)
        .where(AuditEvent.entity_id == uuid.UUID(str(notice_id)))
        .order_by(AuditEvent.id)
    )
    return list(rows)


def _ids(response: Response) -> list[str]:
    assert response.status_code == 200, response.text
    return [item["id"] for item in response.json()["items"]]


async def _attachment(db: AsyncSession, world: World, building: Any = None) -> File:
    building = building or world.a
    uploader = world.a_manager if building is world.a else world.b_manager
    return await make_attachment(db, building.id, uploader.user.id, content_type="application/pdf")


def _download(world: World, file_id: uuid.UUID) -> str:
    return f"/api/buildings/{world.a.id}/files/{file_id}/download-url"


# --- Create (criteria 1, 11) ----------------------------------------------------------------------


async def test_the_manager_creates_a_draft_and_gets_it_back(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)
    file = await _attachment(db, world)
    expires = datetime.now(UTC) + timedelta(days=3)

    response = await client.post(
        _base(world),
        json=BODY
        | {
            "title": "  Water shut-off ",
            "priority": "urgent",
            "expires_at": expires.isoformat(),
            "attachment_file_id": str(file.id),
        },
    )

    assert response.status_code == 201, response.text
    body = response.json()
    notice = await _notice(db, body["id"])
    assert notice.title == "Water shut-off"
    assert notice.body == BODY["body"]
    assert notice.status is NoticeStatus.DRAFT
    assert notice.author_membership_id == world.a_manager.membership.id
    assert notice.attachment_file_id == file.id
    assert body == {
        "id": str(notice.id),
        "title": "Water shut-off",
        "body": BODY["body"],
        "priority": "urgent",
        "status": "draft",
        "expires_at": body["expires_at"],
        "attachment_file_id": str(file.id),
        "author_membership_id": str(world.a_manager.membership.id),
        "published_at": None,
        "published_by_membership_id": None,
        "archived_at": None,
        "archived_by_membership_id": None,
        "created_at": body["created_at"],
        "updated_at": body["updated_at"],
    }
    assert datetime.fromisoformat(body["expires_at"]) == expires
    claimed = await _file(db, file.id)
    assert (claimed.attached_type, claimed.attached_id) == ("notice", notice.id)
    [audit] = await _audits(db, notice.id)
    assert audit.action == "notice.created"
    assert audit.actor_user_id == world.a_manager.user.id
    assert audit.building_id == world.a.id
    assert audit.entity_type == "notice"
    assert audit.metadata_ == {"attachment_file_id": str(file.id)}

    got = await client.get(f"{_base(world)}/{notice.id}")
    assert got.status_code == 200, got.text
    assert got.json() == body


async def test_create_defaults_to_normal_priority_without_expiry_or_attachment(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)

    response = await client.post(_base(world), json=BODY)

    assert response.status_code == 201, response.text
    body = response.json()
    assert (body["priority"], body["expires_at"], body["attachment_file_id"]) == (
        "normal",
        None,
        None,
    )
    [audit] = await _audits(db, body["id"])
    assert audit.metadata_ == {"attachment_file_id": None}


async def test_create_without_a_session_is_401(client: AsyncClient, world: World) -> None:
    assert_problem(await client.post(_base(world), json=BODY), 401, "not_authenticated")


async def test_multi_may_not_create_in_the_building_where_it_is_a_resident(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.multi)
    before = await _counts(db)

    await assert_forbidden_role(client, "POST", _base(world), json=BODY)

    assert await _counts(db) == before


async def test_a_file_of_another_building_looks_like_an_unknown_file(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)
    other = await _attachment(db, world, world.b)
    before = await _counts(db)

    refused = assert_problem(
        await client.post(_base(world), json=BODY | {"attachment_file_id": str(other.id)}),
        404,
        "file_not_found",
    )
    unknown = assert_problem(
        await client.post(_base(world), json=BODY | {"attachment_file_id": str(uuid.uuid4())}),
        404,
        "file_not_found",
    )

    assert without_request_id(refused) == without_request_id(unknown)
    assert await _counts(db) == before
    assert (await _file(db, other.id)).attached_id is None


async def test_a_file_already_attached_elsewhere_is_refused(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)
    file = await _attachment(db, world)
    first = await client.post(_base(world), json=BODY | {"attachment_file_id": str(file.id)})
    assert first.status_code == 201, first.text
    before = await _counts(db)

    second = await client.post(_base(world), json=BODY | {"attachment_file_id": str(file.id)})

    assert_problem(second, 422, "invalid_file")
    assert await _counts(db) == before


async def test_a_failure_after_the_insert_leaves_nothing(
    db: AsyncSession, as_user: Any, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Criterion 7: the notice is inserted and the file claimed, then the audit fails.
    client = await as_user(world.a_manager.user)
    file = await _attachment(db, world)
    before = await _counts(db)

    async def failing_audit(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(service, "record_audit", failing_audit)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await client.post(_base(world), json=BODY | {"attachment_file_id": str(file.id)})

    assert await _counts(db) == before
    assert (await _file(db, file.id)).attached_id is None


# --- Input Postgres would refuse (criterion 8) -----------------------------------------------------


@pytest.mark.parametrize(
    "change",
    [
        {"title": ""},
        {"title": "   "},
        {"title": " "},
        {"title": "T" * 201},
        {"title": "Wa\x00ter"},
        {"title": "\tWater"},
        {"title": "Water\n"},
        {"title": "Water\nshut-off"},
        {"body": ""},
        {"body": " \n\t "},
        {"body": "B" * 10_001},
        {"body": "a\x00b"},
        {"body": "a\x0bb"},
        {"body": "a\x1bb"},
        {"priority": "loud"},
        {"priority": None},
        {"expires_at": "2099-01-01T00:00:00"},
        {"expires_at": "tomorrow"},
        {"attachment_file_id": "not-a-uuid"},
        {"surprise": "field"},
        {"title": None},
    ],
    ids=lambda change: repr(change)[:40],
)
async def test_invalid_input_is_a_422_and_writes_nothing(
    db: AsyncSession, as_user: Any, world: World, change: dict[str, Any]
) -> None:
    client = await as_user(world.a_manager.user)
    before = await _counts(db)

    response = await client.post(_base(world), json=BODY | change)

    assert_problem(response, 422, "validation_error")
    assert await _counts(db) == before


@pytest.mark.parametrize("field", ["title", "body"])
async def test_a_lone_surrogate_is_refused(
    db: AsyncSession, as_user: Any, world: World, field: str
) -> None:
    client = await as_user(world.a_manager.user)
    before = await _counts(db)
    other = "body" if field == "title" else "title"
    # Written by hand: json.dumps would refuse to encode the lone surrogate.
    raw = f'{{"{field}": "a\\ud800b", "{other}": "text"}}'.encode()

    response = await client.post(
        _base(world), content=raw, headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 422, response.text
    assert await _counts(db) == before


async def test_the_longest_title_and_body_are_stored(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)
    # Multi-byte characters: the column lengths count characters, as the schema does.
    title, body = "é" * 200, "\tindented\r\n" + "😀" * 9_989

    response = await client.post(_base(world), json={"title": title, "body": body})

    assert response.status_code == 201, response.text
    notice = await _notice(db, response.json()["id"])
    assert (notice.title, notice.body) == (title, body.strip())


async def test_an_expiry_already_past_is_refused_on_create(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)
    before = await _counts(db)
    past = (await db_now(db)) - timedelta(seconds=1)

    response = await client.post(_base(world), json=BODY | {"expires_at": past.isoformat()})

    assert_problem(response, 422, "notice_expired")
    assert await _counts(db) == before


# --- Edit (criteria 3, 7, 8, 10) -------------------------------------------------------------------


async def _draft(db: AsyncSession, world: World, **overrides: Any) -> Notice:
    return await make_notice(db, world.a_manager.membership, **overrides)


async def test_the_manager_edits_a_draft(db: AsyncSession, as_user: Any, world: World) -> None:
    client = await as_user(world.a_manager.user)
    draft = await _draft(db, world, expires_at=datetime.now(UTC) + timedelta(days=1))

    response = await client.patch(
        f"{_base(world)}/{draft.id}",
        json={"title": " New title ", "priority": "urgent", "expires_at": None},
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["title"], body["priority"], body["expires_at"]) == ("New title", "urgent", None)
    notice = await _notice(db, draft.id)
    assert (notice.title, notice.body, notice.expires_at) == ("New title", draft.body, None)
    assert notice.status is NoticeStatus.DRAFT
    [audit] = await _audits(db, draft.id)
    assert audit.action == "notice.updated"
    assert audit.metadata_ == {
        "fields": ["expires_at", "priority", "title"],
        "attachment_file_id": None,
    }


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"title": None},
        {"body": None},
        {"priority": None},
        {"title": "\tTabbed"},
        {"body": "a\x00b"},
        {"status": "published"},
        {"expires_at": "2099-01-01T00:00:00"},
    ],
    ids=lambda body: repr(body)[:40],
)
async def test_an_invalid_edit_is_a_422_and_changes_nothing(
    db: AsyncSession, as_user: Any, world: World, body: dict[str, Any]
) -> None:
    client = await as_user(world.a_manager.user)
    draft = await _draft(db, world)
    before = await _counts(db)

    response = await client.patch(f"{_base(world)}/{draft.id}", json=body)

    assert_problem(response, 422, "validation_error")
    assert await _counts(db) == before
    assert (await _notice(db, draft.id)).title == draft.title


async def test_an_expiry_already_past_is_refused_on_edit(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)
    draft = await _draft(db, world)
    past = (await db_now(db)) - timedelta(seconds=1)

    response = await client.patch(
        f"{_base(world)}/{draft.id}", json={"expires_at": past.isoformat()}
    )

    assert_problem(response, 422, "notice_expired")
    assert (await _notice(db, draft.id)).expires_at is None


async def test_an_edit_attaches_a_file_to_a_draft_without_one(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    client = await as_user(world.a_manager.user)
    draft = await _draft(db, world)
    file = await _attachment(db, world)

    response = await client.patch(
        f"{_base(world)}/{draft.id}", json={"attachment_file_id": str(file.id)}
    )

    assert response.status_code == 200, response.text
    assert response.json()["attachment_file_id"] == str(file.id)
    claimed = await _file(db, file.id)
    assert (claimed.attached_type, claimed.attached_id) == ("notice", draft.id)
    [audit] = await _audits(db, draft.id)
    assert audit.metadata_ == {"fields": ["attachment_file_id"], "attachment_file_id": str(file.id)}


async def _with_attachment(db: AsyncSession, as_user: Any, world: World) -> tuple[str, File]:
    client = await as_user(world.a_manager.user)
    file = await _attachment(db, world)
    created = await client.post(_base(world), json=BODY | {"attachment_file_id": str(file.id)})
    assert created.status_code == 201, created.text
    return created.json()["id"], file


async def test_replacing_an_attachment_stops_granting_the_old_file(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    # Criterion 10: the old file stays attached to the notice in `files`, but isn't the notice's
    # attachment any more, so the both-sides hook grants it to no one, the manager included.
    notice_id, old = await _with_attachment(db, as_user, world)
    client = await as_user(world.a_manager.user)
    new = await _attachment(db, world)
    assert (await client.get(_download(world, old.id))).status_code == 200

    response = await client.patch(
        f"{_base(world)}/{notice_id}", json={"attachment_file_id": str(new.id)}
    )

    assert response.status_code == 200, response.text
    assert (await _notice(db, notice_id)).attachment_file_id == new.id
    assert (await _file(db, new.id)).attached_id == uuid.UUID(notice_id)
    assert (await client.get(_download(world, new.id))).status_code == 200
    await assert_not_visible(client, "GET", _download(world, old.id), code="file_not_found")


async def test_clearing_an_attachment_stops_granting_it(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    notice_id, old = await _with_attachment(db, as_user, world)
    client = await as_user(world.a_manager.user)

    response = await client.patch(f"{_base(world)}/{notice_id}", json={"attachment_file_id": None})

    assert response.status_code == 200, response.text
    assert response.json()["attachment_file_id"] is None
    await assert_not_visible(client, "GET", _download(world, old.id), code="file_not_found")


async def test_sending_the_current_attachment_again_keeps_it(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    notice_id, file = await _with_attachment(db, as_user, world)
    client = await as_user(world.a_manager.user)

    response = await client.patch(
        f"{_base(world)}/{notice_id}", json={"attachment_file_id": str(file.id), "title": "T2"}
    )

    assert response.status_code == 200, response.text
    assert response.json()["attachment_file_id"] == str(file.id)
    assert (await client.get(_download(world, file.id))).status_code == 200
    audit = (await _audits(db, notice_id))[-1]
    assert audit.metadata_ == {"fields": ["title"], "attachment_file_id": str(file.id)}


async def test_an_edit_with_a_file_of_another_building_changes_nothing(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    notice_id, file = await _with_attachment(db, as_user, world)
    client = await as_user(world.a_manager.user)
    other = await _attachment(db, world, world.b)
    before = await _counts(db)

    response = await client.patch(
        f"{_base(world)}/{notice_id}", json={"attachment_file_id": str(other.id), "title": "T2"}
    )

    assert_problem(response, 404, "file_not_found")
    assert await _counts(db) == before
    notice = await _notice(db, notice_id)
    assert (notice.attachment_file_id, notice.title) == (file.id, BODY["title"])
    assert (await _file(db, other.id)).attached_id is None


async def test_a_failure_after_an_edits_claim_leaves_both_files_as_they_were(
    db: AsyncSession, as_user: Any, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Criterion 7, the edit: the new file is claimed and the notice updated, then the audit fails.
    notice_id, old = await _with_attachment(db, as_user, world)
    client = await as_user(world.a_manager.user)
    new = await _attachment(db, world)
    before = await _counts(db)

    async def failing_audit(*args: Any, **kwargs: Any) -> None:
        raise RuntimeError("simulated failure")

    monkeypatch.setattr(service, "record_audit", failing_audit)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await client.patch(f"{_base(world)}/{notice_id}", json={"attachment_file_id": str(new.id)})

    assert await _counts(db) == before
    assert (await _notice(db, notice_id)).attachment_file_id == old.id
    assert (await _file(db, new.id)).attached_id is None


# --- Get and list (criteria 1, 5) ------------------------------------------------------------------


async def _notices(db: AsyncSession, world: World) -> dict[str, Notice]:
    """One notice in each state, created in this order (so `id DESC` lists them backwards)."""
    manager = world.a_manager.membership
    now = await db_now(db)
    return {
        "draft": await make_notice(db, manager),
        "live": await make_notice(db, manager, **published(manager, LONG_AGO)),
        "expired": await make_notice(
            db, manager, **published(manager, LONG_AGO, expires_at=now - timedelta(seconds=1))
        ),
        "archived": await make_notice(db, manager, **archived(manager, LONG_AGO)),
        "live2": await make_notice(db, manager, **published(manager, LONG_AGO)),
    }


@pytest.mark.parametrize(
    "persona", ["a_security", "a_resident1", "a_council", "a_former", "a_resident2"]
)
async def test_members_list_and_get_the_live_published_notices_newest_first(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    notices = await _notices(db, world)
    client = await as_user(getattr(world, persona).user)

    assert _ids(await client.get(_base(world))) == [
        str(notices["live2"].id),
        str(notices["live"].id),
    ]
    got = await client.get(f"{_base(world)}/{notices['live'].id}")
    assert got.status_code == 200, got.text
    assert got.json()["status"] == "published"
    missing = await assert_not_visible(
        client, "GET", f"{_base(world)}/{uuid.uuid4()}", code="notice_not_found"
    )
    for name in ("draft", "expired", "archived"):
        hidden = await assert_not_visible(
            client, "GET", f"{_base(world)}/{notices[name].id}", code="notice_not_found"
        )
        assert without_request_id(hidden) == without_request_id(missing), name


async def test_the_manager_lists_every_notice_and_filters_by_status(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    notices = await _notices(db, world)
    client = await as_user(world.a_manager.user)

    assert _ids(await client.get(_base(world))) == [
        str(notices[name].id) for name in ("live2", "archived", "expired", "live", "draft")
    ]
    assert _ids(await client.get(_base(world), params={"status": "draft"})) == [
        str(notices["draft"].id)
    ]
    assert _ids(await client.get(_base(world), params={"status": "published"})) == [
        str(notices[name].id) for name in ("live2", "expired", "live")
    ]
    for notice in notices.values():
        got = await client.get(f"{_base(world)}/{notice.id}")
        assert got.status_code == 200, got.text


async def test_a_resident_asking_for_drafts_gets_an_empty_page(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    await _notices(db, world)
    client = await as_user(world.a_resident1.user)

    response = await client.get(_base(world), params={"status": "draft"})

    assert response.status_code == 200, response.text
    assert response.json() == {"items": [], "next_cursor": None}


async def test_an_unknown_status_filter_is_a_422(as_user: Any, world: World) -> None:
    client = await as_user(world.a_manager.user)

    assert_problem(
        await client.get(_base(world), params={"status": "lost"}), 422, "validation_error"
    )


async def test_the_list_pages_with_the_cursor(db: AsyncSession, as_user: Any, world: World) -> None:
    notices = await _notices(db, world)
    client = await as_user(world.a_manager.user)

    first = await client.get(_base(world), params={"limit": 3})
    cursor = first.json()["next_cursor"]
    second = await client.get(_base(world), params={"limit": 3, "cursor": cursor})

    assert _ids(first) + _ids(second) == [
        str(notices[name].id) for name in ("live2", "archived", "expired", "live", "draft")
    ]
    assert second.json()["next_cursor"] is None


async def test_another_buildings_notice_is_404_through_this_building(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    other = await make_notice(db, world.b_manager.membership)
    client = await as_user(world.a_manager.user)
    before = await _counts(db)

    assert other.building_id == world.b.id
    assert str(other.id) not in _ids(await client.get(_base(world)))
    missing = await assert_not_visible(
        client, "GET", f"{_base(world)}/{uuid.uuid4()}", code="notice_not_found"
    )
    for method, path, json in [
        ("GET", "", None),
        ("PATCH", "", {"title": "Hijack"}),
        ("POST", "/publish", None),
        ("POST", "/archive", None),
    ]:
        refused = await assert_not_visible(
            client, method, f"{_base(world)}/{other.id}{path}", code="notice_not_found", json=json
        )
        assert without_request_id(refused) == without_request_id(missing), (method, path)
    assert await _counts(db) == before
    assert (await _notice(db, other.id)).status is NoticeStatus.DRAFT


# --- The tenant table for every route (criteria 1, 6) ----------------------------------------------


def _routes(world: World, notice_id: uuid.UUID) -> list[tuple[str, str, Any]]:
    base = _base(world)
    return [
        ("POST", base, BODY),
        ("PATCH", f"{base}/{notice_id}", {"title": "Edited"}),
        ("POST", f"{base}/{notice_id}/publish", None),
        ("POST", f"{base}/{notice_id}/archive", None),
        ("GET", base, None),
        ("GET", f"{base}/{notice_id}", None),
    ]


WRITES = 4


@pytest.mark.parametrize("persona", ["a_security", "a_resident1", "a_council"])
async def test_only_the_manager_may_write(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    draft = await _draft(db, world)
    client = await as_user(getattr(world, persona).user)
    before = await _counts(db)

    for method, url, json in _routes(world, draft.id)[:WRITES]:
        await assert_forbidden_role(client, method, url, json=json)

    assert await _counts(db) == before
    assert (await _notice(db, draft.id)).status is NoticeStatus.DRAFT


@pytest.mark.parametrize("persona", ["b_manager", "b_resident1", "a_pending", "a_suspended"])
async def test_non_members_get_404_on_every_route(
    db: AsyncSession, as_user: Any, world: World, persona: str
) -> None:
    draft = await _draft(db, world)
    client = await as_user(getattr(world, persona).user)
    before = await _counts(db)

    for method, url, json in _routes(world, draft.id):
        await assert_cross_building_404(client, method, url, json=json)

    assert await _counts(db) == before


async def test_every_route_is_401_without_a_session(
    db: AsyncSession, client: AsyncClient, world: World
) -> None:
    draft = await _draft(db, world)

    for method, url, json in _routes(world, draft.id):
        assert_problem(
            await client.request(method, url, json=json), 401, "not_authenticated"
        )


async def test_every_notice_route_is_403_when_the_feature_is_off(
    db: AsyncSession, as_user: Any, world: World
) -> None:
    draft = await _draft(db, world)
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id, BuildingFeature.feature == Feature.NOTICES
        )
        .values(enabled=False)
    )
    manager = await as_user(world.a_manager.user)
    resident = await as_user(world.a_resident1.user)
    before = await _counts(db)

    for client in (manager, resident):
        for method, url, json in _routes(world, draft.id):
            assert_problem(
                await client.request(method, url, json=json), 403, "feature_disabled"
            )

    assert await _counts(db) == before
    assert (await _notice(db, draft.id)).status is NoticeStatus.DRAFT
