"""Database test infrastructure: per-test isolation, schema from Alembic, test-DB guard.

The two `_probe` tests run in file order: the first commits DDL and a row inside its test
transaction, the second proves both were rolled back.
"""

import pytest
from fastapi import Depends
from sqlalchemy import text
from sqlalchemy.engine import make_url
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession

from app.core.config import settings
from app.core.dependencies import get_db_session
from app.main import app
from tests.conftest import UnsafeTestDatabaseError, assert_safe_test_database_url


@pytest.mark.anyio
async def test_commit_inside_test_transaction_is_visible_to_the_test_only(
    db: AsyncSession, engine: AsyncEngine
):
    await db.execute(text("CREATE TABLE _probe (id integer PRIMARY KEY)"))
    await db.execute(text("INSERT INTO _probe (id) VALUES (1)"))
    await db.commit()

    # The session keeps working after commit() and still sees its own row.
    assert (await db.execute(text("SELECT count(*) FROM _probe"))).scalar_one() == 1

    # commit() only released a savepoint: another connection can't see the table yet.
    async with engine.connect() as other:
        found = await other.execute(text("SELECT to_regclass('public._probe')"))
        assert found.scalar_one() is None


@pytest.mark.anyio
async def test_previous_test_ddl_and_rows_were_rolled_back(db: AsyncSession):
    found = await db.execute(text("SELECT to_regclass('public._probe')"))
    assert found.scalar_one() is None


@pytest.mark.anyio
async def test_schema_is_built_by_alembic(db: AsyncSession):
    heads = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalars().all()
    assert heads == ["989e5bd83064"]


@pytest.mark.anyio
async def test_tests_run_against_the_test_database_not_the_dev_database(engine: AsyncEngine):
    assert engine.url.database is not None
    assert engine.url.database.endswith("_test")
    assert engine.url.database != make_url(settings.database_url).database


@pytest.mark.anyio
async def test_client_requests_use_the_test_session(client, db: AsyncSession):
    await db.execute(text("CREATE TABLE _client_probe (note text)"))
    await db.execute(text("INSERT INTO _client_probe (note) VALUES ('from-the-test')"))

    async def read_probe(session: AsyncSession = Depends(get_db_session)) -> dict[str, str]:
        note = (await session.execute(text("SELECT note FROM _client_probe"))).scalar_one()
        return {"note": note}

    app.add_api_route("/__test__/client-probe", read_probe, methods=["GET"])
    try:
        response = await client.get("/__test__/client-probe")
    finally:
        app.router.routes = [
            r for r in app.router.routes if getattr(r, "path", None) != "/__test__/client-probe"
        ]

    assert response.status_code == 200
    assert response.json() == {"note": "from-the-test"}


@pytest.mark.parametrize(
    ("test_url", "dev_url"),
    [
        # Name doesn't end in _test.
        (
            "postgresql+asyncpg://postgres:pw@localhost:5432/condo_dev",
            "postgresql+asyncpg://postgres:pw@localhost:5432/other_dev",
        ),
        # Same database as DATABASE_URL, even if it is called *_test.
        (
            "postgresql+asyncpg://postgres:pw@localhost:5432/condo_test",
            "postgresql+asyncpg://postgres:pw@localhost:5432/condo_test",
        ),
        # No database name at all.
        (
            "postgresql+asyncpg://postgres:pw@localhost:5432",
            "postgresql+asyncpg://postgres:pw@localhost:5432/condo_dev",
        ),
    ],
)
def test_guard_refuses_unsafe_test_database_urls(test_url: str, dev_url: str):
    with pytest.raises(UnsafeTestDatabaseError):
        assert_safe_test_database_url(test_url, dev_url)


def test_guard_accepts_a_separate_test_database():
    assert_safe_test_database_url(
        "postgresql+asyncpg://postgres:pw@localhost:5432/condo_test",
        "postgresql+asyncpg://postgres:pw@localhost:5432/condo_dev",
    )
