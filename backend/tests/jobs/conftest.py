"""Fixtures for the job queue tests (P3-01a): the test-only handlers and two kinds of session.

`sessions` gives the worker savepoint sessions on the test's connection, rolled back with the test.
`committed_sessions` gives real sessions on the per-run database, for tests that need real
concurrency or a second connection; it deletes the `test.*` jobs they commit.
"""

from collections.abc import AsyncIterator, Callable
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

import pytest
from sqlalchemy import delete
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession, async_sessionmaker

from app.core.database import AsyncSessionLocal
from app.jobs import registry
from app.jobs.models import Job
from app.jobs.registry import JobContext, PermanentJobError, job_handler
from app.jobs.service import enqueue

type Sessions = Callable[[], AsyncSession]


@dataclass
class Calls:
    """What the test handlers saw: one `(kind, payload, attempt)` per run."""

    runs: list[tuple[str, dict[str, Any], int]] = field(default_factory=list)

    def of(self, kind: str) -> list[tuple[str, dict[str, Any], int]]:
        return [run for run in self.runs if run[0] == kind]


class SecretFailure(Exception):
    pass


@pytest.fixture
def handlers(monkeypatch: pytest.MonkeyPatch) -> Calls:
    """Registers the test handlers on a copy of the registry, restored after the test.

    - `test.echo`: succeeds; with `"child": True` it enqueues a `test.echo` job in its transaction
    - `test.fail`: always fails, with the payload's `link` in the message (sensitive key `link`)
    - `test.flaky`: fails while `attempt < payload["succeed_on"]`
    - `test.permanent`: raises `PermanentJobError`
    - `test.slow`: sleeps `payload["seconds"]`
    - `test.secret`: succeeds; sensitive key `link`
    """
    monkeypatch.setattr(registry, "HANDLERS", dict(registry.HANDLERS))
    calls = Calls()

    @job_handler("test.echo")
    async def echo(payload: dict[str, Any], ctx: JobContext) -> None:
        calls.runs.append((ctx.kind, payload, ctx.attempt))
        if payload.get("child"):
            await enqueue(ctx.db, "test.echo", {"parent": str(ctx.job_id)})
        if payload.get("then_fail"):
            raise RuntimeError("failed after writing")

    @job_handler("test.fail", sensitive_keys=("link",))
    async def fail(payload: dict[str, Any], ctx: JobContext) -> None:
        calls.runs.append((ctx.kind, payload, ctx.attempt))
        raise SecretFailure(f"could not send {payload.get('link')} " + "x" * payload.get("pad", 0))

    @job_handler("test.flaky")
    async def flaky(payload: dict[str, Any], ctx: JobContext) -> None:
        calls.runs.append((ctx.kind, payload, ctx.attempt))
        if ctx.attempt < payload["succeed_on"]:
            raise RuntimeError(f"flaky attempt {ctx.attempt}")

    @job_handler("test.permanent")
    async def permanent(payload: dict[str, Any], ctx: JobContext) -> None:
        calls.runs.append((ctx.kind, payload, ctx.attempt))
        raise PermanentJobError("bad address")

    @job_handler("test.slow")
    async def slow(payload: dict[str, Any], ctx: JobContext) -> None:
        import asyncio

        calls.runs.append((ctx.kind, payload, ctx.attempt))
        await asyncio.sleep(payload["seconds"])

    @job_handler("test.secret", sensitive_keys=("link",))
    async def secret(payload: dict[str, Any], ctx: JobContext) -> None:
        calls.runs.append((ctx.kind, payload, ctx.attempt))

    return calls


@pytest.fixture
def sessions(db_connection: AsyncConnection) -> Sessions:
    """Worker sessions on savepoints of the test's connection: commit releases a savepoint."""
    return lambda: AsyncSessionLocal(bind=db_connection, join_transaction_mode="create_savepoint")


@pytest.fixture
async def committed_sessions(engine: AsyncEngine) -> AsyncIterator[Sessions]:
    """Real sessions on the per-run database. Deletes every `test.*` job afterwards."""
    factory = async_sessionmaker(engine, expire_on_commit=False)
    try:
        yield factory
    finally:
        async with factory() as db:
            await db.execute(delete(Job).where(Job.kind.like("test.%")))
            await db.commit()


async def load(sessions: Sessions, job_id: UUID | None) -> Job:
    assert job_id is not None
    async with sessions() as db:
        job = await db.get(Job, job_id)
        assert job is not None
        return job
