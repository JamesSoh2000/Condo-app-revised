"""Operator commands: `python -m app.cli --help` (P1-06).

A command is a use-case, like a service function: it opens its own session through
`run_in_session` and commits once, at the end (CLAUDE.md rule 5). What it calls only flushes.
"""

import asyncio
from collections.abc import Awaitable, Callable

import typer
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.database import AsyncSessionLocal, dispose_database_engine
from app.seed import SeedRefusedError, check_seed_allowed, seed

app = typer.Typer(help="Condo management operator commands.", no_args_is_help=True)


def run_in_session(work: Callable[[AsyncSession], Awaitable[None]]) -> None:
    """Run `work` in a new session and commit once after it returns; on an error, commit nothing."""

    async def main() -> None:
        try:
            async with AsyncSessionLocal() as db:
                await work(db)
                await db.commit()
        finally:
            # The engine's pool belongs to this event loop, which asyncio.run closes next.
            await dispose_database_engine()

    asyncio.run(main())


@app.command("seed")
def seed_command(
    reset: bool = typer.Option(
        False, "--reset", help="Delete every domain row first (APP_ENV=dev only)."
    ),
) -> None:
    """Create or restore the demo buildings and accounts (README, "Seeded accounts")."""
    app_env = settings.app_env
    try:
        # Before any session: a refused seed must not touch the database at all.
        check_seed_allowed(app_env, reset=reset)
    except SeedRefusedError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc

    async def work(db: AsyncSession) -> None:
        await seed(db, app_env=app_env, reset=reset)

    run_in_session(work)
    typer.echo(f"seeded{' after reset' if reset else ''} (APP_ENV={app_env})")


def _placeholder(name: str, ticket: str) -> None:
    def command() -> None:
        typer.echo(f"error: {name} is not implemented yet; {ticket} adds it", err=True)
        raise typer.Exit(1)

    app.command(name, help=f"Not implemented yet ({ticket}).")(command)


# Fail loudly: a script that calls a placeholder must not mistake it for success.
_placeholder("bootstrap-building", "P4-03")
_placeholder("audit", "P2-04")
_placeholder("jobs-status", "P3-01")
_placeholder("email-test", "P3-02")


if __name__ == "__main__":
    app()
