"""`queue_email`, the only way the app sends email (P3-02, ADR-0006): the worker's `email.send`
handler (`app.email.handler`) does the sending."""

import json
from collections.abc import Sequence
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import is_email_address
from app.email.templates import DEFAULT_LOCALE, render_email
from app.jobs.service import enqueue, enqueue_many

# `jobs.dedupe_key` is String(200).
MAX_DEDUPE_KEY = 200


@dataclass(frozen=True)
class EmailRecipient:
    """One recipient of `queue_emails`."""

    to: str
    locale: str = DEFAULT_LOCALE
    dedupe_key: str | None = None


async def queue_email(
    db: AsyncSession,
    *,
    to: str,
    template: str,
    context: dict[str, Any],
    locale: str = DEFAULT_LOCALE,
    dedupe_key: str | None = None,
) -> UUID | None:
    """Enqueue an `email.send` job in `db`'s transaction; return its id, or None if `dedupe_key`
    exists. Never commits.

    Raises `ValueError` and enqueues nothing unless `to` is one address, `context` is a JSON object
    and the template renders with it in `locale`. Put every link or token in `context`: it is the
    payload key the worker scrubs (`sensitive_keys`).
    """
    _check_recipient(to, dedupe_key)
    _check_context(template, context, [locale])
    return await enqueue(
        db, "email.send", _payload(to, template, locale, context), dedupe_key=dedupe_key
    )


async def queue_emails(
    db: AsyncSession,
    *,
    template: str,
    context: dict[str, Any],
    recipients: Sequence[EmailRecipient],
) -> int:
    """`queue_email` of one template and context to each recipient, in one INSERT (P6-01c, the
    fan-out); return how many jobs were added (a dedupe key that exists adds none). Never commits.

    Checks every recipient before any SQL, as `queue_email` does: one bad one raises `ValueError`
    and queues nothing. Rows go in `recipients`' order (`enqueue_many`). The template is rendered
    once per locale, not per recipient.
    """
    for recipient in recipients:
        _check_recipient(recipient.to, recipient.dedupe_key)
    _check_context(template, context, sorted({r.locale for r in recipients}))
    jobs = [(_payload(r.to, template, r.locale, context), r.dedupe_key) for r in recipients]
    return await enqueue_many(db, "email.send", jobs)


def _payload(to: str, template: str, locale: str, context: dict[str, Any]) -> dict[str, Any]:
    return {"to": to, "template": template, "locale": locale, "context": context}


def _check_recipient(to: str, dedupe_key: str | None) -> None:
    if not is_email_address(to):
        raise ValueError("`to` must be one email address")
    if dedupe_key is not None and not _is_storable_key(dedupe_key):
        raise ValueError(
            f"`dedupe_key` must be at most {MAX_DEDUPE_KEY} characters of UTF-8, no NUL"
        )


def _check_context(template: str, context: dict[str, Any], locales: Sequence[str]) -> None:
    if not isinstance(context, dict) or not all(isinstance(key, str) for key in context):
        raise ValueError("`context` must be a dict with string keys")
    # What the jobs table would refuse must fail here, not abort the caller's transaction with a
    # database error (review round 1): NaN and infinities, NUL, lone surrogates, a long key.
    try:
        json.dumps(context, allow_nan=False, ensure_ascii=False).encode()
    except (TypeError, ValueError) as exc:
        raise ValueError(f"`context` must be JSON that Postgres can store: {exc}") from None
    if _has_nul(context):
        raise ValueError("`context` must not contain NUL characters")
    # Rendered now as well as when sent: a missing template or variable fails here, in the
    # caller, instead of as a dead job.
    for locale in locales:
        render_email(template, context, locale)


def _is_storable_key(key: str) -> bool:
    try:
        key.encode()
    except UnicodeEncodeError:
        return False
    return len(key) <= MAX_DEDUPE_KEY and "\x00" not in key


def _has_nul(value: Any) -> bool:
    if isinstance(value, str):
        return "\x00" in value
    if isinstance(value, dict):
        return any(_has_nul(k) or _has_nul(v) for k, v in value.items())
    if isinstance(value, list | tuple):
        return any(_has_nul(item) for item in value)
    return False


def is_allowlisted(address: str, allowlist: Sequence[str]) -> bool:
    """Whether `address` may get mail: the allowlist is empty, or one entry is the address or
    `@` + its domain exactly (any case; a subdomain doesn't match)."""
    if not allowlist:
        return True
    address = address.lower()
    domain = address.rpartition("@")[2]
    return any(
        entry[1:] == domain if entry.startswith("@") else entry == address for entry in allowlist
    )
