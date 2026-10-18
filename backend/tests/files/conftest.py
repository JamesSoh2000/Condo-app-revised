"""The files tests run against the S3 emulator (compose's `s3`, CI's `s3` service).

Each pytest session creates a versioned bucket of its own, `condo-test-<pid>-<8 hex>`, points
`settings.s3_bucket_name` at it, and empties and deletes it at the end, so concurrent suites never
share objects (the same reason as the per-run database, tests/conftest.py).
"""

import os
import secrets
from collections.abc import Iterator
from typing import Any

import httpx
import pytest
from mypy_boto3_s3 import S3Client

from app.core.config import settings
from app.files import storage

PNG = b"\x89PNG\r\n\x1a\n"
PDF = b"%PDF-1.7\n"


def png(size: int = 64, fill: bytes = b"\x00") -> bytes:
    return (PNG + fill * size)[:size]


def pdf(size: int = 64) -> bytes:
    return (PDF + b"\x00" * size)[:size]


@pytest.fixture(scope="session")
def s3_bucket() -> Iterator[str]:
    if settings.s3_endpoint_url is None:
        pytest.fail("the files tests need the S3 emulator: set S3_ENDPOINT_URL (`make test` does)")
    client = storage.client()
    name = f"condo-test-{os.getpid()}-{secrets.token_hex(4)}"
    client.create_bucket(
        Bucket=name, CreateBucketConfiguration={"LocationConstraint": settings.aws_region}
    )
    client.put_bucket_versioning(Bucket=name, VersioningConfiguration={"Status": "Enabled"})
    patch = pytest.MonkeyPatch()
    patch.setattr(settings, "s3_bucket_name", name)
    try:
        yield name
    finally:
        patch.undo()
        versions = client.list_object_versions(Bucket=name)
        for entry in versions.get("Versions", []) + versions.get("DeleteMarkers", []):
            client.delete_object(Bucket=name, Key=entry["Key"], VersionId=entry["VersionId"])
        client.delete_bucket(Bucket=name)


@pytest.fixture(autouse=True)
def _bucket(s3_bucket: str) -> str:
    return s3_bucket


@pytest.fixture
def s3() -> S3Client:
    return storage.client()


async def post_form(upload: dict[str, Any], data: bytes, **field_overrides: str) -> httpx.Response:
    """Upload `data` with a presigned POST, as the browser does (the file field goes last)."""
    fields = {**upload["fields"], **field_overrides}
    async with httpx.AsyncClient() as browser:
        return await browser.post(upload["url"], data=fields, files={"file": ("f", data)})
