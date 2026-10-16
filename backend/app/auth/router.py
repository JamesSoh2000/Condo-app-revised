"""Login and logout (ADR-0003). Both are open to unauthenticated callers, and both are unsafe
methods, so the CSRF middleware checks them."""

import ipaddress
from typing import Annotated

from fastapi import APIRouter, Depends, Request, Response
from sqlalchemy.ext.asyncio import AsyncSession

from app.auth import service
from app.auth.schemas import LoginIn
from app.core.config import settings
from app.core.dependencies import get_db_session
from app.core.errors import problem_responses

router = APIRouter(prefix="/auth", tags=["auth"])

DbSession = Annotated[AsyncSession, Depends(get_db_session)]


@router.post("/login", status_code=204, responses=problem_responses(401))
async def login(body: LoginIn, request: Request, response: Response, db: DbSession) -> None:
    """Log in: 204 with the session cookie, or 401 `invalid_credentials` for any failure."""
    token = await service.login(
        db,
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
