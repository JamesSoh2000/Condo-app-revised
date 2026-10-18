"""`email.send` (P3-02): render the queued email and send it over SMTP, in the worker only.

Delivery is at-least-once, like every job: a worker that dies after the SMTP server accepted the
message, before the job is marked `succeeded`, sends it again when the job is reclaimed.
"""

import logging
from email.message import EmailMessage
from email.utils import format_datetime, make_msgid, parseaddr
from typing import Any

import aiosmtplib

from app.core import clock
from app.core.config import settings
from app.email.service import is_allowlisted
from app.email.templates import EmailTemplateError, render_email
from app.jobs.registry import JobContext, PermanentJobError, job_handler

logger = logging.getLogger(__name__)

# Below the worker's 50 s handler timeout, so a hung server fails as an SMTP timeout (retried).
SMTP_TIMEOUT = 20.0


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
        if exc.recipients and all(_is_permanent(r.code) for r in exc.recipients):
            raise PermanentJobError(_describe(exc.recipients[0])) from exc
        raise
    except aiosmtplib.SMTPResponseException as exc:
        if _is_permanent(exc.code):
            raise PermanentJobError(_describe(exc)) from exc
        raise
    # Connection, timeout and 4xx errors propagate: the worker retries them with backoff.
    logger.info("email_sent", extra={"job_id": str(ctx.job_id), "template": payload["template"]})


def _is_permanent(code: int) -> bool:
    return 500 <= code <= 599


def _describe(exc: aiosmtplib.SMTPResponseException) -> str:
    return f"SMTP {exc.code}: {exc.message}"
