"""Operator commands: `python -m app.cli --help` (P1-06).

A command is a use-case, like a service function: it opens its own session through
`run_in_session` and commits once, at the end (CLAUDE.md rule 5). What it calls only flushes.
"""

import asyncio
import re
from collections.abc import Awaitable, Callable
from datetime import timedelta
from uuid import UUID

import typer
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.report import render
from app.audit.service import AuditQuery, UnknownFilterValue, find_audit_events
from app.core import clock
from app.core.config import settings
from app.core.database import AsyncSessionLocal, dispose_database_engine
from app.seed import SeedRefusedError, check_seed_allowed, seed, seed_password_for

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
    secret = settings.seed_password
    seed_password = secret.get_secret_value() if secret is not None else None
    try:
        # Before any session: a refused seed must not touch the database at all.
        check_seed_allowed(app_env, reset=reset)
        seed_password_for(app_env, seed_password)
    except SeedRefusedError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc

    async def work(db: AsyncSession) -> None:
        await seed(db, app_env=app_env, reset=reset, seed_password=seed_password)

    run_in_session(work)
    typer.echo(f"seeded{' after reset' if reset else ''} (APP_ENV={app_env})")


_SINCE = re.compile(r"([1-9][0-9]{0,5})([mhd])")
_SINCE_UNITS = {"m": "minutes", "h": "hours", "d": "days"}


def _parse_since(value: str | None) -> timedelta | None:
    if value is None:
        return None
    match = _SINCE.fullmatch(value)
    if match is None:
        raise typer.BadParameter("use <n>m, <n>h or <n>d, for example 7d", param_hint="--since")
    window = timedelta(**{_SINCE_UNITS[match[2]]: int(match[1])})
    try:
        clock.now() - window
    except OverflowError:
        # 999999d passes the pattern but leaves datetime's range (review round 1, Claude M1).
        raise typer.BadParameter("too far back", param_hint="--since") from None
    return window


def _parse_entity(value: str | None) -> tuple[str | None, UUID | None]:
    if value is None:
        return None, None
    entity_type, _, raw_id = value.partition(":")
    try:
        if not entity_type:
            raise ValueError
        return entity_type, UUID(raw_id)
    except ValueError:
        raise typer.BadParameter(
            "use TYPE:UUID, for example session:<id>", param_hint="--entity"
        ) from None


@app.command("audit")
def audit_command(
    building: str | None = typer.Option(None, "--building", help="Building slug."),
    actor: str | None = typer.Option(None, "--actor", help="Actor's email (any case)."),
    entity: str | None = typer.Option(None, "--entity", help="TYPE:ID, e.g. session:<uuid>."),
    action: str | None = typer.Option(None, "--action", help="Action prefix, e.g. auth."),
    since: str | None = typer.Option(None, "--since", help="Only newer than <n>m, <n>h or <n>d."),
    as_json: bool = typer.Option(False, "--json", help="Print a JSON array."),
) -> None:
    """Print audit events, newest first, at most 200."""
    # Parsed before any session: a usage error must not touch the database.
    window = _parse_since(since)
    entity_type, entity_id = _parse_entity(entity)
    query = AuditQuery(
        building_slug=building,
        actor_email=actor,
        entity_type=entity_type,
        entity_id=entity_id,
        action_prefix=action,
        since=clock.now() - window if window is not None else None,
    )
    output: list[str] = []

    async def work(db: AsyncSession) -> None:
        output.append(render(await find_audit_events(db, query), as_json=as_json))

    try:
        run_in_session(work)
    except UnknownFilterValue as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(output[0])


def _placeholder(name: str, ticket: str) -> None:
    def command() -> None:
        typer.echo(f"error: {name} is not implemented yet; {ticket} adds it", err=True)
        raise typer.Exit(1)

    app.command(name, help=f"Not implemented yet ({ticket}).")(command)


# Fail loudly: a script that calls a placeholder must not mistake it for success.
_placeholder("bootstrap-building", "P4-03")
_placeholder("jobs-status", "P3-01b")
_placeholder("email-test", "P3-02")


if __name__ == "__main__":
    app()
