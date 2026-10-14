"""Health endpoint tests."""

import pytest

from app.routers import health


@pytest.mark.anyio
async def test_health_returns_ok(client):
    response = await client.get("/api/health")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ok"


@pytest.mark.anyio
async def test_ready_skips_database_when_disabled(client, monkeypatch):
    monkeypatch.setattr(health.settings, "readiness_check_database", False)

    response = await client.get("/api/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    assert "checks" in data
    assert data["checks"]["app"] == "ok"
    assert data["checks"]["database"] == "skipped"


@pytest.mark.anyio
async def test_ready_checks_database_when_enabled(client, monkeypatch):
    async def check_database_connection():
        return None

    monkeypatch.setattr(health.settings, "readiness_check_database", True)
    monkeypatch.setattr(health, "check_database_connection", check_database_connection)

    response = await client.get("/api/ready")
    assert response.status_code == 200
    data = response.json()
    assert data["status"] == "ready"
    assert data["checks"]["database"] == "ok"


@pytest.mark.anyio
async def test_ready_returns_503_when_database_check_fails(client, monkeypatch):
    async def check_database_connection():
        raise RuntimeError("database unavailable")

    monkeypatch.setattr(health.settings, "readiness_check_database", True)
    monkeypatch.setattr(health, "check_database_connection", check_database_connection)

    response = await client.get("/api/ready")
    assert response.status_code == 503
    data = response.json()
    assert data["detail"]["status"] == "not_ready"
    assert data["detail"]["checks"]["database"] == "error"

@pytest.mark.anyio
async def test_version_returns_metadata(client):
    response = await client.get("/api/version")
    assert response.status_code == 200
    data = response.json()
    assert "service" in data
    assert "environment" in data
    assert "server_time" in data
