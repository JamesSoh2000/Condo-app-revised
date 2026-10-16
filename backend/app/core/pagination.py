"""Keyset pagination: `?limit=&cursor=` in, `{items, next_cursor}` out, newest first (§8).

Lists are ordered `id DESC`; ids are uuid7, so that is newest first. The cursor is the last listed
id, and the next page is `WHERE id < cursor`, so rows inserted between requests can't shift a page.
"""

import base64
import re
from collections.abc import Callable
from typing import Annotated
from uuid import UUID

from fastapi import Query
from pydantic import BaseModel
from sqlalchemy import Select
from sqlalchemy.ext.asyncio import AsyncSession
from sqlalchemy.orm import InstrumentedAttribute

from app.core.errors import BadRequest

DEFAULT_LIMIT = 25
MAX_LIMIT = 100
# base64url without padding of the id's 16 bytes.
_CURSOR = re.compile(r"[A-Za-z0-9_-]{22}")


class Page[T](BaseModel):
    items: list[T]
    next_cursor: str | None


def encode_cursor(last_id: UUID) -> str:
    return base64.urlsafe_b64encode(last_id.bytes).rstrip(b"=").decode("ascii")


def decode_cursor(cursor: str) -> UUID:
    """The id a cursor stands for; `BadRequest` `invalid_cursor` if it isn't one we issued."""
    if _CURSOR.fullmatch(cursor):
        last_id = UUID(bytes=base64.urlsafe_b64decode(cursor + "=="))
        # 22 characters hold 4 spare bits; only the canonical spelling is accepted.
        if encode_cursor(last_id) == cursor:
            return last_id
    raise BadRequest(
        code="invalid_cursor",
        title="Invalid cursor",
        detail="Use the next_cursor of a previous page.",
    )


class CursorParams:
    """The list query parameters, as a dependency: `params: Annotated[CursorParams, Depends()]`."""

    def __init__(
        self,
        limit: Annotated[int, Query(ge=1, le=MAX_LIMIT)] = DEFAULT_LIMIT,
        cursor: Annotated[str | None, Query(max_length=64)] = None,
    ) -> None:
        self.limit = limit
        self.after_id = None if cursor is None else decode_cursor(cursor)


async def paginate[M, T](
    db: AsyncSession,
    stmt: Select[M],
    id_col: InstrumentedAttribute[UUID],
    params: CursorParams,
    mapper: Callable[[M], T],
) -> Page[T]:
    """One page of `stmt`'s rows. Its filters are kept; its ORDER BY and LIMIT are replaced."""
    stmt = stmt.order_by(None).order_by(id_col.desc()).limit(params.limit + 1)
    if params.after_id is not None:
        stmt = stmt.where(id_col < params.after_id)
    rows = list((await db.scalars(stmt)).all())
    # The extra row only says whether another page exists.
    has_more = len(rows) > params.limit
    rows = rows[: params.limit]
    next_cursor = encode_cursor(getattr(rows[-1], id_col.key)) if has_more else None
    return Page[T](items=[mapper(row) for row in rows], next_cursor=next_cursor)
