"""POST /api/auth/login and /logout (P2-01b criteria 1-4 and 7-10)."""

import hashlib
import logging
from datetime import timedelta

import pytest
from argon2 import PasswordHasher
from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.auth.models import AuthSession
from app.core.config import Settings, settings
from app.core.security import DUMMY_HASH, hash_password, needs_rehash, verify_password
from app.memberships.enums import MembershipStatus, Role
from app.seed import DEV_SEED_PASSWORD, seed
from app.users.models import User
from tests.factories import make_building, make_membership, make_user
from tests.helpers.db import assert_integrity_error

pytestmark = pytest.mark.anyio

PASSWORD = "a-long-test-password-2026"  # noqa: S105 (test value)
THIRTY_DAYS = 30 * 24 * 3600


async def _user(db: AsyncSession, **overrides) -> User:
    return await make_user(db, password_hash=hash_password(PASSWORD), **overrides)


def _set_cookie(response) -> str:
    [header] = response.headers.get_list("set-cookie")
    return header


def _attributes(header: str) -> dict[str, str]:
    first, *rest = [part.strip() for part in header.split(";")]
    attributes = {"__pair__": first}
    for part in rest:
        name, _, value = part.partition("=")
        attributes[name.lower()] = value
    return attributes


async def _sessions(db: AsyncSession) -> list[AuthSession]:
    return list(await db.scalars(select(AuthSession)))


# Criterion 1: login sets the cookie


@pytest.mark.parametrize("email", ["resident1@example.test", "Resident1@Example.TEST"])
async def test_seeded_resident_logs_in_and_gets_an_httponly_lax_cookie(client, db, email):
    await seed(db, app_env="dev")

    response = await client.post(
        "/api/auth/login", json={"email": email, "password": DEV_SEED_PASSWORD}
    )

    assert response.status_code == 204
    assert response.content == b""
    attributes = _attributes(_set_cookie(response))
    name, _, token = attributes["__pair__"].partition("=")
    assert name == "session"
    assert len(token) >= 43
    assert "httponly" in attributes
    assert attributes["samesite"].lower() == "lax"
    assert attributes["path"] == "/"
    assert attributes["max-age"] == str(THIRTY_DAYS)
    assert "domain" not in attributes
    assert "secure" not in attributes


async def test_cookie_is_host_prefixed_and_secure_with_staging_settings(client, db, monkeypatch):
    staging = Settings(
        _env_file=None,
        app_env="staging",
        secret_key="not-the-default-secret",  # noqa: S106 (test value)
        trusted_origins=["https://staging.example.org"],
        s3_bucket_name="condo-staging-files",
    )
    assert (staging.session_cookie_name, staging.session_cookie_secure) == ("__Host-session", True)
    monkeypatch.setattr(settings, "session_cookie_name", staging.session_cookie_name)
    monkeypatch.setattr(settings, "session_cookie_secure", staging.session_cookie_secure)
    await _user(db, email="staff@example.com")

    response = await client.post(
        "/api/auth/login", json={"email": "staff@example.com", "password": PASSWORD}
    )

    assert response.status_code == 204
    attributes = _attributes(_set_cookie(response))
    assert attributes["__pair__"].startswith("__Host-session=")
    assert "secure" in attributes
    assert attributes["path"] == "/"
    assert "domain" not in attributes


async def test_password_whitespace_is_kept(client, db):
    await make_user(db, email="spaces@example.com", password_hash=hash_password(f"  {PASSWORD}  "))

    stripped = await client.post(
        "/api/auth/login", json={"email": "spaces@example.com", "password": PASSWORD}
    )
    exact = await client.post(
        "/api/auth/login", json={"email": "spaces@example.com", "password": f"  {PASSWORD}  "}
    )

    assert stripped.status_code == 401
    assert exact.status_code == 204


# Criterion 2: only the token's hash is stored, and it is never logged


async def test_db_stores_only_the_token_hash_and_logs_never_hold_the_token(client, db, caplog):
    await _user(db, email="hash@example.com")

    with caplog.at_level(logging.DEBUG):
        response = await client.post(
            "/api/auth/login", json={"email": "hash@example.com", "password": PASSWORD}
        )

    token = response.cookies["session"]
    [row] = await _sessions(db)
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    row_text = await db.scalar(text("SELECT string_agg(s::text, '') FROM sessions s"))
    assert token not in row_text
    assert all(token not in str(record.__dict__) for record in caplog.records)
    assert caplog.records  # something was logged, so the check above isn't vacuous


async def test_database_refuses_a_token_hash_that_isnt_sha256_hex(db):
    user = await make_user(db)

    async def insert_raw_token():
        db.add(
            AuthSession(
                user_id=user.id,
                token_hash="A" * 43,
                last_seen_at=func.now(),
                expires_at=func.now(),
                idle_expires_at=func.now(),
            )
        )
        await db.flush()

    await assert_integrity_error(
        db, insert_raw_token(), constraint="ck_sessions_token_hash_is_sha256_hex"
    )


# Criterion 3: every failure is the same 401


async def _failed_login(client, email: str, password: str = PASSWORD):
    return await client.post(
        "/api/auth/login",
        json={"email": email, "password": password},
        headers={"X-Request-ID": "login-probe"},
    )


async def test_every_credential_failure_is_the_same_401_and_writes_nothing(client, db, monkeypatch):
    await _user(db, email="right@example.com")
    await make_user(db, email="nopassword@example.com")  # password_hash NULL
    await make_user(db, email="corrupt@example.com", password_hash="not-a-hash-é")  # noqa: S106
    await _user(db, email="inactive@example.com", is_active=False)
    verified: list[str] = []
    real_verify = service.verify_password

    def spy(password: str, password_hash: str) -> bool:
        verified.append(password_hash)
        return real_verify(password, password_hash)

    monkeypatch.setattr(service, "verify_password", spy)

    responses = {
        "wrong password": await _failed_login(client, "right@example.com", PASSWORD + "x"),
        "unknown email": await _failed_login(client, "nobody@example.com"),
        "null hash": await _failed_login(client, "nopassword@example.com"),
        "unparsable hash": await _failed_login(client, "corrupt@example.com"),
        "inactive user": await _failed_login(client, "inactive@example.com"),
    }

    bodies = {name: r.content for name, r in responses.items()}
    assert all(r.status_code == 401 for r in responses.values()), bodies
    assert len(set(bodies.values())) == 1, bodies
    body = responses["unknown email"].json()
    assert (body["code"], body["status"]) == ("invalid_credentials", 401)
    assert all("set-cookie" not in r.headers for r in responses.values())
    assert await _sessions(db) == []
    # One verification per attempt; the paths with no usable hash spend it on DUMMY_HASH.
    assert len(verified) == 5
    assert verified[1:4] == [DUMMY_HASH, DUMMY_HASH, DUMMY_HASH]
    assert DUMMY_HASH not in (verified[0], verified[4])


# Criterion 4: logout


async def test_logout_revokes_the_session_and_deletes_the_cookie(client, db):
    await _user(db, email="out@example.com")
    login = await client.post(
        "/api/auth/login", json={"email": "out@example.com", "password": PASSWORD}
    )
    token = login.cookies["session"]

    response = await client.post("/api/auth/logout")

    assert response.status_code == 204
    attributes = _attributes(_set_cookie(response))
    assert attributes["__pair__"] in {"session=", 'session=""'}
    assert attributes["max-age"] == "0"
    assert attributes["path"] == "/"
    assert "httponly" in attributes
    assert attributes["samesite"].lower() == "lax"
    [row] = await _sessions(db)
    assert row.token_hash == hashlib.sha256(token.encode()).hexdigest()
    await db.refresh(row)
    assert row.revoked_at is not None


@pytest.mark.parametrize("cookie", [None, "not-a-real-token"])
async def test_logout_without_a_valid_session_is_still_204(client, cookie):
    if cookie is not None:
        client.cookies.set("session", cookie)

    first = await client.post("/api/auth/logout")
    second = await client.post("/api/auth/logout")

    assert (first.status_code, second.status_code) == (204, 204)


# Criterion 7: the idle window follows the roles


@pytest.mark.parametrize(
    ("roles", "status", "idle"),
    [
        ((Role.RESIDENT,), MembershipStatus.ACTIVE, timedelta(days=7)),
        ((Role.SECURITY,), MembershipStatus.ACTIVE, timedelta(hours=12)),
        ((Role.PROPERTY_MANAGEMENT,), MembershipStatus.ACTIVE, timedelta(hours=12)),
        ((Role.COUNCIL, Role.RESIDENT), MembershipStatus.ACTIVE, timedelta(hours=12)),
        ((Role.SECURITY,), MembershipStatus.PENDING, timedelta(days=7)),
        ((Role.SECURITY,), MembershipStatus.SUSPENDED, timedelta(days=7)),
    ],
)
async def test_idle_window_is_staff_length_only_for_an_active_staff_role(
    client, db, frozen_clock, roles, status, idle
):
    user = await _user(db, email="roles@example.com")
    await make_membership(user, await make_building(db), roles=roles, status=status)

    response = await client.post(
        "/api/auth/login", json={"email": "roles@example.com", "password": PASSWORD}
    )

    assert response.status_code == 204
    [row] = await _sessions(db)
    now = frozen_clock()
    assert (row.created_at, row.last_seen_at) == (now, now)
    assert row.expires_at == now + timedelta(days=30)
    assert row.idle_expires_at == now + idle


async def test_user_without_memberships_gets_the_resident_window(client, db, frozen_clock):
    await _user(db, email="nomember@example.com")

    await client.post(
        "/api/auth/login", json={"email": "nomember@example.com", "password": PASSWORD}
    )

    [row] = await _sessions(db)
    assert row.idle_expires_at == frozen_clock() + timedelta(days=7)


async def test_login_records_user_agent_truncated_and_client_ip(client, db):
    await _user(db, email="agent@example.com")

    await client.post(
        "/api/auth/login",
        json={"email": "agent@example.com", "password": PASSWORD},
        headers={"User-Agent": "x" * 400},
    )

    [row] = await _sessions(db)
    assert row.user_agent == "x" * 300
    assert str(row.ip) == "127.0.0.1"


# Criterion 8: malformed bodies


@pytest.mark.parametrize(
    "body",
    [
        {"email": "a@example.com"},
        {"password": PASSWORD},
        {"email": "a@example.com", "password": PASSWORD, "remember": True},
        {"email": "", "password": PASSWORD},
        {"email": "a@example.com", "password": ""},
        {"email": "a@example.com", "password": "p" * 129},
        {"email": "a" * 321, "password": PASSWORD},
    ],
    ids=[
        "no-password",
        "no-email",
        "extra-field",
        "empty-email",
        "empty-password",
        "long-password",
        "long-email",
    ],
)
async def test_malformed_login_body_is_422_and_verifies_nothing(client, monkeypatch, body):
    verified: list[str] = []
    monkeypatch.setattr(service, "verify_password", lambda p, h: verified.append(h) or False)

    response = await client.post("/api/auth/login", json=body)

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert verified == []


# Criterion 9: rehash on login


async def test_login_upgrades_a_hash_made_with_weaker_parameters(client, db):
    weak = PasswordHasher(time_cost=1, memory_cost=8 * 1024, parallelism=1).hash(PASSWORD)
    user = await make_user(db, email="weak@example.com", password_hash=weak)

    response = await client.post(
        "/api/auth/login", json={"email": "weak@example.com", "password": PASSWORD}
    )

    assert response.status_code == 204
    await db.refresh(user)
    assert user.password_hash != weak
    assert verify_password(PASSWORD, user.password_hash or "")
    assert not needs_rehash(user.password_hash or "")


async def test_login_keeps_a_current_hash(client, db):
    user = await _user(db, email="current@example.com")
    before = user.password_hash

    await client.post(
        "/api/auth/login", json={"email": "current@example.com", "password": PASSWORD}
    )

    await db.refresh(user)
    assert user.password_hash == before


# Criterion 10: the auth routes are behind the CSRF check


@pytest.mark.parametrize("path", ["/api/auth/login", "/api/auth/logout"])
async def test_auth_routes_need_the_csrf_header(client, db, path):
    await _user(db, email="csrf@example.com")
    login = await client.post(
        "/api/auth/login", json={"email": "csrf@example.com", "password": PASSWORD}
    )
    assert login.status_code == 204

    wrong = await client.post(
        path,
        json={"email": "csrf@example.com", "password": PASSWORD},
        headers={"X-Requested-With": "XMLHttpRequest"},
    )
    # Review round 2 L5: missing, not only wrong.
    request = client.build_request(
        "POST", path, json={"email": "csrf@example.com", "password": PASSWORD}
    )
    del request.headers["x-requested-with"]
    missing = await client.send(request)

    assert missing.status_code == 403
    assert missing.json()["code"] == "csrf_failed"
    response = wrong
    assert response.status_code == 403
    assert response.json()["code"] == "csrf_failed"
    [row] = await _sessions(db)
    await db.refresh(row)
    assert row.revoked_at is None


# Review round 1 (Codex Medium): structurally parseable but unusable argon2 hashes cost a full
# verification too (each would fail fast inside libargon2).


def _unusable(kind: str) -> str:
    parts = DUMMY_HASH.split("$")
    if kind == "short_salt":
        parts[-2] = "YWJjZGVmZw"  # 7 bytes; libargon2 needs 8
    elif kind == "short_digest":
        parts[-1] = "YWJj"  # 3 bytes; libargon2 needs 4
    elif kind == "zero_time":
        parts[3] = parts[3].replace("t=3", "t=0")
    elif kind == "zero_lanes":
        parts[3] = parts[3].replace("p=4", "p=0")
    elif kind == "tiny_memory":
        parts[3] = parts[3].replace("m=65536", "m=31")  # under 8 x 4 lanes
    elif kind == "bad_version":
        parts[2] = "v=99"
    return "$".join(parts)


@pytest.mark.parametrize(
    "kind",
    ["short_salt", "short_digest", "zero_time", "zero_lanes", "tiny_memory", "bad_version"],
)
async def test_unusable_argon2_hash_is_verified_as_dummy(client, db, monkeypatch, kind):
    await make_user(db, email="broken@example.com", password_hash=_unusable(kind))
    verified: list[str] = []
    real_verify = service.verify_password
    monkeypatch.setattr(
        service, "verify_password", lambda p, h: verified.append(h) or real_verify(p, h)
    )

    response = await client.post(
        "/api/auth/login", json={"email": "broken@example.com", "password": PASSWORD}
    )

    assert response.status_code == 401
    assert verified == [DUMMY_HASH]


# Review round 1 (Codex Low, Claude Medium 1): Postgres can't store or compare NUL characters.


@pytest.mark.parametrize("email", ["a\x00b@example.com", "\x00", "a@example.com\x00"])
async def test_email_with_a_nul_character_is_422_not_500(app_client, monkeypatch, email):
    verified: list[str] = []
    monkeypatch.setattr(service, "verify_password", lambda p, h: verified.append(h) or False)
    async with app_client(raise_app_exceptions=False) as c:
        response = await c.post("/api/auth/login", json={"email": email, "password": PASSWORD})

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert verified == []


async def test_password_with_a_nul_character_is_an_ordinary_failure(client, db):
    await _user(db, email="nulpw@example.com")

    response = await client.post(
        "/api/auth/login", json={"email": "nulpw@example.com", "password": PASSWORD + "\x00"}
    )

    assert response.status_code == 401


# Review round 1 (Claude, AC4 gaps)


async def test_logging_out_twice_with_the_same_cookie_keeps_the_first_revocation(
    client, db, frozen_clock
):
    await _user(db, email="twice@example.com")
    login = await client.post(
        "/api/auth/login", json={"email": "twice@example.com", "password": PASSWORD}
    )
    token = login.cookies["session"]

    first = await client.post("/api/auth/logout")
    revoked_at = frozen_clock()
    frozen_clock.advance(minutes=10)
    client.cookies.set("session", token)
    second = await client.post("/api/auth/logout")

    assert (first.status_code, second.status_code) == (204, 204)
    [row] = await _sessions(db)
    await db.refresh(row)
    assert row.revoked_at == revoked_at


async def test_logout_deletes_a_secure_host_cookie_with_staging_settings(client, db, monkeypatch):
    monkeypatch.setattr(settings, "session_cookie_name", "__Host-session")
    monkeypatch.setattr(settings, "session_cookie_secure", True)
    await _user(db, email="stagingout@example.com")
    login = await client.post(
        "/api/auth/login", json={"email": "stagingout@example.com", "password": PASSWORD}
    )
    client.cookies.set("__Host-session", login.cookies["__Host-session"])

    response = await client.post("/api/auth/logout")

    attributes = _attributes(_set_cookie(response))
    assert attributes["__pair__"].startswith("__Host-session=")
    assert attributes["max-age"] == "0"
    assert "secure" in attributes
    assert attributes["path"] == "/"
    [row] = await _sessions(db)
    await db.refresh(row)
    assert row.revoked_at is not None


# Review round 2 (Codex Medium): parameters written in a non-canonical way, or past our bounds, are
# not a hash this app wrote; they cost a DUMMY_HASH verification too.


@pytest.mark.parametrize(
    ("old", "new"),
    [
        ("t=3", "t=03"),
        ("t=3", "t=+3"),
        ("t=3", "t=4294967296"),
        ("m=65536", "m=4294967296"),
        ("m=65536,t=3,p=4", "t=3,m=65536,p=4"),
        ("v=19", "v=019"),
    ],
)
async def test_non_canonical_or_out_of_bounds_parameters_verify_as_dummy(
    client, db, monkeypatch, old, new
):
    await make_user(db, email="odd@example.com", password_hash=DUMMY_HASH.replace(old, new, 1))
    verified: list[str] = []
    real_verify = service.verify_password
    monkeypatch.setattr(
        service, "verify_password", lambda p, h: verified.append(h) or real_verify(p, h)
    )

    response = await client.post(
        "/api/auth/login", json={"email": "odd@example.com", "password": PASSWORD}
    )

    assert response.status_code == 401
    assert verified == [DUMMY_HASH]


# Review round 2 (Codex Low): a NUL in the User-Agent must not break a valid login.


async def test_user_agent_with_nul_is_stored_without_it(app_client, db):
    await _user(db, email="nulua@example.com")
    async with app_client(raise_app_exceptions=False) as c:
        response = await c.post(
            "/api/auth/login",
            json={"email": "nulua@example.com", "password": PASSWORD},
            headers={"User-Agent": "agent\x00tail"},
        )

    assert response.status_code == 204
    [row] = await _sessions(db)
    assert row.user_agent == "agenttail"


# Review round 2 (Claude M1): the DB connection is not held while argon2 runs, so a burst of
# logins can't hold the whole pool.


async def test_login_holds_no_transaction_while_verifying(client, db, db_connection, monkeypatch):
    await _user(db, email="pool@example.com")
    # The test's own savepoint; a request still inside its transaction would show its own.
    before = db_connection.sync_connection.get_nested_transaction()
    during: list[object] = []
    real_verify = service.verify_password

    def spy(password: str, password_hash: str) -> bool:
        during.append(db_connection.sync_connection.get_nested_transaction())
        return real_verify(password, password_hash)

    monkeypatch.setattr(service, "verify_password", spy)

    ok = await client.post(
        "/api/auth/login", json={"email": "pool@example.com", "password": PASSWORD}
    )
    bad = await client.post(
        "/api/auth/login", json={"email": "pool@example.com", "password": "x" * 12}
    )

    assert (ok.status_code, bad.status_code) == (204, 401)
    assert during == [before, before]


# Review round 2 (round 1's Claude L2, closed here): the rehash only replaces the hash it read.


async def test_rehash_does_not_overwrite_a_password_changed_meanwhile(client, db, monkeypatch):
    weak = PasswordHasher(time_cost=1, memory_cost=8 * 1024, parallelism=1).hash(PASSWORD)
    await make_user(db, email="race@example.com", password_hash=weak)
    changed = hash_password("changed-meanwhile-2026")
    real_run_sync = service.to_thread.run_sync

    async def run_sync(func, *args):
        if func is service.hash_password:
            # A password reset lands while login computes the upgraded hash.
            await db.execute(
                text("UPDATE users SET password_hash = :h WHERE email = 'race@example.com'"),
                {"h": changed},
            )
        return await real_run_sync(func, *args)

    monkeypatch.setattr(service.to_thread, "run_sync", run_sync)

    response = await client.post(
        "/api/auth/login", json={"email": "race@example.com", "password": PASSWORD}
    )

    assert response.status_code == 204
    stored = await db.scalar(
        text("SELECT password_hash FROM users WHERE email = 'race@example.com'")
    )
    assert stored == changed
