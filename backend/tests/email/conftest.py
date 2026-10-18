"""Fixtures for the email tests (P3-02): a fake SMTP server on a real socket, and the settings the
`email.send` handler reads, pointed at it.

The server speaks just enough SMTP for `aiosmtplib.send` (EHLO, MAIL, RCPT, DATA, RSET, QUIT, no
STARTTLS). `replies` overrides the answer to a command, so a test can make RCPT answer 550 or DATA
451 and see the real `aiosmtplib` exception reach the handler.
"""

import asyncio
import socket
from collections.abc import AsyncIterator, Iterator
from dataclasses import dataclass, field
from email import message_from_bytes, policy
from email.message import EmailMessage

import pytest

from app.core.config import settings
from app.jobs import registry
from tests.jobs.conftest import sessions  # noqa: F401 (the worker's savepoint sessions)


@dataclass
class FakeSMTP:
    port: int
    # Command (`MAIL`, `RCPT`, `DATA` for the end of data) → the full reply line.
    replies: dict[str, str] = field(default_factory=dict)
    messages: list[EmailMessage] = field(default_factory=list)
    envelopes: list[tuple[str, list[str]]] = field(default_factory=list)


async def _serve(
    server: FakeSMTP, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
) -> None:
    def reply(line: str) -> None:
        writer.write(line.encode() + b"\r\n")

    sender = ""
    recipients: list[str] = []
    reply("220 fake ESMTP")
    await writer.drain()
    while line := await reader.readline():
        command = line.decode().strip()
        verb = command.split(" ", 1)[0].split(":", 1)[0].upper()
        if verb in {"EHLO", "HELO"}:
            reply("250-fake\r\n250 8BITMIME")
        elif verb == "MAIL":
            sender = command.split(":", 1)[1].split()[0]
            reply(server.replies.get("MAIL", "250 OK"))
        elif verb == "RCPT":
            recipients.append(command.split(":", 1)[1].split()[0])
            reply(server.replies.get("RCPT", "250 OK"))
        elif verb == "DATA":
            reply("354 end with <CRLF>.<CRLF>")
            await writer.drain()
            data = b""
            while not data.endswith(b"\r\n.\r\n"):
                chunk = await reader.readline()
                if not chunk:
                    return
                data += chunk
            answer = server.replies.get("DATA", "250 queued")
            if answer.startswith("250"):
                body = data[: -len(b".\r\n")].replace(b"\r\n..", b"\r\n.")
                parsed = message_from_bytes(body, policy=policy.default)
                assert isinstance(parsed, EmailMessage)
                server.messages.append(parsed)
                server.envelopes.append((sender, recipients))
            recipients = []
            reply(answer)
        elif verb == "RSET":
            recipients = []
            reply("250 OK")
        elif verb == "QUIT":
            reply("221 bye")
            await writer.drain()
            break
        else:
            reply("502 not implemented")
        await writer.drain()
    writer.close()


@pytest.fixture
async def smtp(monkeypatch: pytest.MonkeyPatch) -> AsyncIterator[FakeSMTP]:
    """A running fake SMTP server; the handler's settings point at it, with no allowlist."""
    fake = FakeSMTP(port=0)
    server = await asyncio.start_server(lambda r, w: _serve(fake, r, w), host="127.0.0.1", port=0)
    fake.port = server.sockets[0].getsockname()[1]
    point_settings_at(monkeypatch, fake.port)
    try:
        yield fake
    finally:
        server.close()
        await server.wait_closed()


def point_settings_at(monkeypatch: pytest.MonkeyPatch, port: int) -> None:
    monkeypatch.setattr(settings, "smtp_host", "127.0.0.1")
    monkeypatch.setattr(settings, "smtp_port", port)
    monkeypatch.setattr(settings, "smtp_starttls", False)
    monkeypatch.setattr(settings, "smtp_username", None)
    monkeypatch.setattr(settings, "smtp_password", None)
    monkeypatch.setattr(settings, "email_from", "Maple Tower <no-reply@maple.example.test>")
    monkeypatch.setattr(settings, "app_base_url", "http://localhost:5173")
    monkeypatch.setattr(settings, "email_recipient_allowlist", ())


@pytest.fixture
def closed_port() -> int:
    """A local port nothing listens on: connecting to it is refused, like a stopped Mailpit."""
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0))
        port: int = probe.getsockname()[1]
    return port


@pytest.fixture
def email_handler(monkeypatch: pytest.MonkeyPatch) -> Iterator[registry.HandlerSpec]:
    """The registered `email.send` handler (importing the module registers it)."""
    import app.email.handler  # noqa: F401

    yield registry.HANDLERS["email.send"]
