"""problem+json errors (P1-04 criteria 1-4 and 10), through a test-only router on `create_app()`."""

import json
import logging
import re
from datetime import UTC, datetime
from uuid import UUID

import pytest
from fastapi import APIRouter, HTTPException
from pydantic import Field
from starlette.exceptions import HTTPException as StarletteHTTPException

from app.core.errors import (
    BadRequest,
    Conflict,
    DomainError,
    Forbidden,
    NotFound,
    RateLimited,
    Unauthorized,
)
from app.core.schemas import InputModel
from app.logging_config import JsonFormatter

PROBLEM_MEMBERS = {"type", "title", "status", "code", "request_id"}

router = APIRouter(prefix="/probe", tags=["probe"])


class SignUp(InputModel):
    email: str = Field(max_length=100)
    password: str = Field(min_length=12, max_length=100)


@router.get("/int")
async def int_param(n: int) -> dict[str, int]:
    return {"n": n}


@router.post("/signup")
async def signup(body: SignUp) -> dict[str, str]:
    return {"email": body.email}


@router.get("/conflict")
async def conflict() -> None:
    raise Conflict(code="x_conflict", detail="Already done.", extra={"package_id": "p-1"})


PACKAGE_ID = UUID("01920000-0000-7000-8000-000000000001")
PICKED_UP_AT = datetime(2026, 10, 16, 12, 30, tzinfo=UTC)


@router.get("/conflict-typed-extra")
async def conflict_typed_extra() -> None:
    raise Conflict(
        code="package_already_picked_up",
        extra={"package_id": PACKAGE_ID, "picked_up_at": PICKED_UP_AT, "ids": [PACKAGE_ID]},
    )


DOMAIN_ERRORS: dict[str, type[DomainError]] = {
    "not_found": NotFound,
    "forbidden": Forbidden,
    "unauthorized": Unauthorized,
    "conflict": Conflict,
    "bad_request": BadRequest,
}


@router.get("/domain/{name}")
async def domain_error(name: str) -> None:
    raise DOMAIN_ERRORS[name]()


@router.get("/extra-named/{key}")
async def extra_named(key: str) -> None:
    raise Conflict(code="x_conflict", extra={key: "r-1"})


@router.get("/rate-limited")
async def rate_limited() -> None:
    raise RateLimited(retry_after=30)


@router.get("/http/{status}")
async def http_error(status: int) -> None:
    raise HTTPException(status_code=status, detail="custom detail")


@router.get("/starlette-http")
async def starlette_http_error() -> None:
    raise StarletteHTTPException(status_code=404)


@router.get("/boom")
async def boom() -> None:
    raise RuntimeError("secret dsn")


def assert_problem(response, status: int, code: str) -> dict[str, object]:
    assert response.status_code == status
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body.keys() >= PROBLEM_MEMBERS
    assert body["status"] == status
    assert body["code"] == code
    assert body["type"] == "/problems/" + code.replace("_", "-")
    assert body["request_id"] == response.headers["X-Request-ID"]
    return body


# Criterion 1


@pytest.mark.anyio
async def test_unknown_route_is_problem_404_with_the_clients_request_id(client):
    response = await client.get("/api/nope", headers={"X-Request-ID": "req-abc"})

    body = assert_problem(response, 404, "not_found")
    assert body["request_id"] == "req-abc"
    assert body["title"] == "Not Found"


@pytest.mark.anyio
async def test_unknown_route_without_request_id_gets_a_generated_one(client):
    response = await client.get("/api/nope")

    body = assert_problem(response, 404, "not_found")
    assert body["request_id"]


@pytest.mark.anyio
async def test_wrong_method_is_problem_405_and_keeps_allow_header(client):
    response = await client.post("/api/health")

    assert_problem(response, 405, "method_not_allowed")
    assert response.headers["allow"] == "GET"


# Criterion 2


@pytest.mark.anyio
async def test_bad_query_param_is_validation_error_pointing_at_the_param(app_client):
    async with app_client(router) as c:
        response = await c.get("/api/probe/int", params={"n": "abc"})

    body = assert_problem(response, 422, "validation_error")
    assert body["errors"][0]["loc"] == ["query", "n"]
    assert all(set(item) == {"loc", "msg", "type"} for item in body["errors"])


@pytest.mark.anyio
async def test_validation_error_never_echoes_the_submitted_value(app_client):
    async with app_client(router) as c:
        response = await c.post(
            "/api/probe/signup", json={"email": "a@example.org", "password": "hunter2"}
        )

    body = assert_problem(response, 422, "validation_error")
    assert body["errors"][0]["loc"] == ["body", "password"]
    assert "hunter2" not in response.text


@pytest.mark.anyio
async def test_unknown_body_field_on_input_model_is_rejected(app_client):
    async with app_client(router) as c:
        response = await c.post(
            "/api/probe/signup",
            json={"email": "a@example.org", "password": "long-enough-pass", "is_admin": True},
        )

    body = assert_problem(response, 422, "validation_error")
    assert body["errors"][0]["type"] == "extra_forbidden"
    assert body["errors"][0]["loc"] == ["body", "is_admin"]


# Criterion 3


@pytest.mark.anyio
async def test_conflict_is_problem_409_with_its_code_detail_and_extra(app_client):
    async with app_client(router) as c:
        response = await c.get("/api/probe/conflict")

    body = assert_problem(response, 409, "x_conflict")
    assert body["title"] == "Conflict"
    assert body["detail"] == "Already done."
    assert body["package_id"] == "p-1"


@pytest.mark.anyio
async def test_extra_with_uuid_and_datetime_values_is_still_the_domain_error(app_client):
    # Review round 1, F1: ids are uuid7 and times are datetimes, the first things services pass.
    async with app_client(router) as c:
        response = await c.get("/api/probe/conflict-typed-extra")

    body = assert_problem(response, 409, "package_already_picked_up")
    assert body["package_id"] == str(PACKAGE_ID)
    assert body["picked_up_at"] == "2026-10-16T12:30:00Z"
    assert body["ids"] == [str(PACKAGE_ID)]


@pytest.mark.anyio
@pytest.mark.parametrize("key", ["request", "headers", "members", "status_code", "media_type"])
async def test_extra_named_like_a_parameter_is_still_the_domain_error(app_client, key):
    # Review round 2, F1: extra keys reached problem_response() as keyword arguments.
    async with app_client(router) as c:
        response = await c.get(f"/api/probe/extra-named/{key}")

    body = assert_problem(response, 409, "x_conflict")
    assert body[key] == "r-1"


@pytest.mark.anyio
@pytest.mark.parametrize(
    ("name", "status"),
    [("not_found", 404), ("forbidden", 403), ("unauthorized", 401), ("bad_request", 400)],
)
async def test_each_domain_error_has_its_status_and_default_code(app_client, name, status):
    async with app_client(router) as c:
        response = await c.get(f"/api/probe/domain/{name}")

    body = assert_problem(response, status, name)
    assert "detail" not in body


def test_domain_error_default_codes_are_snake_case():
    for error in [*DOMAIN_ERRORS.values(), RateLimited]:
        assert re.fullmatch(r"[a-z]+(_[a-z]+)*", error.code), error


@pytest.mark.anyio
async def test_rate_limited_sets_retry_after_header_and_member(app_client):
    async with app_client(router) as c:
        response = await c.get("/api/probe/rate-limited")

    body = assert_problem(response, 429, "rate_limited")
    assert response.headers["retry-after"] == "30"
    assert body["retry_after"] == 30


@pytest.mark.parametrize("member", ["type", "title", "status", "code", "detail", "request_id"])
def test_extra_cannot_overwrite_a_standard_member(member):
    with pytest.raises(ValueError, match=member):
        Conflict(code="x_conflict", extra={member: "spoofed"})


def test_base_domain_error_takes_explicit_code_status_and_title():
    error = DomainError("teapot", 418, "I'm a teapot", detail="Short and stout.")

    assert (error.code, error.status, error.title, error.detail) == (
        "teapot",
        418,
        "I'm a teapot",
        "Short and stout.",
    )


@pytest.mark.anyio
async def test_http_exception_maps_to_problem_with_derived_code_and_detail(app_client):
    async with app_client(router) as c:
        response = await c.get("/api/probe/http/409")
        starlette_response = await c.get("/api/probe/starlette-http")

    body = assert_problem(response, 409, "conflict")
    assert body["detail"] == "custom detail"
    assert_problem(starlette_response, 404, "not_found")


@pytest.mark.anyio
async def test_http_exception_5xx_drops_its_detail(app_client):
    async with app_client(router) as c:
        response = await c.get("/api/probe/http/503")

    body = assert_problem(response, 503, "service_unavailable")
    assert "detail" not in body
    assert "custom detail" not in response.text


@pytest.mark.anyio
@pytest.mark.parametrize("status", [204, 304])
async def test_http_exception_without_a_body_status_sends_no_body(app_client, status):
    # Review round 2, F2: 204 and 304 must not carry a body (Starlette's default handler agrees).
    async with app_client(router) as c:
        response = await c.get(f"/api/probe/http/{status}")

    assert response.status_code == status
    assert response.content == b""
    assert "content-type" not in response.headers
    assert response.headers["X-Request-ID"]


# Criterion 4


@pytest.mark.anyio
async def test_unhandled_error_is_generic_500_and_logged_with_traceback(app_client, caplog):
    with caplog.at_level(logging.ERROR, logger="app.request"):
        async with app_client(router, raise_app_exceptions=False) as c:
            response = await c.get("/api/probe/boom", headers={"X-Request-ID": "req-boom"})

    body = assert_problem(response, 500, "internal_error")
    assert body["request_id"] == "req-boom"
    assert body["title"] == "Internal Server Error"
    assert "secret" not in response.text

    records = [r for r in caplog.records if r.name == "app.request"]
    assert len(records) == 1
    record = records[0]
    assert record.request_id == "req-boom"
    assert record.exc_info is not None
    assert record.exc_info[0] is RuntimeError
    line = json.loads(JsonFormatter().format(record))
    assert line["request_id"] == "req-boom"
    assert "Traceback" in line["exception"]
    assert "RuntimeError: secret dsn" in line["exception"]


# Criterion 10


@pytest.mark.anyio
@pytest.mark.parametrize("request_id", ["bad id", "x" * 129, "id;drop", "ünïcode".encode()])
async def test_malformed_client_request_id_is_replaced(client, request_id):
    response = await client.get("/api/nope", headers={"X-Request-ID": request_id})

    body = assert_problem(response, 404, "not_found")
    assert body["request_id"] != request_id
    assert re.fullmatch(r"[A-Za-z0-9._-]{1,128}", body["request_id"])


@pytest.mark.anyio
async def test_well_formed_client_request_id_is_kept_up_to_128_chars(client):
    request_id = "A.b_c-9" + "x" * 121

    response = await client.get("/api/health", headers={"X-Request-ID": request_id})

    assert response.headers["X-Request-ID"] == request_id


# P2-01a criterion 10 (carried from P1-04 round 3 M1): no positional code, snake_case only


@pytest.mark.parametrize("error", [*DOMAIN_ERRORS.values()])
def test_domain_error_subclasses_take_no_positional_arguments(error):
    with pytest.raises(TypeError):
        error("Package not found")


def test_rate_limited_takes_retry_after_first_and_the_rest_by_keyword():
    with pytest.raises(TypeError):
        RateLimited(30, "too_many")  # type: ignore[misc]

    assert RateLimited(retry_after=30, code="login_rate_limited").code == "login_rate_limited"
    assert RateLimited(30).headers["Retry-After"] == "30"


@pytest.mark.parametrize(
    "code",
    ["Not Snake", "not-snake", "Package not found", "_leading", "trailing_", "a__b", "", "1st"],
)
def test_domain_error_code_must_be_snake_case(code):
    with pytest.raises(ValueError, match="snake_case"):
        Conflict(code=code)
    with pytest.raises(ValueError, match="snake_case"):
        DomainError(code, 418, "I'm a teapot")


@pytest.mark.parametrize("code", ["x_conflict", "csrf_failed", "teapot", "error_2fa"])
def test_snake_case_codes_are_accepted(code):
    assert Conflict(code=code).code == code
