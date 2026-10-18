"""`queue_email` (P3-02 criteria 10 and 11): validates, renders, then enqueues; never commits."""

from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.email.service import queue_email
from app.jobs.models import Job, JobStatus
from tests.email.conftest import point_settings_at

pytestmark = pytest.mark.anyio


@pytest.fixture(autouse=True)
def _email_settings(monkeypatch: pytest.MonkeyPatch) -> None:
    point_settings_at(monkeypatch, 1025)


async def job_count(db: AsyncSession) -> int:
    return (
        await db.scalar(select(func.count()).select_from(Job).where(Job.kind == "email.send")) or 0
    )


async def test_queue_email_enqueues_one_email_send_job(db: AsyncSession) -> None:
    job_id = await queue_email(
        db, to="dev@example.test", template="test", context={"name": "Ann"}, locale="fr"
    )

    job = await db.get(Job, job_id)
    assert job is not None
    assert job.kind == "email.send"
    assert job.status is JobStatus.QUEUED
    assert job.payload == {
        "to": "dev@example.test",
        "template": "test",
        "locale": "fr",
        "context": {"name": "Ann"},
    }


async def test_queue_email_dedupes_on_its_key(db: AsyncSession) -> None:
    first = await queue_email(db, to="a@example.test", template="test", context={}, dedupe_key="k1")
    second = await queue_email(
        db, to="a@example.test", template="test", context={}, dedupe_key="k1"
    )

    assert first is not None
    assert second is None
    assert await job_count(db) == 1


# Criterion 10

BAD_ARGUMENTS: list[tuple[str, dict[str, Any]]] = [
    ("unknown template", {"template": "nope"}),
    ("traversal in the template name", {"template": "../en/test"}),
    ("upper-case template name", {"template": "Test"}),
    ("unsupported locale", {"locale": "de"}),
    ("no @", {"to": "dev.example.test"}),
    ("two @", {"to": "a@b@example.test"}),
    ("two addresses", {"to": "a@example.test, b@example.test"}),
    ("a display name", {"to": "Ann <a@example.test>"}),
    ("CR LF", {"to": "a@example.test\r\nBcc: b@example.test"}),
    ("LF", {"to": "a@example.test\n"}),
    ("whitespace", {"to": " a@example.test"}),
    ("NUL", {"to": "a\x00@example.test"}),
    ("too long", {"to": "a" * 243 + "@example.test"}),
    ("empty", {"to": ""}),
    ("context not JSON", {"context": {"when": object()}}),
    ("context key not a string", {"context": {1: "x"}}),
    ("context not a dict", {"context": ["x"]}),
    # What Postgres's JSONB or the jobs table would refuse, aborting the caller's transaction
    # (review round 1).
    ("NaN", {"context": {"n": float("nan")}}),
    ("Infinity", {"context": {"n": float("inf")}}),
    ("-Infinity", {"context": {"n": [-float("inf")]}}),
    ("NUL in a value", {"context": {"name": "a\x00b"}}),
    ("NUL in a nested value", {"context": {"rows": [{"x": "\x00"}]}}),
    ("NUL in a key", {"context": {"na\x00me": "x"}}),
    ("NUL in a tuple", {"context": {"rows": ("ok", "\x00")}}),
    ("lone surrogate", {"context": {"name": "\ud800"}}),
    ("dedupe key too long", {"dedupe_key": "k" * 201}),
    ("dedupe key with NUL", {"dedupe_key": "k\x00"}),
]


@pytest.mark.parametrize(
    "overrides", [b for _, b in BAD_ARGUMENTS], ids=[a for a, _ in BAD_ARGUMENTS]
)
async def test_queue_email_rejects_bad_arguments_and_enqueues_nothing(
    db: AsyncSession, overrides: dict[str, Any]
) -> None:
    arguments: dict[str, Any] = {"to": "dev@example.test", "template": "test", "context": {}}

    with pytest.raises(ValueError):  # each case has its own message
        await queue_email(db, **(arguments | overrides))

    # Raised before any SQL: the caller's transaction is still usable.
    assert await db.scalar(select(1)) == 1
    assert await job_count(db) == 0


async def test_queue_email_accepts_the_longest_address(db: AsyncSession) -> None:
    address = "a" * 241 + "@example.test"
    assert len(address) == 254

    assert await queue_email(db, to=address, template="test", context={}) is not None


async def test_queue_email_rejects_a_context_missing_a_variable(
    db: AsyncSession, tmp_path, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.email import templates

    (tmp_path / "en").mkdir()
    files = {
        "base.txt": "{% block body %}{% endblock %}",
        "base.html": "{% block body %}{% endblock %}",
        "needs.subject.txt": "For {{ name }}",
        "needs.txt": "x",
        "needs.html": "x",
    }
    for name, text in files.items():
        (tmp_path / "en" / name).write_text(text)
    monkeypatch.setattr(templates, "TEMPLATES_DIR", tmp_path)

    with pytest.raises(ValueError, match="'name' is undefined"):
        await queue_email(db, to="dev@example.test", template="needs", context={})

    assert await job_count(db) == 0
    assert await queue_email(db, to="dev@example.test", template="needs", context={"name": "A"})


# Criterion 11


async def test_rolled_back_transaction_leaves_no_job(db: AsyncSession) -> None:
    async with db.begin_nested() as savepoint:
        await queue_email(db, to="dev@example.test", template="test", context={})
        assert await job_count(db) == 1
        await savepoint.rollback()

    assert await job_count(db) == 0
