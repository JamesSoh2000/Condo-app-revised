"""`record_audit` and the auth events it records (P2-04 criteria 1-4 and 7-9)."""

import json
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
    password = "not-the-password-at-all" if case == "wrong_password" else PASSWORD  # noqa: S105

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
    router = APIRouter()

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
        select(AuthSession.id).where(AuthSession.user_id == user.id, AuthSession.user_agent == "tests")
    )
    [other] = [i for i in ids if i != current]

    response = await client.delete(f"/api/auth/sessions/{other}")

    assert response.status_code == 204
    [event] = await _events(db)
    assert event.action == actions.AUTH_SESSION_REVOKED == "auth.session_revoked"
    assert event.actor_user_id == user.id
    assert (event.entity_type, event.entity_id) == ("session", other)


async def test_revoking_an_unknown_session_records_nothing(client, db):
    user = await make_user(db)
    await login_as(db, client, user)

    response = await client.delete(f"/api/auth/sessions/{uuid7()}")

    assert_problem(response, 404, "not_found")
    assert await _count(db) == 0
