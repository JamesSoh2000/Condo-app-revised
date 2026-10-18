"""`app.seed` and `python -m app.cli` (P1-06).

`seed()` runs in the test's transaction (rolled back afterwards). A CLI command runs its own event
loop, which can't share the test's connection, so the CLI tests cover the refusals (before any
session) and the runner's commit with a fake session; `make seed` is run on the stack in the PR.
"""

import asyncio

import pytest
from argon2 import PasswordHasher
from pydantic import SecretStr
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession
from typer.testing import CliRunner

from app import cli
from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.core.config import AppEnv, Settings
from app.core.security import hash_password, needs_rehash, verify_password
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.occupancy import end_occupancy
from app.seed import DEV_SEED_PASSWORD, SeedRefusedError, check_seed_allowed, seed
from app.units.models import Unit
from app.users.models import User
from tests.factories import make_building, make_membership, make_user

DOMAIN_TABLES = (
    Building,
    BuildingFeature,
    Unit,
    User,
    BuildingMembership,
    MembershipRole,
    UnitOccupancy,
)

pytestmark = pytest.mark.anyio


async def _counts(db: AsyncSession) -> dict[str, int]:
    return {
        model.__tablename__: await db.scalar(select(func.count()).select_from(model)) or 0
        for model in DOMAIN_TABLES
    }


async def _ids(db: AsyncSession) -> dict[str, set[object]]:
    return {
        "buildings": set(await db.scalars(select(Building.id))),
        "units": set(await db.scalars(select(Unit.id))),
        "users": set(await db.scalars(select(User.id))),
        "memberships": set(await db.scalars(select(BuildingMembership.id))),
        "occupancies": set(await db.scalars(select(UnitOccupancy.id))),
    }


async def _building(db: AsyncSession, slug: str) -> Building:
    return (await db.scalars(select(Building).where(Building.slug == slug))).one()


async def _member(db: AsyncSession, slug: str, email: str) -> BuildingMembership:
    return (
        await db.scalars(
            select(BuildingMembership)
            .join(User, User.id == BuildingMembership.user_id)
            .join(Building, Building.id == BuildingMembership.building_id)
            .where(Building.slug == slug, User.email == email)
        )
    ).one()


async def _roles(db: AsyncSession, membership: BuildingMembership) -> set[Role]:
    return set(
        await db.scalars(
            select(MembershipRole.role).where(MembershipRole.membership_id == membership.id)
        )
    )


async def _current(db: AsyncSession, membership: BuildingMembership) -> list[UnitOccupancy]:
    return list(
        await db.scalars(
            select(UnitOccupancy).where(
                UnitOccupancy.membership_id == membership.id, UnitOccupancy.ended_at.is_(None)
            )
        )
    )


# Criterion 1


async def test_seed_twice_keeps_row_counts_and_ids(db: AsyncSession) -> None:
    assert sum((await _counts(db)).values()) == 0

    await seed(db, app_env="dev")
    first_counts, first_ids = await _counts(db), await _ids(db)
    await seed(db, app_env="dev")

    assert await _counts(db) == first_counts
    assert await _ids(db) == first_ids
    assert all(first_counts.values())


# Criteria 2 and 3: the guard


@pytest.mark.parametrize("reset", [False, True])
def test_seed_is_refused_in_prod(reset: bool) -> None:
    with pytest.raises(SeedRefusedError, match="APP_ENV=prod"):
        check_seed_allowed("prod", reset=reset)


@pytest.mark.parametrize("app_env", ["staging", "test", "prod"])
def test_reset_is_refused_outside_dev(app_env: str) -> None:
    with pytest.raises(SeedRefusedError, match=f"APP_ENV={app_env}"):
        check_seed_allowed(app_env, reset=True)  # type: ignore[arg-type]


@pytest.mark.parametrize("app_env", ["dev", "test", "staging"])
def test_seed_without_reset_is_allowed_outside_prod(app_env: str) -> None:
    check_seed_allowed(app_env, reset=False)  # type: ignore[arg-type]


async def test_seed_in_prod_writes_nothing(db: AsyncSession) -> None:
    with pytest.raises(SeedRefusedError):
        await seed(db, app_env="prod")

    assert sum((await _counts(db)).values()) == 0
    assert not db.new


async def test_seed_runs_in_staging(db: AsyncSession) -> None:
    await seed(db, app_env="staging", seed_password=STAGING_PASSWORD)

    assert (await _building(db, "maple")).name == "Maple Tower"


# P2-01a criterion 9: seed passwords

STAGING_PASSWORD = "staging-demo-pass-2026"  # noqa: S105 (test value)


async def _hashes(db: AsyncSession) -> dict[str, str | None]:
    return {u.email: u.password_hash for u in await db.scalars(select(User))}


async def test_dev_password_is_documented_and_passes_the_policy() -> None:
    from app.core.security import check_password_policy

    assert DEV_SEED_PASSWORD == "DevPassword!2026"  # noqa: S105 (README, "Seeded accounts")
    check_password_policy(DEV_SEED_PASSWORD)


async def test_seed_twice_keeps_every_password_hash(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    first = await _hashes(db)

    await seed(db, app_env="dev")

    assert await _hashes(db) == first
    assert all(first.values())


async def test_seed_replaces_a_hash_made_with_weaker_parameters(db: AsyncSession) -> None:
    # Review round 1 L3: a hash that verifies but needs_rehash is upgraded.
    await seed(db, app_env="dev")
    user = (await db.scalars(select(User).where(User.email == "resident1@example.test"))).one()
    weak = PasswordHasher(time_cost=1, memory_cost=8 * 1024, parallelism=1).hash(DEV_SEED_PASSWORD)
    user.password_hash = weak
    await db.flush()

    await seed(db, app_env="dev")

    assert user.password_hash != weak
    assert verify_password(DEV_SEED_PASSWORD, user.password_hash or "")
    assert not needs_rehash(user.password_hash or "")


async def test_seed_restores_a_changed_password(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    user = (await db.scalars(select(User).where(User.email == "resident1@example.test"))).one()
    user.password_hash = hash_password("someone-changed-it-2026")
    await db.flush()

    await seed(db, app_env="dev")

    assert verify_password(DEV_SEED_PASSWORD, user.password_hash or "")


@pytest.mark.parametrize(
    "seed_password",
    [None, "", "short-pw", "1qaz2wsx3edc", DEV_SEED_PASSWORD],
    ids=["unset", "empty", "too-short", "common", "dev-password"],
)
async def test_seed_in_staging_refuses_a_missing_or_weak_password(
    db: AsyncSession, seed_password: str | None
) -> None:
    with pytest.raises(SeedRefusedError, match="SEED_PASSWORD") as excinfo:
        await seed(db, app_env="staging", seed_password=seed_password)

    if seed_password:
        assert seed_password not in str(excinfo.value)
    assert sum((await _counts(db)).values()) == 0
    assert not db.new


async def test_seed_in_staging_uses_the_seed_password(db: AsyncSession) -> None:
    await seed(db, app_env="staging", seed_password=STAGING_PASSWORD)

    hashes = await _hashes(db)
    assert len(hashes) == 13
    assert all(verify_password(STAGING_PASSWORD, h or "") for h in hashes.values())
    assert not any(verify_password(DEV_SEED_PASSWORD, h or "") for h in hashes.values())


@pytest.mark.parametrize("app_env", ["dev", "test"])
async def test_seed_outside_staging_ignores_seed_password(db: AsyncSession, app_env: str) -> None:
    await seed(db, app_env=app_env, seed_password=STAGING_PASSWORD)  # type: ignore[arg-type]

    hashes = await _hashes(db)
    assert all(verify_password(DEV_SEED_PASSWORD, h or "") for h in hashes.values())


runner = CliRunner()


def _cli_settings(
    monkeypatch: pytest.MonkeyPatch, app_env: AppEnv, seed_password: str | None = None
) -> list[str]:
    """Point the CLI at `app_env` and record any attempt to open a session."""
    opened: list[str] = []
    secret = SecretStr(seed_password) if seed_password is not None else None
    monkeypatch.setattr(
        cli, "settings", Settings.model_construct(app_env=app_env, seed_password=secret)
    )
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: opened.append("session"))
    return opened


@pytest.mark.parametrize("args", [["seed"], ["seed", "--reset"]])
def test_cli_seed_in_prod_exits_nonzero_without_opening_a_session(
    monkeypatch: pytest.MonkeyPatch, args: list[str]
) -> None:
    opened = _cli_settings(monkeypatch, "prod")

    result = runner.invoke(cli.app, args)

    assert result.exit_code == 1
    assert "APP_ENV=prod" in result.output
    assert opened == []


def test_cli_seed_reset_in_staging_exits_nonzero_without_opening_a_session(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    opened = _cli_settings(monkeypatch, "staging")

    result = runner.invoke(cli.app, ["seed", "--reset"])

    assert result.exit_code == 1
    assert "--reset" in result.output
    assert opened == []


@pytest.mark.parametrize("seed_password", [None, "short-pw"])
def test_cli_seed_in_staging_without_a_valid_seed_password_opens_no_session(
    monkeypatch: pytest.MonkeyPatch, seed_password: str | None
) -> None:
    opened = _cli_settings(monkeypatch, "staging", seed_password)

    result = runner.invoke(cli.app, ["seed"])

    assert result.exit_code == 1
    assert "SEED_PASSWORD" in result.output
    assert opened == []


def test_cli_seed_in_staging_passes_seed_password_to_seed(monkeypatch: pytest.MonkeyPatch) -> None:
    # Review round 1 L2: the success path's wiring, not only the refusals.
    _cli_settings(monkeypatch, "staging", STAGING_PASSWORD)
    received: list[tuple[str, str | None]] = []

    async def fake_seed(db, *, app_env, reset, seed_password):
        received.append((app_env, seed_password))

    async def no_commit_session(work):
        await work(None)

    monkeypatch.setattr(cli, "seed", fake_seed)
    monkeypatch.setattr(cli, "run_in_session", lambda work: asyncio.run(no_commit_session(work)))

    result = runner.invoke(cli.app, ["seed"])

    assert result.exit_code == 0, result.output
    assert received == [("staging", STAGING_PASSWORD)]
    assert STAGING_PASSWORD not in result.output


# Criterion 4


async def test_seeded_maple_has_the_documented_building_and_units(db: AsyncSession) -> None:
    await seed(db, app_env="dev")

    maple = await _building(db, "maple")
    assert (maple.name, maple.timezone, maple.join_code) == (
        "Maple Tower",
        "America/Toronto",
        "MAPLE-2026",
    )
    units = list(await db.scalars(select(Unit).where(Unit.building_id == maple.id)))
    assert len(units) == 40
    assert {(u.floor, u.label) for u in units} == {
        (floor, f"{floor}{n:02d}") for floor in range(1, 11) for n in range(1, 5)
    }
    assert all(u.tower is None and u.is_active for u in units)
    features = set(
        await db.scalars(
            select(BuildingFeature.feature).where(
                BuildingFeature.building_id == maple.id, BuildingFeature.enabled
            )
        )
    )
    assert features == {Feature.PACKAGES, Feature.NOTICES, Feature.MAINTENANCE}


async def test_seeded_maple_has_seven_residents_with_current_occupancies(db: AsyncSession) -> None:
    # resident1 to resident6, plus the multi-building user (P2-06b), resident in 201.
    await seed(db, app_env="dev")

    relationships = set()
    for n in range(1, 7):
        membership = await _member(db, "maple", f"resident{n}@example.test")
        assert membership.status == MembershipStatus.ACTIVE
        assert await _roles(db, membership) == {Role.RESIDENT}
        [occupancy] = await _current(db, membership)
        relationships.add(occupancy.relationship)
    assert relationships == set(OccupancyRelationship)

    maple = await _building(db, "maple")
    active_residents = await db.scalar(
        select(func.count())
        .select_from(BuildingMembership)
        .join(MembershipRole, MembershipRole.membership_id == BuildingMembership.id)
        .where(
            BuildingMembership.building_id == maple.id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            MembershipRole.role == Role.RESIDENT,
        )
    )
    assert active_residents == 7


async def test_seeded_maple_has_one_pending_membership(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    maple = await _building(db, "maple")

    pending = list(
        await db.scalars(
            select(BuildingMembership).where(
                BuildingMembership.building_id == maple.id,
                BuildingMembership.status == MembershipStatus.PENDING,
            )
        )
    )

    assert len(pending) == 1
    assert await _roles(db, pending[0]) == {Role.RESIDENT}
    assert await _current(db, pending[0]) == []


@pytest.mark.parametrize(
    ("email", "role"),
    [
        ("manager@example.test", Role.PROPERTY_MANAGEMENT),
        ("security@example.test", Role.SECURITY),
        ("council@example.test", Role.COUNCIL),
    ],
)
async def test_seeded_maple_has_the_documented_staff(
    db: AsyncSession, email: str, role: Role
) -> None:
    await seed(db, app_env="dev")

    membership = await _member(db, "maple", email)

    assert membership.status == MembershipStatus.ACTIVE
    assert await _roles(db, membership) == {role}
    assert await _current(db, membership) == []


async def test_seeded_birch_has_eight_units_a_manager_and_a_resident(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    birch = await _building(db, "birch")

    assert birch.name == "Birch Court"
    assert await db.scalar(select(func.count()).where(Unit.building_id == birch.id)) == 8
    manager = await _member(db, "birch", "birch.manager@example.test")
    assert await _roles(db, manager) == {Role.PROPERTY_MANAGEMENT}
    resident = await _member(db, "birch", "birch.resident@example.test")
    assert await _roles(db, resident) == {Role.RESIDENT}
    assert len(await _current(db, resident)) == 1


async def test_multi_building_user_is_active_in_maple_and_birch(db: AsyncSession) -> None:
    # P2-06b criterion 10: one person in two buildings, with a different role in each.
    await seed(db, app_env="dev")

    in_maple = await _member(db, "maple", "multi@example.test")
    in_birch = await _member(db, "birch", "multi@example.test")

    assert in_maple.user_id == in_birch.user_id
    assert (in_maple.status, in_birch.status) == (MembershipStatus.ACTIVE, MembershipStatus.ACTIVE)
    assert await _roles(db, in_maple) == {Role.RESIDENT}
    assert await _roles(db, in_birch) == {Role.SECURITY}
    [occupancy] = await _current(db, in_maple)
    unit = await db.get(Unit, occupancy.unit_id)
    assert unit is not None
    assert (unit.label, occupancy.relationship) == ("201", OccupancyRelationship.OWNER)
    assert await _current(db, in_birch) == []
    user = await db.get(User, in_maple.user_id)
    assert user is not None
    assert user.full_name == "Kim Laurent"


async def test_seeded_users_use_example_test_and_the_dev_password(db: AsyncSession) -> None:
    # P1-06 asserted no password here; P2-01a gives every seeded user the documented dev password.
    await seed(db, app_env="dev")

    users = list(await db.scalars(select(User)))

    assert len(users) == 13
    assert all(u.email.endswith("@example.test") for u in users)
    assert all(u.password_hash and u.password_hash.startswith("$argon2id$") for u in users)
    assert all(verify_password(DEV_SEED_PASSWORD, u.password_hash or "") for u in users)


# Criterion 5


def test_cli_help_lists_every_command() -> None:
    result = runner.invoke(cli.app, ["--help"])

    assert result.exit_code == 0
    for command in (
        "seed",
        "bootstrap-building",
        "audit",
        "jobs-status",
        "jobs-retry",
        "email-test",
    ):
        assert command in result.output


@pytest.mark.parametrize(
    ("command", "ticket"),
    [
        ("bootstrap-building", "P4-03"),
    ],
)
def test_cli_placeholders_exit_nonzero_naming_their_ticket(command: str, ticket: str) -> None:
    result = runner.invoke(cli.app, [command])

    assert result.exit_code == 1
    assert "not implemented" in result.output
    assert ticket in result.output


# Criterion 6


async def test_seed_leaves_rows_it_did_not_create(db: AsyncSession) -> None:
    other = await make_building(db, slug="oak")
    user = await make_user(db, email="someone@example.com")
    membership = await make_membership(user, other)

    await seed(db, app_env="dev")

    assert (await _building(db, "oak")).id == other.id
    assert await db.get(BuildingMembership, membership.id) is not None


async def test_reset_removes_other_rows_and_matches_a_fresh_seed(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    fresh = await _counts(db)
    other = await make_building(db, slug="oak")
    await make_membership(await make_user(db, email="someone@example.com"), other)

    await seed(db, app_env="dev", reset=True)

    assert await _counts(db) == fresh
    assert await db.scalar(select(Building.id).where(Building.slug == "oak")) is None


# Criterion 7


async def test_seed_restores_drifted_seed_data(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    maple = await _building(db, "maple")
    maple.name = "Renamed"
    resident = await _member(db, "maple", "resident1@example.test")
    [before] = await _current(db, resident)
    seeded = (before.unit_id, before.relationship)
    await end_occupancy(db, building_id=maple.id, membership_id=resident.id)
    counts = await _counts(db)

    await seed(db, app_env="dev")

    # Read back from the database, not the identity map.
    db.expire_all()
    assert (await _building(db, "maple")).name == "Maple Tower"
    [after] = await _current(db, await _member(db, "maple", "resident1@example.test"))
    assert (after.unit_id, after.relationship) == seeded
    assert await _counts(db) == counts | {"unit_occupancies": counts["unit_occupancies"] + 1}


# Criterion 8


async def test_seed_does_not_commit(db: AsyncSession, monkeypatch: pytest.MonkeyPatch) -> None:
    commits: list[None] = []

    async def no_commit() -> None:
        commits.append(None)

    monkeypatch.setattr(db, "commit", no_commit)

    await seed(db, app_env="dev")

    assert commits == []


class _FakeSession:
    def __init__(self) -> None:
        self.commits = 0

    async def __aenter__(self) -> _FakeSession:
        return self

    async def __aexit__(self, *_: object) -> None:
        return None

    async def commit(self) -> None:
        self.commits += 1


def test_cli_runner_commits_once_after_the_command(monkeypatch: pytest.MonkeyPatch) -> None:
    session = _FakeSession()
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: session)
    seen: list[int] = []

    async def work(db: object) -> None:
        seen.append(session.commits)

    cli.run_in_session(work)

    assert seen == [0]
    assert session.commits == 1


def test_cli_runner_does_not_commit_when_the_command_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    session = _FakeSession()
    monkeypatch.setattr(cli, "AsyncSessionLocal", lambda: session)

    async def work(db: object) -> None:
        raise RuntimeError("boom")

    with pytest.raises(RuntimeError, match="boom"):
        cli.run_in_session(work)

    assert session.commits == 0
