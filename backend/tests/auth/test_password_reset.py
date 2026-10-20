"""POST /api/auth/password-reset/request and /confirm (P4-04 criteria 1-7 and 9-12; the races of
criterion 8 are in test_password_reset_concurrency.py)."""

import json
import logging
import re
from datetime import timedelta
from typing import Any

import pytest
from httpx import AsyncClient, Headers, Response
from sqlalchemy import select, text, update
from sqlalchemy.exc import OperationalError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.auth import service
from app.auth.models import AuthSession, PasswordResetToken
from app.core import clock
from app.core.security import hash_password, hash_token, verify_password
from app.email import service as email_service
from app.jobs.models import Job, JobStatus
from app.jobs.worker import Worker
from app.logging_config import JsonFormatter
from app.users.models import User
from tests.conftest import FrozenClock
from tests.email.conftest import FakeSMTP, point_settings_at
from tests.factories import make_user
from tests.helpers.auth import login_as
from tests.helpers.tenancy import assert_problem, without_request_id
from tests.jobs.conftest import Sessions

pytestmark = pytest.mark.anyio

REQUEST = "/api/auth/password-reset/request"
CONFIRM = "/api/auth/password-reset/confirm"
OLD_PASSWORD = "the-old-password-2026"  # noqa: S105 (test value)
NEW_PASSWORD = "a-brand-new-password-2026"  # noqa: S105 (test value)
EMAIL = "forgetful@example.test"
GENERIC = {"detail": "If an account exists for this email, we sent a link to reset its password."}
PATH = re.compile(r"/reset-password/([A-Za-z0-9_-]{43})")
_CSRF = {"origin", "x-requested-with", "sec-fetch-site"}
LINK = re.compile(r"http://localhost:5173/reset-password/([A-Za-z0-9_-]{43})\b")


@pytest.fixture(autouse=True)
def _email_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    point_settings_at(monkeypatch, 1025)


async def _user(db: AsyncSession, email: str = EMAIL, **overrides: Any) -> User:
    return await make_user(db, email=email, password_hash=hash_password(OLD_PASSWORD), **overrides)


async def _email_jobs(db: AsyncSession) -> list[Job]:
    return list(
        await db.scalars(
            select(Job)
            .where(Job.kind == "email.send")
            .order_by(Job.id)
            .execution_options(populate_existing=True)
        )
    )


async def _tokens(db: AsyncSession) -> list[PasswordResetToken]:
    return list(
        await db.scalars(
            select(PasswordResetToken)
            .order_by(PasswordResetToken.id)
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


async def _request_token(client: AsyncClient, db: AsyncSession, email: str = EMAIL) -> str:
    r = await client.post(REQUEST, json={"email": email})
    assert r.status_code == 202, r.text
    return _token_of((await _email_jobs(db))[-1])


async def _password_hash(db: AsyncSession, user: User) -> str | None:
    return await db.scalar(
        select(User.password_hash)
        .where(User.id == user.id)
        .execution_options(populate_existing=True)
    )


def _headers(r: Response) -> dict[str, str]:
    return {k: v for k, v in r.headers.items() if k.lower() != "x-request-id"}


async def _login(client: AsyncClient, email: str, password: str) -> int:
    r = await client.post("/api/auth/login", json={"email": email, "password": password})
    client.cookies.clear()
    return r.status_code


# Criterion 1 (and 7: the inactive user's answer is the same)


async def test_request_answers_identically_whether_or_not_the_account_exists(
    client: AsyncClient, db: AsyncSession
):
    await _user(db)
    await _user(db, email="gone@example.test", is_active=False)

    responses = [
        await client.post(REQUEST, json={"email": email})
        for email in (
            EMAIL,
            "nobody@example.test",
            "Forgetful@Example.TEST",
            "not-an-email",
            "gone@example.test",
        )
    ]

    first = responses[0]
    assert first.status_code == 202
    assert first.json() == GENERIC
    for r in responses:
        assert r.status_code == 202
        assert r.content == first.content
        assert _headers(r) == _headers(first)
    # Only the known active account's two requests (any case) queued email, to the stored address.
    jobs = await _email_jobs(db)
    assert [(job.payload["to"], job.payload["template"]) for job in jobs] == [
        (EMAIL, "password_reset"),
        (EMAIL, "password_reset"),
    ]


async def test_request_audits_with_the_user_id_only_when_an_account_matched(
    client: AsyncClient, db: AsyncSession
):
    user = await _user(db)

    for email in (EMAIL, "nobody@example.test"):
        assert (await client.post(REQUEST, json={"email": email})).status_code == 202

    known, unknown = await _audit(db, "auth.password_reset_requested")
    assert known.metadata_ == {"user_id": str(user.id)}
    assert known.actor_user_id is None
    assert unknown.metadata_ == {}
    assert unknown.actor_user_id is None and unknown.entity_id is None


# Criterion 2


@pytest.mark.usefixtures("email_handler")
async def test_only_the_hash_is_stored_and_the_sent_job_drops_the_link(
    client: AsyncClient, db: AsyncSession, sessions: Sessions, smtp: FakeSMTP
):
    user = await _user(db)

    r = await client.post(REQUEST, json={"email": EMAIL})

    (job,) = await _email_jobs(db)
    token = _token_of(job)
    (row,) = await _tokens(db)
    assert row.user_id == user.id
    assert row.token_hash == hash_token(token)
    assert token not in str({c.key: getattr(row, c.key) for c in PasswordResetToken.__table__.c})
    assert token not in r.text
    (event,) = await _audit(db, "auth.password_reset_requested")
    assert token not in str(event.metadata_)

    assert await Worker(sessions, jitter=lambda: 1.0, recurring=()).run_once() == 1

    (message,) = smtp.messages
    assert message["To"] == EMAIL
    assert message["Subject"] == "Reset your password"
    parts = {part.get_content_type(): part.get_content() for part in message.iter_parts()}
    assert LINK.findall(parts["text/plain"]) == [token]
    assert set(LINK.findall(parts["text/html"])) == {token}
    (sent,) = await _email_jobs(db)
    assert sent.status is JobStatus.SUCCEEDED
    assert "context" not in sent.payload
    assert token not in json.dumps(sent.payload)


async def test_stored_token_hash_must_be_sha256_hex(db: AsyncSession):
    user = await _user(db)
    db.add(
        PasswordResetToken(
            user_id=user.id,
            token_hash="not-a-hash",  # noqa: S106 (not a secret)
            expires_at=clock.now(),
        )
    )
    with pytest.raises(Exception, match="ck_password_reset_tokens_token_hash_is_sha256_hex"):
        await db.flush()
    await db.rollback()


async def test_token_expires_one_hour_after_the_request(
    client: AsyncClient, db: AsyncSession, frozen_clock: FrozenClock
):
    await _user(db)

    await _request_token(client, db)

    (row,) = await _tokens(db)
    assert row.expires_at == frozen_clock() + timedelta(hours=1)
    assert row.used_at is None and row.revoked_at is None


# Criterion 3 (and 12: no session for the caller)


async def test_confirm_sets_the_password_and_revokes_every_session(
    client: AsyncClient, db: AsyncSession, as_user
):
    user = await _user(db)
    other = await _user(db, email="other@example.test")
    phone = await as_user(user)
    laptop = await as_user(user)
    bystander = await as_user(other)
    token = await _request_token(client, db)
    # The caller's own browser is logged in as the user too.
    await login_as(db, client, user)

    r = await client.post(CONFIRM, json={"token": token, "new_password": NEW_PASSWORD})

    assert r.status_code == 204, r.text
    assert r.content == b""
    assert "set-cookie" not in r.headers
    for c in (phone, laptop, client):
        assert_problem(await c.get("/api/auth/me"), 401, "not_authenticated")
    assert (await bystander.get("/api/auth/me")).status_code == 200
    stored = await _password_hash(db, user)
    assert stored is not None and verify_password(NEW_PASSWORD, stored)
    (row,) = await _tokens(db)
    assert row.used_at is not None
    live = await db.scalars(
        select(AuthSession.id).where(
            AuthSession.user_id == user.id, AuthSession.revoked_at.is_(None)
        )
    )
    assert live.all() == []
    (event,) = await _audit(db, "auth.password_reset_completed")
    assert event.entity_type == "user" and event.entity_id == user.id
    assert event.actor_user_id == user.id
    assert event.metadata_ == {"sessions_revoked": 3}
    assert token not in str(event.metadata_)

    assert await _login(client, EMAIL, OLD_PASSWORD) == 401
    assert await _login(client, EMAIL, NEW_PASSWORD) == 204


async def test_new_password_is_not_stripped(client: AsyncClient, db: AsyncSession):
    user = await _user(db)
    token = await _request_token(client, db)
    padded = f"  {NEW_PASSWORD}  "

    r = await client.post(CONFIRM, json={"token": token, "new_password": padded})

    assert r.status_code == 204, r.text
    stored = await _password_hash(db, user)
    assert stored is not None and verify_password(padded, stored)
    assert not verify_password(NEW_PASSWORD, stored)


# Criterion 4


async def _invalid(client: AsyncClient, token: str) -> dict[str, Any]:
    r = await client.post(CONFIRM, json={"token": token, "new_password": NEW_PASSWORD})
    body = assert_problem(r, 400, "reset_token_invalid")
    return without_request_id(body)


@pytest.mark.parametrize(
    "case", ["reused", "at-one-hour", "past-one-hour", "replaced", "unknown", "malformed", "empty"]
)
async def test_reused_expired_replaced_or_unknown_tokens_are_invalid(
    client: AsyncClient, db: AsyncSession, frozen_clock: FrozenClock, case: str
):
    user = await _user(db)
    token = await _request_token(client, db)
    if case == "reused":
        r = await client.post(CONFIRM, json={"token": token, "new_password": "first-new-pw-2026"})
        assert r.status_code == 204
    elif case == "at-one-hour":
        frozen_clock.advance(hours=1)
    elif case == "past-one-hour":
        frozen_clock.advance(hours=1, seconds=1)
    elif case == "replaced":
        newer = await _request_token(client, db)
        assert newer != token
    elif case == "unknown":
        token = "A" * 43
    elif case == "malformed":
        token = "../../" + token
    else:
        token = ""
    before = await _password_hash(db, user)

    body = await _invalid(client, token)

    assert body == {
        "type": "/problems/reset-token-invalid",
        "title": "Bad Request",
        "status": 400,
        "detail": "This password reset link is invalid or has expired. Ask for a new one.",
        "code": "reset_token_invalid",
    }
    assert await _password_hash(db, user) == before


async def test_newer_token_still_works_after_the_older_was_refused(
    client: AsyncClient, db: AsyncSession
):
    await _user(db)
    older = await _request_token(client, db)
    newer = await _request_token(client, db)
    await _invalid(client, older)

    r = await client.post(CONFIRM, json={"token": newer, "new_password": NEW_PASSWORD})

    assert r.status_code == 204
    first, second = await _tokens(db)
    assert first.revoked_at is not None and first.used_at is None
    assert second.used_at is not None and second.revoked_at is None


async def test_token_of_a_deactivated_user_is_invalid(client: AsyncClient, db: AsyncSession):
    user = await _user(db)
    token = await _request_token(client, db)
    await db.execute(update(User).where(User.id == user.id).values(is_active=False))
    before = await _password_hash(db, user)

    await _invalid(client, token)

    assert await _password_hash(db, user) == before
    (row,) = await _tokens(db)
    assert row.used_at is None


# Criterion 5


@pytest.mark.parametrize(
    ("password", "kind", "message"),
    [
        ("password123", "password_too_short", "must be at least 12 characters"),
        ("password1234", "password_too_common", "is too common"),
    ],
)
async def test_weak_password_is_422_and_the_token_stays_usable(
    client: AsyncClient, db: AsyncSession, password: str, kind: str, message: str
):
    user = await _user(db)
    token = await _request_token(client, db)
    before = await _password_hash(db, user)

    r = await client.post(CONFIRM, json={"token": token, "new_password": password})

    problem = assert_problem(r, 422, "validation_error")
    assert password not in r.text
    assert problem["errors"] == [{"loc": ["body", "new_password"], "msg": message, "type": kind}]
    assert await _password_hash(db, user) == before
    (row,) = await _tokens(db)
    assert row.used_at is None

    r = await client.post(CONFIRM, json={"token": token, "new_password": NEW_PASSWORD})
    assert r.status_code == 204, r.text


# Criterion 6 (and 10)


async def test_ninth_request_for_one_email_is_rate_limited(client: AsyncClient, db: AsyncSession):
    await _user(db)

    for email in (EMAIL, "nobody@example.test"):
        allowed = [await client.post(REQUEST, json={"email": email}) for _ in range(8)]
        assert {(r.status_code, r.content) for r in allowed} == {(202, allowed[0].content)}, email
        assert allowed[0].json() == GENERIC

        limited = await client.post(REQUEST, json={"email": email})

        assert_problem(limited, 429, "rate_limited")
        assert int(limited.headers["retry-after"]) > 0
    # The 9th known request was refused before the lookup: 8 emails, not 9.
    assert len(await _email_jobs(db)) == 8


async def test_requests_from_one_ip_are_rate_limited(client: AsyncClient, db: AsyncSession):
    for n in range(30):
        r = await client.post(REQUEST, json={"email": f"person{n}@example.test"})
        assert r.status_code == 202

    assert_problem(
        await client.post(REQUEST, json={"email": "person31@example.test"}), 429, "rate_limited"
    )


async def test_reset_counts_are_apart_from_login_counts(client: AsyncClient, db: AsyncSession):
    await _user(db)
    for _ in range(8):
        assert (await client.post(REQUEST, json={"email": EMAIL})).status_code == 202

    assert await _login(client, EMAIL, OLD_PASSWORD) == 204


async def test_confirm_is_rate_limited_per_ip(client: AsyncClient, db: AsyncSession):
    for _ in range(30):
        await _invalid(client, "A" * 43)

    r = await client.post(CONFIRM, json={"token": "A" * 43, "new_password": NEW_PASSWORD})

    assert_problem(r, 429, "rate_limited")


# Criterion 7


async def test_inactive_user_gets_the_same_202_and_no_email(client: AsyncClient, db: AsyncSession):
    await _user(db, is_active=False)

    r = await client.post(REQUEST, json={"email": EMAIL})

    assert r.status_code == 202
    assert r.json() == GENERIC
    assert await _email_jobs(db) == []
    assert await _tokens(db) == []


async def test_new_request_revokes_only_that_users_live_tokens(
    client: AsyncClient, db: AsyncSession
):
    await _user(db)
    await _user(db, email="other@example.test")
    mine = await _request_token(client, db)
    theirs = await _request_token(client, db, "other@example.test")

    await _request_token(client, db)

    r = await client.post(CONFIRM, json={"token": theirs, "new_password": NEW_PASSWORD})
    assert r.status_code == 204
    await _invalid(client, mine)


# Criterion 9: no second output path for the token


SECRET = "LeakCheck_" + "x" * 33


@pytest.mark.parametrize("fail_at", ["token-insert", "job-insert", "audit-insert", "commit"])
async def test_failed_request_leaks_no_token(
    app_client,
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    capsys: pytest.CaptureFixture[str],
    fail_at: str,
):
    await _user(db)
    monkeypatch.setattr(service, "generate_token", lambda: SECRET)
    tables = {
        "token-insert": "password_reset_tokens",
        "job-insert": "jobs",
        "audit-insert": "audit_events",
    }
    if fail_at in tables:
        await db.execute(
            text(
                "CREATE FUNCTION p4_04_fail() RETURNS trigger LANGUAGE plpgsql AS $$"
                " BEGIN RAISE EXCEPTION 'simulated failure'; END $$"
            )
        )
        await db.execute(
            text(
                f"CREATE TRIGGER p4_04_fail BEFORE INSERT ON {tables[fail_at]}"
                " FOR EACH ROW EXECUTE FUNCTION p4_04_fail()"
            )
        )
    else:
        queued: list[AsyncSession] = []
        real_queue = email_service.queue_email
        real_commit = AsyncSession.commit

        async def queue_and_mark(session: AsyncSession, **kwargs: Any) -> object:
            queued.append(session)
            return await real_queue(session, **kwargs)

        async def failing_commit(self: AsyncSession) -> None:
            if self in queued:
                raise OperationalError("COMMIT", {}, ConnectionResetError("connection lost"))
            await real_commit(self)

        monkeypatch.setattr(service, "queue_email", queue_and_mark)
        monkeypatch.setattr(AsyncSession, "commit", failing_commit)
    caplog.set_level(logging.DEBUG)

    async with app_client(raise_app_exceptions=False) as c:
        r = await c.post(REQUEST, json={"email": EMAIL})

    assert_problem(r, 500, "internal_error")
    formatter = JsonFormatter()
    logged = "\n".join(formatter.format(record) for record in caplog.records)
    assert "request_failed" in logged
    captured = capsys.readouterr()
    for output in (r.text, logged, captured.out, captured.err):
        assert SECRET not in output
        assert "/reset-password/" not in output


def test_app_engine_hides_sql_parameters():
    from app.core.database import engine

    assert engine.sync_engine.hide_parameters is True


# Criterion 11


@pytest.mark.parametrize(
    "body",
    [
        "{}",
        '{"email": null}',
        '{"email": 42}',
        '{"email": ""}',
        json.dumps({"email": "a" * 321}),
        '{"email": "nul\\u0000@example.test"}',
        # A lone surrogate: valid JSON, but no UTF-8 for Postgres (httpx can't encode a str one).
        '{"email": "lone\\ud800@example.test"}',
    ],
    ids=["missing", "null", "number", "empty", "too-long", "nul", "lone-surrogate"],
)
async def test_malformed_email_is_422_without_a_lookup(
    client: AsyncClient, db: AsyncSession, body: str
):
    r = await client.post(REQUEST, content=body, headers={"content-type": "application/json"})

    assert r.status_code == 422, r.text
    assert await _audit(db, "auth.password_reset_requested") == []


@pytest.mark.parametrize(
    "body",
    [
        json.dumps({"token": "A" * 43}),
        json.dumps({"new_password": NEW_PASSWORD}),
        json.dumps({"token": "A" * 43, "new_password": None}),
        json.dumps({"token": "A" * 201, "new_password": NEW_PASSWORD}),
        '{"token": "' + "A" * 43 + '", "new_password": "lone\\ud800-password-2026"}',
    ],
    ids=["no-password", "no-token", "null-password", "long-token", "lone-surrogate"],
)
async def test_malformed_confirm_is_422(client: AsyncClient, body: str):
    r = await client.post(CONFIRM, content=body, headers={"content-type": "application/json"})

    assert r.status_code == 422, r.text


async def test_reset_routes_need_no_session_and_still_need_csrf(client: AsyncClient):
    for path, body in (
        (REQUEST, {"email": EMAIL}),
        (CONFIRM, {"token": "A" * 43, "new_password": NEW_PASSWORD}),
    ):
        request = client.build_request("POST", path, json=body)
        request.headers = Headers(
            [(k, v) for k, v in request.headers.multi_items() if k.lower() not in _CSRF]
        )
        assert_problem(await client.send(request), 403, "csrf_failed")
