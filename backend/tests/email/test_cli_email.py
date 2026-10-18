"""`email-test --to ADDRESS` (P3-02 criteria 1 and 17).

The end-to-end test runs the real CLI, which opens its own event loop and commits, against this
run's database (`CommittedDb` from tests/jobs/test_cli_jobs.py), and deletes the jobs after.
"""

from collections.abc import Iterator

import pytest
from sqlalchemy import delete, select
from typer.testing import CliRunner

from app import cli
from app.jobs.models import Job, JobStatus
from tests.email.conftest import point_settings_at
from tests.jobs.test_cli_jobs import CommittedDb

runner = CliRunner()


@pytest.fixture
def committed_db(
    migrated_test_database: str, monkeypatch: pytest.MonkeyPatch
) -> Iterator[CommittedDb]:
    point_settings_at(monkeypatch, 1025)
    committed = CommittedDb(migrated_test_database)
    monkeypatch.setattr(cli, "AsyncSessionLocal", committed.factory)
    try:
        yield committed
    finally:
        committed.run(lambda db: db.execute(delete(Job)))


# Criterion 17


@pytest.mark.parametrize(
    "address", ["not-an-address", "a@example.test, b@example.test", "a@example.test\nBcc: b@x.test"]
)
def test_bad_address_exits_1_without_a_session(
    address: str, monkeypatch: pytest.MonkeyPatch
) -> None:
    def no_session(*args: object, **kwargs: object) -> None:
        raise AssertionError("opened a session")

    monkeypatch.setattr(cli, "AsyncSessionLocal", no_session)

    result = runner.invoke(cli.app, ["email-test", "--to", address])

    assert result.exit_code == 1
    assert "error:" in result.output
    # Untrusted terminal input is not echoed back.
    assert address not in result.output


def test_to_is_required() -> None:
    result = runner.invoke(cli.app, ["email-test"])

    assert result.exit_code != 0


# Criterion 1 (the queue half; the worker half is tests/email/test_send.py and the stack run)


def test_email_test_queues_one_test_email(committed_db: CommittedDb) -> None:
    result = runner.invoke(cli.app, ["email-test", "--to", "dev@example.test"])

    assert result.exit_code == 0, result.output

    async def email_jobs(db):
        return (await db.scalars(select(Job).where(Job.kind == "email.send"))).all()

    jobs = committed_db.run(email_jobs)
    assert len(jobs) == 1
    assert jobs[0].status is JobStatus.QUEUED
    assert jobs[0].payload == {
        "to": "dev@example.test",
        "template": "test",
        "locale": "en",
        "context": {},
    }
    assert result.output == f"queued email job {jobs[0].id}\n"
