"""Health endpoint tests."""

import logging

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
async def test_ready_returns_503_without_exception_text_when_database_check_fails(
    client, monkeypatch, caplog
):
    async def check_database_connection():
        raise RuntimeError("database unavailable at secret-host:5432")

    monkeypatch.setattr(health.settings, "readiness_check_database", True)
    monkeypatch.setattr(health, "check_database_connection", check_database_connection)

    with caplog.at_level(logging.ERROR, logger="app.health"):
        response = await client.get("/api/ready", headers={"X-Request-ID": "req-ready-503"})

    assert response.status_code == 503
    assert response.json() == {
        "status": "not_ready",
        "checks": {"app": "ok", "database": "error"},
    }
    assert "database unavailable" not in response.text
    assert "secret-host" not in response.text
    assert response.headers["X-Request-ID"] == "req-ready-503"

    records = [r for r in caplog.records if r.name == "app.health"]
    assert len(records) == 1
    record = records[0]
    assert record.levelno == logging.ERROR
    assert record.request_id == "req-ready-503"
    assert record.exc_info is not None
    assert record.exc_info[0] is RuntimeError
    assert "database unavailable" in str(record.exc_info[1])


@pytest.mark.anyio
async def test_version_returns_metadata(client):
    response = await client.get("/api/version")
    assert response.status_code == 200
    data = response.json()
    assert "service" in data
    assert "environment" in data
    assert "server_time" in data
