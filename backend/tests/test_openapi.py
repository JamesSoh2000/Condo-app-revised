"""OpenAPI conventions (P1-04 criteria 7-8)."""

import json
import re
from typing import Any

import pytest
from fastapi import APIRouter

from app.core.errors import problem_responses
from app.main import app, create_app

OPERATION_ID = re.compile(r"^[a-z]+_[a-z_]+$")
PROBLEM_CONTENT = {"application/problem+json": {"schema": {"$ref": "#/components/schemas/Problem"}}}


def operation_id_problems(document: dict[str, Any]) -> list[str]:
    """Every reason the document's operation ids break the convention (empty when they don't)."""
    problems = []
    seen: set[str] = set()
    for path, operations in document["paths"].items():
        for method, operation in operations.items():
            operation_id = operation.get("operationId")
            if operation_id is None or not OPERATION_ID.fullmatch(operation_id):
                problems.append(f"{method.upper()} {path}: malformed {operation_id!r}")
            elif operation_id in seen:
                problems.append(f"{method.upper()} {path}: duplicate {operation_id!r}")
            else:
                seen.add(operation_id)
    return problems


def operations(document: dict[str, Any]) -> list[dict[str, Any]]:
    return [op for ops in document["paths"].values() for op in ops.values()]


# Criterion 7


def test_operation_ids_are_unique_and_domain_underscore_name():
    document = app.openapi()

    assert operation_id_problems(document) == []
    assert {op["operationId"] for op in operations(document)} >= {
        "health_health",
        "health_ready",
        "version_version",
    }


def test_operation_id_check_reports_duplicate_and_malformed_ids():
    # The check above must be able to fail.
    document = {
        "paths": {
            "/a": {"get": {"operationId": "units_list"}},
            "/b": {"get": {"operationId": "units_list"}, "post": {"operationId": "Units-Create"}},
            "/c": {"get": {}},
        }
    }

    assert operation_id_problems(document) == [
        "GET /b: duplicate 'units_list'",
        "POST /b: malformed 'Units-Create'",
        "GET /c: malformed None",
    ]


def test_route_without_a_tag_fails_when_declared():
    untagged = APIRouter()

    @untagged.get("/untagged")
    async def untagged_route() -> None:
        return None

    with pytest.raises(ValueError, match=r"untagged_route.*tag"):
        create_app().include_router(untagged)


# Criterion 8

router = APIRouter(prefix="/probe", tags=["probe"])


@router.get("/documented/{item_id}", responses=problem_responses(404, 409))
async def documented(item_id: int) -> dict[str, int]:
    return {"item_id": item_id}


def test_problem_responses_document_the_problem_schema_as_problem_json():
    test_app = create_app()
    test_app.include_router(router, prefix="/api")

    document = test_app.openapi()
    responses = document["paths"]["/api/probe/documented/{item_id}"]["get"]["responses"]

    assert responses["404"]["content"] == PROBLEM_CONTENT
    assert responses["409"]["content"] == PROBLEM_CONTENT
    assert responses["404"]["description"] == "Not Found"
    assert responses["422"]["content"] == PROBLEM_CONTENT
    problem = document["components"]["schemas"]["Problem"]
    assert set(problem["required"]) == {"type", "title", "status", "code", "request_id"}
    assert "errors" in problem["properties"]


def test_no_operation_documents_fastapis_default_validation_error():
    test_app = create_app()
    test_app.include_router(router, prefix="/api")

    document = test_app.openapi()

    assert "HTTPValidationError" not in json.dumps(document)
    for operation in operations(document):
        if "422" in operation["responses"]:
            assert operation["responses"]["422"]["content"] == PROBLEM_CONTENT
