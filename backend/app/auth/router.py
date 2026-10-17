"""Login and logout (ADR-0003), open to unauthenticated callers; the caller's account and sessions
(P2-02), which need a session. Every unsafe method here goes through the CSRF middleware."""

import ipaddress
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.auth.deps import get_current_session
from app.auth.schemas import LoginIn, MeOut, SessionOut
from app.auth.service import CurrentSession
from app.core.config import settings
from app.core.dependencies import get_db_session
from app.core.errors import problem_responses
from app.core.pagination import CursorParams, Page
from app.rate_limits.service import RateLimiter, get_rate_limiter

router = APIRouter(prefix="/auth", tags=["auth"])

DbSession = Annotated[AsyncSession, Depends(get_db_session)]
# Listed first in every signature below: its activity refresh commits (app/auth/deps.py).
Current = Annotated[CurrentSession, Depends(get_current_session)]


@router.post("/login", status_code=204, responses=problem_responses(401, 429))
async def login(
    body: LoginIn,
    request: Request,
    response: Response,
    db: DbSession,
    limiter: Annotated[RateLimiter, Depends(get_rate_limiter)],
) -> None:
    """Log in: 204 with the session cookie, 401 `invalid_credentials` for any failure, or 429
    `rate_limited` (with Retry-After) after too many attempts from the IP or for the email."""
    token = await service.login(
        db,
        limiter,
        email=body.email,
        password=body.password,
        user_agent=request.headers.get("user-agent"),
        ip=_client_ip(request),
    )
    _set_session_cookie(response, token, max_age=settings.session_absolute_days * 24 * 3600)


@router.post("/logout", status_code=204)
async def logout(request: Request, response: Response, db: DbSession) -> None:
    """Revoke the current session, if any, and delete the cookie. Always 204."""
    await service.logout(db, request.cookies.get(settings.session_cookie_name))
    # Deleting: same name, Path and flags, or the browser treats it as another cookie.
    _set_session_cookie(response, "", max_age=0)


@router.get("/me", responses=problem_responses(401))
async def me(current: Current, db: DbSession) -> MeOut:
    """The current user and their memberships (all but deactivated), for the app shell."""
    return await service.get_me(db, current.user)


@router.post("/logout-all", status_code=204, responses=problem_responses(401))
async def logout_all(current: Current, response: Response, db: DbSession) -> None:
    """Revoke every session of the current user, this one included, and delete the cookie."""
    await service.logout_all(db, current.user.id)
    _set_session_cookie(response, "", max_age=0)


@router.get("/sessions", responses=problem_responses(400, 401))
async def sessions_list(
    current: Current, db: DbSession, params: Annotated[CursorParams, Depends()]
) -> Page[SessionOut]:
    """The current user's live sessions, newest first; `current` marks this one."""
    return await service.list_sessions(db, current.session, params)


@router.delete("/sessions/{session_id}", status_code=204, responses=problem_responses(401, 404))
async def sessions_revoke(
    current: Current, session_id: UUID, response: Response, db: DbSession
) -> None:
    """Revoke one of the current user's live sessions; 404 for any other id. Revoking this one
    also deletes the cookie, as logout does."""
    await service.revoke_session(db, current.user.id, session_id)
    if session_id == current.session.id:
        _set_session_cookie(response, "", max_age=0)


def _set_session_cookie(response: Response, value: str, *, max_age: int) -> None:
    # No Domain: the cookie stays on the exact host (and the __Host- prefix requires that).
    response.set_cookie(
        settings.session_cookie_name,
        value,
        max_age=max_age,
        path="/",
        secure=settings.session_cookie_secure,
        httponly=True,
        samesite="lax",
    )


def _client_ip(request: Request) -> str | None:
    # request.client is the proxy-resolved peer (see RequestLoggingMiddleware); keep it only if it
    # is an IP address, since the column is INET.
    host = request.client.host if request.client else None
    try:
        return str(ipaddress.ip_address(host)) if host else None
    except ValueError:
        return None
