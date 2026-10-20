"""CSRF protection (ADR-0003): unsafe requests must come from the app's own pages.

The session cookie will be `SameSite=Lax` (P2-01b). That stops most cross-site POSTs from carrying
it, but not a POST from another origin on the same site (a sibling subdomain), and it depends on the
browser. So every request whose method can change state must also show two things another origin
can't fake from a browser:
- where it comes from: an `Origin` in `settings.trusted_origins`, or, if the browser sent no
  `Origin`, `Sec-Fetch-Site: same-origin`;
- that a script on our page sent it: `X-Requested-With: fetch`. An HTML form can't set headers, and
  a cross-origin script that sets one needs a CORS preflight, which this API never grants.
"""

import logging

from starlette.datastructures import Headers
from starlette.requests import Request
from starlette.types import ASGIApp, Receive, Scope, Send

from app.core.config import settings
from app.core.errors import problem_response
from app.logging_config import loggable_path

logger = logging.getLogger("app.csrf")

SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


class CSRFMiddleware:
    """Rejects an unsafe request that fails the check with 403 `csrf_failed`, before any routing."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        # Only HTTP: there are no WebSocket routes (CLAUDE.md rule 13). One that reads the session
        # cookie must check `Origin` itself (review round 1 L4).
        if scope["type"] != "http" or scope["method"] in SAFE_METHODS:
            await self.app(scope, receive, send)
            return
        reason = _failure(Headers(scope=scope))
        if reason is None:
            await self.app(scope, receive, send)
            return
        logger.warning(
            "csrf_rejected", extra={"reason": reason, "path": loggable_path(scope["path"])}
        )
        # A response, not a raised DomainError: an exception raised in a middleware never reaches
        # the app's exception handlers and would become a 500.
        response = problem_response(
            Request(scope),
            status=403,
            code="csrf_failed",
            title="Forbidden",
            detail="The request did not pass the CSRF check.",
        )
        await response(scope, receive, send)


def _failure(headers: Headers) -> str | None:
    """Why the request fails the check, or None if it passes. Duplicated headers fail."""
    if headers.getlist("x-requested-with") != ["fetch"]:
        return "x_requested_with"
    origins = headers.getlist("origin")
    if origins:
        return None if len(origins) == 1 and origins[0] in settings.trusted_origins else "origin"
    if headers.getlist("sec-fetch-site") != ["same-origin"]:
        return "no_origin"
    return None
