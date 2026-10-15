"""Database test infrastructure: per-test isolation, schema from Alembic, test-DB guard.

The two `_probe` tests run in file order: the first commits DDL and a row inside its test
transaction, the second proves both were rolled back.
"""

import contextlib
from collections.abc import Callable, Iterator
from typing import Annotated, Any

import pytest
from alembic.config import Config
from alembic.script import ScriptDirectory
from fastapi import Depends, HTTPException
from sqlalchemy import select, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncEngine, AsyncSession
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column

from app.core.config import settings
from app.core.database import AsyncSessionLocal
from app.core.dependencies import get_db_session
from app.main import app
from tests.conftest import BACKEND_DIR, UnsafeTestDatabaseError, assert_safe_test_database_url


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


async def _create_probe_item(session: AsyncSession, item_id: int, name: str) -> bool:
    """Shaped like a service write: commit on success, rollback on a constraint error."""
    try:
        await session.execute(
            text("INSERT INTO _rollback_probe (id, name) VALUES (:id, :name)"),
            {"id": item_id, "name": name},
        )
        await session.commit()
        return True
    except IntegrityError:
        await session.rollback()
        return False


@pytest.mark.anyio
async def test_service_rollback_after_an_error_keeps_the_test_transaction(
    db: AsyncSession, engine: AsyncEngine
):
    await db.execute(
        text("CREATE TABLE _rollback_probe (id integer PRIMARY KEY, name text UNIQUE)")
    )
    await db.commit()

    assert await _create_probe_item(db, 1, "a") is True
    assert await _create_probe_item(db, 2, "a") is False  # unique violation -> rollback()

    # rollback() only went back to the last savepoint: the table and the first row remain.
    assert (await db.execute(text("SELECT count(*) FROM _rollback_probe"))).scalar_one() == 1
    async with engine.connect() as other:
        found = await other.execute(text("SELECT to_regclass('public._rollback_probe')"))
        assert found.scalar_one() is None


@pytest.mark.anyio
async def test_previous_test_rollback_probe_was_rolled_back(db: AsyncSession):
    found = await db.execute(text("SELECT to_regclass('public._rollback_probe')"))
    assert found.scalar_one() is None


@pytest.mark.anyio
async def test_db_session_is_configured_like_the_app_session(db: AsyncSession):
    # Tests must see the same flush behaviour as production code (AsyncSessionLocal).
    assert db.sync_session.autoflush == AsyncSessionLocal.kw["autoflush"]
    assert db.sync_session.expire_on_commit == AsyncSessionLocal.kw["expire_on_commit"]


@pytest.mark.anyio
async def test_schema_is_built_by_alembic(db: AsyncSession):
    script = ScriptDirectory.from_config(Config(str(BACKEND_DIR / "alembic.ini")))
    applied = (await db.execute(text("SELECT version_num FROM alembic_version"))).scalars().all()
    assert applied == [script.get_current_head()]


@pytest.mark.anyio
async def test_tests_run_against_the_test_database_not_the_dev_database(engine: AsyncEngine):
    assert engine.url.database is not None
    assert engine.url.database.endswith("_test")
    assert engine.url.database != make_url(settings.database_url).database


@pytest.mark.anyio
async def test_client_requests_use_the_test_session(client, db: AsyncSession):
    await db.execute(text("CREATE TABLE _client_probe (note text)"))
    await db.execute(text("INSERT INTO _client_probe (note) VALUES ('from-the-test')"))

    async def read_probe(
        session: Annotated[AsyncSession, Depends(get_db_session)],
    ) -> dict[str, str]:
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
        # Same database name as DATABASE_URL through a host alias (localhost vs 127.0.0.1).
        (
            "postgresql+asyncpg://postgres:pw@127.0.0.1:5432/shared_test",
            "postgresql+asyncpg://postgres:pw@localhost/shared_test",
        ),
        # Query parameters that asyncpg uses to override the parsed URL.
        *[
            (
                f"postgresql+asyncpg://postgres:pw@localhost:5432/condo_test?{param}=condo_dev",
                "postgresql+asyncpg://postgres:pw@localhost:5432/condo_dev",
            )
            for param in ("database", "host", "port", "dsn")
        ],
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


def _add_probe_route(path: str, *, commit: bool) -> None:
    async def write_probe(
        session: Annotated[AsyncSession, Depends(get_db_session)],
    ) -> dict[str, bool]:
        await session.execute(text("INSERT INTO _request_probe (note) VALUES ('from-request')"))
        if commit:
            await session.commit()
        return {"committed": commit}

    app.add_api_route(path, write_probe, methods=["POST"])


def _remove_route(path: str) -> None:
    app.router.routes = [r for r in app.router.routes if getattr(r, "path", None) != path]


@pytest.mark.anyio
async def test_request_writes_without_commit_are_discarded_like_in_production(
    client, db: AsyncSession
):
    await db.execute(text("CREATE TABLE _request_probe (note text)"))
    await db.commit()

    _add_probe_route("/__test__/write-no-commit", commit=False)
    try:
        response = await client.post("/__test__/write-no-commit")
    finally:
        _remove_route("/__test__/write-no-commit")

    assert response.status_code == 200
    # Production closes the session without committing, so the insert is lost; tests must agree.
    assert (await db.execute(text("SELECT count(*) FROM _request_probe"))).scalar_one() == 0


@pytest.mark.anyio
async def test_request_writes_with_commit_are_visible_to_the_test(client, db: AsyncSession):
    await db.execute(text("CREATE TABLE _request_probe (note text)"))
    await db.commit()

    _add_probe_route("/__test__/write-commit", commit=True)
    try:
        response = await client.post("/__test__/write-commit")
    finally:
        _remove_route("/__test__/write-commit")

    assert response.status_code == 200
    assert (await db.execute(text("SELECT count(*) FROM _request_probe"))).scalar_one() == 1


# --- Request sessions on error paths (B-1, option A) ---------------------------------------------


class _ProbeBase(DeclarativeBase):
    """Test-only metadata, kept out of the app's Base so autogenerate never sees it."""


class _OrmProbe(_ProbeBase):
    __tablename__ = "_orm_probe"
    id: Mapped[int] = mapped_column(primary_key=True)
    name: Mapped[str]


async def _create_request_probe_table(db: AsyncSession) -> None:
    await db.execute(text("CREATE TABLE _request_probe (note text UNIQUE)"))


async def _count_request_probe(db: AsyncSession) -> int:
    return (await db.execute(text("SELECT count(*) FROM _request_probe"))).scalar_one()


@contextlib.contextmanager
def _route(path: str, endpoint: Callable[..., Any], method: str = "POST") -> Iterator[None]:
    app.add_api_route(path, endpoint, methods=[method])
    try:
        yield
    finally:
        _remove_route(path)


async def _insert(session: AsyncSession, note: str) -> None:
    await session.execute(text("INSERT INTO _request_probe (note) VALUES (:note)"), {"note": note})


@pytest.mark.anyio
async def test_request_writes_are_discarded_when_the_handler_raises_http_exception(
    client, db: AsyncSession
):
    await _create_request_probe_table(db)

    async def write_then_conflict(
        session: Annotated[AsyncSession, Depends(get_db_session)],
    ) -> None:
        await _insert(session, "uncommitted")
        raise HTTPException(status_code=409, detail="conflict")

    with _route("/__test__/write-then-409", write_then_conflict):
        response = await client.post("/__test__/write-then-409")

    assert response.status_code == 409
    # Production discards the uncommitted insert when the request fails; tests must agree.
    assert await _count_request_probe(db) == 0


@pytest.mark.anyio
async def test_request_writes_are_discarded_when_the_handler_raises_an_unhandled_error(
    client, db: AsyncSession
):
    await _create_request_probe_table(db)

    async def write_then_crash(session: Annotated[AsyncSession, Depends(get_db_session)]) -> None:
        await _insert(session, "uncommitted")
        raise RuntimeError("boom")

    with (
        _route("/__test__/write-then-crash", write_then_crash),
        pytest.raises(RuntimeError, match="boom"),
    ):
        await client.post("/__test__/write-then-crash")

    assert await _count_request_probe(db) == 0


@pytest.mark.anyio
async def test_request_work_committed_before_an_error_is_kept(client, db: AsyncSession):
    await _create_request_probe_table(db)

    async def commit_then_conflict(
        session: Annotated[AsyncSession, Depends(get_db_session)],
    ) -> None:
        await _insert(session, "committed")
        await session.commit()
        await _insert(session, "uncommitted")
        raise HTTPException(status_code=409, detail="conflict")

    with _route("/__test__/commit-then-409", commit_then_conflict):
        response = await client.post("/__test__/commit-then-409")

    assert response.status_code == 409
    notes = (await db.execute(text("SELECT note FROM _request_probe"))).scalars().all()
    assert notes == ["committed"]


@pytest.mark.anyio
async def test_next_request_works_after_a_request_caught_a_db_error(client, db: AsyncSession):
    await _create_request_probe_table(db)
    await _insert(db, "taken")

    async def insert_duplicate_and_recover(
        session: Annotated[AsyncSession, Depends(get_db_session)],
    ) -> dict[str, bool]:
        try:
            await _insert(session, "taken")
            await session.commit()
            return {"created": True}
        except IntegrityError:
            await session.rollback()
            return {"created": False}

    async def insert_fresh(session: Annotated[AsyncSession, Depends(get_db_session)]) -> None:
        await _insert(session, "fresh")
        await session.commit()

    with (
        _route("/__test__/duplicate", insert_duplicate_and_recover),
        _route("/__test__/fresh", insert_fresh),
    ):
        first = await client.post("/__test__/duplicate")
        second = await client.post("/__test__/fresh")

    assert first.json() == {"created": False}
    assert second.status_code == 200
    assert await _count_request_probe(db) == 2  # "taken" from setup + "fresh"


@pytest.mark.anyio
async def test_next_request_works_after_a_request_failed_on_an_uncaught_db_error(
    client, db: AsyncSession
):
    await _create_request_probe_table(db)
    await _insert(db, "taken")

    async def insert_duplicate(session: Annotated[AsyncSession, Depends(get_db_session)]) -> None:
        await _insert(session, "taken")
        await session.commit()

    async def insert_fresh(session: Annotated[AsyncSession, Depends(get_db_session)]) -> None:
        await _insert(session, "fresh")
        await session.commit()

    with (
        _route("/__test__/duplicate-uncaught", insert_duplicate),
        _route("/__test__/fresh-after-uncaught", insert_fresh),
    ):
        with pytest.raises(IntegrityError):
            await client.post("/__test__/duplicate-uncaught")
        second = await client.post("/__test__/fresh-after-uncaught")

    assert second.status_code == 200
    # The test's own session is still usable and sees its setup plus the second request's row.
    assert await _count_request_probe(db) == 2


async def _create_orm_probe(db: AsyncSession) -> None:
    await db.run_sync(lambda s: _ProbeBase.metadata.create_all(s.connection()))
    db.add(_OrmProbe(id=1, name="before"))
    await db.commit()


async def _get_orm_probe_count(client) -> int:
    async def count(session: Annotated[AsyncSession, Depends(get_db_session)]) -> dict[str, int]:
        return {"n": len((await session.execute(select(_OrmProbe))).scalars().all())}

    with _route("/__test__/orm-probe", count, method="GET"):
        response = await client.get("/__test__/orm-probe")
    return int(response.json()["n"])


@pytest.mark.anyio
async def test_orm_objects_loaded_by_the_test_stay_usable_after_a_request(client, db: AsyncSession):
    await _create_orm_probe(db)
    db.expunge_all()
    probe = (await db.execute(select(_OrmProbe))).scalar_one()

    assert await _get_orm_probe_count(client) == 1

    # A request must not expire the test's objects: plain attribute access, no lazy reload
    # (which raises MissingGreenlet in async code).
    assert probe.name == "before"


@pytest.mark.anyio
async def test_test_setup_flushed_but_not_committed_survives_a_request(client, db: AsyncSession):
    await _create_orm_probe(db)
    probe = await db.get(_OrmProbe, 1)
    assert probe is not None
    probe.name = "changed"
    await db.flush()  # not committed: requests see it, and a request must not undo it

    assert await _get_orm_probe_count(client) == 1

    assert probe.name == "changed"
    db.expunge_all()
    assert (await db.get(_OrmProbe, 1)).name == "changed"  # type: ignore[union-attr]
