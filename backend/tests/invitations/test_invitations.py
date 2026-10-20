"""The manager's invitation routes (P4-02a criteria 1-10) and the tenant table
(docs/ENGINEERING_PRACTICES.md §7)."""

import re
import uuid
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.core import clock
from app.core.security import hash_token
from app.invitations.models import Invitation
from app.jobs.models import Job, JobStatus
from app.jobs.worker import Worker
from tests.conftest import FrozenClock
from tests.email.conftest import FakeSMTP, point_settings_at
from tests.factories import make_unit
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)
from tests.jobs.conftest import Sessions
from tests.world import World

pytestmark = pytest.mark.anyio

LINK = re.compile(r"http://localhost:5173/invite/([A-Za-z0-9_-]{43})\b")
PATH = re.compile(r"/invite/([A-Za-z0-9_-]{43})")


@pytest.fixture(autouse=True)
def _email_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    # APP_BASE_URL and the From header as the email tests set them; no SMTP is reached unless a
    # test runs the worker with the `smtp` fixture.
    point_settings_at(monkeypatch, 1025)


def _url(world: World, building: Any = None) -> str:
    return f"/api/buildings/{(building or world.a).id}/invitations"


def _guard(**overrides: Any) -> dict[str, Any]:
    return {"email": "guard@example.test", "roles": ["security"]} | overrides


async def _invite(client: AsyncClient, world: World, **overrides: Any) -> dict[str, Any]:
    r = await client.post(_url(world), json=_guard(**overrides))
    assert r.status_code == 201, r.text
    body: dict[str, Any] = r.json()
    return body


async def _row(db: AsyncSession, invitation_id: str) -> Invitation:
    row = await db.scalar(
        select(Invitation)
        .where(Invitation.id == uuid.UUID(invitation_id))
        .execution_options(populate_existing=True)
    )
    assert row is not None
    return row


async def _count(db: AsyncSession) -> int:
    return await db.scalar(select(func.count()).select_from(Invitation)) or 0


async def _email_jobs(db: AsyncSession) -> list[Job]:
    return list(
        await db.scalars(
            select(Job)
            .where(Job.kind == "email.send")
            .order_by(Job.id)
            .execution_options(populate_existing=True)
        )
    )


async def _audit(db: AsyncSession, action: str) -> list[AuditEvent]:
    return list(
        await db.scalars(
            select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)
        )
    )


def _token_of(job: Job) -> str:
    match = PATH.fullmatch(job.payload["context"]["link"])
    assert match is not None, job.payload
    return match.group(1)


# Criterion 1


@pytest.mark.usefixtures("email_handler")
async def test_manager_invites_and_the_email_carries_the_only_copy_of_the_token(
    as_user, db, world, sessions: Sessions, smtp: FakeSMTP
):
    client = await as_user(world.a_manager.user)

    r = await client.post(_url(world), json=_guard())

    assert r.status_code == 201, r.text
    body = r.json()
    assert set(body) == {
        "id",
        "email",
        "roles",
        "unit_id",
        "relationship",
        "status",
        "expires_at",
        "created_at",
    }
    assert body["email"] == "guard@example.test"
    assert body["roles"] == ["security"]
    assert body["status"] == "pending"
    assert body["unit_id"] is None and body["relationship"] is None

    assert await Worker(sessions, jitter=lambda: 1.0, recurring=()).run_once() == 1

    assert len(smtp.messages) == 1
    message = smtp.messages[0]
    assert message["To"] == "guard@example.test"
    parts = {part.get_content_type(): part.get_content() for part in message.iter_parts()}
    tokens = {ctype: LINK.findall(text) for ctype, text in parts.items()}
    token = tokens["text/plain"][0]
    assert set(tokens["text/html"]) == {token}
    assert world.a.name in parts["text/plain"]

    row = await _row(db, body["id"])
    assert row.token_hash == hash_token(token)
    # No column holds the token itself, and the response never did.
    assert token not in str({c.key: getattr(row, c.key) for c in Invitation.__table__.columns})
    assert token not in r.text
    assert row.token_hash not in r.text
    # The sent job's payload no longer holds the link (the handler's sensitive `context`).
    (job,) = await _email_jobs(db)
    assert job.status is JobStatus.SUCCEEDED
    assert "context" not in job.payload
    assert token not in str(job.payload)

    (event,) = await _audit(db, "invitation.created")
    assert event.building_id == world.a.id
    assert event.actor_user_id == world.a_manager.user.id
    assert event.entity_id == row.id
    assert token not in str(event.metadata_)


async def test_created_row_holds_the_inviter_and_a_seven_day_expiry(
    as_user, db, world, frozen_clock: FrozenClock
):
    client = await as_user(world.a_manager.user)

    body = await _invite(client, world)

    row = await _row(db, body["id"])
    assert row.building_id == world.a.id
    assert row.created_by_user_id == world.a_manager.user.id
    assert row.expires_at == frozen_clock.at + timedelta(days=7)
    assert row.accepted_at is None and row.revoked_at is None


# Criterion 2


async def test_email_is_stored_lowercased(as_user, db, world):
    client = await as_user(world.a_manager.user)

    body = await _invite(client, world, email="Guard@Example.TEST")

    assert body["email"] == "guard@example.test"
    assert (await _row(db, body["id"])).email == "guard@example.test"


@pytest.mark.parametrize(
    "email",
    [
        "",
        " guard@example.test",
        "guard@example.test ",
        "gärd@example.test",
        "guard@exämple.test",
        "guard",
        "guard@",
        "a@b@example.test",
        "a@example.test, b@example.test",
        "Guard <guard@example.test>",
        "guard@example.test\r\nBcc: x@example.test",
        "gu\x00ard@example.test",
        "a" * 64 + "@" + "b" * 63 + "." + "c" * 63 + "." + "d" * 63 + ".test",
    ],
)
async def test_invalid_emails_are_422_and_write_nothing(as_user, db, world, email):
    client = await as_user(world.a_manager.user)

    r = await client.post(_url(world), json=_guard(email=email))

    assert_problem(r, 422, "validation_error")
    assert await _count(db) == 0
    assert await _email_jobs(db) == []


async def test_lone_surrogate_in_the_email_is_422(as_user, db, world):
    client = await as_user(world.a_manager.user)

    # Raw JSON: httpx can't encode a lone surrogate, but a client can send its escape.
    r = await client.post(
        _url(world),
        content=b'{"email": "\\ud800@example.test", "roles": ["security"]}',
        headers={"content-type": "application/json"},
    )

    assert_problem(r, 422, "validation_error")
    assert await _count(db) == 0
    assert await _email_jobs(db) == []


# Criterion 3


@pytest.mark.parametrize(
    "overrides",
    [
        {"roles": []},
        {"roles": ["owner"]},
        {"roles": "security"},
        {"roles": None},
        {"relationship": "owner"},
        {"roles": ["resident"], "unit_id": "UNIT"},
        {"roles": ["security"], "unit_id": "UNIT", "relationship": "owner"},
        {"roles": ["resident"], "unit_id": "UNIT", "relationship": "landlord"},
        {"token": "chosen-by-client"},
    ],
)
async def test_invalid_roles_or_unit_pairing_is_422_and_writes_nothing(
    as_user, db, world, overrides
):
    if overrides.get("unit_id") == "UNIT":
        overrides = overrides | {"unit_id": str(world.a_102.id)}
    client = await as_user(world.a_manager.user)

    r = await client.post(_url(world), json=_guard(**overrides))

    assert_problem(r, 422, "validation_error")
    assert await _count(db) == 0


async def test_duplicate_roles_are_stored_once(as_user, db, world):
    client = await as_user(world.a_manager.user)

    body = await _invite(client, world, roles=["security", "council", "security"])

    assert body["roles"] == ["council", "security"]
    assert (await _row(db, body["id"])).roles == ["council", "security"]


# Criterion 4


@pytest.mark.parametrize("which", ["other_building", "unknown"])
async def test_unit_of_another_building_or_unknown_is_404_and_writes_nothing(
    as_user, db, world, which
):
    unit_id = world.b_101.id if which == "other_building" else uuid.uuid4()
    client = await as_user(world.a_manager.user)

    r = await client.post(
        _url(world),
        json=_guard(roles=["resident"], unit_id=str(unit_id), relationship="owner"),
    )

    assert_problem(r, 404, "unit_not_found")
    assert await _count(db) == 0
    assert await _email_jobs(db) == []


async def test_inactive_unit_is_409_and_writes_nothing(as_user, db, world):
    unit = await make_unit(db, world.a, label="301", is_active=False)
    client = await as_user(world.a_manager.user)

    r = await client.post(
        _url(world), json=_guard(roles=["resident"], unit_id=str(unit.id), relationship="tenant")
    )

    assert_problem(r, 409, "unit_inactive")
    assert await _count(db) == 0


async def test_invitation_with_unit_and_relationship(as_user, db, world):
    client = await as_user(world.a_manager.user)

    body = await _invite(
        client,
        world,
        email="owner@example.test",
        roles=["resident"],
        unit_id=str(world.a_102.id),
        relationship="owner",
    )

    assert body["unit_id"] == str(world.a_102.id)
    assert body["relationship"] == "owner"
    row = await _row(db, body["id"])
    assert (row.unit_id, row.relationship) == (world.a_102.id, "owner")


# Criterion 5


async def test_second_pending_invitation_for_the_email_is_409(as_user, db, world):
    client = await as_user(world.a_manager.user)
    await _invite(client, world)

    r = await client.post(_url(world), json=_guard(email="GUARD@example.test", roles=["council"]))

    assert_problem(r, 409, "invitation_pending")
    assert await _count(db) == 1
    assert len(await _email_jobs(db)) == 1


@pytest.mark.parametrize("closed_by", ["revoked", "accepted", "expired"])
async def test_closed_invitations_do_not_block_a_new_one(
    as_user, db, world, frozen_clock: FrozenClock, closed_by
):
    client = await as_user(world.a_manager.user)
    first = await _invite(client, world)
    if closed_by == "revoked":
        assert (await client.post(f"{_url(world)}/{first['id']}/revoke")).status_code == 204
    elif closed_by == "accepted":
        await _mark_accepted(db, first["id"], world)
    else:
        await _expire(db, first["id"])

    second = await _invite(client, world)

    assert second["id"] != first["id"]
    assert await _count(db) == 2


async def test_same_email_in_another_building_is_independent(as_user, db, world):
    await _invite(await as_user(world.a_manager.user), world)
    b_client = await as_user(world.b_manager.user)

    r = await b_client.post(_url(world, world.b), json=_guard())

    assert r.status_code == 201, r.text
    assert await _count(db) == 2


async def _expire(db: AsyncSession, invitation_id: str) -> None:
    # Moved into the past directly: advancing the clock 7 days would also end the manager's
    # 12-hour session.
    await db.execute(
        update(Invitation)
        .where(Invitation.id == uuid.UUID(invitation_id))
        .values(expires_at=clock.now() - timedelta(seconds=1))
    )
    await db.flush()


async def _mark_accepted(db: AsyncSession, invitation_id: str, world: World) -> None:
    # P4-02b writes this through accept; here the row is set directly.
    await db.execute(
        update(Invitation)
        .where(Invitation.id == uuid.UUID(invitation_id))
        .values(accepted_at=clock.now(), accepted_user_id=world.no_membership.id)
    )
    await db.flush()


# Criterion 6


async def test_non_managers_get_403_on_every_route(as_user, db, world):
    invitation = await _invite(await as_user(world.a_manager.user), world)
    item = f"{_url(world)}/{invitation['id']}"
    for member in (world.a_security, world.a_resident1, world.a_council):
        client = await as_user(member.user)
        await assert_forbidden_role(
            client, "POST", _url(world), json=_guard(email="x@example.test")
        )
        await assert_forbidden_role(client, "GET", _url(world))
        await assert_forbidden_role(client, "POST", f"{item}/revoke")
        await assert_forbidden_role(client, "POST", f"{item}/resend")
    assert await _count(db) == 1
    row = await _row(db, invitation["id"])
    assert row.revoked_at is None


async def test_other_buildings_manager_gets_404_for_an_a_invitation(as_user, db, world):
    invitation = await _invite(await as_user(world.a_manager.user), world)
    before = await _row(db, invitation["id"])
    hash_before = before.token_hash
    b_client = await as_user(world.b_manager.user)
    random_id = uuid.uuid4()

    for action in ("revoke", "resend"):
        hidden = await assert_cross_building_404(
            b_client,
            "POST",
            f"{_url(world, world.b)}/{invitation['id']}/{action}",
            code="invitation_not_found",
        )
        missing = await assert_cross_building_404(
            b_client,
            "POST",
            f"{_url(world, world.b)}/{random_id}/{action}",
            code="invitation_not_found",
        )
        assert without_request_id(hidden) == without_request_id(missing)

    row = await _row(db, invitation["id"])
    assert row.revoked_at is None
    assert row.token_hash == hash_before
    assert len(await _email_jobs(db)) == 1


async def test_tenant_guards_on_invitation_routes(as_user, client, db, world):
    invitation = await _invite(await as_user(world.a_manager.user), world)
    item = f"{_url(world)}/{invitation['id']}"
    routes = [
        ("POST", _url(world), _guard(email="y@example.test")),
        ("GET", _url(world), None),
        ("POST", f"{item}/revoke", None),
        ("POST", f"{item}/resend", None),
    ]
    for method, url, json in routes:
        assert_problem(await client.request(method, url, json=json), 401, "not_authenticated")
    for member in (world.b_manager, world.a_pending, world.a_suspended):
        outsider = await as_user(member.user)
        for method, url, json in routes:
            await assert_cross_building_404(outsider, method, url, json=json)
    assert await _count(db) == 1
    assert (await _row(db, invitation["id"])).revoked_at is None


# Criterion 7


async def test_list_filters_by_status_within_the_building(
    as_user, db, world, frozen_clock: FrozenClock
):
    client = await as_user(world.a_manager.user)
    expired = await _invite(client, world, email="expired@example.test")
    await _expire(db, expired["id"])
    pending = await _invite(client, world, email="pending@example.test")
    accepted = await _invite(client, world, email="accepted@example.test")
    await _mark_accepted(db, accepted["id"], world)
    revoked = await _invite(client, world, email="revoked@example.test")
    assert (await client.post(f"{_url(world)}/{revoked['id']}/revoke")).status_code == 204
    b_client = await as_user(world.b_manager.user)
    r = await b_client.post(_url(world, world.b), json=_guard(email="b@example.test"))
    assert r.status_code == 201, r.text

    async def listed(**params: str) -> list[tuple[str, str]]:
        r = await client.get(_url(world), params=params)
        assert r.status_code == 200, r.text
        assert "token" not in r.text
        return [(item["id"], item["status"]) for item in r.json()["items"]]

    assert await listed(status="pending") == [(pending["id"], "pending")]
    assert await listed(status="accepted") == [(accepted["id"], "accepted")]
    assert await listed(status="revoked") == [(revoked["id"], "revoked")]
    assert await listed(status="expired") == [(expired["id"], "expired")]
    assert await listed() == [
        (revoked["id"], "revoked"),
        (accepted["id"], "accepted"),
        (pending["id"], "pending"),
        (expired["id"], "expired"),
    ]
    r = await client.get(_url(world), params={"status": "bogus"})
    assert_problem(r, 422, "validation_error")


async def test_list_paginates_newest_first(as_user, world):
    client = await as_user(world.a_manager.user)
    ids = [(await _invite(client, world, email=f"p{n}@example.test"))["id"] for n in range(3)]

    first = (await client.get(_url(world), params={"limit": 2})).json()
    second = (
        await client.get(_url(world), params={"limit": 2, "cursor": first["next_cursor"]})
    ).json()

    assert [i["id"] for i in first["items"]] == [ids[2], ids[1]]
    assert [i["id"] for i in second["items"]] == [ids[0]]
    assert second["next_cursor"] is None


# Criterion 8


async def test_revoke_sets_revoked_at_and_audits(as_user, db, world):
    client = await as_user(world.a_manager.user)
    invitation = await _invite(client, world)

    r = await client.post(f"{_url(world)}/{invitation['id']}/revoke")

    assert r.status_code == 204, r.text
    assert (await _row(db, invitation["id"])).revoked_at is not None
    (event,) = await _audit(db, "invitation.revoked")
    assert event.entity_id == uuid.UUID(invitation["id"])
    assert event.building_id == world.a.id
    assert event.actor_user_id == world.a_manager.user.id


async def test_revoke_of_an_expired_invitation_closes_it(
    as_user, db, world, frozen_clock: FrozenClock
):
    client = await as_user(world.a_manager.user)
    invitation = await _invite(client, world)
    await _expire(db, invitation["id"])

    r = await client.post(f"{_url(world)}/{invitation['id']}/revoke")

    assert r.status_code == 204, r.text
    assert (await _row(db, invitation["id"])).revoked_at is not None


@pytest.mark.parametrize("closed_by", ["revoked", "accepted"])
async def test_revoke_of_a_closed_invitation_is_409(as_user, db, world, closed_by):
    client = await as_user(world.a_manager.user)
    invitation = await _invite(client, world)
    url = f"{_url(world)}/{invitation['id']}/revoke"
    if closed_by == "revoked":
        assert (await client.post(url)).status_code == 204
    else:
        await _mark_accepted(db, invitation["id"], world)

    assert_problem(await client.post(url), 409, "invalid_transition")
    assert len(await _audit(db, "invitation.revoked")) == (1 if closed_by == "revoked" else 0)


# Criterion 9


async def test_resend_rotates_token_and_expiry_and_requeues(
    as_user, db, world, frozen_clock: FrozenClock
):
    client = await as_user(world.a_manager.user)
    invitation = await _invite(client, world)
    (first_job,) = await _email_jobs(db)
    old_token = _token_of(first_job)
    await _expire(db, invitation["id"])  # resend revives an expired invitation
    frozen_clock.advance(hours=1)

    r = await client.post(f"{_url(world)}/{invitation['id']}/resend")

    assert r.status_code == 200, r.text
    body = r.json()
    assert body["status"] == "pending"
    assert body["id"] == invitation["id"]
    row = await _row(db, invitation["id"])
    assert row.expires_at == frozen_clock.at + timedelta(days=7)
    jobs = await _email_jobs(db)
    assert len(jobs) == 2
    new_token = _token_of(jobs[1])
    assert new_token != old_token
    assert row.token_hash == hash_token(new_token)
    stale = await db.scalar(
        select(Invitation).where(Invitation.token_hash == hash_token(old_token))
    )
    assert stale is None
    assert jobs[1].payload["to"] == "guard@example.test"
    assert new_token not in r.text
    (event,) = await _audit(db, "invitation.resent")
    assert event.entity_id == row.id
    assert event.actor_user_id == world.a_manager.user.id


@pytest.mark.parametrize("closed_by", ["revoked", "accepted"])
async def test_resend_of_a_closed_invitation_is_409_and_queues_nothing(
    as_user, db, world, closed_by
):
    client = await as_user(world.a_manager.user)
    invitation = await _invite(client, world)
    if closed_by == "revoked":
        assert (await client.post(f"{_url(world)}/{invitation['id']}/revoke")).status_code == 204
    else:
        await _mark_accepted(db, invitation["id"], world)
    hash_before = (await _row(db, invitation["id"])).token_hash

    r = await client.post(f"{_url(world)}/{invitation['id']}/resend")

    assert_problem(r, 409, "invalid_transition")
    assert len(await _email_jobs(db)) == 1
    assert (await _row(db, invitation["id"])).token_hash == hash_before
    assert await _audit(db, "invitation.resent") == []


async def test_resend_of_an_expired_invitation_beside_a_pending_replacement_is_409(
    as_user, db, world
):
    # Review round 1 (Codex): resend revived the old invitation next to its replacement, so two
    # live links offered conflicting roles.
    client = await as_user(world.a_manager.user)
    old = await _invite(client, world, roles=["property_management"])
    await _expire(db, old["id"])
    replacement = await _invite(client, world, roles=["security"])
    hash_before = (await _row(db, old["id"])).token_hash

    r = await client.post(f"{_url(world)}/{old['id']}/resend")

    assert_problem(r, 409, "invitation_pending")
    pending = (await client.get(_url(world), params={"status": "pending"})).json()["items"]
    assert [item["id"] for item in pending] == [replacement["id"]]
    assert (await _row(db, old["id"])).token_hash == hash_before
    assert len(await _email_jobs(db)) == 2
    assert await _audit(db, "invitation.resent") == []


@pytest.mark.parametrize("replacement_closed_by", ["revoked", "accepted", "expired"])
async def test_resend_is_allowed_once_the_replacement_is_closed(
    as_user, db, world, replacement_closed_by
):
    client = await as_user(world.a_manager.user)
    old = await _invite(client, world)
    await _expire(db, old["id"])
    replacement = await _invite(client, world)
    if replacement_closed_by == "revoked":
        r = await client.post(f"{_url(world)}/{replacement['id']}/revoke")
        assert r.status_code == 204
    elif replacement_closed_by == "accepted":
        await _mark_accepted(db, replacement["id"], world)
    else:
        await _expire(db, replacement["id"])

    r = await client.post(f"{_url(world)}/{old['id']}/resend")

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "pending"


async def test_pending_invitation_in_another_building_does_not_block_resend(as_user, db, world):
    client = await as_user(world.a_manager.user)
    old = await _invite(client, world)
    await _expire(db, old["id"])
    r = await (await as_user(world.b_manager.user)).post(_url(world, world.b), json=_guard())
    assert r.status_code == 201, r.text

    r = await client.post(f"{_url(world)}/{old['id']}/resend")

    assert r.status_code == 200, r.text


# Criterion 10


async def test_revoke_after_resend_revokes_and_resend_after_revoke_is_409(as_user, db, world):
    client = await as_user(world.a_manager.user)
    invitation = await _invite(client, world)
    item = f"{_url(world)}/{invitation['id']}"

    assert (await client.post(f"{item}/resend")).status_code == 200
    assert (await client.post(f"{item}/revoke")).status_code == 204
    assert_problem(await client.post(f"{item}/resend"), 409, "invalid_transition")

    assert (await _row(db, invitation["id"])).revoked_at is not None
    assert len(await _email_jobs(db)) == 2


# The email


async def test_email_names_building_roles_and_expiry_and_uses_the_buildings_locale(
    as_user, db, world
):
    client = await as_user(world.a_manager.user)

    await _invite(client, world, roles=["security", "council"])

    (job,) = await _email_jobs(db)
    assert job.payload["to"] == "guard@example.test"
    assert job.payload["template"] == "invitation"
    assert job.payload["locale"] == world.a.locale
    context = job.payload["context"]
    assert context["building_name"] == world.a.name
    assert context["roles"] == ["council", "security"]
