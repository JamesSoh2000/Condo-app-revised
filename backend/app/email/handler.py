"""`email.send` (P3-02): render the queued email and send it over SMTP, in the worker only.

Delivery is at-least-once, like every job: a worker that dies after the SMTP server accepted the
message, before the job is marked `succeeded`, sends it again when the job is reclaimed.
"""

import logging
import re
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid, parseaddr
from typing import Any, NoReturn

import aiosmtplib

from app.core import clock
from app.core.config import settings
from app.email.service import is_allowlisted
from app.email.templates import EmailTemplateError, render_email
from app.jobs.registry import JobContext, PermanentJobError, job_handler

logger = logging.getLogger(__name__)

# Below the worker's 50 s handler timeout, so a hung server fails as an SMTP timeout (retried).
SMTP_TIMEOUT = 20.0
_ENHANCED_CODE = re.compile(r"[245]\.[0-9]{1,3}\.[0-9]{1,3}")


class SMTPTemporaryError(Exception):
    """A 4xx reply, retried by the worker. Like `PermanentJobError` here, it holds codes only."""


@job_handler("email.send", sensitive_keys=("context",))
async def send_email(payload: dict[str, Any], ctx: JobContext) -> None:
    to: str = payload["to"]
    if not is_allowlisted(to, settings.email_recipient_allowlist):
        # Succeeds: retrying can't change the answer, and a skip is not a failure (criterion 4).
        logger.info(
            "email_skipped_not_allowlisted",
            extra={"job_id": str(ctx.job_id), "recipient_domain": to.rpartition("@")[2].lower()},
        )
        return
    try:
        rendered = render_email(payload["template"], payload["context"], payload["locale"])
    except EmailTemplateError as exc:
        # The template changed or went away since `queue_email` rendered it: retrying won't help.
        raise PermanentJobError(str(exc)) from exc

    message = EmailMessage()
    message["From"] = settings.email_from
    message["To"] = to
    message["Subject"] = rendered.subject
    message["Date"] = format_datetime(clock.now())
    message["Message-ID"] = make_msgid(domain=parseaddr(settings.email_from)[1].rpartition("@")[2])
    message.set_content(rendered.text)
    message.add_alternative(rendered.html, subtype="html")

    password = settings.smtp_password
    try:
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username,
            password=password.get_secret_value() if password is not None else None,
            start_tls=settings.smtp_starttls,
            timeout=SMTP_TIMEOUT,
        )
    except aiosmtplib.SMTPRecipientsRefused as exc:
        # Our one recipient refused: as permanent as its reply code says.
        if not exc.recipients:
            raise SMTPTemporaryError("SMTP recipient refused, no reply code") from None
        _raise_for_reply(exc.recipients[0], all(_is_permanent(r.code) for r in exc.recipients))
    except aiosmtplib.SMTPResponseException as exc:
        _raise_for_reply(exc, _is_permanent(exc.code))
    # Connection and timeout errors propagate: the worker retries them with backoff.
    logger.info(
        "email_sent", extra={"job_id": str(ctx.job_id), "email_template": payload["template"]}
    )


def _is_permanent(code: int) -> bool:
    return 500 <= code <= 599


def _raise_for_reply(reply: aiosmtplib.SMTPResponseException, permanent: bool) -> NoReturn:
    """Raise with the reply's code and enhanced status code, never its text: a server may quote
    the message back (the context's links and tokens), and `last_error` keeps what is raised for
    7 days. Python escapes quotes in that text, so redacting exact values can miss them (review
    round 1). `from None`, so the reply isn't chained either."""
    enhanced = _ENHANCED_CODE.match(reply.message)
    text = f"SMTP {reply.code}" + (f" {enhanced[0]}" if enhanced else "") + " (reply withheld)"
    raise (PermanentJobError if permanent else SMTPTemporaryError)(text) from None
