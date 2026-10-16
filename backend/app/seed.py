"""Demo data for local and staging use: `python -m app.cli seed [--reset]` (P1-06).

Idempotent: every row is found by its natural key (building slug, unit `(building, tower, label)`,
user email, membership `(building, user)`) and created only if missing, and its seeded fields are
set back to the values below. Running it twice leaves the same rows with the same ids; rows the seed
didn't create are never touched, except by `--reset`.

Like the other building blocks, `seed()` flushes but never commits: the CLI command commits once at
the end (CLAUDE.md rule 5). The README lists the seeded accounts and the dev password.
"""

from dataclasses import dataclass
from typing import Any

from sqlalchemy import func, select, text
from sqlalchemy.ext.asyncio import AsyncSession

import app.models.registry  # noqa: F401 (every table in Base.metadata)
from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.core.config import AppEnv
from app.core.security import (
    WeakPasswordError,
    check_password_policy,
    hash_password,
    needs_rehash,
    verify_password,
)
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.occupancy import start_occupancy, transfer_occupancy
from app.models.base import Base
from app.units.models import Unit
from app.users.models import User

OWNER, TENANT, HOUSEHOLD = (
    OccupancyRelationship.OWNER,
    OccupancyRelationship.TENANT,
    OccupancyRelationship.HOUSEHOLD,
)


@dataclass(frozen=True)
class SeedBuilding:
    slug: str
    name: str
    address: str
    join_code: str
    floors: int
    units_per_floor: int
    features: tuple[Feature, ...]


@dataclass(frozen=True)
class SeedMember:
    building: str  # slug
    email: str
    full_name: str
    roles: tuple[Role, ...]
    status: MembershipStatus = MembershipStatus.ACTIVE
    unit: str | None = None  # label of the current occupancy's unit
    relationship: OccupancyRelationship | None = None


BUILDINGS = (
    SeedBuilding(
        "maple",
        "Maple Tower",
        "100 Maple Street, Toronto, ON",
        "MAPLE-2026",
        floors=10,
        units_per_floor=4,
        features=(Feature.PACKAGES, Feature.NOTICES, Feature.MAINTENANCE),
    ),
    SeedBuilding(
        "birch",
        "Birch Court",
        "25 Birch Court, Toronto, ON",
        "BIRCH-2026",
        floors=2,
        units_per_floor=4,
        features=(Feature.PACKAGES,),
    ),
)


def _staff(building: str, email: str, name: str, role: Role) -> SeedMember:
    return SeedMember(building, email, name, (role,))


def _resident(
    building: str, email: str, name: str, unit: str, relationship: OccupancyRelationship
) -> SeedMember:
    return SeedMember(building, email, name, (Role.RESIDENT,), unit=unit, relationship=relationship)


MEMBERS = (
    _staff("maple", "manager@example.test", "Morgan Reyes", Role.PROPERTY_MANAGEMENT),
    _staff("maple", "security@example.test", "Sam Okafor", Role.SECURITY),
    _staff("maple", "council@example.test", "Casey Lindqvist", Role.COUNCIL),
    # Shared units (102, 304) show several current occupants of one unit.
    _resident("maple", "resident1@example.test", "Alex Chen", "101", OWNER),
    _resident("maple", "resident2@example.test", "Jordan Patel", "102", TENANT),
    _resident("maple", "resident3@example.test", "Riley Patel", "102", HOUSEHOLD),
    _resident("maple", "resident4@example.test", "Taylor Nguyen", "304", OWNER),
    _resident("maple", "resident5@example.test", "Jamie Moreau", "503", TENANT),
    _resident("maple", "resident6@example.test", "Avery Nguyen", "304", HOUSEHOLD),
    SeedMember(
        "maple",
        "pending@example.test",
        "Quinn Murphy",
        (Role.RESIDENT,),
        status=MembershipStatus.PENDING,
    ),
    _staff("birch", "birch.manager@example.test", "Drew Kowalski", Role.PROPERTY_MANAGEMENT),
    _resident("birch", "birch.resident@example.test", "Robin Silva", "201", TENANT),
)


# Public (README): every seeded user's password in dev and test. Staging uses SEED_PASSWORD instead.
DEV_SEED_PASSWORD = "DevPassword!2026"  # noqa: S105


class SeedRefusedError(Exception):
    """`seed` must not run in this environment, or not with these options."""


def check_seed_allowed(app_env: AppEnv, *, reset: bool) -> None:
    """Raise `SeedRefusedError` unless `seed` may run. Call it before opening a session."""
    if app_env == "prod":
        # Demo accounts with known emails (and, from P2-01, known passwords) never go to production.
        raise SeedRefusedError("seed refuses to run with APP_ENV=prod: demo data never goes there")
    if reset and app_env != "dev":
        raise SeedRefusedError(
            "seed --reset deletes every domain row and runs only with APP_ENV=dev, "
            f"not APP_ENV={app_env}"
        )


def seed_password_for(app_env: AppEnv, seed_password: str | None) -> str:
    """The seeded users' password. Raise `SeedRefusedError` if staging has no usable one.

    Staging is reachable, so its demo accounts must not use the password published in the README.
    """
    if app_env != "staging":
        return DEV_SEED_PASSWORD
    if not seed_password:
        raise SeedRefusedError("seed in staging needs SEED_PASSWORD (a secret), which is not set")
    if seed_password == DEV_SEED_PASSWORD:
        raise SeedRefusedError("SEED_PASSWORD must not be the public dev password in staging")
    try:
        check_password_policy(seed_password)
    except WeakPasswordError as exc:
        # The reason only, never the value.
        raise SeedRefusedError(f"SEED_PASSWORD fails the password policy: {exc.reason}") from None
    return seed_password


async def seed(
    db: AsyncSession, *, app_env: AppEnv, reset: bool = False, seed_password: str | None = None
) -> None:
    """Create or restore the demo dataset. Flushes, never commits.

    `seed_password` (the SEED_PASSWORD setting) is used in staging only; see `seed_password_for`.
    """
    check_seed_allowed(app_env, reset=reset)
    password = seed_password_for(app_env, seed_password)
    password_hash = hash_password(password)
    if reset:
        await _truncate_domain_tables(db)
    buildings = {spec.slug: await _building(db, spec) for spec in BUILDINGS}
    units = {
        (spec.slug, label): unit
        for spec in BUILDINGS
        for label, unit in (await _units(db, buildings[spec.slug], spec)).items()
    }
    for member in MEMBERS:
        building = buildings[member.building]
        user_values = {"full_name": member.full_name, "is_active": True}
        where = (func.lower(User.email) == member.email,)
        user = await _upsert(db, User, where, email=member.email, **user_values)
        _set(user, **user_values)
        # A hash that already verifies is kept, so a re-run doesn't rewrite every user.
        current = user.password_hash
        if current is None or not verify_password(password, current) or needs_rehash(current):
            user.password_hash = password_hash
        membership = await _membership(db, building, user, member)
        if member.unit is not None and member.relationship is not None:
            unit = units[member.building, member.unit]
            await _occupancy(db, membership, unit, member.relationship)
    await db.flush()


async def _truncate_domain_tables(db: AsyncSession) -> None:
    # Every table the models declare (the registry imports them all), so a later slice's tables are
    # included without editing this; alembic_version isn't a model, so it stays.
    preparer = db.get_bind().dialect.identifier_preparer
    tables = ", ".join(preparer.format_table(t) for t in Base.metadata.sorted_tables)
    await db.execute(text(f"TRUNCATE {tables} CASCADE"))
    db.expunge_all()


async def _upsert[T](db: AsyncSession, model: type[T], where: tuple[Any, ...], **key: Any) -> T:
    """The row matching `where`, or a new one built from `key` and flushed."""
    found = (await db.scalars(select(model).where(*where))).one_or_none()
    if found is not None:
        return found
    obj = model(**key)
    db.add(obj)
    await db.flush()
    return obj


def _set(obj: object, **values: Any) -> None:
    # Only assign what differs, so an unchanged row isn't written (and keeps its updated_at).
    for name, value in values.items():
        if getattr(obj, name) != value:
            setattr(obj, name, value)


async def _building(db: AsyncSession, spec: SeedBuilding) -> Building:
    values = {
        "name": spec.name,
        "address": spec.address,
        "timezone": "America/Toronto",
        "join_code": spec.join_code,
    }
    building = await _upsert(db, Building, (Building.slug == spec.slug,), slug=spec.slug, **values)
    _set(building, is_active=True, **values)
    for feature in spec.features:
        row = await _upsert(
            db,
            BuildingFeature,
            (BuildingFeature.building_id == building.id, BuildingFeature.feature == feature),
            building_id=building.id,
            feature=feature,
        )
        _set(row, enabled=True)
    return building


async def _units(db: AsyncSession, building: Building, spec: SeedBuilding) -> dict[str, Unit]:
    units: dict[str, Unit] = {}
    for floor in range(1, spec.floors + 1):
        for n in range(1, spec.units_per_floor + 1):
            label = f"{floor}{n:02d}"
            where = (Unit.building_id == building.id, Unit.tower.is_(None), Unit.label == label)
            unit = await _upsert(db, Unit, where, building_id=building.id, label=label)
            _set(unit, floor=floor, is_active=True)
            units[label] = unit
    return units


async def _membership(
    db: AsyncSession, building: Building, user: User, member: SeedMember
) -> BuildingMembership:
    membership = await _upsert(
        db,
        BuildingMembership,
        (BuildingMembership.building_id == building.id, BuildingMembership.user_id == user.id),
        building_id=building.id,
        user_id=user.id,
        status=member.status,
    )
    _set(membership, status=member.status)
    have = set(
        await db.scalars(
            select(MembershipRole.role).where(MembershipRole.membership_id == membership.id)
        )
    )
    db.add_all(
        MembershipRole(building_id=building.id, membership_id=membership.id, role=role)
        for role in member.roles
        if role not in have
    )
    return membership


async def _occupancy(
    db: AsyncSession,
    membership: BuildingMembership,
    unit: Unit,
    relationship: OccupancyRelationship,
) -> None:
    current = (
        await db.scalars(
            select(UnitOccupancy).where(
                UnitOccupancy.membership_id == membership.id, UnitOccupancy.ended_at.is_(None)
            )
        )
    ).one_or_none()
    if current is None:
        await start_occupancy(
            db,
            building_id=membership.building_id,
            membership_id=membership.id,
            unit_id=unit.id,
            relationship=relationship,
        )
    elif (current.unit_id, current.relationship) != (unit.id, relationship):
        # History is ended, never rewritten (ADR-0010): move them back with a transfer.
        await transfer_occupancy(
            db,
            building_id=membership.building_id,
            membership_id=membership.id,
            new_unit_id=unit.id,
            relationship=relationship,
        )
