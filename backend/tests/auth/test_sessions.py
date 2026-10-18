"""get_current_session / get_current_user (P2-01b criteria 4-7 and 11), on a test-only route."""

from datetime import timedelta
from typing import Annotated

import pytest
from fastapi import APIRouter, Depends
from sqlalchemy import select, text

from app.auth import service
from app.auth.deps import get_current_session, get_current_user
from app.auth.models import AuthSession
from app.core.security import hash_password, hash_token
from app.memberships.enums import Role
from app.users.models import User
from tests.factories import make_building, make_membership, make_user
from tests.helpers.auth import login_as

pytestmark = pytest.mark.anyio

router = APIRouter(prefix="/session-probe", tags=["probe"])


@router.get("/whoami")
async def whoami(user: Annotated[User, Depends(get_current_user)]) -> dict[str, str]:
    return {"user_id": str(user.id)}


@router.get("/session")
async def current_session(
    current: Annotated[object, Depends(get_current_session)],
) -> dict[str, str]:
    session = current.session  # type: ignore[attr-defined]
    return {"session_id": str(session.id), "user_id": str(current.user.id)}  # type: ignore[attr-defined]


def assert_not_authenticated(response) -> None:
    assert response.status_code == 401
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "not_authenticated"


async def _row(db, token: str) -> AuthSession:
    row: AuthSession = (
        await db.scalars(select(AuthSession).where(AuthSession.token_hash == hash_token(token)))
    ).one()
    await db.refresh(row)
    return row


# Criterion 11: login_as


async def test_login_as_authenticates_a_world_user_without_a_password(app_client, db, world):
    async with app_client(router) as c:
        assert_not_authenticated(await c.get("/api/session-probe/whoami"))
        await login_as(db, c, world.a_resident1.user)
        response = await c.get("/api/session-probe/whoami")

    assert world.a_resident1.user.password_hash is None
    assert response.status_code == 200
    assert response.json() == {"user_id": str(world.a_resident1.user.id)}


async def test_current_session_carries_the_session_and_its_user(app_client, db):
    user = await make_user(db)
    async with app_client(router) as c:
        token = await login_as(db, c, user)
        response = await c.get("/api/session-probe/session")

    assert response.json() == {
        "session_id": str((await _row(db, token)).id),
        "user_id": str(user.id),
    }


# Criterion 4: a logged-out cookie is dead


async def test_cookie_reused_after_logout_is_rejected(app_client, db):
    user = await make_user(db, email="reuse@example.com", password_hash=hash_password("p" * 16))
    async with app_client(router) as c:
        login = await c.post(
            "/api/auth/login", json={"email": "reuse@example.com", "password": "p" * 16}
        )
        token = login.cookies["session"]
        assert (await c.get("/api/session-probe/whoami")).status_code == 200
        assert (await c.post("/api/auth/logout")).status_code == 204
        c.cookies.set("session", token)  # the attacker kept a copy
        response = await c.get("/api/session-probe/whoami")

    assert_not_authenticated(response)
    assert user.id  # the user still exists; only the session is gone


# Criterion 5: expiry, revocation and other dead sessions


@pytest.mark.parametrize("which", ["expires_at", "idle_expires_at"])
@pytest.mark.parametrize(("offset", "status"), [(-1, 200), (0, 401), (1, 401)])
async def test_session_is_rejected_from_either_deadline_on(
    app_client, db, frozen_clock, which, offset, status
):
    # One request per case: a request is activity, and activity moves the idle deadline.
    user = await make_user(db)
    async with app_client(router) as c:
        token = await login_as(db, c, user)
        row = await _row(db, token)
        # Move the other deadline far out, so only `which` decides.
        other = "idle_expires_at" if which == "expires_at" else "expires_at"
        setattr(row, other, frozen_clock() + timedelta(days=365))
        setattr(row, which, frozen_clock() + timedelta(hours=1))
        await db.flush()

        frozen_clock.advance(hours=1, seconds=offset)
        response = await c.get("/api/session-probe/whoami")

    if status == 200:
        assert response.status_code == 200
    else:
        assert_not_authenticated(response)


async def test_resident_session_dies_after_7_idle_days_and_staff_after_12_hours(
    app_client, db, frozen_clock
):
    building = await make_building(db)
    resident = await make_user(db)
    staff = await make_user(db)
    await make_membership(resident, building, roles=(Role.RESIDENT,))
    await make_membership(staff, building, roles=(Role.SECURITY,))
    async with app_client(router) as resident_client, app_client(router) as staff_client:
        await login_as(db, resident_client, resident)
        await login_as(db, staff_client, staff)

        frozen_clock.advance(hours=12)
        staff_after_12h = await staff_client.get("/api/session-probe/whoami")
        resident_after_12h = await resident_client.get("/api/session-probe/whoami")
        frozen_clock.advance(days=7)
        resident_after_7d_more = await resident_client.get("/api/session-probe/whoami")

    assert_not_authenticated(staff_after_12h)
    assert resident_after_12h.status_code == 200
    # The 12-hour request refreshed the resident's window to T+12h+7d; 7 days later it has ended.
    assert_not_authenticated(resident_after_7d_more)


async def test_session_dies_at_30_days_however_active(app_client, db, frozen_clock):
    user = await make_user(db)
    async with app_client(router) as c:
        await login_as(db, c, user)
        for _ in range(29):
            frozen_clock.advance(days=1)
            assert (await c.get("/api/session-probe/whoami")).status_code == 200
        frozen_clock.advance(days=1)
        response = await c.get("/api/session-probe/whoami")

    assert_not_authenticated(response)


async def test_revoked_session_is_rejected(app_client, db, frozen_clock):
    user = await make_user(db)
    async with app_client(router) as c:
        token = await login_as(db, c, user)
        (await _row(db, token)).revoked_at = frozen_clock()
        await db.flush()
        response = await c.get("/api/session-probe/whoami")

    assert_not_authenticated(response)


async def test_deactivated_user_is_rejected_on_the_next_request(app_client, db):
    user = await make_user(db)
    async with app_client(router) as c:
        await login_as(db, c, user)
        assert (await c.get("/api/session-probe/whoami")).status_code == 200
        user.is_active = False
        await db.flush()
        response = await c.get("/api/session-probe/whoami")

    assert_not_authenticated(response)


@pytest.mark.parametrize("cookie", [None, "", "garbage", "x" * 4096])
async def test_missing_or_unknown_cookie_is_rejected(app_client, cookie):
    async with app_client(router) as c:
        if cookie is not None:
            c.cookies.set("session", cookie)
        response = await c.get("/api/session-probe/whoami")

    assert_not_authenticated(response)


# Criterion 6: last_seen_at moves at most once per 5 minutes


async def test_last_seen_at_is_written_at_most_every_5_minutes(app_client, db, frozen_clock):
    user = await make_user(db)
    start = frozen_clock()
    async with app_client(router) as c:
        token = await login_as(db, c, user)

        frozen_clock.advance(minutes=1)
        await c.get("/api/session-probe/whoami")
        after_1 = await _row(db, token)
        seen_1, idle_1 = after_1.last_seen_at, after_1.idle_expires_at

        frozen_clock.advance(minutes=4)  # T+5
        await c.get("/api/session-probe/whoami")
        after_5 = await _row(db, token)
        seen_5, idle_5 = after_5.last_seen_at, after_5.idle_expires_at

        frozen_clock.advance(minutes=1)  # T+6
        await c.get("/api/session-probe/whoami")
        after_6 = await _row(db, token)

    assert (seen_1, idle_1) == (start, start + timedelta(days=7))
    assert (seen_5, idle_5) == (start + timedelta(minutes=5), start + timedelta(minutes=5, days=7))
    assert (after_6.last_seen_at, after_6.idle_expires_at) == (seen_5, idle_5)


async def test_refresh_recomputes_the_idle_window_from_current_roles(app_client, db, frozen_clock):
    user = await make_user(db)
    async with app_client(router) as c:
        token = await login_as(db, c, user)
        assert (await _row(db, token)).idle_expires_at == frozen_clock() + timedelta(days=7)

        await make_membership(user, await make_building(db), roles=(Role.PROPERTY_MANAGEMENT,))
        frozen_clock.advance(minutes=5)
        await c.get("/api/session-probe/whoami")

    assert (await _row(db, token)).idle_expires_at == frozen_clock() + timedelta(hours=12)


# Review round 1 (Claude): the refresh is conditional on the value read, and it updates the loaded
# session object as well as the row.


async def test_refresh_does_not_overwrite_a_newer_write(db, frozen_clock):
    user = await make_user(db)
    token = await service.start_session(db, user.id, user_agent=None, ip=None)
    stale = await service.resolve_session(db, token)
    assert stale is not None
    # Another request refreshed the row after this one read it.
    newer = frozen_clock() + timedelta(minutes=7)
    await db.execute(
        text("UPDATE sessions SET last_seen_at = :t WHERE token_hash = :h"),
        {"t": newer, "h": hash_token(token)},
    )
    frozen_clock.advance(minutes=6)

    await service.touch_session(db, stale.session)

    assert (
        await db.scalar(
            text("SELECT last_seen_at FROM sessions WHERE token_hash = :h"),
            {"h": hash_token(token)},
        )
        == newer
    )


async def test_refresh_updates_the_loaded_session_too(db, frozen_clock):
    user = await make_user(db)
    token = await service.start_session(db, user.id, user_agent=None, ip=None)
    current = await service.resolve_session(db, token)
    assert current is not None
    frozen_clock.advance(minutes=6)

    await service.touch_session(db, current.session)

    assert current.session.last_seen_at == frozen_clock()
    assert current.session.idle_expires_at == frozen_clock() + timedelta(days=7)
