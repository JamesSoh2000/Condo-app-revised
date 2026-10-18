"""`queue_email`, the only way the app sends email (P3-02, ADR-0006): the worker's `email.send`
handler (`app.email.handler`) does the sending."""

import json
from collections.abc import Sequence
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import is_email_address
from app.email.templates import DEFAULT_LOCALE, render_email
from app.jobs.service import enqueue


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
    if not is_email_address(to):
        raise ValueError("`to` must be one email address")
    if not isinstance(context, dict) or not all(isinstance(key, str) for key in context):
        raise ValueError("`context` must be a dict with string keys")
    try:
        json.dumps(context)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"`context` must be JSON-serializable: {exc}") from None
    # Rendered now as well as when sent: a missing template or variable fails here, in the
    # caller, instead of as a dead job.
    render_email(template, context, locale)
    payload = {"to": to, "template": template, "locale": locale, "context": context}
    return await enqueue(db, "email.send", payload, dedupe_key=dedupe_key)


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
