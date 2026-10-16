"""CSRF middleware (P2-01a criteria 1-5), through test-only routes on `create_app()`.

The `client`/`app_client` fixtures send the passing headers by default; `send` here sends exactly
the headers a test lists, so a missing or duplicated header is really missing or duplicated.
"""

import logging
from urllib.parse import urlsplit

import httpx
import pytest
from fastapi import APIRouter

from app.core.config import settings
from app.main import create_app

TRUSTED = settings.trusted_origins[0]
_trusted = urlsplit(TRUSTED)
OTHER_PORT = f"{_trusted.scheme}://{_trusted.hostname}:{(_trusted.port or 80) + 1}"
OK = [("X-Requested-With", "fetch"), ("Origin", TRUSTED)]

calls: list[str] = []
router = APIRouter(prefix="/csrf-probe", tags=["probe"])


@router.api_route("/write", methods=["POST", "PUT", "PATCH", "DELETE", "PROPFIND"])
async def write() -> dict[str, bool]:
    calls.append("write")
    return {"ok": True}


@router.api_route("/read", methods=["GET", "HEAD", "OPTIONS"])
async def read() -> dict[str, bool]:
    calls.append("read")
    return {"ok": True}


@pytest.fixture(autouse=True)
def _reset_calls():
    calls.clear()


async def send(c: httpx.AsyncClient, method: str, path: str, headers: list[tuple[str, str]]):
    request = c.build_request(method, path)
    # Only the listed headers (plus what httpx always adds: host, content-length...).
    request.headers = httpx.Headers(
        [(k, v) for k, v in request.headers.multi_items() if k.lower() not in _CSRF_HEADERS]
        + headers
    )
    return await c.send(request)


_CSRF_HEADERS = {"origin", "x-requested-with", "sec-fetch-site"}


def assert_csrf_rejected(response: httpx.Response) -> None:
    assert response.status_code == 403
    assert response.headers["content-type"] == "application/problem+json"
    body = response.json()
    assert body["code"] == "csrf_failed"
    assert body["title"] == "Forbidden"
    assert body["request_id"] == response.headers["x-request-id"]
    assert calls == []


UNSAFE = ["POST", "PUT", "PATCH", "DELETE", "PROPFIND"]


# Criterion 1: the X-Requested-With header


@pytest.mark.anyio
@pytest.mark.parametrize("method", UNSAFE)
@pytest.mark.parametrize(
    "requested_with",
    [
        [],
        [("X-Requested-With", "XMLHttpRequest")],
        [("X-Requested-With", "Fetch")],
        [
            ("X-Requested-With", "fetch "),
        ],
        [("X-Requested-With", "fetch"), ("X-Requested-With", "fetch")],
    ],
    ids=["missing", "xmlhttprequest", "wrong-case", "padded", "twice"],
)
async def test_unsafe_request_without_exactly_fetch_header_is_rejected(
    app_client, method, requested_with
):
    async with app_client(router) as c:
        response = await send(
            c, method, "/api/csrf-probe/write", [("Origin", TRUSTED), *requested_with]
        )

    assert_csrf_rejected(response)


# Criterion 2: the Origin header


@pytest.mark.anyio
@pytest.mark.parametrize(
    "origins",
    [
        ["https://evil.example"],
        ["null"],
        [TRUSTED + "/"],
        [TRUSTED.upper()],
        [OTHER_PORT],
        [TRUSTED, TRUSTED],
        [TRUSTED, "https://evil.example"],
        [""],
    ],
    ids=[
        "evil",
        "null",
        "trailing-slash",
        "upper-case",
        "other-port",
        "twice",
        "trusted-and-evil",
        "empty",
    ],
)
async def test_unsafe_request_from_an_untrusted_origin_is_rejected(app_client, origins):
    headers = [("X-Requested-With", "fetch"), *(("Origin", o) for o in origins)]
    async with app_client(router) as c:
        response = await send(c, "POST", "/api/csrf-probe/write", headers)

    assert_csrf_rejected(response)


# Criterion 3: no Origin, Sec-Fetch-Site decides


@pytest.mark.anyio
@pytest.mark.parametrize(
    "fetch_site",
    [
        [],
        [("Sec-Fetch-Site", "same-site")],
        [("Sec-Fetch-Site", "cross-site")],
        [("Sec-Fetch-Site", "none")],
    ],
    ids=["absent", "same-site", "cross-site", "none"],
)
async def test_unsafe_request_without_origin_needs_same_origin_fetch_site(app_client, fetch_site):
    async with app_client(router) as c:
        response = await send(
            c, "POST", "/api/csrf-probe/write", [("X-Requested-With", "fetch"), *fetch_site]
        )

    assert_csrf_rejected(response)


@pytest.mark.anyio
async def test_unsafe_request_without_origin_but_same_origin_fetch_site_passes(app_client):
    headers = [("X-Requested-With", "fetch"), ("Sec-Fetch-Site", "same-origin")]
    async with app_client(router) as c:
        response = await send(c, "POST", "/api/csrf-probe/write", headers)

    assert response.status_code == 200
    assert calls == ["write"]


# Criterion 4: what passes


@pytest.mark.anyio
@pytest.mark.parametrize("method", UNSAFE)
async def test_unsafe_request_with_trusted_origin_and_fetch_header_reaches_the_handler(
    app_client, method
):
    async with app_client(router) as c:
        response = await send(c, method, "/api/csrf-probe/write", OK)

    assert response.status_code == 200
    assert calls == ["write"]


@pytest.mark.anyio
@pytest.mark.parametrize("method", ["GET", "HEAD", "OPTIONS"])
async def test_safe_methods_need_no_csrf_headers(app_client, method):
    async with app_client(router) as c:
        response = await send(
            c, method, "/api/csrf-probe/read", [("Origin", "https://evil.example")]
        )

    assert response.status_code == 200
    assert calls == ["read"]


@pytest.mark.anyio
async def test_check_covers_paths_outside_api():
    test_app = create_app()
    test_app.include_router(router)  # no /api prefix
    transport = httpx.ASGITransport(app=test_app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        rejected = await send(c, "POST", "/csrf-probe/write", [("Origin", TRUSTED)])
        assert_csrf_rejected(rejected)
        passed = await send(c, "POST", "/csrf-probe/write", OK)

    assert passed.status_code == 200
    assert calls == ["write"]


@pytest.mark.anyio
async def test_check_runs_before_routing(client):
    # No unsafe route exists here: without the headers it is the CSRF 403, not a 405.
    rejected = await send(client, "POST", "/api/health", [])
    allowed = await send(client, "POST", "/api/health", OK)

    assert_csrf_rejected(rejected)
    assert allowed.status_code == 405


@pytest.mark.anyio
async def test_default_test_client_headers_pass_the_check(app_client):
    async with app_client(router) as c:
        response = await c.post("/api/csrf-probe/write")

    assert response.status_code == 200


# Criterion 5: a problem response, logged like any other request


@pytest.mark.anyio
async def test_rejection_is_a_logged_403_not_a_500(app_client, caplog):
    with caplog.at_level(logging.INFO, logger="app.request"):
        async with app_client(router, raise_app_exceptions=False) as c:
            response = await send(
                c, "POST", "/api/csrf-probe/write", [("X-Request-ID", "csrf-probe-1")]
            )

    assert_csrf_rejected(response)
    assert response.headers["x-request-id"] == "csrf-probe-1"
    [record] = [r for r in caplog.records if r.getMessage() == "request_completed"]
    assert (record.status_code, record.request_id, record.path) == (
        403,
        "csrf-probe-1",
        "/api/csrf-probe/write",
    )


@pytest.mark.anyio
async def test_rejection_does_not_read_the_request_body(app_client):
    received: list[bytes] = []

    async def body():
        received.append(b"read")
        yield b'{"a": 1}'

    async with app_client(router) as c:
        request = c.build_request("POST", "/api/csrf-probe/write", content=body())
        request.headers = httpx.Headers(
            [(k, v) for k, v in request.headers.multi_items() if k.lower() not in _CSRF_HEADERS]
        )
        response = await c.send(request)

    assert_csrf_rejected(response)
    assert received == []
