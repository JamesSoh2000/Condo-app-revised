"""`record_audit` and the auth events it records (P2-04 criteria 1-4 and 7-9)."""

import json
import sys
import time
from typing import Annotated
from uuid import UUID, uuid7

import pytest
from fastapi import APIRouter, Depends
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit import actions
from app.audit.models import AuditEvent
from app.audit.service import record_audit
from app.auth.models import AuthSession
from app.auth.service import start_session
from app.core.config import settings
from app.core.dependencies import get_db_session
from app.core.security import hash_password
from app.logging_config import request_id_ctx
from app.users.models import User
from tests.factories import make_building, make_user
from tests.helpers.auth import login_as
from tests.helpers.tenancy import assert_problem

pytestmark = pytest.mark.anyio

PASSWORD = "a-long-test-password-2026"  # noqa: S105 (test value)
LOGIN = "/api/auth/login"
COOKIE = settings.session_cookie_name


async def _events(db: AsyncSession, action: str | None = None) -> list[AuditEvent]:
    stmt = select(AuditEvent).order_by(AuditEvent.created_at, AuditEvent.id)
    if action is not None:
        stmt = stmt.where(AuditEvent.action == action)
    return list(await db.scalars(stmt))


async def _count(db: AsyncSession) -> int:
    return await db.scalar(select(func.count()).select_from(AuditEvent)) or 0


def _row_text(event: AuditEvent) -> str:
    """Every column of the row, as one string, to search for leaked values."""
    columns = {c.key: getattr(event, c.key) for c in AuditEvent.__mapper__.column_attrs}
    return json.dumps(columns, default=str).lower()


async def _user(db: AsyncSession, **overrides) -> User:
    return await make_user(db, password_hash=hash_password(PASSWORD), **overrides)


# Criterion 1: a successful login


async def test_login_records_one_logged_in_event_with_the_response_request_id(client, db):
    user = await _user(db)

    response = await client.post(LOGIN, json={"email": user.email, "password": PASSWORD})

    assert response.status_code == 204
    [event] = await _events(db)
    session_id = await db.scalar(select(AuthSession.id).where(AuthSession.user_id == user.id))
    assert event.action == actions.AUTH_LOGGED_IN == "auth.logged_in"
    assert event.actor_user_id == user.id
    assert (event.entity_type, event.entity_id) == ("session", session_id)
    assert event.building_id is None
    assert event.metadata_ == {}
    assert event.request_id == response.headers["X-Request-ID"]


async def test_client_request_id_of_128_characters_is_stored_whole(client, db):
    user = await _user(db)
    request_id = "r" * 128

    response = await client.post(
        LOGIN,
        json={"email": user.email, "password": PASSWORD},
        headers={"X-Request-ID": request_id},
    )

    assert response.status_code == 204
    [event] = await _events(db)
    assert event.request_id == request_id


# Criterion 2: failed logins


async def test_unknown_email_records_login_failed_without_the_email_or_password(client, db):
    email = "Nobody-Here@Example.TEST"

    response = await client.post(LOGIN, json={"email": email, "password": PASSWORD})

    assert_problem(response, 401, "invalid_credentials")
    [event] = await _events(db)
    assert event.action == actions.AUTH_LOGIN_FAILED == "auth.login_failed"
    assert event.actor_user_id is None
    assert event.entity_id is None
    assert event.building_id is None
    assert event.metadata_ == {}
    assert event.request_id == response.headers["X-Request-ID"]
    row = _row_text(event)
    assert email.lower() not in row
    assert "nobody-here" not in row
    assert PASSWORD not in row


@pytest.mark.parametrize("case", ["wrong_password", "inactive_user"])
async def test_known_user_failure_records_only_the_user_id(client, db, case):
    user = await _user(db, is_active=case != "inactive_user")
    wrong = "not-the-password-at-all"
    password = wrong if case == "wrong_password" else PASSWORD

    response = await client.post(LOGIN, json={"email": user.email, "password": password})
    unknown = await client.post(
        LOGIN, json={"email": "someone-else@example.test", "password": password}
    )

    body = assert_problem(response, 401, "invalid_credentials")
    unknown_body = assert_problem(unknown, 401, "invalid_credentials")
    assert {k: v for k, v in body.items() if k != "request_id"} == {
        k: v for k, v in unknown_body.items() if k != "request_id"
    }
    known, _unknown = await _events(db, actions.AUTH_LOGIN_FAILED)
    assert known.actor_user_id is None
    assert (known.entity_type, known.entity_id) == ("user", None)
    assert known.metadata_ == {"user_id": str(user.id)}
    row = _row_text(known)
    assert user.email.lower() not in row
    assert password not in row


# Criterion 3: the audit row shares the action's transaction


async def test_audit_row_is_discarded_when_the_use_case_raises_before_commit(app_client, db):
    router = APIRouter(tags=["test"])

    @router.post("/test-audit-then-fail")
    async def audit_then_fail(db: Annotated[AsyncSession, Depends(get_db_session)]) -> None:
        await record_audit(db, action="test.recorded", entity_type="test")
        await db.flush()
        raise RuntimeError("boom before commit")

    async with app_client(router, raise_app_exceptions=False) as c:
        response = await c.post("/api/test-audit-then-fail")

    assert response.status_code == 500
    assert await _count(db) == 0


# Criterion 4: metadata sanitizing


@pytest.mark.parametrize(
    "metadata",
    [
        {"new_password": "x"},
        {"Password": "x"},
        {"reset_Token": "x"},
        {"SECRET": "x"},
        {"cookie_value": "x"},
        {"Authorization": "x"},
        {"changes": {"password_hash": "x"}},
        {"changes": [{"api_token": "x"}]},
        {"note": "x" * 1025},
        {"note": "é" * 513},
        {"blob": ["x" * 600, "y" * 600]},
        {"when": object()},
    ],
)
async def test_record_audit_refuses_secret_keys_large_and_non_json_values(db, metadata):
    with pytest.raises(ValueError):
        await record_audit(db, action="test.recorded", entity_type="test", metadata=metadata)

    assert not db.new
    assert await _count(db) == 0


def _cyclic(kind: str) -> object:
    value: dict[str, object] | list[object] = {} if kind == "dict" else []
    if isinstance(value, dict):
        value["self"] = value
    else:
        value.append(value)
    return value


def _deep(depth: int) -> object:
    value: object = None
    for _ in range(depth):
        value = [value]
    return value


@pytest.mark.parametrize(
    "metadata",
    [
        # Review round 2 (Codex L1, Claude L2): deeper than the recursion limit, no cycle.
        {"changes": _deep(sys.getrecursionlimit() + 10)},
        {"changes": {"x": _deep(sys.getrecursionlimit() + 10)}},
        # Review round 2 (Claude L3): Postgres JSONB can't hold NUL; it would fail the commit.
        {"field": "a\x00b"},
        {"fie\x00ld": "x"},
        {"changes": [{"field": "\x00"}]},
        {"changes": {"fie\x00ld": 1}},
    ],
)
async def test_record_audit_refuses_deep_nesting_and_nul_characters(db, metadata):
    with pytest.raises(ValueError):
        await record_audit(db, action="test.recorded", entity_type="test", metadata=metadata)
    assert not db.new


@pytest.mark.parametrize("metadata", [["user_id"], "user_id", 1])
async def test_record_audit_refuses_metadata_that_is_not_a_dict(db, metadata):
    # Review round 2 (Claude L4): was an AttributeError.
    with pytest.raises(ValueError):
        await record_audit(db, action="test.recorded", entity_type="test", metadata=metadata)
    assert not db.new


@pytest.mark.parametrize("metadata", [False, 0, "", [], ()])
async def test_record_audit_refuses_falsy_metadata_that_is_not_a_dict(db, metadata):
    # P2-04 review round 3 (Low): `metadata or {}` turned these into `{}` and stored them.
    with pytest.raises(ValueError):
        await record_audit(db, action="test.recorded", entity_type="test", metadata=metadata)
    assert not db.new


@pytest.mark.parametrize("metadata", [{"\ud800": "x"}, {"changes": {"\udfff": 1}}])
async def test_record_audit_refuses_a_lone_surrogate_key(db, metadata):
    # P2-04 review round 3 (Low): a surrogate key passed the checks and failed at flush.
    with pytest.raises(ValueError):
        await record_audit(db, action="test.recorded", entity_type="test", metadata=metadata)
    assert not db.new


def _shared(levels: int) -> object:
    value: object = ["x"]
    for _ in range(levels):
        value = [value, value]
    return value


async def test_record_audit_refuses_shared_sub_objects_without_walking_every_path(db):
    # P2-04 review round 3 (Low): 25 levels of `x = [x, x]` is 2**25 paths, within the depth
    # limit; walking (or serializing) each one took exponential time.
    started = time.perf_counter()
    with pytest.raises(ValueError):
        await record_audit(
            db, action="test.recorded", entity_type="test", metadata={"changes": _shared(25)}
        )
    assert time.perf_counter() - started < 1
    assert not db.new


async def test_small_shared_sub_objects_are_accepted(db):
    shared = ["field"]
    await record_audit(
        db, action="test.recorded", entity_type="test", metadata={"a": shared, "b": shared}
    )
    await db.flush()
    [event] = await _events(db)
    assert event.metadata_ == {"a": ["field"], "b": ["field"]}


async def test_moderately_nested_metadata_is_accepted(db):
    await record_audit(
        db, action="test.recorded", entity_type="test", metadata={"changes": _deep(20)}
    )
    await db.flush()
    [event] = await _events(db)
    assert event.metadata_ == {"changes": _deep(20)}


@pytest.mark.parametrize("kind", ["dict", "list"])
async def test_record_audit_refuses_self_referencing_metadata(db, kind):
    # Review round 1 (Codex L1): this was a RecursionError, not the documented ValueError.
    with pytest.raises(ValueError):
        await record_audit(
            db, action="test.recorded", entity_type="test", metadata={"changes": _cyclic(kind)}
        )
    assert not db.new


async def test_value_of_exactly_one_kib_and_uuids_are_accepted(db):
    entity = uuid7()
    # 1,022 characters plus the JSON quotes: 1,024 bytes.
    await record_audit(
        db,
        action="test.recorded",
        entity_type="test",
        entity_id=entity,
        metadata={"note": "x" * 1022, "other_id": entity},
    )
    await db.flush()

    [event] = await _events(db)
    assert event.metadata_ == {"note": "x" * 1022, "other_id": str(entity)}
    assert event.entity_id == entity


async def test_record_audit_never_commits(db):
    building = await make_building(db)
    await db.commit()

    await record_audit(db, action="test.recorded", entity_type="test", building_id=building.id)
    await db.flush()
    assert await _count(db) == 1
    await db.rollback()

    assert await _count(db) == 0


async def test_request_id_is_null_outside_a_request(db):
    token = request_id_ctx.set(None)
    try:
        await record_audit(db, action="test.recorded", entity_type="test")
        await db.flush()
    finally:
        request_id_ctx.reset(token)

    [event] = await _events(db)
    assert event.request_id is None


@pytest.mark.parametrize("action", ["Auth.logged_in", "auth", "auth.logged-in", "a." + "x" * 63])
async def test_record_audit_refuses_a_malformed_action(db, action):
    with pytest.raises(ValueError):
        await record_audit(db, action=action, entity_type="test")
    assert not db.new


# Criteria 7 and 8: logout, logout-all, revoke one session


async def test_logout_records_logged_out_for_the_revoked_session(client, db):
    user = await make_user(db)
    token = await login_as(db, client, user)
    session_id = await db.scalar(select(AuthSession.id).where(AuthSession.user_id == user.id))

    response = await client.post("/api/auth/logout")

    assert response.status_code == 204
    [event] = await _events(db)
    assert event.action == actions.AUTH_LOGGED_OUT == "auth.logged_out"
    assert event.actor_user_id == user.id
    assert (event.entity_type, event.entity_id) == ("session", session_id)
    assert event.request_id == response.headers["X-Request-ID"]

    # The same token again: already revoked, nothing more is recorded.
    client.cookies.set(COOKIE, token)
    assert (await client.post("/api/auth/logout")).status_code == 204
    assert await _count(db) == 1


async def test_logout_of_an_expired_session_revokes_and_records_it(client, db, frozen_clock):
    # Review round 1 (Codex): criterion 7's expired-session case had no test.
    user = await make_user(db)
    await login_as(db, client, user)
    session = await db.scalar(select(AuthSession).where(AuthSession.user_id == user.id))
    frozen_clock.advance(days=31)

    assert (await client.post("/api/auth/logout")).status_code == 204

    [event] = await _events(db)
    assert (event.action, event.entity_id) == (actions.AUTH_LOGGED_OUT, session.id)
    await db.refresh(session)
    assert session.revoked_at is not None


@pytest.mark.parametrize("cookie", [None, "not-a-real-token"])
async def test_logout_without_a_live_session_records_nothing(client, db, cookie):
    if cookie is not None:
        client.cookies.set(COOKIE, cookie)

    assert (await client.post("/api/auth/logout")).status_code == 204

    assert await _count(db) == 0


async def test_logout_all_records_one_event_with_the_count(client, db):
    user = await make_user(db)
    await login_as(db, client, user)
    await _extra_sessions(db, user, 2)

    response = await client.post("/api/auth/logout-all")

    assert response.status_code == 204
    [event] = await _events(db)
    assert event.action == actions.AUTH_LOGGED_OUT_ALL == "auth.logged_out_all"
    assert event.actor_user_id == user.id
    assert (event.entity_type, event.entity_id) == ("user", user.id)
    assert event.metadata_ == {"count": 3}


async def _extra_sessions(db: AsyncSession, user: User, n: int) -> list[UUID]:
    for _ in range(n):
        await start_session(db, user.id, user_agent="other", ip=None)
    return list(await db.scalars(select(AuthSession.id).where(AuthSession.user_id == user.id)))


async def test_revoking_one_session_records_session_revoked(client, db):
    user = await make_user(db)
    await login_as(db, client, user)
    ids = await _extra_sessions(db, user, 1)
    current = await db.scalar(
        select(AuthSession.id).where(
            AuthSession.user_id == user.id, AuthSession.user_agent == "tests"
        )
    )
    [other] = [i for i in ids if i != current]

    response = await client.delete(f"/api/auth/sessions/{other}")

    assert response.status_code == 204
    [event] = await _events(db)
    assert event.action == actions.AUTH_SESSION_REVOKED == "auth.session_revoked"
    assert event.actor_user_id == user.id
    assert (event.entity_type, event.entity_id) == ("session", other)


@pytest.mark.parametrize("target", ["unknown", "someone_elses", "revoked", "expired"])
async def test_revoking_a_session_that_is_not_ones_own_live_one_records_nothing(
    client, db, frozen_clock, target
):
    # Review round 1 (Codex): every 404 kind, not only an unknown id.
    user = await make_user(db)
    other = await make_user(db)
    session_id = uuid7()
    if target == "someone_elses":
        await start_session(db, other.id, user_agent=None, ip=None)
        session_id = await db.scalar(select(AuthSession.id).where(AuthSession.user_id == other.id))
    elif target in ("revoked", "expired"):
        await start_session(db, user.id, user_agent="target", ip=None)
        session = await db.scalar(select(AuthSession).where(AuthSession.user_agent == "target"))
        session_id = session.id
        if target == "revoked":
            session.revoked_at = frozen_clock.at
        else:
            session.expires_at = frozen_clock.at
    await db.flush()
    await login_as(db, client, user)

    response = await client.delete(f"/api/auth/sessions/{session_id}")

    assert_problem(response, 404, "not_found")
    assert await _count(db) == 0
