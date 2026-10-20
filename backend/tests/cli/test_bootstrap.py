"""`bootstrap-building` (P4-03): the use-case against the test session, then the CLI wiring.

The use-case only flushes; the CLI's `run_in_session` commits once. So the database tests call
`bootstrap_building` with the test's session, and the CLI tests use a fake session, as the units
import tests do (`tests/units/test_import.py`).
"""

import logging
from pathlib import Path
from typing import Any
from uuid import UUID

import pytest
from httpx import AsyncClient
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from typer.testing import CliRunner

from app import cli
from app.audit.models import AuditEvent
from app.buildings import service
from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.buildings.schemas import BootstrapInput
from app.buildings.service import BootstrapResult, SlugExists, bootstrap_building
from app.core.config import settings
from app.invitations import service as invitations_service
from app.invitations.models import Invitation
from app.jobs.models import Job
from app.memberships.enums import MembershipStatus
from app.memberships.models import BuildingMembership, MembershipRole
from app.units.models import Unit
from app.units.service import ParsedUnits, parse_units_csv
from app.users.models import User
from tests.world import World

pytestmark = pytest.mark.anyio

MANAGER = "pat.manager@example.test"
PASSWORD = "correct horse battery staple"  # noqa: S105 (a test password)
TABLES = (Building, BuildingFeature, Unit, Invitation, Job, AuditEvent)


def _input(**overrides: Any) -> BootstrapInput:
    values: dict[str, Any] = {
        "slug": "cedar",
        "name": "Cedar Court",
        "address": "1 Cedar St, Toronto",
        "timezone": "America/Toronto",
        "locale": "en",
        "features": [Feature.PACKAGES, Feature.NOTICES, Feature.MAINTENANCE],
        "manager_email": MANAGER,
        "manager_name": "Pat Manager",
        "reason": "pilot onboarding",
        "operator": "james",
    }
    return BootstrapInput.model_validate(values | overrides)


def _forty_units() -> ParsedUnits:
    rows = [f",{floor}{n:02d},{floor}" for floor in range(1, 11) for n in range(1, 5)]
    return parse_units_csv("tower,label,floor\n" + "\n".join(rows) + "\n")


async def _counts(db: AsyncSession) -> dict[str, int]:
    return {
        model.__tablename__: await db.scalar(select(func.count()).select_from(model)) or 0
        for model in TABLES
    }


# AC1


async def test_dry_run_writes_nothing_and_prints_the_plan(db: AsyncSession, world: World) -> None:
    before = await _counts(db)

    result = await bootstrap_building(db, _input(), _forty_units(), dry_run=True)

    assert await _counts(db) == before
    assert result.token is None and result.building_id is None
    plan = service.render_bootstrap(_input(), result, dry_run=True)
    assert plan.splitlines()[0] == "dry run: nothing was written"
    for expected in (
        "slug: cedar",
        "name: Cedar Court",
        "timezone: America/Toronto",
        "locale: en",
        "features: maintenance, notices, packages",
        "units: 40",
        f"invitation: {MANAGER} (property_management)",
    ):
        assert expected in plan.splitlines()
    assert "/invite/" not in plan


# AC2


async def test_real_run_creates_exactly_the_bootstrap_rows(db: AsyncSession, world: World) -> None:
    before = await _counts(db)

    result = await bootstrap_building(db, _input(), _forty_units(), dry_run=False)

    after = await _counts(db)
    assert {table: after[table] - before[table] for table in after} == {
        "buildings": 1,
        "building_features": 3,
        "units": 40,
        "invitations": 1,
        "jobs": 1,
        "audit_events": 1,
    }
    building = await db.get_one(Building, result.building_id)
    assert (building.slug, building.name, building.timezone, building.locale) == (
        "cedar",
        "Cedar Court",
        "America/Toronto",
        "en",
    )
    assert building.join_code is not None and building.join_code == result.join_code
    features = await db.scalars(
        select(BuildingFeature).where(BuildingFeature.building_id == building.id)
    )
    assert sorted((f.feature, f.enabled) for f in features) == [
        (Feature.MAINTENANCE, True),
        (Feature.NOTICES, True),
        (Feature.PACKAGES, True),
    ]
    invitation = await db.scalar(select(Invitation).where(Invitation.building_id == building.id))
    assert invitation is not None
    assert (invitation.email, invitation.roles, invitation.unit_id) == (
        MANAGER,
        ["property_management"],
        None,
    )
    assert invitation.created_by_user_id is None
    assert invitation.accepted_at is None and invitation.revoked_at is None
    assert invitation.id == result.invitation_id
    job = await db.scalar(select(Job).order_by(Job.created_at.desc(), Job.id.desc()).limit(1))
    assert job is not None
    assert (job.kind, job.payload["to"], job.payload["template"]) == (
        "email.send",
        MANAGER,
        "invitation",
    )
    assert job.payload["context"]["link"] == f"/invite/{result.token}"
    event = await db.scalar(select(AuditEvent).where(AuditEvent.building_id == building.id))
    assert event is not None
    assert (event.action, event.actor_user_id, event.entity_type, event.entity_id) == (
        "building.bootstrapped",
        None,
        "building",
        building.id,
    )
    assert event.metadata_ == {
        "operator": "james",
        "reason": "pilot onboarding",
        "invitation_id": str(invitation.id),
        "units": 40,
    }


async def test_join_codes_are_generated_and_differ(db: AsyncSession, world: World) -> None:
    first = await bootstrap_building(db, _input(), None, dry_run=False)
    second = await bootstrap_building(
        db, _input(slug="elm", manager_email="m2@example.test"), None, dry_run=False
    )

    assert first.join_code is not None and second.join_code is not None
    assert first.join_code != second.join_code
    for code in (first.join_code, second.join_code):
        assert len(code) == 11 and code[5] == "-"
        assert set(code.replace("-", "")) <= set(service.JOIN_CODE_ALPHABET)


async def test_without_a_csv_no_units_are_created(db: AsyncSession, world: World) -> None:
    result = await bootstrap_building(db, _input(features=[]), None, dry_run=False)

    count = await db.scalar(
        select(func.count()).select_from(Unit).where(Unit.building_id == result.building_id)
    )
    features = await db.scalar(
        select(func.count())
        .select_from(BuildingFeature)
        .where(BuildingFeature.building_id == result.building_id)
    )
    assert (count, features, result.unit_count) == (0, 0, 0)


# AC3


@pytest.mark.parametrize("dry_run", [False, True], ids=["real", "dry-run"])
async def test_same_slug_again_is_refused_and_writes_nothing(
    db: AsyncSession, world: World, dry_run: bool
) -> None:
    await bootstrap_building(db, _input(), None, dry_run=False)
    before = await _counts(db)

    with pytest.raises(SlugExists, match="slug already exists"):
        await bootstrap_building(
            db, _input(manager_email="other@example.test"), _forty_units(), dry_run=dry_run
        )

    assert await _counts(db) == before


async def test_existing_world_slug_is_refused(db: AsyncSession, world: World) -> None:
    with pytest.raises(SlugExists):
        await bootstrap_building(db, _input(slug="maple"), None, dry_run=False)


# AC4 (the input rules; the CLI tests below show they run before a session)


@pytest.mark.parametrize(
    ("field", "value"),
    [
        ("timezone", "Mars/Base"),
        ("timezone", "localtime"),
        ("slug", "Cedar"),
        ("slug", "cedar court"),
        ("slug", ""),
        ("slug", "c" * 64),
        ("manager_email", "not-an-email"),
        ("manager_email", "a@b.test, c@d.test"),
        ("locale", "de"),
        ("features", ["packages", "packages"]),
        ("features", ["laundry"]),
        ("reason", "   "),
        ("reason", "x" * 501),
        ("reason", "line\nbreak"),
        ("operator", ""),
        ("operator", "o" * 65),
        ("name", ""),
        ("name", "n" * 201),
        ("address", ""),
        ("manager_name", "tab\there"),
    ],
)
def test_bad_input_is_refused(field: str, value: Any) -> None:
    with pytest.raises(ValidationError) as caught:
        _input(**{field: value})

    assert caught.value.errors()[0]["loc"][0] == field


def test_manager_email_is_lowered() -> None:
    assert _input(manager_email="Pat.Manager@Example.TEST").manager_email == MANAGER


# AC5


async def test_manager_accepts_and_can_invite_staff(
    client: AsyncClient, db: AsyncSession, world: World
) -> None:
    result = await bootstrap_building(db, _input(), _forty_units(), dry_run=False)

    accepted = await client.post(
        f"/api/invitations/{result.token}/accept",
        json={"full_name": "Pat Manager", "password": PASSWORD},
    )

    assert accepted.status_code == 200, accepted.text
    assert accepted.json()["roles"] == ["property_management"]
    user = await db.scalar(select(User).where(User.email == MANAGER))
    assert user is not None
    membership = await db.scalar(
        select(BuildingMembership).where(
            BuildingMembership.building_id == result.building_id,
            BuildingMembership.user_id == user.id,
        )
    )
    assert membership is not None and membership.status == MembershipStatus.ACTIVE
    assert membership.status_changed_by_user_id is None
    roles = await db.scalars(
        select(MembershipRole.role).where(MembershipRole.membership_id == membership.id)
    )
    assert list(roles) == ["property_management"]
    invited = await client.post(
        f"/api/buildings/{result.building_id}/invitations",
        json={"email": "guard@example.test", "roles": ["security"]},
    )
    assert invited.status_code == 201, invited.text


# AC6


async def test_logs_and_audit_hold_no_token_or_url(
    client: AsyncClient, db: AsyncSession, world: World, caplog: pytest.LogCaptureFixture
) -> None:
    caplog.set_level(logging.DEBUG)

    result = await bootstrap_building(db, _input(), _forty_units(), dry_run=False)
    accepted = await client.post(
        f"/api/invitations/{result.token}/accept",
        json={"full_name": "Pat Manager", "password": PASSWORD},
    )

    assert accepted.status_code == 200, accepted.text
    assert result.token is not None
    # Not the test's own HTTP client (`httpx`, `httpcore`), which logs the URL it requested.
    records = [r for r in caplog.records if not r.name.startswith(("httpx", "httpcore"))]
    logged = "\n".join(
        [record.getMessage() for record in records] + [repr(record.__dict__) for record in records]
    )
    assert any(r.name == "app.request" for r in records), "the accept logs its access line"
    assert result.token not in logged
    assert "/invite/" not in logged
    events = await db.scalars(select(AuditEvent.metadata_))
    assert all(result.token not in repr(m) and "/invite/" not in repr(m) for m in events)


# AC8


async def test_late_failure_writes_nothing(
    db: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    before = await _counts(db)

    async def failing_email(*args: Any, **kwargs: Any) -> None:
        raise ValueError("the email can't be queued")

    monkeypatch.setattr(invitations_service, "queue_email", failing_email)

    with pytest.raises(ValueError, match="can't be queued"):
        async with db.begin_nested():
            await bootstrap_building(db, _input(), _forty_units(), dry_run=False)

    assert await _counts(db) == before


async def test_bootstrap_flushes_but_never_commits(
    db: AsyncSession, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def no_commit() -> None:
        pytest.fail("bootstrap_building committed")

    monkeypatch.setattr(db, "commit", no_commit)

    await bootstrap_building(db, _input(), _forty_units(), dry_run=False)


# AC9


async def test_other_buildings_are_untouched(db: AsyncSession, world: World) -> None:
    async def world_rows() -> list[Any]:
        rows: list[Any] = []
        ids = [world.a.id, world.b.id]
        for table in (Building.__table__, Unit.__table__, Invitation.__table__):
            key = table.c.id if table is Building.__table__ else table.c.building_id
            rows += (await db.execute(select(table).where(key.in_(ids)))).all()
        table = BuildingFeature.__table__
        rows += (await db.execute(select(table).where(table.c.building_id.in_(ids)))).all()
        return sorted(rows, key=repr)

    before = await world_rows()

    await bootstrap_building(db, _input(), _forty_units(), dry_run=False)

    assert await world_rows() == before


# The CLI wiring (fake session; the stack run is in the PR)


class FakeSession:
    def __init__(self) -> None:
        self.committed = False
        self.rolled_back = False

    async def __aenter__(self) -> FakeSession:
        return self

    async def __aexit__(self, *exc: object) -> None:
        return None

    async def commit(self) -> None:
        self.committed = True

    async def rollback(self) -> None:
        self.rolled_back = True


@pytest.fixture
def fake_session(monkeypatch: pytest.MonkeyPatch) -> FakeSession:
    session = FakeSession()
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: session)

    async def no_dispose() -> None:
        return None

    monkeypatch.setattr(cli, "dispose_database_engine", no_dispose)
    monkeypatch.setenv("OPERATOR", "james")
    return session


TOKEN = "t" * 43
BUILDING_ID = UUID("00000000-0000-7000-8000-000000000001")


@pytest.fixture
def calls(monkeypatch: pytest.MonkeyPatch) -> list[dict[str, Any]]:
    recorded: list[dict[str, Any]] = []

    async def fake_bootstrap(
        db: Any, data: BootstrapInput, units: ParsedUnits | None, *, dry_run: bool
    ) -> BootstrapResult:
        recorded.append(
            {
                "data": data,
                "units": None if units is None else len(units.rows),
                "dry_run": dry_run,
            }
        )
        if data.slug == "maple":
            raise SlugExists("slug already exists: maple")
        unit_count = 0 if units is None else len(units.rows)
        if dry_run:
            return BootstrapResult(None, None, unit_count, None, None)
        return BootstrapResult(BUILDING_ID, "ABCDE-FGHJK", unit_count, BUILDING_ID, TOKEN)

    monkeypatch.setattr(cli, "bootstrap_building", fake_bootstrap)
    return recorded


ARGS = [
    "--slug",
    "cedar",
    "--name",
    "Cedar Court",
    "--address",
    "1 Cedar St",
    "--timezone",
    "America/Toronto",
    "--manager-email",
    MANAGER,
    "--reason",
    "pilot onboarding",
]


def _run(*args: str) -> Any:
    return CliRunner().invoke(cli.app, ["bootstrap-building", *args])


def _csv(tmp_path: Path, text: str) -> str:
    path = tmp_path / "units.csv"
    path.write_text(text, encoding="utf-8")
    return str(path)


def test_cli_real_run_commits_and_prints_the_url_last(tmp_path, fake_session, calls):
    result = _run(*ARGS, "--units-csv", _csv(tmp_path, "tower,label,floor\n,101,1\n,102,1\n"))

    assert result.exit_code == 0, result.output
    assert fake_session.committed and not fake_session.rolled_back
    [call] = calls
    assert (call["units"], call["dry_run"]) == (2, False)
    assert call["data"].operator == "james"
    assert call["data"].features == [Feature.MAINTENANCE, Feature.NOTICES, Feature.PACKAGES]
    assert call["data"].locale == "en"
    url = f"{settings.app_base_url}/invite/{TOKEN}"
    assert result.stdout.count(url) == 1
    assert result.stdout.rstrip("\n").splitlines()[-1] == f"accept URL: {url}"
    assert "join code: ABCDE-FGHJK" in result.stdout.splitlines()


def test_cli_dry_run_rolls_back_and_prints_no_url(tmp_path, fake_session, calls):
    result = _run(*ARGS, "--dry-run")

    assert result.exit_code == 0, result.output
    assert fake_session.rolled_back and not fake_session.committed
    assert calls[0]["dry_run"] is True
    assert result.stdout.startswith("dry run: nothing was written")
    assert "/invite/" not in result.output


def test_cli_same_slug_exits_1_without_committing(fake_session, calls):
    args = list(ARGS)
    args[args.index("cedar")] = "maple"

    result = _run(*args)

    assert result.exit_code == 1
    assert "slug already exists" in result.stderr
    assert not fake_session.committed


def test_cli_features_and_locale_options(fake_session, calls):
    result = _run(*ARGS, "--features", "notices, packages", "--locale", "fr")

    assert result.exit_code == 0, result.output
    assert calls[0]["data"].features == [Feature.NOTICES, Feature.PACKAGES]
    assert calls[0]["data"].locale == "fr"


def test_cli_empty_features_means_none(fake_session, calls):
    result = _run(*ARGS, "--features", "")

    assert result.exit_code == 0, result.output
    assert calls[0]["data"].features == []


def test_cli_user_is_the_operator_when_operator_is_unset(fake_session, calls, monkeypatch):
    monkeypatch.delenv("OPERATOR")
    monkeypatch.setenv("USER", "ops")

    result = _run(*ARGS)

    assert result.exit_code == 0, result.output
    assert calls[0]["data"].operator == "ops"


@pytest.mark.parametrize(
    ("change", "option"),
    [
        (("--timezone", "Mars/Base"), "--timezone"),
        (("--slug", "Cedar"), "--slug"),
        (("--manager-email", "nobody"), "--manager-email"),
        (("--features", "packages,laundry"), "--features"),
        (("--features", "packages,packages"), "--features"),
        (("--features", "packages,,notices"), "--features"),
        (("--locale", "de"), "--locale"),
        (("--reason", " "), "--reason"),
    ],
    ids=lambda v: v if isinstance(v, str) else "-".join(v),
)
def test_cli_refuses_bad_input_before_any_session(monkeypatch, change, option):
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: pytest.fail("opened a session"))
    monkeypatch.setenv("OPERATOR", "james")
    args = list(ARGS)
    if change[0] in args:
        args[args.index(change[0]) + 1] = change[1]
    else:
        args += list(change)

    result = _run(*args)

    assert result.exit_code == 1, result.output
    assert f"error: {option}" in result.stderr


def test_cli_refuses_without_an_operator(monkeypatch):
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: pytest.fail("opened a session"))
    monkeypatch.delenv("OPERATOR", raising=False)
    monkeypatch.delenv("USER", raising=False)

    result = _run(*ARGS)

    assert result.exit_code == 1
    assert "OPERATOR" in result.stderr


@pytest.mark.parametrize(
    "content",
    [
        b"tower,label,floor\n,101,1\n,,2\n",
        b"tower,label,floor\n,101,1\n,101,1\n",
        b"tower,label\n,1\n",
        b"tower,label,floor\n\xff\xfe,1,\n",
        b'tower,label,floor\nA,"1,\n',
    ],
    ids=["no-label-row", "duplicate-row", "header", "not-utf8", "broken-csv"],
)
def test_cli_bad_csv_exits_1_before_any_session(tmp_path, monkeypatch, content):
    path = tmp_path / "units.csv"
    path.write_bytes(content)
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: pytest.fail("opened a session"))
    monkeypatch.setenv("OPERATOR", "james")

    result = _run(*ARGS, "--units-csv", str(path))

    assert result.exit_code == 1
    assert "error:" in result.stderr


def test_cli_invalid_rows_are_listed_by_line_without_values(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: pytest.fail("opened a session"))
    monkeypatch.setenv("OPERATOR", "james")
    path = _csv(tmp_path, "tower,label,floor\n,101,1\nSECRETTOWER,,2\n")

    result = _run(*ARGS, "--units-csv", path)

    assert result.exit_code == 1
    assert "line 3" in result.stderr
    assert "SECRETTOWER" not in result.output


def test_cli_missing_csv_exits_1(tmp_path, monkeypatch):
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: pytest.fail("opened a session"))
    monkeypatch.setenv("OPERATOR", "james")

    result = _run(*ARGS, "--units-csv", str(tmp_path / "missing.csv"))

    assert result.exit_code == 1


# AC7


def test_cli_runs_with_app_env_prod(fake_session, calls, monkeypatch):
    monkeypatch.setattr(settings, "app_env", "prod")

    result = _run(*ARGS)

    assert result.exit_code == 0, result.output
    assert fake_session.committed


# AC6: an unexpected error's traceback must not print the token held in a local variable.


def test_cli_tracebacks_never_show_locals():
    assert cli.app.pretty_exceptions_show_locals is False
