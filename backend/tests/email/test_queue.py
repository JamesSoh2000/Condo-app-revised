"""`queue_email` (P3-02 criteria 10 and 11): validates, renders, then enqueues; never commits."""

from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.email.service import EmailRecipient, queue_email, queue_emails
from app.email.templates import render_email
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


@pytest.mark.parametrize(
    "address", ["first.last@example.test", "a.b.c+tag@example.test", "o'reilly@example.test"]
)
async def test_queue_email_accepts_dotted_local_parts(db: AsyncSession, address: str) -> None:
    assert await queue_email(db, to=address, template="test", context={}) is not None


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
    # Review round 2: dot-atom local parts, and the RFC 5321 length limits a server would refuse.
    ("leading dot", {"to": ".ann@example.test"}),
    ("double dot", {"to": "ann..lee@example.test"}),
    ("trailing dot", {"to": "ann.@example.test"}),
    ("local part over 64", {"to": "a" * 65 + "@example.test"}),
    ("domain label over 63", {"to": "a@" + "b" * 64 + ".test"}),
    ("domain trailing dot", {"to": "a@example.test."}),
    # Review round 3: addresses are ASCII (no SMTPUTF8), so the 64 and 254 limits are octets too.
    ("lone surrogate in to", {"to": "\ud800@example.test"}),
    ("non-ASCII local part", {"to": "\u00e9" * 33 + "@example.test"}),
    ("non-ASCII domain", {"to": "a@\u00e9xample.test"}),
    ("dedupe key with a lone surrogate", {"dedupe_key": "email:\ud800"}),
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
    # A 64-character local part and 63-character labels: every limit at once.
    address = "a" * 64 + "@" + ".".join(["b" * 63, "c" * 63, "d" * 56]) + ".test"
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


# `queue_emails` (P6-01c): one template and context to many recipients, in one INSERT


async def test_queue_emails_enqueues_one_job_per_recipient_in_one_statement(
    db: AsyncSession, statements: list[str]
) -> None:
    await db.flush()
    statements.clear()

    queued = await queue_emails(
        db,
        template="test",
        context={"name": "Ann"},
        recipients=[
            EmailRecipient("b@example.test", "fr", "k:b"),
            EmailRecipient("a@example.test"),
        ],
    )

    assert queued == 2
    assert [s.split(" (")[0] for s in statements] == ["INSERT INTO jobs"]
    jobs = (await db.scalars(select(Job).order_by(Job.id))).all()
    assert [(job.kind, job.dedupe_key, job.payload) for job in jobs] == [
        (
            "email.send",
            "k:b",
            {
                "to": "b@example.test",
                "template": "test",
                "locale": "fr",
                "context": {"name": "Ann"},
            },
        ),
        (
            "email.send",
            None,
            {
                "to": "a@example.test",
                "template": "test",
                "locale": "en",
                "context": {"name": "Ann"},
            },
        ),
    ]


async def test_queue_emails_counts_only_what_its_dedupe_keys_let_in(db: AsyncSession) -> None:
    await queue_email(db, to="a@example.test", template="test", context={}, dedupe_key="k:a")

    queued = await queue_emails(
        db,
        template="test",
        context={},
        recipients=[
            EmailRecipient("a@example.test", dedupe_key="k:a"),
            EmailRecipient("b@example.test"),
        ],
    )

    assert queued == 1
    assert await job_count(db) == 2


async def test_queue_emails_to_nobody_sends_nothing(
    db: AsyncSession, statements: list[str]
) -> None:
    await db.flush()
    statements.clear()

    assert await queue_emails(db, template="test", context={}, recipients=[]) == 0
    assert statements == []


@pytest.mark.parametrize(
    "overrides", [b for _, b in BAD_ARGUMENTS], ids=[a for a, _ in BAD_ARGUMENTS]
)
async def test_queue_emails_rejects_bad_arguments_and_enqueues_nothing(
    db: AsyncSession, overrides: dict[str, Any]
) -> None:
    # The same refusals as `queue_email`, for the second recipient: nothing of the first is queued.
    second = EmailRecipient(
        overrides.get("to", "dev@example.test"),
        overrides.get("locale", "en"),
        overrides.get("dedupe_key"),
    )

    with pytest.raises(ValueError):
        await queue_emails(
            db,
            template=overrides.get("template", "test"),
            context=overrides.get("context", {}),
            recipients=[EmailRecipient("ok@example.test"), second],
        )

    assert await db.scalar(select(1)) == 1
    assert await job_count(db) == 0


async def test_queue_emails_renders_in_every_recipients_locale(
    db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.email import service

    rendered: list[str] = []
    original = render_email

    def spy(template: str, context: dict[str, Any], locale: str) -> Any:
        rendered.append(locale)
        return original(template, context, locale)

    monkeypatch.setattr(service, "render_email", spy)

    await queue_emails(
        db,
        template="test",
        context={},
        recipients=[
            EmailRecipient(f"u{n}@example.test", locale)
            for n, locale in enumerate(["fr", "en", "fr"])
        ],
    )

    # Once per locale, not per recipient.
    assert sorted(rendered) == ["en", "fr"]
