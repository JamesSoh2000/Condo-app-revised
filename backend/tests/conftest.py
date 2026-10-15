"""Shared test fixtures.

The test database (`TEST_DATABASE_URL`) is rebuilt once per session with `alembic upgrade head`.
Each test then runs on one connection inside an outer transaction that is rolled back at the end.
The test's session and each request's session join it with
`join_transaction_mode="create_savepoint"`, so `commit()` in code under test only releases a
savepoint (docs/ARCHITECTURE.md §14).
"""

import asyncio
from collections.abc import AsyncIterator, Iterator
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from httpx import ASGITransport, AsyncClient
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncConnection, AsyncEngine, AsyncSession, create_async_engine

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.dependencies import get_db_session
from app.main import app

BACKEND_DIR = Path(__file__).resolve().parent.parent
# asyncpg lets these query parameters override the host/port/database parsed from the URL.
_CONNECTION_OVERRIDE_PARAMS = frozenset({"database", "dbname", "host", "port", "dsn"})


class UnsafeTestDatabaseError(RuntimeError):
    """The test database URL could point at data that must not be dropped."""


def assert_safe_test_database_url(test_url: str, dev_url: str) -> None:
    """Refuse any test database that isn't clearly a separate, disposable `*_test` database."""
    test_db = make_url(test_url)
    dev_db = make_url(dev_url)
    overrides = _CONNECTION_OVERRIDE_PARAMS.intersection(test_db.query)
    if overrides:
        raise UnsafeTestDatabaseError(
            f"TEST_DATABASE_URL must not override the connection target via {sorted(overrides)}"
        )
    if not test_db.database or not test_db.database.endswith("_test"):
        raise UnsafeTestDatabaseError(
            f"TEST_DATABASE_URL database {test_db.database!r} must end in '_test'"
        )
    # Compared by name only: host aliases (localhost, 127.0.0.1, ::1) and default ports would make a
    # host/port comparison miss the same database.
    if test_db.database == dev_db.database:
        raise UnsafeTestDatabaseError("TEST_DATABASE_URL must not name the DATABASE_URL database")


async def _recreate_test_schema(test_url: str) -> None:
    url = make_url(test_url)
    # CREATE DATABASE can't run in a transaction, hence AUTOCOMMIT on the maintenance database.
    admin = create_async_engine(url.set(database="postgres"), isolation_level="AUTOCOMMIT")
    try:
        async with admin.connect() as conn:
            exists = await conn.scalar(
                text("SELECT 1 FROM pg_database WHERE datname = :name"), {"name": url.database}
            )
            if not exists:
                await conn.execute(text(f'CREATE DATABASE "{url.database}"'))
    finally:
        await admin.dispose()

    engine = create_async_engine(url)
    try:
        async with engine.begin() as conn:
            # Belt and braces: check the database the server actually connected us to.
            connected_to = await conn.scalar(text("SELECT current_database()"))
            if connected_to != url.database or not str(connected_to).endswith("_test"):
                raise UnsafeTestDatabaseError(
                    f"connected to {connected_to!r}, expected {url.database!r}; not dropping"
                )
            await conn.execute(text("DROP SCHEMA IF EXISTS public CASCADE"))
            await conn.execute(text("CREATE SCHEMA public"))
    finally:
        await engine.dispose()


@pytest.fixture(scope="session")
def anyio_backend() -> str:
    return "asyncio"


@pytest.fixture(scope="session")
def migrated_test_database() -> str:
    """Rebuild the test database's schema with the real migrations, once per session.

    Sync on purpose: Alembic's env.py calls asyncio.run(), which can't run inside the test loop.
    """
    test_url = settings.test_database_url
    assert_safe_test_database_url(test_url, settings.database_url)
    asyncio.run(_recreate_test_schema(test_url))

    alembic_cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    alembic_cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    alembic_cfg.attributes["database_url"] = test_url
    alembic_cfg.attributes["configure_logger"] = False
    command.upgrade(alembic_cfg, "head")
    return test_url


@pytest.fixture(scope="session")
async def engine(migrated_test_database: str) -> AsyncIterator[AsyncEngine]:
    test_engine = create_async_engine(migrated_test_database)
    yield test_engine
    await test_engine.dispose()


@pytest.fixture
async def db_connection(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """One connection per test, inside an outer transaction that is always rolled back."""
    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            yield conn
        finally:
            await trans.rollback()


@pytest.fixture
async def db(db_connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    """The test's session: commit() releases a savepoint; everything is rolled back at the end."""
    # The app's own session factory, so flush/expire behaviour matches production code.
    session = AsyncSessionLocal(bind=db_connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        await session.close()


@pytest.fixture
async def client(db_connection: AsyncConnection) -> AsyncIterator[AsyncClient]:
    """Async test client that hits the FastAPI app directly, on the test's connection.

    Each request gets its own session, like production (`get_db_session`), on a savepoint of the
    test's connection. It sees the test's setup, committed or only flushed. What the request
    commits stays visible to the test; what it doesn't commit is discarded when the request ends,
    on every path (success, `HTTPException`, unhandled error), as in production. The test's own
    session is never rolled back or expired by a request. Requests share one connection, so they
    must not run concurrently.
    """

    async def override_get_db_session() -> AsyncIterator[AsyncSession]:
        session = AsyncSessionLocal(bind=db_connection, join_transaction_mode="create_savepoint")
        try:
            yield session
        finally:
            # Like production's `async with AsyncSessionLocal()`: closing rolls back to the
            # request's savepoint, discarding uncommitted work, even when the endpoint raised.
            await session.close()

    app.dependency_overrides[get_db_session] = override_get_db_session
    try:
        async with AsyncClient(transport=ASGITransport(app=app), base_url="http://test") as ac:
            yield ac
    finally:
        app.dependency_overrides.pop(get_db_session, None)


@pytest.fixture(autouse=True)
def _no_leftover_dependency_overrides() -> Iterator[None]:
    yield
    assert get_db_session not in app.dependency_overrides
