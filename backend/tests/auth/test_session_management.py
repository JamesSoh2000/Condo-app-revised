"""Session list, revoke one, logout-all, revoke_all_sessions (P2-02 criteria 5-8, 12-16)."""

from datetime import datetime, timedelta
from uuid import uuid7

import pytest
from sqlalchemy import select

from app.auth import service
from app.auth.models import AuthSession
from app.core import clock
from app.core.config import settings
from app.core.security import hash_token
from app.main import app
from tests.factories import make_user
from tests.helpers.auth import login_as
from tests.test_csrf import assert_csrf_rejected, send

pytestmark = pytest.mark.anyio

ME = "/api/auth/me"
SESSIONS = "/api/auth/sessions"
LOGOUT_ALL = "/api/auth/logout-all"
COOKIE = settings.session_cookie_name


def assert_not_authenticated(response) -> None:
    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "not_authenticated"


def assert_not_found(response) -> None:
    assert response.status_code == 404
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "not_found"


def assert_cookie_deleted(response) -> None:
    [header] = response.headers.get_list("set-cookie")
    first, *rest = [part.strip() for part in header.split(";")]
    attributes = {k.lower(): v for k, _, v in (part.partition("=") for part in rest)}
    assert first in {f"{COOKIE}=", f'{COOKIE}=""'}
    assert attributes["max-age"] == "0"
    assert attributes["path"] == "/"
    assert "httponly" in attributes
    assert attributes["samesite"].lower() == "lax"


async def _session(db, token: str) -> AuthSession:
    row = (
        await db.scalars(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    ).one()
    await db.refresh(row)
    return row


def _ids(response) -> list[str]:
    return [item["id"] for item in response.json()["items"]]


# Criterion 5: logout-all


async def test_logout_all_ends_every_session_of_the_user_at_once(client, app_client, db, world):
    user = world.a_resident1.user
    async with app_client() as other_device, app_client() as someone_else:
        token_1 = await login_as(db, client, user)
        await login_as(db, other_device, user)
        await login_as(db, someone_else, world.a_resident2.user)
        assert (await other_device.get(ME)).status_code == 200

        response = await client.post(LOGOUT_ALL)

        assert response.status_code == 204
        assert_cookie_deleted(response)
        assert_not_authenticated(await other_device.get(ME))
        client.cookies.set(COOKIE, token_1)  # replaying the old cookie
        assert_not_authenticated(await client.get(ME))
        assert (await someone_else.get(ME)).status_code == 200


async def test_logout_all_without_a_cookie_is_not_authenticated(client):
    assert_not_authenticated(await client.post(LOGOUT_ALL))


async def test_logout_all_without_csrf_headers_is_refused_and_revokes_nothing(client, db, world):
    token = await login_as(db, client, world.a_resident1.user)

    response = await send(client, "POST", LOGOUT_ALL, headers=[])

    assert_csrf_rejected(response)
    assert (await _session(db, token)).revoked_at is None
    assert (await client.get(ME)).status_code == 200


# Criterion 6: only your own sessions


async def test_session_list_holds_only_the_callers_sessions(client, app_client, db, world):
    async with app_client() as phone, app_client() as other_user:
        laptop_token = await login_as(db, client, world.a_resident1.user)
        phone_token = await login_as(db, phone, world.a_resident1.user)
        other_token = await login_as(db, other_user, world.a_resident2.user)

        from_laptop = await client.get(SESSIONS)
        from_phone = await phone.get(SESSIONS)

    laptop = await _session(db, laptop_token)
    phone_row = await _session(db, phone_token)
    other = await _session(db, other_token)
    assert from_laptop.status_code == 200
    body = from_laptop.json()
    assert body["next_cursor"] is None
    # Newest first; `current` marks the session of the client that asks.
    assert [(i["id"], i["current"]) for i in body["items"]] == [
        (str(phone_row.id), False),
        (str(laptop.id), True),
    ]
    for item, row in zip(body["items"], [phone_row, laptop], strict=True):
        assert set(item) == {"id", "created_at", "last_seen_at", "user_agent", "current"}
        assert datetime.fromisoformat(item["created_at"]) == row.created_at
        assert datetime.fromisoformat(item["last_seen_at"]) == row.last_seen_at
        assert item["user_agent"] == "tests"
    assert str(other.id) not in _ids(from_laptop)
    assert [(i["id"], i["current"]) for i in from_phone.json()["items"]] == [
        (str(phone_row.id), True),
        (str(laptop.id), False),
    ]


async def test_revoking_another_users_session_is_not_found_and_changes_nothing(
    client, app_client, db, world
):
    async with app_client() as victim:
        await login_as(db, client, world.a_resident1.user)
        victim_token = await login_as(db, victim, world.a_resident2.user)
        victim_id = (await _session(db, victim_token)).id

        theirs = await client.delete(f"{SESSIONS}/{victim_id}")
        unknown = await client.delete(f"{SESSIONS}/{uuid7()}")

        assert_not_found(theirs)
        same = ("type", "title", "status", "code", "detail")
        assert {k: theirs.json().get(k) for k in same} == {k: unknown.json().get(k) for k in same}
        assert (await _session(db, victim_token)).revoked_at is None
        assert (await victim.get(ME)).status_code == 200


async def test_session_endpoints_without_a_cookie_are_not_authenticated(client):
    assert_not_authenticated(await client.get(SESSIONS))
    assert_not_authenticated(await client.delete(f"{SESSIONS}/{uuid7()}"))


# Criterion 8: no secrets in responses


SECRET_KEYS = {"password_hash", "token_hash", "ip"}


def _keys(value) -> set[str]:
    if isinstance(value, dict):
        return set(value) | {k for v in value.values() for k in _keys(v)}
    if isinstance(value, list):
        return {k for v in value for k in _keys(v)}
    return set()


def _schema_properties(spec: dict, schema: dict, seen: set[str]) -> set[str]:
    """Every property name reachable from `schema`, following `$ref`s."""
    if "$ref" in schema:
        name = schema["$ref"].rsplit("/", 1)[-1]
        if name in seen:
            return set()
        seen.add(name)
        return _schema_properties(spec, spec["components"]["schemas"][name], seen)
    names = set(schema.get("properties", {}))
    children = [*schema.get("properties", {}).values()]
    children += [
        schema[k] for k in ("items", "additionalProperties") if isinstance(schema.get(k), dict)
    ]
    children += [s for k in ("anyOf", "allOf", "oneOf") for s in schema.get(k, [])]
    for child in children:
        names |= _schema_properties(spec, child, seen)
    return names


@pytest.mark.parametrize(
    ("path", "method"),
    [
        ("/api/auth/me", "get"),
        ("/api/auth/sessions", "get"),
        ("/api/auth/logout-all", "post"),
        ("/api/auth/sessions/{session_id}", "delete"),
    ],
)
def test_response_schemas_have_no_secret_fields(path, method):
    spec = app.openapi()
    operation = spec["paths"][path][method]
    names: set[str] = set()
    for response in operation["responses"].values():
        for content in response.get("content", {}).values():
            names |= _schema_properties(spec, content["schema"], set())

    assert not names & SECRET_KEYS


async def test_responses_have_no_secret_fields(client, db, world):
    await login_as(db, client, world.multi)

    me = (await client.get(ME)).json()
    sessions = (await client.get(SESSIONS)).json()

    assert me["memberships"] and sessions["items"]
    assert not (_keys(me) | _keys(sessions)) & SECRET_KEYS


def test_operation_ids():
    spec = app.openapi()
    ids = {
        (path, method): spec["paths"][path][method]["operationId"]
        for path, method in [
            ("/api/auth/me", "get"),
            ("/api/auth/logout-all", "post"),
            ("/api/auth/sessions", "get"),
            ("/api/auth/sessions/{session_id}", "delete"),
        ]
    }
    assert sorted(ids.values()) == [
        "auth_logout_all",
        "auth_me",
        "auth_sessions_list",
        "auth_sessions_revoke",
    ]


# Criterion 12: only live sessions, paginated


async def test_session_list_leaves_out_revoked_and_expired_sessions(client, db, world):
    user = world.a_resident1.user
    current = await login_as(db, client, user)
    revoked, expired, idle = [
        await service.start_session(db, user.id, user_agent="old", ip="203.0.113.9")
        for _ in range(3)
    ]
    now = clock.now()
    (await _session(db, revoked)).revoked_at = now
    (await _session(db, expired)).expires_at = now - timedelta(seconds=1)
    (await _session(db, idle)).idle_expires_at = now - timedelta(seconds=1)
    await db.flush()

    response = await client.get(SESSIONS)

    assert _ids(response) == [str((await _session(db, current)).id)]


async def test_session_list_is_paginated_newest_first(client, db, world):
    user = world.a_resident1.user
    await login_as(db, client, user)
    for _ in range(2):
        await service.start_session(db, user.id, user_agent="other", ip=None)
    everything = _ids(await client.get(SESSIONS))

    first = await client.get(SESSIONS, params={"limit": 2})
    second = await client.get(SESSIONS, params={"limit": 2, "cursor": first.json()["next_cursor"]})

    assert len(everything) == 3
    assert everything == sorted(everything, reverse=True)
    assert _ids(first) + _ids(second) == everything
    assert second.json()["next_cursor"] is None


async def test_session_list_keeps_the_user_agent_and_hides_the_ip(client, db, world):
    user = world.a_resident1.user
    await login_as(db, client, user)
    await service.start_session(db, user.id, user_agent="Firefox/140", ip="203.0.113.9")

    items = (await client.get(SESSIONS)).json()["items"]

    assert items[0]["user_agent"] == "Firefox/140"
    assert "203.0.113.9" not in str(items)


# Criterion 13: revoking one session


async def test_revoking_another_of_your_sessions_ends_only_that_one(client, app_client, db, world):
    user = world.a_resident1.user
    async with app_client() as lost_phone:
        await login_as(db, client, user)
        phone_token = await login_as(db, lost_phone, user)
        phone_id = (await _session(db, phone_token)).id

        response = await client.delete(f"{SESSIONS}/{phone_id}")

        assert response.status_code == 204
        assert "set-cookie" not in response.headers
        assert_not_authenticated(await lost_phone.get(ME))
        assert (await client.get(ME)).status_code == 200
        assert str(phone_id) not in _ids(await client.get(SESSIONS))


async def test_revoking_a_session_twice_is_not_found(client, db, world):
    user = world.a_resident1.user
    await login_as(db, client, user)
    other = await service.start_session(db, user.id, user_agent=None, ip=None)
    other_id = (await _session(db, other)).id

    first = await client.delete(f"{SESSIONS}/{other_id}")
    second = await client.delete(f"{SESSIONS}/{other_id}")

    assert first.status_code == 204
    assert_not_found(second)


async def test_revoking_your_own_expired_session_is_not_found(client, db, world):
    user = world.a_resident1.user
    await login_as(db, client, user)
    expired = await service.start_session(db, user.id, user_agent=None, ip=None)
    row = await _session(db, expired)
    row.expires_at = clock.now() - timedelta(seconds=1)
    await db.flush()

    response = await client.delete(f"{SESSIONS}/{row.id}")

    assert_not_found(response)
    assert (await _session(db, expired)).revoked_at is None


async def test_revoking_the_current_session_logs_you_out(client, db, world):
    token = await login_as(db, client, world.a_resident1.user)
    current_id = (await _session(db, token)).id

    response = await client.delete(f"{SESSIONS}/{current_id}")

    assert response.status_code == 204
    assert_cookie_deleted(response)
    client.cookies.set(COOKIE, token)
    assert_not_authenticated(await client.get(ME))


# Criterion 14: CSRF on DELETE


async def test_revoking_without_csrf_headers_is_refused(client, db, world):
    user = world.a_resident1.user
    await login_as(db, client, user)
    other = await service.start_session(db, user.id, user_agent=None, ip=None)
    other_id = (await _session(db, other)).id

    response = await send(client, "DELETE", f"{SESSIONS}/{other_id}", headers=[])

    assert_csrf_rejected(response)
    assert (await _session(db, other)).revoked_at is None


# Criterion 15: revoke_all_sessions


async def test_revoke_all_sessions_revokes_live_ones_and_never_commits(db, world, monkeypatch):
    user = world.a_resident1.user
    live = [await service.start_session(db, user.id, user_agent=None, ip=None) for _ in range(2)]
    already = await service.start_session(db, user.id, user_agent=None, ip=None)
    revoked_before = clock.now() - timedelta(hours=1)
    (await _session(db, already)).revoked_at = revoked_before
    untouched = await service.start_session(db, world.a_resident2.user.id, user_agent=None, ip=None)
    await db.flush()

    async def no_commit() -> None:
        raise AssertionError("revoke_all_sessions must not commit")

    monkeypatch.setattr(db, "commit", no_commit)
    count = await service.revoke_all_sessions(db, user.id)

    assert count == 2
    assert all([(await _session(db, t)).revoked_at is not None for t in live])
    assert (await _session(db, already)).revoked_at == revoked_before
    assert (await _session(db, untouched)).revoked_at is None


async def test_revoke_all_sessions_for_a_user_without_sessions_is_zero(db):
    user = await make_user(db)

    assert await service.revoke_all_sessions(db, user.id) == 0


# Criterion 16


async def test_a_session_id_that_is_not_a_uuid_is_a_validation_error(client, db, world):
    await login_as(db, client, world.a_resident1.user)

    response = await client.delete(f"{SESSIONS}/not-a-uuid")

    assert response.status_code == 422
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "validation_error"
