"""The `email.send` handler run by a real `Worker` against a fake SMTP server on a real socket
(P3-02 criteria 1 to 4, 8, 9, 14, and the skip log of 15)."""

import json
import logging
from typing import Any
from uuid import UUID

import pytest

from app.core.config import settings
from app.email.service import queue_email
from app.jobs.models import JobStatus
from app.jobs.registry import HandlerSpec
from app.jobs.worker import Worker
from app.logging_config import JsonFormatter
from tests.conftest import FrozenClock
from tests.email.conftest import FakeSMTP, point_settings_at
from tests.jobs.conftest import Sessions, load

pytestmark = [pytest.mark.anyio, pytest.mark.usefixtures("email_handler")]

SECRET_NAME = "Ann-s3cr3t-name"  # noqa: S105 (a context value, not a password)


async def queue(sessions: Sessions, to: str = "dev@example.test", **values: Any) -> UUID:
    arguments: dict[str, Any] = {"template": "test", "context": {"name": SECRET_NAME}} | values
    async with sessions() as db:
        job_id = await queue_email(db, to=to, **arguments)
        await db.commit()
    assert job_id is not None
    return job_id


def worker(sessions: Sessions) -> Worker:
    return Worker(sessions, jitter=lambda: 1.0, recurring=())


# Criterion 1


async def test_sends_multipart_text_and_html_with_from_header(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock
) -> None:
    job_id = await queue(sessions, context={"name": "Ann", "building_name": "Oak Court"})

    assert await worker(sessions).run_once() == 1

    assert (await load(sessions, job_id)).status is JobStatus.SUCCEEDED
    assert len(smtp.messages) == 1
    message = smtp.messages[0]
    assert message["From"] == "Maple Tower <no-reply@maple.example.test>"
    assert message["To"] == "dev@example.test"
    assert message["Subject"]
    assert message["Date"]
    assert message["Message-ID"].endswith("@maple.example.test>")
    assert message.get_content_type() == "multipart/alternative"
    parts = {part.get_content_type(): part.get_content() for part in message.iter_parts()}
    assert set(parts) == {"text/plain", "text/html"}
    assert "Hello Ann" in parts["text/plain"]
    assert "Hello Ann" in parts["text/html"]
    assert "Oak Court" in parts["text/html"]
    assert smtp.envelopes == [("<no-reply@maple.example.test>", ["<dev@example.test>"])]


# Criterion 9


async def test_success_scrubs_context_and_keeps_the_rest(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock
) -> None:
    job_id = await queue(sessions, locale="fr")

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.SUCCEEDED
    assert job.payload == {"to": "dev@example.test", "template": "test", "locale": "fr"}


# Criterion 2


async def test_connection_refused_is_retried_then_delivered(
    sessions: Sessions,
    smtp: FakeSMTP,
    closed_port: int,
    frozen_clock: FrozenClock,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(settings, "smtp_port", closed_port)
    job_id = await queue(sessions)
    before = frozen_clock.at

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.QUEUED
    assert job.attempts == 1
    assert job.run_at > before
    assert job.last_error is not None
    assert "context" in job.payload
    assert smtp.messages == []

    # Mailpit is back.
    monkeypatch.setattr(settings, "smtp_port", smtp.port)
    frozen_clock.advance(seconds=30)
    await worker(sessions).run_once()

    assert (await load(sessions, job_id)).status is JobStatus.SUCCEEDED
    assert len(smtp.messages) == 1


async def test_server_that_never_answers_times_out_and_is_retried(
    sessions: Sessions, frozen_clock: FrozenClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    import asyncio

    from app.email import handler

    async def silent(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        await reader.read()
        writer.close()

    server = await asyncio.start_server(silent, host="127.0.0.1", port=0)
    point_settings_at(monkeypatch, server.sockets[0].getsockname()[1])
    monkeypatch.setattr(handler, "SMTP_TIMEOUT", 0.2)
    try:
        job_id = await queue(sessions)
        await worker(sessions).run_once()
    finally:
        server.close()
        await server.wait_closed()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.QUEUED
    assert job.attempts == 1
    assert job.last_error is not None
    assert job.last_error.startswith("SMTPConnectTimeoutError")


# Criterion 3


@pytest.mark.parametrize(
    ("command", "reply"),
    [
        ("RCPT", "550 5.1.1 no such user"),
        ("MAIL", "553 5.1.8 sender rejected"),
        ("DATA", "554 5.6.0 message rejected"),
    ],
)
async def test_smtp_5xx_goes_dead_without_retry(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock, command: str, reply: str
) -> None:
    smtp.replies[command] = reply
    job_id = await queue(sessions)

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.DEAD
    assert job.attempts == 1
    assert job.last_error is not None
    assert job.last_error.startswith("PermanentJobError")
    assert reply.split(" ", 1)[0] in job.last_error


# Criterion 8


@pytest.mark.parametrize("command", ["RCPT", "DATA", "MAIL"])
async def test_smtp_4xx_is_retried_and_error_has_no_context(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock, command: str
) -> None:
    smtp.replies[command] = f"451 4.3.0 try again later {SECRET_NAME}"
    job_id = await queue(sessions)

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.QUEUED
    assert job.attempts == 1
    assert job.last_error is not None
    assert "451" in job.last_error
    assert SECRET_NAME not in job.last_error


# Review round 1: a reply that echoes the message, with quotes Python escapes in the exception's
# text, slipped past the exact-value redaction. The reply text is now never kept.
QUOTED_PRIVATE = 'For "O\'Reilly": https://app.example.org/reset?token=synthetic-reset-token-73'


@pytest.mark.parametrize(
    ("command", "reply", "status", "kept"),
    [
        ("DATA", "451 4.3.0 rejected content: {}", JobStatus.QUEUED, "SMTP 451 4.3.0"),
        ("RCPT", "450 4.2.1 busy: {}", JobStatus.QUEUED, "SMTP 450 4.2.1"),
        ("MAIL", "421 service closing: {}", JobStatus.QUEUED, "SMTP 421"),
        ("DATA", "554 5.6.0 rejected content: {}", JobStatus.DEAD, "SMTP 554 5.6.0"),
        ("RCPT", "550 5.1.1 unknown: {}", JobStatus.DEAD, "SMTP 550 5.1.1"),
    ],
)
async def test_smtp_reply_text_never_reaches_last_error(
    sessions: Sessions,
    smtp: FakeSMTP,
    frozen_clock: FrozenClock,
    command: str,
    reply: str,
    status: JobStatus,
    kept: str,
) -> None:
    smtp.replies[command] = reply.format(QUOTED_PRIVATE)
    job_id = await queue(sessions, context={"name": QUOTED_PRIVATE})

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is status
    assert job.last_error is not None
    assert "synthetic-reset-token-73" not in job.last_error
    assert "Reilly" not in job.last_error
    assert kept in job.last_error


async def test_last_attempt_4xx_goes_dead(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock
) -> None:
    smtp.replies["RCPT"] = "450 4.2.1 mailbox busy"
    job_id = await queue(sessions)
    w = worker(sessions)
    for _ in range(8):
        await w.run_once()
        frozen_clock.advance(hours=2)

    job = await load(sessions, job_id)
    assert job.status is JobStatus.DEAD
    assert job.attempts == 8


# Criterion 4 and the skip log of 15


async def test_non_allowlisted_recipient_is_skipped_and_succeeds(
    sessions: Sessions,
    smtp: FakeSMTP,
    frozen_clock: FrozenClock,
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
) -> None:
    monkeypatch.setattr(settings, "email_recipient_allowlist", ("@example.test",))
    job_id = await queue(sessions, to="someone@gmail.com")

    with caplog.at_level(logging.INFO, logger="app.email.handler"):
        await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.SUCCEEDED
    assert job.attempts == 1
    assert smtp.messages == []
    skips = [r for r in caplog.records if r.getMessage() == "email_skipped_not_allowlisted"]
    assert len(skips) == 1
    assert all("someone" not in str(value) for value in vars(skips[0]).values())
    # What is written out: the JSON formatter keeps only the fields it lists (review round 1).
    emitted = json.loads(JsonFormatter().format(skips[0]))
    assert emitted["job_id"] == str(job_id)
    assert emitted["recipient_domain"] == "gmail.com"
    assert "someone" not in json.dumps(emitted)


async def test_allowlisted_recipient_is_sent(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "email_recipient_allowlist", ("@example.test",))
    await queue(sessions, to="Dev@Example.Test")

    await worker(sessions).run_once()

    assert len(smtp.messages) == 1


async def test_sent_log_has_no_address_or_context(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock, caplog: pytest.LogCaptureFixture
) -> None:
    with caplog.at_level(logging.DEBUG):
        await queue(sessions, to="private.person@example.test")
        await worker(sessions).run_once()

    text = "\n".join(f"{r.getMessage()} {vars(r)}" for r in caplog.records)
    assert "email_sent" in text
    assert "private.person" not in text
    assert SECRET_NAME not in text
    sent = next(r for r in caplog.records if r.getMessage() == "email_sent")
    emitted = json.loads(JsonFormatter().format(sent))
    assert emitted["email_template"] == "test"
    assert emitted["job_id"]


# Criterion 14


async def test_missing_template_at_send_time_goes_dead(
    sessions: Sessions, smtp: FakeSMTP, frozen_clock: FrozenClock, tmp_path, monkeypatch
) -> None:
    from app.email import templates

    job_id = await queue(sessions)
    monkeypatch.setattr(templates, "TEMPLATES_DIR", tmp_path)

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is JobStatus.DEAD
    assert job.attempts == 1
    assert smtp.messages == []


async def test_credentials_and_starttls_reach_aiosmtplib(
    email_handler: HandlerSpec, monkeypatch: pytest.MonkeyPatch, frozen_clock: FrozenClock
) -> None:
    import aiosmtplib
    from pydantic import SecretStr

    from app.email import handler
    from app.jobs.registry import JobContext

    seen: dict[str, Any] = {}

    async def fake_send(message: Any, **options: Any) -> None:
        seen.update(options)

    point_settings_at(monkeypatch, 587)
    monkeypatch.setattr(settings, "smtp_host", "email-smtp.example.test")
    monkeypatch.setattr(settings, "smtp_username", "AKIAEXAMPLE")
    monkeypatch.setattr(settings, "smtp_password", SecretStr("smtp-pass"))
    monkeypatch.setattr(settings, "smtp_starttls", True)
    monkeypatch.setattr(aiosmtplib, "send", fake_send)
    payload = {"to": "dev@example.test", "template": "test", "locale": "en", "context": {}}
    ctx = JobContext(db=None, job_id=UUID(int=1), kind="email.send", attempt=1)  # type: ignore[arg-type]

    await email_handler.handler(payload, ctx)

    assert seen["hostname"] == "email-smtp.example.test"
    assert seen["port"] == 587
    assert seen["username"] == "AKIAEXAMPLE"
    assert seen["password"] == "smtp-pass"  # noqa: S105 (a fake)
    assert seen["start_tls"] is True
    assert seen["timeout"] == handler.SMTP_TIMEOUT
    assert handler.SMTP_TIMEOUT < 50


def test_email_send_scrubs_context(email_handler: HandlerSpec) -> None:
    assert email_handler.sensitive_keys == ("context",)


def test_worker_loads_the_email_handler() -> None:
    from app.jobs.worker import HANDLER_MODULES

    assert "app.email.handler" in HANDLER_MODULES
