"""`app.files.storage` against the S3 emulator."""

from urllib.parse import urlsplit

import httpx
import pytest

from app.core.config import settings
from app.files import storage
from tests.files.conftest import png

pytestmark = pytest.mark.anyio


async def test_head_of_a_missing_key_is_none(s3_bucket):
    assert await storage.head("b/none/package_photo/missing") is None


async def test_head_and_get_range_read_the_given_version(s3, s3_bucket):
    first = s3.put_object(Bucket=s3_bucket, Key="t/k", Body=b"first-bytes", ContentType="image/png")
    s3.put_object(Bucket=s3_bucket, Key="t/k", Body=b"second", ContentType="image/jpeg")

    found = await storage.head("t/k")

    assert found is not None
    assert (found.size, found.content_type) == (6, "image/jpeg")
    assert await storage.get_range("t/k", first["VersionId"], 5) == b"first"
    assert await storage.get_range("t/k", found.version_id or "", 16) == b"second"


async def test_presign_post_signs_for_the_public_endpoint(s3, s3_bucket):
    post = await storage.presign_post("t/p", content_type="image/png", size_bytes=8, expires_in=60)

    public = settings.s3_public_endpoint_url or settings.s3_endpoint_url
    assert public is not None
    assert urlsplit(post.url).netloc == urlsplit(public).netloc
    async with httpx.AsyncClient() as browser:
        r = await browser.post(post.url, data=post.fields, files={"file": ("f", png(8))})
    assert r.status_code == 204, r.text
    assert s3.head_object(Bucket=s3_bucket, Key="t/p")["ContentType"] == "image/png"
