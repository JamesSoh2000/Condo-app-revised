"""Job handlers by kind (P3-01a). Each is registered with `@job_handler` in its domain's module,
which the worker imports (`app.jobs.worker.HANDLER_MODULES`)."""

from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy.ext.asyncio import AsyncSession


class PermanentJobError(Exception):
    """Raised by a handler for a failure that retrying can't fix: the job goes `dead` at once."""


@dataclass(frozen=True)
class JobContext:
    # The job's own transaction: what the handler writes commits with the job's `succeeded`, and is
    # rolled back if it fails. Handlers never commit (CLAUDE.md rule 5).
    db: AsyncSession
    job_id: UUID
    kind: str
    attempt: int


type JobHandler = Callable[[dict[str, Any], JobContext], Awaitable[None]]


@dataclass(frozen=True)
class HandlerSpec:
    handler: JobHandler
    # Top-level payload keys dropped on success and redacted from `last_error` (links, tokens).
    sensitive_keys: tuple[str, ...]


HANDLERS: dict[str, HandlerSpec] = {}


def job_handler(
    kind: str, *, sensitive_keys: tuple[str, ...] = ()
) -> Callable[[JobHandler], JobHandler]:
    """Register the decorated function as the handler of `kind` (`<domain>.<verb>`)."""

    def register(handler: JobHandler) -> JobHandler:
        if kind in HANDLERS:
            raise ValueError(f"a handler for job kind {kind!r} is already registered")
        HANDLERS[kind] = HandlerSpec(handler, sensitive_keys)
        return handler

    return register
