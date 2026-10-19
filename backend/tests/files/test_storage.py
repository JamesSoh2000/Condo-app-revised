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


# --- P3-04c criterion 26: delete_versions ------------------------------------------------------


def _left_under(s3, bucket: str, key: str) -> list[str]:
    listed = s3.list_object_versions(Bucket=bucket, Prefix=key)
    entries = listed.get("Versions", []) + listed.get("DeleteMarkers", [])
    return [entry["VersionId"] for entry in entries if entry["Key"] == key]


async def test_delete_versions_removes_every_version_and_delete_marker(s3, s3_bucket):
    s3.put_object(Bucket=s3_bucket, Key="t/d", Body=b"one")
    s3.put_object(Bucket=s3_bucket, Key="t/d", Body=b"two")
    s3.delete_object(Bucket=s3_bucket, Key="t/d")  # a delete marker on top
    assert len(_left_under(s3, s3_bucket, "t/d")) == 3

    await storage.delete_versions("t/d")

    assert _left_under(s3, s3_bucket, "t/d") == []


async def test_delete_versions_leaves_a_key_with_the_same_prefix(s3, s3_bucket):
    s3.put_object(Bucket=s3_bucket, Key="t/e", Body=b"mine")
    s3.put_object(Bucket=s3_bucket, Key="t/e-other", Body=b"not mine")

    await storage.delete_versions("t/e")

    assert _left_under(s3, s3_bucket, "t/e") == []
    assert len(_left_under(s3, s3_bucket, "t/e-other")) == 1


async def test_delete_versions_of_an_empty_key_is_a_no_op(s3, s3_bucket):
    await storage.delete_versions("t/never-uploaded")

    assert _left_under(s3, s3_bucket, "t/never-uploaded") == []


async def test_delete_versions_raises_when_s3_refuses_an_object(s3, s3_bucket, monkeypatch):
    s3.put_object(Bucket=s3_bucket, Key="t/f", Body=b"kept")
    real = storage.client()

    class Refusing:
        def __getattr__(self, name):
            return getattr(real, name)

        def delete_objects(self, **kwargs):
            entry = kwargs["Delete"]["Objects"][0]
            return {"Errors": [{"Key": entry["Key"], "Code": "AccessDenied", "Message": "no"}]}

    monkeypatch.setattr(storage, "client", lambda: Refusing())

    with pytest.raises(storage.DeleteVersionsError):
        await storage.delete_versions("t/f")
    assert len(_left_under(s3, s3_bucket, "t/f")) == 1
