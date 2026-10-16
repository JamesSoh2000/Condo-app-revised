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
