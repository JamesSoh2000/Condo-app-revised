"""Recording audit events, and finding them for the operator CLI (P2-04, ARCHITECTURE §12).

`record_audit` adds a row to the caller's session and never commits (CLAUDE.md rule 5): the event is
written by the use-case's own commit, or not at all.
"""

import json
import re
from dataclasses import dataclass
from datetime import datetime
from typing import Any, NamedTuple
from uuid import UUID

from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.models import Building
from app.core import clock
from app.logging_config import request_id_ctx
from app.users.models import User

# Matched anywhere in a key, in any case: `new_password`, `resetToken`, `Set-Cookie`.
_SECRET_KEY = re.compile(r"password|token|secret|cookie|authorization", re.IGNORECASE)
MAX_VALUE_BYTES = 1024
MAX_DEPTH = 32
_ACTION = re.compile(r"[a-z][a-z_]*\.[a-z][a-z_]*")
_ACTION_MAX = 64
_ENTITY_TYPE_MAX = 40


async def record_audit(
    db: AsyncSession,
    *,
    action: str,
    entity_type: str,
    entity_id: UUID | None = None,
    building_id: UUID | None = None,
    actor_user_id: UUID | None = None,
    metadata: dict[str, Any] | None = None,
) -> None:
    """Add an audit event to `db`'s transaction. Never commits.

    `metadata` holds IDs and field names only (CLAUDE.md rule 10): a key naming a secret, a value
    over 1 KiB as JSON, a value that isn't JSON (UUIDs become strings), nesting deeper than 32 or a
    NUL character raises `ValueError`, and nothing is added. `request_id` comes from the request's
    logging context; null outside one.
    """
    if not _ACTION.fullmatch(action) or len(action) > _ACTION_MAX:
        raise ValueError(f"audit action must be '<domain>.<past_verb>', got {action!r}")
    if not entity_type or len(entity_type) > _ENTITY_TYPE_MAX:
        raise ValueError(f"audit entity_type must be 1-{_ENTITY_TYPE_MAX} characters")
    clean = _sanitize(metadata or {})
    db.add(
        AuditEvent(
            building_id=building_id,
            actor_user_id=actor_user_id,
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            request_id=request_id_ctx.get(),
            metadata_=clean,
            created_at=clock.now(),
        )
    )


def _sanitize(metadata: object) -> dict[str, Any]:
    if not isinstance(metadata, dict):
        raise ValueError("audit metadata must be a dict")
    # Walked before json sees it: the depth limit also stops a self-referencing container, and
    # nothing below recurses deep enough to raise RecursionError (review rounds 1 and 2).
    _check_structure(metadata)
    for key, value in metadata.items():
        if len(_to_json(value).encode()) > MAX_VALUE_BYTES:
            raise ValueError(f"audit metadata value for {key!r} is over {MAX_VALUE_BYTES} bytes")
    # Round-tripped, so what is stored is exactly what was checked (UUIDs as strings).
    result: dict[str, Any] = json.loads(_to_json(metadata))
    return result


def _check_structure(metadata: dict[str, Any]) -> None:
    """Refuse a secret-looking key at any depth (`{"changes": {"password": …}}` too), nesting
    deeper than `MAX_DEPTH`, and NUL in any key or string, which Postgres JSONB can't store."""
    pending: list[tuple[object, int]] = [(metadata, 1)]
    while pending:
        value, depth = pending.pop()
        if depth > MAX_DEPTH:
            raise ValueError(f"audit metadata is nested deeper than {MAX_DEPTH}")
        if isinstance(value, dict):
            for key, inner in value.items():
                if not isinstance(key, str) or _SECRET_KEY.search(key) or "\x00" in key:
                    raise ValueError(f"audit metadata key {key!r} is not allowed")
                pending.append((inner, depth + 1))
        elif isinstance(value, list | tuple):
            pending.extend((inner, depth + 1) for inner in value)
        elif isinstance(value, str) and "\x00" in value:
            raise ValueError("audit metadata strings must not contain NUL")


def _to_json(value: object) -> str:
    try:
        return json.dumps(value, default=_encode, ensure_ascii=False, allow_nan=False)
    except (TypeError, ValueError) as exc:
        raise ValueError(f"audit metadata is not JSON: {exc}") from None


def _encode(value: object) -> str:
    if isinstance(value, UUID):
        return str(value)
    raise TypeError(f"{type(value).__name__} is not allowed")


class UnknownFilterValue(ValueError):
    """A filter names a building or user that doesn't exist."""


@dataclass(frozen=True)
class AuditQuery:
    building_slug: str | None = None
    actor_email: str | None = None
    entity_type: str | None = None
    entity_id: UUID | None = None
    action_prefix: str | None = None
    since: datetime | None = None
    limit: int = 200


class AuditEventRow(NamedTuple):
    id: UUID
    created_at: datetime
    action: str
    building_id: UUID | None
    building_slug: str | None
    actor_user_id: UUID | None
    actor_email: str | None
    entity_type: str
    entity_id: UUID | None
    request_id: str | None
    metadata: dict[str, Any]


async def find_audit_events(db: AsyncSession, query: AuditQuery) -> list[AuditEventRow]:
    """Events matching every filter given, newest first, at most `query.limit`. Read-only."""
    stmt = (
        select(
            AuditEvent.id,
            AuditEvent.created_at,
            AuditEvent.action,
            AuditEvent.building_id,
            Building.slug,
            AuditEvent.actor_user_id,
            User.email,
            AuditEvent.entity_type,
            AuditEvent.entity_id,
            AuditEvent.request_id,
            AuditEvent.metadata_,
        )
        .outerjoin(Building, Building.id == AuditEvent.building_id)
        .outerjoin(User, User.id == AuditEvent.actor_user_id)
        # uuid7 ids follow insertion order: events stamped with the same instant stay in order.
        .order_by(AuditEvent.created_at.desc(), AuditEvent.id.desc())
        .limit(query.limit)
    )
    if query.building_slug is not None:
        building_id = await db.scalar(
            select(Building.id).where(Building.slug == query.building_slug)
        )
        if building_id is None:
            raise UnknownFilterValue(f"no building with slug {query.building_slug!r}")
        stmt = stmt.where(AuditEvent.building_id == building_id)
    if query.actor_email is not None:
        user_id = await db.scalar(
            select(User.id).where(func.lower(User.email) == func.lower(query.actor_email))
        )
        if user_id is None:
            raise UnknownFilterValue(f"no user with email {query.actor_email!r}")
        stmt = stmt.where(AuditEvent.actor_user_id == user_id)
    if query.entity_type is not None:
        stmt = stmt.where(AuditEvent.entity_type == query.entity_type)
    if query.entity_id is not None:
        stmt = stmt.where(AuditEvent.entity_id == query.entity_id)
    if query.action_prefix is not None:
        # autoescape: `_` and `%` are common in action names and must not act as wildcards.
        stmt = stmt.where(AuditEvent.action.startswith(query.action_prefix, autoescape=True))
    if query.since is not None:
        stmt = stmt.where(AuditEvent.created_at >= query.since)
    return [AuditEventRow(*row) for row in await db.execute(stmt)]
