"""`python -m app.export_openapi` feeds the frontend's generated types (P1-07 criterion 1)."""

import json
import os
import subprocess
import sys

from app.main import create_app
from tests.conftest import BACKEND_DIR


def run_export(**env: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, "-m", "app.export_openapi"],
        cwd=BACKEND_DIR,
        env={**os.environ, **env},
        capture_output=True,
        text=True,
        timeout=60,
        check=False,
    )


def test_export_prints_the_apps_openapi_document_without_a_database():
    # Nothing listens on port 1: the export must not connect anywhere.
    result = run_export(DATABASE_URL="postgresql+asyncpg://nobody:nothing@127.0.0.1:1/none")

    assert result.returncode == 0, result.stderr
    assert json.loads(result.stdout) == create_app().openapi()


def test_export_is_byte_identical_between_runs():
    # A second `make gen-api` must produce no diff, so the JSON text must not vary between runs.
    first, second = run_export(), run_export()

    assert first.returncode == second.returncode == 0
    assert '"/api/version"' in first.stdout
    assert first.stdout == second.stdout


def test_version_response_is_a_typed_object():
    document = create_app().openapi()
    response = document["paths"]["/api/version"]["get"]["responses"]["200"]
    schema = response["content"]["application/json"]["schema"]

    assert schema == {"$ref": "#/components/schemas/VersionOut"}
    version_out = document["components"]["schemas"]["VersionOut"]
    assert set(version_out["required"]) == {
        "service",
        "environment",
        "git_sha",
        "image_tag",
        "build_time",
        "server_time",
    }
