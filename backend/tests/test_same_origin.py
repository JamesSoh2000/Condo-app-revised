"""Same-origin (P1-04 criterion 9: no CORS) and the shared schema bases (criterion 11)."""

from types import SimpleNamespace

import pytest
from pydantic import ValidationError

from app.core.schemas import APIModel, InputModel

EVIL = "http://evil.example"


@pytest.mark.anyio
async def test_cross_origin_preflight_gets_no_cors_headers(client):
    response = await client.options(
        "/api/health",
        headers={"Origin": EVIL, "Access-Control-Request-Method": "GET"},
    )

    assert "access-control-allow-origin" not in response.headers
    assert "access-control-allow-credentials" not in response.headers


@pytest.mark.anyio
@pytest.mark.parametrize("origin", [EVIL, "http://localhost:5173"])
async def test_request_with_an_origin_gets_no_cors_headers(client, origin):
    response = await client.get("/api/health", headers={"Origin": origin})

    assert response.status_code == 200
    assert "access-control-allow-origin" not in response.headers


class Out(APIModel):
    name: str


class In(InputModel):
    name: str


def test_api_model_reads_attributes_and_strips_whitespace():
    assert Out.model_validate(SimpleNamespace(name="  Tower A  ")).name == "Tower A"


def test_input_model_strips_whitespace_and_forbids_unknown_fields():
    assert In.model_validate({"name": " x "}).name == "x"
    with pytest.raises(ValidationError, match="Extra inputs are not permitted"):
        In.model_validate({"name": "x", "role": "admin"})
