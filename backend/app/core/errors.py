"""Domain errors, and the problem+json (RFC 9457) body of every API error (ARCHITECTURE.md §8).

Services raise a `DomainError` subclass with a stable snake_case `code` for frontend logic. The
handlers installed by `install_error_handlers` give it, request validation errors, `HTTPException`s
and unhandled exceptions one body shape, always with the request's `request_id`.
"""

import copy
import json
import re
import uuid
from http import HTTPStatus
from typing import Any

from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.responses import JSONResponse
from pydantic import BaseModel, ConfigDict
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.logging_config import request_id_ctx

PROBLEM_MEDIA_TYPE = "application/problem+json"
_MEMBERS = frozenset({"type", "title", "status", "code", "detail", "request_id", "errors"})
_PROBLEM_CONTENT = {PROBLEM_MEDIA_TYPE: {"schema": {"$ref": "#/components/schemas/Problem"}}}


class DomainError(Exception):
    """An expected failure a service reports to the client: `status`, a stable `code`, a `title`."""

    code: str
    status: int
    title: str

    def __init__(
        self,
        code: str,
        status: int,
        title: str,
        detail: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        reserved = _MEMBERS.intersection(extra or {})
        if reserved:
            raise ValueError(f"extra must not overwrite problem members: {sorted(reserved)}")
        super().__init__(code)
        self.code = code
        self.status = status
        self.title = title
        self.detail = detail
        self.extra = dict(extra or {})
        self.headers: dict[str, str] = {}


class _StatusError(DomainError):
    """A `DomainError` whose subclass fixes the status and gives the default code and title."""

    def __init__(
        self,
        code: str | None = None,
        title: str | None = None,
        detail: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code or self.code, self.status, title or self.title, detail, extra)


class BadRequest(_StatusError):
    status, code, title = 400, "bad_request", "Bad Request"


class Unauthorized(_StatusError):
    status, code, title = 401, "unauthorized", "Unauthorized"


class Forbidden(_StatusError):
    status, code, title = 403, "forbidden", "Forbidden"


class NotFound(_StatusError):
    status, code, title = 404, "not_found", "Not Found"


class Conflict(_StatusError):
    status, code, title = 409, "conflict", "Conflict"


class RateLimited(_StatusError):
    status, code, title = 429, "rate_limited", "Too Many Requests"

    def __init__(
        self,
        retry_after: int,
        code: str | None = None,
        title: str | None = None,
        detail: str | None = None,
        extra: dict[str, Any] | None = None,
    ) -> None:
        super().__init__(code, title, detail, {**(extra or {}), "retry_after": retry_after})
        self.headers["Retry-After"] = str(retry_after)


class ProblemError(BaseModel):
    loc: list[str | int]
    msg: str
    type: str


class Problem(BaseModel):
    """The documented error body. Some codes add members (`retry_after`), hence `extra="allow"`."""

    model_config = ConfigDict(extra="allow")

    type: str
    title: str
    status: int
    code: str
    request_id: str
    detail: str | None = None
    errors: list[ProblemError] | None = None


def problem_responses(*statuses: int) -> dict[int | str, dict[str, Any]]:
    """`responses=` for a route: each status documented with the `Problem` schema."""
    return {
        status: {"description": _phrase(status), "content": copy.deepcopy(_PROBLEM_CONTENT)}
        for status in statuses
    }


def problem_response(
    request: Request,
    *,
    status: int,
    code: str,
    title: str,
    detail: str | None = None,
    headers: dict[str, str] | None = None,
    **members: Any,
) -> JSONResponse:
    # Set by RequestLoggingMiddleware. request.state survives to the 500 handler, which runs outside
    # the middleware, after the context variable is reset.
    request_id = (
        getattr(request.state, "request_id", None) or request_id_ctx.get() or str(uuid.uuid4())
    )
    body: dict[str, Any] = {
        "type": "/problems/" + code.replace("_", "-"),
        "title": title,
        "status": status,
        "code": code,
    }
    if detail is not None:
        body["detail"] = detail
    body.update(members)
    body["request_id"] = request_id
    return JSONResponse(
        body,
        status_code=status,
        headers={**(headers or {}), "X-Request-ID": request_id},
        media_type=PROBLEM_MEDIA_TYPE,
    )


async def _domain_error(request: Request, exc: DomainError) -> JSONResponse:
    return problem_response(
        request,
        status=exc.status,
        code=exc.code,
        title=exc.title,
        detail=exc.detail,
        headers=exc.headers,
        **exc.extra,
    )


async def _validation_error(request: Request, exc: RequestValidationError) -> JSONResponse:
    # Only loc/msg/type: pydantic's `input` and `ctx` would echo submitted values (passwords).
    errors = [{"loc": list(e["loc"]), "msg": e["msg"], "type": e["type"]} for e in exc.errors()]
    return problem_response(
        request, status=422, code="validation_error", title="Validation Error", errors=errors
    )


async def _http_exception(request: Request, exc: StarletteHTTPException) -> JSONResponse:
    title = _phrase(exc.status_code)
    code = re.sub(r"[^a-z0-9]+", "_", title.lower()).strip("_") or "http_error"
    # A 5xx detail may describe internals; below 500 it is a message the code chose to send.
    keep = exc.status_code < 500 and isinstance(exc.detail, str) and exc.detail != title
    return problem_response(
        request,
        status=exc.status_code,
        code=code,
        title=title,
        detail=exc.detail if keep else None,
        headers=dict(exc.headers or {}),
    )


async def _unhandled_error(request: Request, exc: Exception) -> JSONResponse:
    # Never the exception's text. RequestLoggingMiddleware has already logged the traceback with
    # the request_id, so this doesn't log it again.
    return problem_response(
        request, status=500, code="internal_error", title="Internal Server Error"
    )


def install_error_handlers(app: FastAPI) -> None:
    app.exception_handler(DomainError)(_domain_error)
    app.exception_handler(RequestValidationError)(_validation_error)
    app.exception_handler(StarletteHTTPException)(_http_exception)
    app.exception_handler(Exception)(_unhandled_error)
    _document_problems(app)


def _document_problems(app: FastAPI) -> None:
    """Add `Problem` to the OpenAPI components, and document every 422 with it.

    FastAPI files a `responses=` model only under `application/json`, and documents 422 with its own
    `HTTPValidationError`, a body this API never sends.
    """
    build = app.openapi

    def openapi() -> dict[str, Any]:
        if app.openapi_schema is not None:
            return app.openapi_schema
        document = build()  # also caches it in app.openapi_schema, edited in place below
        schemas = document.setdefault("components", {}).setdefault("schemas", {})
        problem = Problem.model_json_schema(ref_template="#/components/schemas/{model}")
        schemas.update(problem.pop("$defs", {}))
        schemas["Problem"] = problem
        for path_item in document.get("paths", {}).values():
            for operation in path_item.values():
                if "422" in operation.get("responses", {}):
                    operation["responses"]["422"]["content"] = copy.deepcopy(_PROBLEM_CONTENT)
        schemas.pop("HTTPValidationError", None)
        if "#/components/schemas/ValidationError" not in json.dumps(document):
            schemas.pop("ValidationError", None)
        return document

    app.openapi = openapi  # type: ignore[method-assign]


def _phrase(status: int) -> str:
    try:
        return HTTPStatus(status).phrase
    except ValueError:
        return "HTTP Error"
