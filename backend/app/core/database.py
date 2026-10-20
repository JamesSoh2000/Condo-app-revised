from typing import Any

from sqlalchemy import text
from sqlalchemy.ext.asyncio import (
    AsyncEngine,
    AsyncSession,
    async_sessionmaker,
    create_async_engine,
)

from app.core.config import settings


def make_engine(url: str, **options: Any) -> AsyncEngine:
    """An engine with the app's options; the tests build theirs with it too.

    `hide_parameters`: a database error's message and traceback never carry a statement's values,
    such as an emailed link in a job's payload, into a log line or stderr (ADR-0019).
    """
    return create_async_engine(url, hide_parameters=True, **options)


engine: AsyncEngine = make_engine(
    settings.database_url,
    echo=False,
    pool_pre_ping=True,
    pool_size=5,
    max_overflow=10,
)

# This is Async_session_factory
AsyncSessionLocal = async_sessionmaker(
    bind=engine,
    class_=AsyncSession,
    expire_on_commit=False,
    autoflush=False,
    autocommit=False,
)

# This is moved to dependencies.py since getting a db_session
# is mostly used as depency injection for router functions
# async def get_db_session() -> AsyncGenerator[AsyncSession, None]:
#     async with AsyncSessionLocal() as session:
#         try:
#             yield session
#         finally:
#             await session.close()


async def check_database_connection() -> None:
    async with engine.connect() as connection:
        await connection.execute(text("SELECT 1"))


async def dispose_database_engine() -> None:
    await engine.dispose()
