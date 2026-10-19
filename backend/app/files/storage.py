"""The only code that talks to S3 (ADR-0007). boto3 blocks, so each call runs in anyio's threads.

Locally `S3_ENDPOINT_URL` points the API at the emulator and presigned URLs use
`S3_PUBLIC_ENDPOINT_URL`, the address the browser can reach; in production both are unset (the
settings validator enforces it) and boto3 talks to AWS. The bucket is read from settings on every
call.
"""

from dataclasses import dataclass
from functools import lru_cache
from typing import TYPE_CHECKING

import anyio.to_thread
import boto3
from botocore.config import Config
from botocore.exceptions import ClientError

from app.core.config import settings

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

# HEAD reports a missing key as a bare 404 (it has no body to name NoSuchKey).
_MISSING = frozenset({"404", "NoSuchKey", "NotFound"})
_MISSING_VERSION = _MISSING | {"NoSuchVersion"}


class DeleteVersionsError(RuntimeError):
    """S3 refused to delete some versions of a key; the message names error codes only."""


@dataclass(frozen=True, slots=True)
class PresignedPost:
    url: str
    fields: dict[str, str]


@dataclass(frozen=True, slots=True)
class ObjectHead:
    size: int
    content_type: str
    # None (or "null") when the bucket isn't versioned.
    version_id: str | None


def _client_for(endpoint_url: str | None) -> S3Client:
    return boto3.client(
        "s3",
        region_name=settings.aws_region,
        endpoint_url=endpoint_url,
        config=Config(
            signature_version="s3v4",
            # The emulator serves the bucket in the path, not as a subdomain.
            s3={"addressing_style": "path" if endpoint_url else "auto"},
            connect_timeout=5,
            read_timeout=10,
            retries={"max_attempts": 3, "mode": "standard"},
        ),
    )


@lru_cache
def client() -> S3Client:
    """The API's own client (boto3 clients are thread-safe)."""
    return _client_for(settings.s3_endpoint_url)


@lru_cache
def _presigning_client() -> S3Client:
    # Signing is local, but a presigned URL names its host, which must be the browser's.
    return _client_for(settings.s3_public_endpoint_url or settings.s3_endpoint_url)


async def presign_post(
    key: str, *, content_type: str, size_bytes: int, expires_in: int
) -> PresignedPost:
    """A POST form for exactly `size_bytes` bytes of `content_type` at `key`; S3 enforces both."""

    def sign() -> PresignedPost:
        post = _presigning_client().generate_presigned_post(
            Bucket=settings.s3_bucket_name,
            Key=key,
            Fields={"Content-Type": content_type},
            Conditions=[
                {"Content-Type": content_type},
                ["content-length-range", size_bytes, size_bytes],
            ],
            ExpiresIn=expires_in,
        )
        return PresignedPost(url=post["url"], fields={k: str(v) for k, v in post["fields"].items()})

    return await anyio.to_thread.run_sync(sign)


async def head(key: str) -> ObjectHead | None:
    """The latest version's size, type and version ID, or None if nothing is stored at `key`."""

    def call() -> ObjectHead | None:
        try:
            found = client().head_object(Bucket=settings.s3_bucket_name, Key=key)
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _MISSING:
                return None
            raise
        return ObjectHead(
            size=found["ContentLength"],
            content_type=found.get("ContentType", ""),
            version_id=found.get("VersionId"),
        )

    return await anyio.to_thread.run_sync(call)


async def get_range(key: str, version_id: str, length: int) -> bytes | None:
    """The first `length` bytes of one version of `key` (fewer if the object is shorter), or None
    if that version is gone."""

    def call() -> bytes | None:
        try:
            found = client().get_object(
                Bucket=settings.s3_bucket_name,
                Key=key,
                VersionId=version_id,
                Range=f"bytes=0-{length - 1}",
            )
        except ClientError as exc:
            if exc.response.get("Error", {}).get("Code") in _MISSING_VERSION:
                return None
            raise
        body = found["Body"]
        try:
            return body.read(length)
        finally:
            body.close()

    return await anyio.to_thread.run_sync(call)


async def presign_get(key: str, version_id: str, disposition: str, *, expires_in: int) -> str:
    """A GET URL for one version of `key`, valid `expires_in` seconds; S3 serves it with this
    `Content-Disposition`."""

    def sign() -> str:
        return _presigning_client().generate_presigned_url(
            "get_object",
            Params={
                "Bucket": settings.s3_bucket_name,
                "Key": key,
                "VersionId": version_id,
                "ResponseContentDisposition": disposition,
            },
            ExpiresIn=expires_in,
        )

    return await anyio.to_thread.run_sync(sign)


async def delete_versions(key: str) -> None:
    """Delete every version and delete marker of `key`, so nothing is left under it.

    Nothing stored is not an error. Raises `DeleteVersionsError` if S3 refuses any object.
    """

    def call() -> None:
        s3 = client()
        pages = s3.get_paginator("list_object_versions").paginate(
            Bucket=settings.s3_bucket_name, Prefix=key
        )
        found = [
            {"Key": key, "VersionId": entry["VersionId"]}
            for page in pages
            for entry in page.get("Versions", []) + page.get("DeleteMarkers", [])
            # A prefix also matches longer keys.
            if entry["Key"] == key
        ]
        for start in range(0, len(found), 1000):  # the most one request may delete
            result = s3.delete_objects(
                Bucket=settings.s3_bucket_name,
                Delete={"Objects": found[start : start + 1000], "Quiet": True},  # type: ignore[typeddict-item]
            )
            if errors := result.get("Errors"):
                raise DeleteVersionsError(
                    f"S3 refused {len(errors)} object(s), first {errors[0].get('Code')}"
                )

    await anyio.to_thread.run_sync(call)
