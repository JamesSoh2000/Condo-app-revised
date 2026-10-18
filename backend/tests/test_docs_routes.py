"""`/api/docs` and `/api/openapi.json` follow `API_DOCS_ENABLED` (P2-07 criterion 5)."""

import json

import pytest
from httpx import ASGITransport, AsyncClient

from app import export_openapi
from app.core.config import settings
from app.main import create_app

DOCS_PATHS = ("/api/docs", "/api/openapi.json")


@pytest.mark.anyio
@pytest.mark.parametrize(("enabled", "status"), [(True, 200), (False, 404)])
async def test_docs_routes_follow_the_flag(monkeypatch, enabled, status):
    monkeypatch.setattr(settings, "api_docs_enabled", enabled)
    test_app = create_app()

    async with AsyncClient(transport=ASGITransport(app=test_app), base_url="http://test") as c:
        statuses = {path: (await c.get(path)).status_code for path in DOCS_PATHS}

    assert statuses == dict.fromkeys(DOCS_PATHS, status)


def test_export_works_with_the_docs_routes_off(monkeypatch, capsys):
    monkeypatch.setattr(settings, "api_docs_enabled", True)
    with_docs = create_app().openapi()
    monkeypatch.setattr(settings, "api_docs_enabled", False)

    export_openapi.main()

    assert json.loads(capsys.readouterr().out) == with_docs
