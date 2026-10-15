# /// script
# requires-python = ">=3.12"
# dependencies = ["boto3>=1.35", "httpx>=0.28"]
# ///
"""Smoke test for the local S3 emulator (P0-04a AC2, ADR-0007).

Checks that the emulator enforces what the upload flow relies on: a presigned POST's size and
Content-Type policy, bucket versioning (a VersionId on every object), and CORS for the app origin
only.

    make up && make s3-smoke

Exits 1 if any check fails. Env: S3_PUBLIC_ENDPOINT_URL (default http://localhost:4566),
S3_BUCKET_NAME (default condo-app-dev-files).
"""

import os
import sys
import uuid

import boto3
import httpx

ENDPOINT = os.environ.get("S3_PUBLIC_ENDPOINT_URL", "http://localhost:4566")
BUCKET = os.environ.get("S3_BUCKET_NAME", "condo-app-dev-files")
APP_ORIGIN = "http://localhost:5173"
OTHER_ORIGIN = "http://evil.example"
MAX_BYTES = 1024

s3 = boto3.client(
    "s3",
    endpoint_url=ENDPOINT,
    region_name="ca-central-1",
    aws_access_key_id="test",  # LocalStack accepts any credentials
    aws_secret_access_key="test",  # noqa: S106
)
failures: list[str] = []


def check(name: str, ok: bool, detail: str = "") -> None:
    print(f"{'ok  ' if ok else 'FAIL'}  {name}{f'  ({detail})' if detail else ''}")
    if not ok:
        failures.append(name)


def presigned_post(key: str, size: int, content_type: str = "image/png") -> httpx.Response:
    """Uploads `size` bytes with a policy of at most MAX_BYTES and Content-Type image/png."""
    post = s3.generate_presigned_post(
        BUCKET,
        key,
        Fields={"Content-Type": "image/png"},
        Conditions=[["content-length-range", 1, MAX_BYTES], {"Content-Type": "image/png"}],
        ExpiresIn=300,
    )
    fields = {**post["fields"], "Content-Type": content_type}
    return httpx.post(post["url"], data=fields, files={"file": ("f.png", b"x" * size)})


def preflight(origin: str) -> httpx.Response:
    return httpx.options(
        f"{ENDPOINT}/{BUCKET}",
        headers={"Origin": origin, "Access-Control-Request-Method": "POST"},
    )


run = uuid.uuid4().hex
too_big = presigned_post(f"smoke/{run}/too-big", 2 * MAX_BYTES)
check(
    "2 KiB upload rejected by a 1 KiB policy", too_big.status_code >= 400, str(too_big.status_code)
)

wrong_type = presigned_post(f"smoke/{run}/wrong-type", 100, content_type="text/html")
check(
    "Content-Type outside the policy rejected",
    wrong_type.status_code >= 400,
    str(wrong_type.status_code),
)

key = f"smoke/{run}/ok"
small = presigned_post(key, 512)
check("512 B upload accepted", small.status_code in (200, 201, 204), str(small.status_code))

version_id = s3.head_object(Bucket=BUCKET, Key=key).get("VersionId") if small.is_success else None
check("head_object returns a VersionId", bool(version_id) and version_id != "null", str(version_id))

versioning = s3.get_bucket_versioning(Bucket=BUCKET).get("Status")
check("bucket versioning is Enabled", versioning == "Enabled", str(versioning))

allowed = preflight(APP_ORIGIN)
allow_origin = allowed.headers.get("Access-Control-Allow-Origin")
check(
    f"CORS preflight from {APP_ORIGIN} allowed", allowed.is_success and allow_origin == APP_ORIGIN
)

denied = preflight(OTHER_ORIGIN)
check(
    f"CORS preflight from {OTHER_ORIGIN} refused",
    not denied.is_success and denied.headers.get("Access-Control-Allow-Origin") is None,
    str(denied.status_code),
)

if failures:
    print(f"\n{len(failures)} check(s) failed")
    sys.exit(1)
print("\nall S3 emulator checks passed")
