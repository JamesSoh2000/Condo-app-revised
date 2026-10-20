import logging
import re
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.logging_config import building_id_ctx, request_id_ctx, user_id_ctx

logger = logging.getLogger("app.request")

# A client's X-Request-ID is echoed into headers, logs and error bodies, so only plain ids are kept.
_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")
# The public invitation routes carry their token in the path (P4-02b); a token is never logged
# (CLAUDE.md rule 10). Anchored: building routes' `/invitations/{id}` hold no secret.
_INVITATION_TOKEN = re.compile(r"^/api/invitations/[^/]*")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("x-request-id", "")
        if not _REQUEST_ID.fullmatch(request_id):
            request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        token = request_id_ctx.set(request_id)
        # Cleared for every request, so a value set by an earlier one (or outside any) can't leak
        # into this request's logs; get_tenant_context sets them on building routes.
        tenant_tokens = building_id_ctx.set(None), user_id_ctx.set(None)
        start = time.perf_counter()

        method = request.method
        path = _INVITATION_TOKEN.sub("/api/invitations/{token}", request.url.path, count=1)
        client_ip = _get_client_ip(request)
        user_agent = request.headers.get("user-agent")

        try:
            response = await call_next(request)
            latency_ms = round((time.perf_counter() - start) * 1000, 2)

            response.headers["X-Request-ID"] = request_id

            logger.info(
                "request_completed",
                extra={
                    "request_id": request_id,
                    "method": method,
                    "path": path,
                    "status_code": response.status_code,
                    "latency_ms": latency_ms,
                    "client_ip": client_ip,
                    "user_agent": user_agent,
                    # Set by get_tenant_context on building routes (app/tenancy/deps.py).
                    "building_id": getattr(request.state, "building_id", None),
                    "user_id": getattr(request.state, "user_id", None),
                },
            )

            return response

        except Exception as exc:
            latency_ms = round((time.perf_counter() - start) * 1000, 2)

            logger.exception(
                "request_failed",
                extra={
                    "request_id": request_id,
                    "method": method,
                    "path": path,
                    "status_code": 500,
                    "latency_ms": latency_ms,
                    "client_ip": client_ip,
                    "user_agent": user_agent,
                    "building_id": getattr(request.state, "building_id", None),
                    "user_id": getattr(request.state, "user_id", None),
                    "error_type": exc.__class__.__name__,
                    "error_message": str(exc),
                },
            )
            raise

        finally:
            request_id_ctx.reset(token)
            building_id_ctx.reset(tenant_tokens[0])
            user_id_ctx.reset(tenant_tokens[1])


def _get_client_ip(request: Request) -> str | None:
    # Not the X-Forwarded-For header: any client can send one. The server (gunicorn/uvicorn) already
    # replaced request.client with the forwarded address when, and only when, the peer is a trusted
    # proxy (FORWARDED_ALLOW_IPS, P1-08).
    if request.client:
        return request.client.host

    return None
