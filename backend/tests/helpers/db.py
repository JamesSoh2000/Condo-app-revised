"""Database assertions for tests that run inside the per-test transaction (tests/conftest.py)."""

import inspect
from collections.abc import Awaitable

import pytest
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession


async def assert_integrity_error(
    db: AsyncSession, awaitable: Awaitable[object], *, constraint: str
) -> IntegrityError:
    """Await `awaitable` in a savepoint and assert it violates `constraint`; return the error.

    A failed statement aborts the whole Postgres transaction, and the test's transaction is the
    outer one: without the savepoint, every later query in the test would fail. Rolling back to
    the savepoint undoes only what `awaitable` did; rows flushed before stay. Any error other than
    an `IntegrityError` propagates.
    """
    started = False
    try:
        async with db.begin_nested():
            started = True
            await awaitable
    except IntegrityError as exc:
        # asyncpg's own exception, behind SQLAlchemy's DBAPI adapter, names the constraint.
        name = getattr(exc.orig.__cause__, "constraint_name", None) if exc.orig else None
        if name != constraint:
            pytest.fail(f"expected an IntegrityError on {constraint!r}, got one on {name!r}")
        return exc
    finally:
        if not started and inspect.iscoroutine(awaitable):
            awaitable.close()  # begin_nested() failed: don't leave a never-awaited coroutine
    pytest.fail(f"no IntegrityError raised (expected one on {constraint!r})")
