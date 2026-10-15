import asyncio
from logging.config import fileConfig

from alembic import context
from sqlalchemy import pool
from sqlalchemy.engine import Connection
from sqlalchemy.ext.asyncio import async_engine_from_config

from app.core.config import settings
from app.models.base import Base

# Autogenerate only sees tables whose model modules are imported. When a feature module defines a
# real table (P1-01 onwards), import it here (e.g. `import app.buildings.models`), with a noqa for
# F401 since the import is only for its side effect. The P0 stubs have no table yet and can't be
# imported: they raise "does not have a __table__ or __tablename__".

config = context.config

# Programmatic callers (the test suite) keep the app's logging: fileConfig would replace the root
# handlers and disable every logger created before it.
if config.config_file_name is not None and config.attributes.get("configure_logger", True):
    fileConfig(config.config_file_name)

target_metadata = Base.metadata

# Callers (the test suite) can point Alembic at another database with
# `Config.attributes["database_url"]`; otherwise DATABASE_URL is used.
database_url: str = config.attributes.get("database_url", settings.database_url)


def run_migrations_offline() -> None:
    url = database_url
    context.configure(
        url=url,
        target_metadata=target_metadata,
        literal_binds=True,
        dialect_opts={"paramstyle": "named"},
    )

    with context.begin_transaction():
        context.run_migrations()


def do_run_migrations(connection: Connection) -> None:
    context.configure(
        connection=connection,
        target_metadata=target_metadata,
    )

    with context.begin_transaction():
        context.run_migrations()


async def run_async_migrations() -> None:
    configuration = config.get_section(config.config_ini_section, {})
    configuration["sqlalchemy.url"] = database_url

    connectable = async_engine_from_config(
        configuration,
        prefix="sqlalchemy.",
        poolclass=pool.NullPool,
    )

    async with connectable.connect() as connection:
        # Since alembic is synchronous while SQLalchemy is async,
        # SQLalchemy needs a bridge function (run_sync) for Alembic to run the migration.
        await connection.run_sync(do_run_migrations)

    await connectable.dispose()


def run_migrations_online() -> None:
    asyncio.run(run_async_migrations())


if context.is_offline_mode():
    run_migrations_offline()
else:
    run_migrations_online()
