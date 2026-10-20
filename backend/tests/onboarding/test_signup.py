"""`POST /api/auth/signup` (P4-05a criteria 1 and 3): a resident's own account, logged in at
once."""

import json
from collections.abc import AsyncIterator

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.auth.models import AuthSession
from app.core.config import Settings, settings
from app.core.security import verify_password
from app.main import app
from app.users.models import User
from tests.conftest import CSRF_HEADERS
from tests.factories import make_user
from tests.helpers.tenancy import assert_problem

pytestmark = pytest.mark.anyio

URL = "/api/auth/signup"
PASSWORD = "correct horse battery staple"  # noqa: S105 (a test password)


def _body(**overrides: object) -> dict[str, object]:
    return {"email": "Rosa@Example.test", "full_name": "Rosa Resident", "password": PASSWORD} | (
        overrides
    )


async def _counts(db: AsyncSession) -> tuple[int, int]:
    users = await db.scalar(select(func.count()).select_from(User))
    sessions = await db.scalar(select(func.count()).select_from(AuthSession))
    return users or 0, sessions or 0


@pytest.fixture
async def other_ip_client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app, client=("203.0.113.9", 4321))
    async with AsyncClient(
        transport=transport, base_url="http://test", headers=CSRF_HEADERS
    ) as other:
        yield other


async def test_signup_creates_a_logged_in_user(client: AsyncClient, db: AsyncSession) -> None:
    response = await client.post(URL, json=_body())

    assert response.status_code == 201, response.text
    body = response.json()
    assert body["email"] == "rosa@example.test"
    assert body["full_name"] == "Rosa Resident"
    assert settings.session_cookie_name in response.cookies
    user = await db.scalar(select(User).where(User.id == body["id"]))
    assert user is not None
    assert user.email == "rosa@example.test"
    assert user.email_verified_at is None
    assert user.is_active
    assert user.password_hash is not None and verify_password(PASSWORD, user.password_hash)
    me = await client.get("/api/auth/me")
    assert me.status_code == 200
    assert me.json()["user"]["id"] == body["id"]
    assert me.json()["memberships"] == []
    actions = set(
        await db.scalars(select(AuditEvent.action).where(AuditEvent.actor_user_id == user.id))
    )
    assert actions == {"auth.signed_up", "auth.logged_in"}


@pytest.mark.parametrize("email", ["rosa@example.test", "ROSA@EXAMPLE.TEST"])
async def test_signup_with_an_existing_email_in_any_case_is_409(
    client: AsyncClient, db: AsyncSession, email: str
) -> None:
    await make_user(db, email="rosa@example.test")
    before = await _counts(db)

    response = await client.post(URL, json=_body(email=email))

    assert_problem(response, 409, "email_in_use")
    assert settings.session_cookie_name not in response.cookies
    assert await _counts(db) == before


@pytest.mark.parametrize(
    ("password", "code"),
    [("tiny pw", "password_too_short"), ("password1234", "password_too_common")],
)
async def test_signup_refuses_a_weak_password(
    client: AsyncClient, db: AsyncSession, password: str, code: str
) -> None:
    before = await _counts(db)

    response = await client.post(URL, json=_body(password=password))

    body = assert_problem(response, 422, "validation_error")
    assert [(error["loc"], error["type"]) for error in body["errors"]] == [
        (["body", "password"], code)
    ]
    assert password not in response.text
    assert await _counts(db) == before


@pytest.mark.parametrize(
    "email",
    [
        "rösa@example.test",
        " rosa@example.test",
        "rosa@example.test ",
        "",
        "r" * 64 + "@" + "e" * 186 + ".test",
        "rosa@example.test, eve@example.test",
        "Rosa <rosa@example.test>",
        "rosa\x00@example.test",
        "rosa\ud800@example.test",
        "not-an-email",
    ],
)
async def test_signup_refuses_malformed_emails(
    client: AsyncClient, db: AsyncSession, email: str
) -> None:
    before = await _counts(db)

    # json.dumps escapes non-ASCII, so a lone surrogate reaches the API as `\ud800`.
    response = await client.post(
        URL, content=json.dumps(_body(email=email)), headers={"Content-Type": "application/json"}
    )

    assert response.status_code == 422, response.text
    assert await _counts(db) == before


@pytest.mark.parametrize("full_name", ["Rosa\x00", "Rosa\nResident", "", "   ", "r" * 201])
async def test_signup_refuses_a_bad_full_name(
    client: AsyncClient, db: AsyncSession, full_name: str
) -> None:
    before = await _counts(db)

    response = await client.post(URL, json=_body(full_name=full_name))

    assert response.status_code == 422, response.text
    assert await _counts(db) == before


async def test_signup_refuses_extra_fields(client: AsyncClient) -> None:
    response = await client.post(URL, json=_body(is_active=False))

    assert response.status_code == 422


async def test_signup_without_csrf_headers_is_refused(
    client: AsyncClient, db: AsyncSession
) -> None:
    before = await _counts(db)

    response = await client.post(URL, json=_body(), headers={"Origin": "https://evil.example"})

    assert response.status_code == 403
    assert await _counts(db) == before


async def test_the_11th_signup_from_one_ip_is_429(
    client: AsyncClient, db: AsyncSession, other_ip_client: AsyncClient
) -> None:
    limit = settings.rate_limit_signup_ip.limit
    for n in range(limit):
        response = await client.post(URL, json=_body(email=f"r{n}@example.test"))
        assert response.status_code == 201, response.text
    before = await _counts(db)

    limited = await client.post(URL, json=_body(email="late@example.test"))

    assert_problem(limited, 429, "rate_limited")
    assert int(limited.headers["Retry-After"]) >= 1
    assert await _counts(db) == before
    # Another IP has a counter of its own.
    other = await other_ip_client.post(URL, json=_body(email="other@example.test"))
    assert other.status_code == 201


async def test_a_taken_email_still_counts_against_the_limit(
    client: AsyncClient, db: AsyncSession
) -> None:
    await make_user(db, email="rosa@example.test")
    for _ in range(settings.rate_limit_signup_ip.limit):
        assert_problem(await client.post(URL, json=_body()), 409, "email_in_use")

    assert_problem(
        await client.post(URL, json=_body(email="new@example.test")), 429, "rate_limited"
    )


def test_signup_rate_policy_is_10_per_hour() -> None:
    default = Settings.model_fields["rate_limit_signup_ip"].default
    assert (default.limit, default.window_seconds) == (10, 3600)
