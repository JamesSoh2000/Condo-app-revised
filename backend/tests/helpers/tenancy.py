"""HTTP helpers for the 10-case tenant table (docs/ENGINEERING_PRACTICES.md §7, tests/README.md).

`as_user` is a fixture (tests/conftest.py): `client = await as_user(world.a_manager.user)` gives a
client of its own, logged in, so a test can hold several users at once. The assertions send one
request and check the problem+json answer a tenant rule demands.
"""

from typing import Any

from httpx import AsyncClient, Response

from app.core.errors import PROBLEM_MEDIA_TYPE


def assert_problem(response: Response, status: int, code: str) -> dict[str, Any]:
    """`response` is a problem+json `status` with this `code`; return its body."""
    assert response.status_code == status, response.text
    assert response.headers["content-type"] == PROBLEM_MEDIA_TYPE
    body: dict[str, Any] = response.json()
    assert body["code"] == code, body
    return body


async def assert_cross_building_404(
    client: AsyncClient,
    method: str,
    url: str,
    *,
    json: Any = None,
    code: str = "building_not_found",
) -> dict[str, Any]:
    """Tenant rows 3 and 6: a caller who isn't an active member of the URL's building gets a 404
    that says nothing about the building. Pass `code` for a record of another building reached
    through the caller's own building (a 404 of the record's domain)."""
    return assert_problem(await client.request(method, url, json=json), 404, code)


async def assert_forbidden_role(
    client: AsyncClient, method: str, url: str, *, json: Any = None
) -> dict[str, Any]:
    """Tenant row 4: an active member without one of the route's roles gets 403 `forbidden_role`."""
    return assert_problem(await client.request(method, url, json=json), 403, "forbidden_role")


async def assert_not_visible(
    client: AsyncClient, method: str, url: str, *, code: str, json: Any = None
) -> dict[str, Any]:
    """Tenant row 5: a record that exists but isn't the caller's is a 404 with the domain's `code`,
    the same answer as a record that doesn't exist (compare it with one)."""
    return assert_problem(await client.request(method, url, json=json), 404, code)


def without_request_id(body: dict[str, Any]) -> dict[str, Any]:
    """A problem body minus `request_id`, the one member that differs between identical answers."""
    return {key: value for key, value in body.items() if key != "request_id"}
