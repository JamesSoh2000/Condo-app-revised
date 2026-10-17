"""Rate limiting (P2-05): the Postgres counter, the login policies and the client IP they use."""

import asyncio
import hashlib
from collections.abc import AsyncIterator
from datetime import UTC, datetime, timedelta

import pytest
from fastapi import APIRouter, Depends
from httpx import ASGITransport, AsyncClient
from sqlalchemy import delete, event, func, select
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession, async_sessionmaker
from uvicorn.middleware.proxy_headers import ProxyHeadersMiddleware

from app.auth import service as auth_service
from app.auth.models import AuthSession
from app.core.config import RatePolicy, Settings, settings
from app.core.dependencies import get_db_session
from app.core.security import hash_password
from app.main import app
from app.rate_limits.models import RateLimit
from app.rate_limits.service import (
    RateDecision,
    RateLimiter,
    delete_expired_rate_limits,
    get_rate_limiter,
    ip_key,
    window_start,
)
from app.users.models import User
from tests.conftest import CSRF_HEADERS, limiter_on
from tests.factories import make_user

pytestmark = pytest.mark.anyio

PASSWORD = "a-long-test-password-2026"  # noqa: S105 (test value)
FIFTEEN_MINUTES = timedelta(minutes=15)


async def _login(client: AsyncClient, email: str, password: str = PASSWORD):
    return await client.post("/api/auth/login", json={"email": email, "password": password})


async def _counts(db: AsyncSession) -> dict[str, int]:
    rows = await db.execute(select(RateLimit.key, RateLimit.count))
    return {key: count for key, count in rows.tuples()}


def _email_key(lowered: str) -> str:
    return "login:email:" + hashlib.sha256(lowered.encode()).hexdigest()


class _TrackingLimiter(RateLimiter):
    """Remembers its keys, so the test can delete the rows it really committed."""

    def __init__(self, sessions: async_sessionmaker[AsyncSession]) -> None:
        super().__init__(sessions)
        self.keys_seen: set[str] = set()

    async def hit(self, key: str, limit: int, window: timedelta) -> RateDecision:
        self.keys_seen.add(key)
        return await super().hit(key, limit, window)


@pytest.fixture
async def committing(engine: AsyncEngine) -> AsyncIterator[_TrackingLimiter]:
    """A limiter on connections of its own that really commit, as in production.

    Its rows outlive the test's transaction, so the fixture deletes every key it used afterwards.
    """
    limiter = _TrackingLimiter(async_sessionmaker(engine, expire_on_commit=False))
    try:
        yield limiter
    finally:
        async with engine.begin() as conn:
            await conn.execute(delete(RateLimit).where(RateLimit.key.in_(limiter.keys_seen)))


async def _committed_count(engine: AsyncEngine, key: str) -> int | None:
    """The count as a third connection sees it: only what was committed."""
    async with engine.connect() as conn:
        return await conn.scalar(select(func.sum(RateLimit.count)).where(RateLimit.key == key))


# Criterion 1: the email limit, even with the right password, and the same answer for any email


async def test_ninth_login_for_one_email_in_15_minutes_is_429_even_with_the_right_password(
    client, db, frozen_clock
):
    await make_user(db, email="victim@example.com", password_hash=hash_password(PASSWORD))
    for _ in range(8):
        assert (await _login(client, "victim@example.com", "wrong-password-x")).status_code == 401

    response = await _login(client, "victim@example.com")

    assert response.status_code == 429
    body = response.json()
    assert body["code"] == "rate_limited"
    assert int(response.headers["Retry-After"]) > 0
    assert body["retry_after"] == int(response.headers["Retry-After"])
    assert "set-cookie" not in response.headers
    assert list(await db.scalars(select(AuthSession))) == []


async def test_limited_login_answers_the_same_for_a_known_and_an_unknown_email(
    client, db, frozen_clock
):
    await make_user(db, email="known@example.com", password_hash=hash_password(PASSWORD))
    answers = {}
    for email in ("known@example.com", "unknown@example.com"):
        for _ in range(8):
            await _login(client, email, "wrong-password-x")
        response = await _login(client, email)
        body = response.json()
        answers[email] = (
            response.status_code,
            body["code"],
            body["retry_after"],
            response.headers["Retry-After"],
            sorted(set(body) - {"request_id"}),
        )

    assert answers["known@example.com"][0] == 429
    assert answers["known@example.com"] == answers["unknown@example.com"]


async def test_limited_login_runs_no_lookup_and_no_argon2(client, db, frozen_clock, monkeypatch):
    for _ in range(8):
        await _login(client, "someone@example.com", "wrong-password-x")
    verified: list[str] = []
    monkeypatch.setattr(auth_service, "verify_password", lambda *args: verified.append("x"))
    statements: list[str] = []

    def record(conn, cursor, statement, *args):
        statements.append(statement)

    sync_engine = (await db.connection()).engine.sync_engine
    event.listen(sync_engine, "before_cursor_execute", record)
    try:
        response = await _login(client, "someone@example.com")
    finally:
        event.remove(sync_engine, "before_cursor_execute", record)

    assert response.status_code == 429
    assert verified == []
    assert not [s for s in statements if "FROM users" in s]


# Criterion 2: the email limit is per email


async def test_another_email_from_the_same_ip_is_not_blocked_by_the_email_limit(
    client, db, frozen_clock
):
    await make_user(db, email="other@example.com", password_hash=hash_password(PASSWORD))
    for _ in range(9):
        await _login(client, "victim@example.com", "wrong-password-x")

    response = await _login(client, "other@example.com")

    assert response.status_code == 204


# Criterion 3: the counter commits on its own, whatever the request does


async def test_failed_login_counter_is_committed_on_the_limiters_own_connection(
    client, db, engine, committing
):
    app.dependency_overrides[get_rate_limiter] = lambda: committing

    response = await _login(client, "failed@example.com", "wrong-password-x")

    assert response.status_code == 401
    assert await _committed_count(engine, _email_key("failed@example.com")) == 1
    assert await _committed_count(engine, "login:ip:127.0.0.1") == 1


async def test_counter_survives_a_request_whose_own_transaction_rolls_back(
    app_client, db, engine, committing
):
    router = APIRouter(tags=["test"])

    @router.post("/limited-then-fails")
    async def limited_then_fails(
        session: AsyncSession = Depends(get_db_session),  # noqa: B008
    ) -> None:
        session.add(RateLimit(key="test:request-write", window_start=datetime.now(UTC), count=1))
        await session.flush()
        await committing.enforce("test:rollback", RatePolicy(limit=5, window_seconds=60))
        raise RuntimeError("the request fails after the limiter ran")

    async with app_client(router, raise_app_exceptions=False) as c:
        response = await c.post("/api/limited-then-fails")

    assert response.status_code == 500
    # The request's own write was rolled back, and the counter was not.
    assert "test:request-write" not in await _counts(db)
    assert await _committed_count(engine, "test:rollback") == 1


# Criterion 4: concurrent hits on separate connections


async def test_ten_concurrent_hits_on_one_key_count_exactly_ten(engine, committing):
    window = timedelta(minutes=10)

    decisions = await asyncio.gather(
        *(committing.hit("test:concurrent", 7, window) for _ in range(10))
    )

    assert await _committed_count(engine, "test:concurrent") == 10
    assert sorted(d.count for d in decisions) == list(range(1, 11))
    assert sum(d.allowed for d in decisions) == 7


# Criterion 5: fixed, epoch-aligned windows


def test_windows_are_aligned_to_their_length_since_the_epoch():
    at = datetime(2026, 1, 15, 12, 7, 30, tzinfo=UTC)

    assert window_start(at, FIFTEEN_MINUTES) == datetime(2026, 1, 15, 12, 0, tzinfo=UTC)
    assert window_start(at, timedelta(minutes=10)) == datetime(2026, 1, 15, 12, 0, tzinfo=UTC)
    assert window_start(at, timedelta(hours=1)) == datetime(2026, 1, 15, 12, 0, tzinfo=UTC)
    assert window_start(at, timedelta(seconds=7)) == datetime(2026, 1, 15, 12, 7, 25, tzinfo=UTC)


async def test_login_is_allowed_again_when_the_window_passes(client, db, frozen_clock):
    await make_user(db, email="victim@example.com", password_hash=hash_password(PASSWORD))
    for _ in range(8):
        await _login(client, "victim@example.com", "wrong-password-x")
    first = await _login(client, "victim@example.com")
    assert first.status_code == 429
    assert first.headers["Retry-After"] == "900"

    frozen_clock.advance(seconds=899)
    almost = await _login(client, "victim@example.com")
    assert almost.status_code == 429
    assert almost.headers["Retry-After"] == "1"

    frozen_clock.advance(seconds=1)
    assert (await _login(client, "victim@example.com")).status_code == 204


async def test_retry_after_rounds_up_to_whole_seconds(db_connection, frozen_clock):
    limiter = limiter_on(db_connection)
    frozen_clock.advance(seconds=10, microseconds=500_000)

    decision = await limiter.hit("test:round", 1, timedelta(minutes=1))

    assert decision.allowed
    assert decision.retry_after == 50


# Criterion 6: no raw email in the table, and one counter per account


async def test_no_key_holds_a_raw_email_address(client, db, frozen_clock):
    emails = ["Resident1@Example.TEST", "resident1@example.test", "another.person@example.org"]
    for email in emails:
        await _login(client, email, "wrong-password-x")

    keys = (await _counts(db)).keys()

    assert keys == {
        "login:ip:127.0.0.1",
        _email_key("resident1@example.test"),
        _email_key("another.person@example.org"),
    }
    for key in keys:
        assert "@" not in key
        assert "resident1" not in key.lower() and "another" not in key.lower()
    assert (await _counts(db))[_email_key("resident1@example.test")] == 2


async def test_email_key_uses_postgres_lower_so_unicode_spellings_share_a_counter(
    client, db, frozen_clock
):
    dotted = "İnfo@example.org"  # Python lowers İ to i + U+0307; Postgres (en_US.utf8) to i
    assert dotted.lower() != "info@example.org"
    lowered = await db.scalar(select(func.lower(dotted)))

    await _login(client, dotted, "wrong-password-x")
    await _login(client, "info@example.org", "wrong-password-x")

    assert lowered == "info@example.org"
    assert (await _counts(db))[_email_key("info@example.org")] == 2


# Criterion 7: X-Forwarded-For is trusted only from the proxy


async def _login_through_proxy(peer: str, forwarded_for: str) -> int:
    wrapped = ProxyHeadersMiddleware(app, trusted_hosts="10.213.208.10")
    async with AsyncClient(
        transport=ASGITransport(app=wrapped, client=(peer, 40000)),
        base_url="http://test",
        headers=CSRF_HEADERS,
    ) as c:
        response = await c.post(
            "/api/auth/login",
            json={"email": "xff@example.com", "password": "wrong-password-x"},
            headers={"X-Forwarded-For": forwarded_for},
        )
    return response.status_code


async def test_forged_x_forwarded_for_from_an_untrusted_peer_is_ignored(client, db, frozen_clock):
    assert await _login_through_proxy("203.0.113.7", "198.51.100.1") == 401

    keys = (await _counts(db)).keys()
    assert "login:ip:203.0.113.7" in keys
    assert "login:ip:198.51.100.1" not in keys


async def test_x_forwarded_for_from_the_trusted_proxy_names_the_client(client, db, frozen_clock):
    assert await _login_through_proxy("10.213.208.10", "198.51.100.1") == 401

    keys = (await _counts(db)).keys()
    assert "login:ip:198.51.100.1" in keys
    assert "login:ip:10.213.208.10" not in keys


# Criterion 8: the IP limit, which doesn't count against the email


async def test_thirty_first_login_from_one_ip_in_10_minutes_is_429(client, db, frozen_clock):
    for n in range(30):
        assert (await _login(client, f"user{n}@example.com", "wrong-x")).status_code == 401

    response = await _login(client, "user30@example.com", "wrong-x")

    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"
    counts = await _counts(db)
    assert counts["login:ip:127.0.0.1"] == 31
    assert _email_key("user30@example.com") not in counts


# Criterion 9: IP keys


@pytest.mark.parametrize(
    ("ip", "key"),
    [
        ("203.0.113.7", "login:ip:203.0.113.7"),
        ("2001:db8:1:2::1", "login:ip:2001:db8:1:2::/64"),
        ("2001:db8:1:2:ffff:ffff:ffff:ffff", "login:ip:2001:db8:1:2::/64"),
        ("::ffff:192.0.2.1", "login:ip:192.0.2.1"),
        (None, "login:ip:unknown"),
        ("not-an-ip", "login:ip:unknown"),
    ],
)
def test_ip_key_groups_ipv6_by_64_and_unmaps_ipv4(ip, key):
    assert ip_key("login", ip) == key


# Criterion 10: cleanup, and policies the cleanup can't outlive


async def test_cleanup_deletes_windows_older_than_a_day_and_never_commits(db, frozen_clock):
    now = frozen_clock.at
    db.add_all(
        [
            RateLimit(key="old", window_start=now - timedelta(days=1, seconds=1), count=3),
            RateLimit(key="day", window_start=now - timedelta(days=1), count=2),
            RateLimit(key="new", window_start=now - timedelta(hours=1), count=1),
        ]
    )
    await db.flush()
    commits: list[str] = []
    original_commit = db.commit

    async def no_commit() -> None:
        commits.append("commit")
        await original_commit()

    db.commit = no_commit  # type: ignore[method-assign]

    deleted = await delete_expired_rate_limits(db)

    assert deleted == 1
    assert commits == []
    assert set((await _counts(db)).keys()) == {"day", "new"}


@pytest.mark.parametrize(
    "policy",
    [
        {"limit": 0, "window_seconds": 60},
        {"limit": 5, "window_seconds": 0},
        {"limit": 5, "window_seconds": 86401},
    ],
)
def test_settings_refuse_a_policy_with_no_limit_or_a_window_over_a_day(policy):
    with pytest.raises(ValueError):
        Settings(_env_file=None, rate_limit_login_ip=policy)


# Criterion 11: the policies and their overrides


def test_default_policies():
    defaults = Settings(_env_file=None)

    assert defaults.rate_limit_login_ip == RatePolicy(limit=30, window_seconds=600)
    assert defaults.rate_limit_login_email == RatePolicy(limit=8, window_seconds=900)
    assert defaults.rate_limit_reset_ip == RatePolicy(limit=30, window_seconds=600)
    assert defaults.rate_limit_reset_email == RatePolicy(limit=8, window_seconds=900)
    assert defaults.rate_limit_signup_ip == RatePolicy(limit=10, window_seconds=3600)
    assert defaults.rate_limit_join_ip == RatePolicy(limit=20, window_seconds=600)
    assert defaults.rate_limit_login_email.window == FIFTEEN_MINUTES


def test_a_policy_is_overridden_by_a_json_environment_variable(monkeypatch):
    monkeypatch.setenv("RATE_LIMIT_LOGIN_EMAIL", '{"limit": 3, "window_seconds": 60}')

    assert Settings(_env_file=None).rate_limit_login_email == RatePolicy(limit=3, window_seconds=60)


async def test_login_uses_the_policy_in_settings_at_request_time(
    client, db, frozen_clock, monkeypatch
):
    monkeypatch.setattr(settings, "rate_limit_login_email", RatePolicy(limit=2, window_seconds=60))
    for _ in range(2):
        assert (await _login(client, "tuned@example.com", "wrong-x")).status_code == 401

    response = await _login(client, "tuned@example.com", "wrong-x")

    assert response.status_code == 429
    assert response.headers["Retry-After"] == "60"


# Criterion 12: documented


def test_login_documents_429_as_problem():
    responses = app.openapi()["paths"]["/api/auth/login"]["post"]["responses"]

    assert "429" in responses
    assert "application/problem+json" in responses["429"]["content"]


# Criterion 13, row 1: an ordinary login still works with the limiter on


async def test_login_succeeds_under_the_limits(client, db, frozen_clock):
    user: User = await make_user(
        db, email="fine@example.com", password_hash=hash_password(PASSWORD)
    )

    response = await _login(client, "fine@example.com")

    assert response.status_code == 204
    assert (await db.scalar(select(AuthSession.user_id))) == user.id
    assert (await _counts(db))[_email_key("fine@example.com")] == 1


def test_production_limiter_opens_sessions_of_its_own_not_the_requests():
    from app.core.database import AsyncSessionLocal

    assert get_rate_limiter()._sessions is AsyncSessionLocal
