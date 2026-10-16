import logging
import re
import time
import uuid

from starlette.middleware.base import BaseHTTPMiddleware, RequestResponseEndpoint
from starlette.requests import Request
from starlette.responses import Response

from app.logging_config import request_id_ctx

logger = logging.getLogger("app.request")

# A client's X-Request-ID is echoed into headers, logs and error bodies, so only plain ids are kept.
_REQUEST_ID = re.compile(r"[A-Za-z0-9._-]{1,128}")


class RequestLoggingMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next: RequestResponseEndpoint) -> Response:
        request_id = request.headers.get("x-request-id", "")
        if not _REQUEST_ID.fullmatch(request_id):
            request_id = str(uuid.uuid4())
        request.state.request_id = request_id
        token = request_id_ctx.set(request_id)
        start = time.perf_counter()

        method = request.method
        path = request.url.path
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
                    "error_type": exc.__class__.__name__,
                    "error_message": str(exc),
                },
            )
            raise

        finally:
            request_id_ctx.reset(token)


def _get_client_ip(request: Request) -> str | None:
    # Not the X-Forwarded-For header: any client can send one. The server (gunicorn/uvicorn) already
    # replaced request.client with the forwarded address when, and only when, the peer is a trusted
    # proxy (FORWARDED_ALLOW_IPS, P1-08).
    if request.client:
        return request.client.host

    return None
