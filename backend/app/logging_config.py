import contextvars
import json
import logging
import socket
import sys
from datetime import UTC, datetime
from typing import Any

from app.core.config import settings

request_id_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "request_id",
    default=None,
)
# Set by get_tenant_context (app/tenancy/deps.py) for the rest of a building request.
building_id_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar(
    "building_id", default=None
)
user_id_ctx: contextvars.ContextVar[str | None] = contextvars.ContextVar("user_id", default=None)


class JsonFormatter(logging.Formatter):
    def format(self, record: logging.LogRecord) -> str:
        log: dict[str, Any] = {
            "timestamp": datetime.now(UTC).isoformat(),
            "level": record.levelname,
            "logger": record.name,
            "message": record.getMessage(),
            "environment": settings.app_env,
            "service": settings.service_name,
            "request_id": getattr(record, "request_id", None) or request_id_ctx.get(),
            "git_sha": settings.git_sha or settings.image_tag,
            "image_tag": settings.image_tag,
            "container_name": socket.gethostname(),
        }

        extra_fields = [
            "method",
            "path",
            "status_code",
            "latency_ms",
            "client_ip",
            "user_agent",
            "error_type",
            "error_message",
            "reason",
            # The job worker (P3-01a).
            "worker_id",
            "job_id",
            "job_kind",
            "attempt",
            "succeeded",
            "retried",
            "dead",
            # The cleanup jobs (P3-01b).
            "deleted",
            "scrubbed",
            # files.cleanup (P3-04c): IDs and counts, never the S3 key.
            "file_id",
            "failed",
            "left",
            # Email (P3-02): never the address, only its domain.
            "recipient_domain",
            "email_template",
        ]

        for field in extra_fields:
            value = getattr(record, field, None)
            if value is not None:
                log[field] = value

        # A record's own value first: the request log runs outside the request's context.
        for field, context in (("building_id", building_id_ctx), ("user_id", user_id_ctx)):
            value = getattr(record, field, None) or context.get()
            if value is not None:
                log[field] = str(value)

        if record.exc_info:
            log["exception"] = self.formatException(record.exc_info)

        return json.dumps(log, ensure_ascii=False, default=str)


def configure_logging() -> None:
    log_level = settings.log_level.upper()

    root_logger = logging.getLogger()
    root_logger.handlers.clear()
    root_logger.setLevel(log_level)

    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(JsonFormatter())
    root_logger.addHandler(handler)

    # Let these loggers flow through our JSON root logger.
    for logger_name in ["uvicorn", "uvicorn.error", "fastapi"]:
        logger = logging.getLogger(logger_name)
        logger.handlers.clear()
        logger.propagate = True

    # Disable Uvicorn's default access logger because request middleware below
    # will emit cleaner JSON request logs.
    access_logger = logging.getLogger("uvicorn.access")
    access_logger.handlers.clear()
    access_logger.propagate = False
    access_logger.disabled = True
