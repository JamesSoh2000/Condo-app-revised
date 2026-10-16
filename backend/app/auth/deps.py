"""Who is calling: the session cookie resolved to a live session and its user (ADR-0003)."""

from typing import Annotated

from fastapi import Depends, Request
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.auth.service import CurrentSession
from app.core.config import settings
from app.core.dependencies import get_db_session
from app.core.errors import Unauthorized
from app.users.models import User


class NotAuthenticated(Unauthorized):
    code = "not_authenticated"
    title = "Unauthorized"


async def get_current_session(
    request: Request, db: Annotated[AsyncSession, Depends(get_db_session)]
) -> CurrentSession:
    """The caller's live session and active user, or 401 `not_authenticated`.

    Refreshes the session's activity (at most every 5 minutes) before the endpoint runs.
    """
    token = request.cookies.get(settings.session_cookie_name)
    current = await service.resolve_session(db, token) if token else None
    if current is None:
        raise NotAuthenticated(detail="Log in to continue.")
    await service.touch_session(db, current.session)
    return current


async def get_current_user(
    current: Annotated[CurrentSession, Depends(get_current_session)],
) -> User:
    return current.user
