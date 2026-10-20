"""Request logging middleware tests."""

import logging

import pytest


@pytest.mark.anyio
async def test_request_log_ignores_a_client_supplied_x_forwarded_for(client, caplog):
    # The test client connects as 127.0.0.1 with no proxy in front: a client-supplied
    # X-Forwarded-For is not a trusted proxy's word, so it must not become the logged client
    # address (P1-08). Behind a trusted proxy, the server (gunicorn --forwarded-allow-ips) sets
    # request.client from it instead.
    with caplog.at_level(logging.INFO, logger="app.request"):
        response = await client.get("/api/health", headers={"X-Forwarded-For": "203.0.113.9"})

    assert response.status_code == 200
    [record] = [r for r in caplog.records if r.getMessage() == "request_completed"]
    assert record.client_ip == "127.0.0.1"


@pytest.mark.anyio
async def test_invitation_token_is_not_logged(client, caplog):
    # The public invitation routes carry their token in the path (P4-02b criterion 11), and a token
    # is never logged (CLAUDE.md rule 10). Building routes keep their path: an id is no secret.
    token = "T" * 43
    building = "0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b"
    with caplog.at_level(logging.INFO, logger="app.request"):
        await client.get(f"/api/invitations/{token}")
        await client.post(f"/api/invitations/{token}/accept", json={})
        await client.get(f"/api/buildings/{building}/invitations")

    paths = [r.path for r in caplog.records if r.getMessage() == "request_completed"]
    assert paths == [
        "/api/invitations/{token}",
        "/api/invitations/{token}/accept",
        f"/api/buildings/{building}/invitations",
    ]
    # The app's records only: httpx, the test's client, logs the URL it sent.
    assert not any(token in str(vars(r)) for r in caplog.records if r.name.startswith("app"))
