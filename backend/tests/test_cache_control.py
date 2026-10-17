"""Authenticated API responses are never cached (P2-03 criterion 11, carried from P2-02)."""

import pytest
from fastapi import APIRouter, Response

from tests.helpers.auth import login_as

pytestmark = pytest.mark.anyio


async def test_api_responses_are_no_store(client, db, world):
    anonymous = [await client.get("/api/auth/me"), await client.get("/api/health")]
    await login_as(db, client, world.a_manager.user)
    member = [
        await client.get("/api/auth/me"),
        await client.get(f"/api/buildings/{world.a.id}"),
        await client.get(f"/api/buildings/{world.b.id}"),
    ]

    statuses = [r.status_code for r in anonymous + member]
    assert statuses == [401, 200, 200, 200, 404]
    assert [r.headers.get("cache-control") for r in anonymous + member] == ["no-store"] * 5


async def test_a_route_that_sets_its_own_cache_control_keeps_it(app_client):
    router = APIRouter(tags=["probe"])

    @router.get("/cached")
    async def cached(response: Response) -> dict[str, str]:
        response.headers["Cache-Control"] = "public, max-age=60"
        return {}

    async with app_client(router) as c:
        response = await c.get("/api/cached")

    assert response.headers["cache-control"] == "public, max-age=60"


async def test_non_api_paths_are_left_alone(client):
    response = await client.get("/not-api")

    assert response.status_code == 404
    assert "cache-control" not in response.headers
