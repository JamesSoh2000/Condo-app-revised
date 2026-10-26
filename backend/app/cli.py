"""Operator commands: `python -m app.cli --help` (P1-06).

A command is a use-case, like a service function: it opens its own session through
`run_in_session` and commits once, at the end (CLAUDE.md rule 5). What it calls only flushes.
"""

import asyncio
import os
import re
from collections.abc import Awaitable, Callable
from datetime import timedelta
from pathlib import Path
from uuid import UUID

import typer
from pydantic import ValidationError
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.report import render
from app.audit.service import AuditQuery, UnknownFilterValue, find_audit_events
from app.buildings.schemas import BootstrapInput
from app.buildings.service import SlugExists, bootstrap_building, render_bootstrap
from app.core import clock
from app.core.config import is_email_address, settings
from app.core.database import AsyncSessionLocal, dispose_database_engine
from app.email.service import queue_email
from app.jobs.report import render_status
from app.jobs.service import JobNotRetryable, job_status, retry_dead_job
from app.seed import SeedRefusedError, check_seed_allowed, seed, seed_password_for
from app.units.service import (
    MAX_IMPORT_BYTES,
    CsvError,
    ParsedUnits,
    UnknownBuilding,
    building_id_for_slug,
    import_units,
    parse_units_csv,
    render_import_report,
)

app = typer.Typer(
    help="Condo management operator commands.",
    no_args_is_help=True,
    # A traceback must not print local variables: `bootstrap-building` holds an invitation token.
    pretty_exceptions_show_locals=False,
)


def run_in_session(work: Callable[[AsyncSession], Awaitable[None]], *, commit: bool = True) -> None:
    """Run `work` in a new session and commit once after it returns (roll back if not `commit`); on
    an error, commit nothing."""

    async def main() -> None:
        try:
            async with AsyncSessionLocal() as db:
                await work(db)
                if commit:
                    await db.commit()
                else:
                    await db.rollback()
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


@app.command("jobs-status")
def jobs_status_command() -> None:
    """Print job counts by status, the oldest due job's age and the latest dead jobs."""
    output: list[str] = []

    async def work(db: AsyncSession) -> None:
        output.append(render_status(await job_status(db), now=clock.now()))

    run_in_session(work)
    typer.echo(output[0])


@app.command("jobs-retry")
def jobs_retry_command(job_id: str = typer.Argument(..., help="The dead job's id.")) -> None:
    """Re-queue a job that died in the last 7 days, with its attempts reset."""
    try:
        # Parsed before any session; not echoed, since it is untrusted terminal input.
        parsed = UUID(job_id)
    except ValueError:
        typer.echo("error: not a job id (expected a UUID)", err=True)
        raise typer.Exit(1) from None

    async def work(db: AsyncSession) -> None:
        await retry_dead_job(db, parsed)

    try:
        # A refusal raises inside `work`, so `run_in_session` commits nothing.
        run_in_session(work)
    except JobNotRetryable as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(f"requeued {parsed}")


@app.command("email-test")
def email_test_command(
    to: str = typer.Option(..., "--to", help="The one address to send the test email to."),
) -> None:
    """Queue the `test` email; the worker sends it (Mailpit locally: http://localhost:8025)."""
    if not is_email_address(to):
        # Checked before any session; not echoed, since it is untrusted terminal input.
        typer.echo("error: --to must be one email address", err=True)
        raise typer.Exit(1)
    queued: list[UUID | None] = []

    async def work(db: AsyncSession) -> None:
        queued.append(await queue_email(db, to=to, template="test", context={}))

    run_in_session(work)
    typer.echo(f"queued email job {queued[0]}")


def _read_units_csv(csv_path: str, option: str) -> ParsedUnits:
    """Read and parse a units CSV, or print the error, naming `option`, and exit 1."""
    try:
        with Path(csv_path).open("rb") as file:
            data = file.read(MAX_IMPORT_BYTES + 1)
        if len(data) > MAX_IMPORT_BYTES:
            raise CsvError(f"the file is larger than {MAX_IMPORT_BYTES // 1024} KiB")
        return parse_units_csv(data.decode("utf-8"))
    except OSError as exc:
        typer.echo(f"error: {option}: can't read {csv_path}: {exc.strerror}", err=True)
        raise typer.Exit(1) from None
    except UnicodeDecodeError:
        typer.echo(f"error: {option}: the file is not UTF-8 text", err=True)
        raise typer.Exit(1) from None
    except CsvError as exc:
        typer.echo(f"error: {option}: {exc}", err=True)
        raise typer.Exit(1) from None


@app.command("import-units")
def import_units_command(
    building: str = typer.Option(..., "--building", help="Building slug."),
    csv_path: str = typer.Option(..., "--csv", help="UTF-8 CSV: tower,label,floor columns."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Report the changes; write nothing."),
) -> None:
    """Create or update a building's units from a CSV, matched by (tower, label).

    Invalid rows are skipped and listed by line; the valid ones are written.
    """
    # Read and checked before any session: a bad file must not touch the database.
    parsed = _read_units_csv(csv_path, "--csv")
    output: list[str] = []

    async def work(db: AsyncSession) -> None:
        building_id = await building_id_for_slug(db, building)
        report = await import_units(db, building_id, parsed, dry_run=dry_run)
        output.append(render_import_report(report, dry_run=dry_run))

    try:
        run_in_session(work, commit=not dry_run)
    except UnknownBuilding as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    typer.echo(output[0])


DEFAULT_FEATURES = "packages,notices,maintenance"


def _option_name(field: str) -> str:
    return "OPERATOR" if field == "operator" else "--" + field.replace("_", "-")


@app.command("bootstrap-building")
def bootstrap_building_command(
    slug: str = typer.Option(..., "--slug", help="a-z, 0-9 and -, at most 63."),
    name: str = typer.Option(..., "--name"),
    address: str = typer.Option(..., "--address"),
    timezone: str = typer.Option(..., "--timezone", help="IANA name, e.g. America/Toronto."),
    locale: str = typer.Option("en", "--locale", help="The emails' language: en or fr."),
    features: str = typer.Option(
        DEFAULT_FEATURES, "--features", help='Comma-separated; "" for none.'
    ),
    units_csv: str | None = typer.Option(
        None, "--units-csv", help="UTF-8 CSV: tower,label,floor columns; every row must be valid."
    ),
    manager_email: str = typer.Option(..., "--manager-email"),
    manager_name: str | None = typer.Option(None, "--manager-name", help="Shown in the summary."),
    emergency_phone: str | None = typer.Option(
        None, "--emergency-phone", help="Shown with emergency maintenance requests."
    ),
    reason: str = typer.Option(..., "--reason", help="Why; recorded in the audit event."),
    dry_run: bool = typer.Option(False, "--dry-run", help="Print the plan; write nothing."),
) -> None:
    """Provision a building, its features and units, and invite its first manager, in one audited
    transaction. Prints the accept URL once (deliver it yourself if the email fails).

    The operator's name comes from $OPERATOR, else $USER.
    """
    # Everything is checked before any session: a refused run must not touch the database.
    operator = os.environ.get("OPERATOR") or os.environ.get("USER")
    if operator is None:
        typer.echo("error: set OPERATOR (or USER) to your name for the audit event", err=True)
        raise typer.Exit(1)
    try:
        data = BootstrapInput(
            slug=slug,
            name=name,
            address=address,
            timezone=timezone,
            locale=locale,
            # Each item is checked, so "a,,b" is refused, not read as "a,b".
            features=[item.strip() for item in features.split(",")] if features.strip() else [],
            manager_email=manager_email,
            manager_name=manager_name,
            emergency_phone=emergency_phone,
            reason=reason,
            operator=operator,
        )
    except ValidationError as exc:
        for error in exc.errors():
            typer.echo(f"error: {_option_name(str(error['loc'][0]))}: {error['msg']}", err=True)
        raise typer.Exit(1) from None
    units = _read_units_csv(units_csv, "--units-csv") if units_csv is not None else None
    if units is not None and units.invalid:
        # P4-03 D3: a building is provisioned from a clean file or not at all.
        typer.echo(f"error: --units-csv: {len(units.invalid)} invalid rows", err=True)
        for row in units.invalid:
            typer.echo(f"  line {row.line}: {row.reason}", err=True)
        raise typer.Exit(1)
    output: list[str] = []

    async def work(db: AsyncSession) -> None:
        result = await bootstrap_building(db, data, units, dry_run=dry_run)
        output.append(render_bootstrap(data, result, dry_run=dry_run))
        if result.token is not None:
            # stdout only, once: never logged (ticket). The link the email carries.
            output.append(
                "deliver this link to the manager only if the email does not arrive:\n"
                f"accept URL: {settings.app_base_url}/invite/{result.token}"
            )

    try:
        run_in_session(work, commit=not dry_run)
    except SlugExists as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
    except SQLAlchemyError as exc:
        # Never the message or the traceback: they carry the statements' parameters, and the
        # email job's hold the accept link (review round 1, F1). The SQLSTATE says what failed.
        state = getattr(getattr(exc, "orig", None), "sqlstate", None) or type(exc).__name__
        typer.echo(
            f"error: the database refused the bootstrap (SQLSTATE {state}); nothing was written",
            err=True,
        )
        raise typer.Exit(1) from None
    typer.echo("\n".join(output))


if __name__ == "__main__":
    app()
