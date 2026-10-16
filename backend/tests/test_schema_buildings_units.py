"""P1-01: constraints on buildings, building_features and units, enforced by the database.

Rows are inserted through the models (or raw SQL where the point is to bypass Python validation) and
the database's verdict is asserted. Criterion numbers refer to the ticket.
"""

import ast
import asyncio
import re
from pathlib import Path
from uuid import UUID

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import delete, func, inspect, select, text
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.core.time import validate_timezone
from app.units.models import Unit
from tests.conftest import BACKEND_DIR

pytestmark = pytest.mark.anyio

TABLES = {"buildings", "building_features", "units"}
P1_01_REVISION = "891dd631e5a1"
P1_01_DOWN_REVISION = "989e5bd83064"


async def _building(db: AsyncSession, slug: str, **overrides: object) -> Building:
    fields: dict[str, object] = {
        "slug": slug,
        "name": f"Building {slug}",
        "address": "1 Main St",
        "timezone": "America/Toronto",
    }
    fields.update(overrides)
    building = Building(**fields)
    db.add(building)
    await db.flush()
    return building


async def _unit(db: AsyncSession, building: Building, label: str, tower: str | None = None) -> Unit:
    unit = Unit(building_id=building.id, tower=tower, label=label)
    db.add(unit)
    await db.flush()
    return unit


# --- 1, 2: unit uniqueness per building, NULL tower included ----------------------------------


async def test_duplicate_untowered_unit_in_same_building_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    await _unit(db, a, "101")

    with pytest.raises(IntegrityError, match="uq_units_building_id_tower_label"):
        await _unit(db, a, "101")


async def test_duplicate_towered_unit_in_same_building_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    await _unit(db, a, "101", tower="T1")

    with pytest.raises(IntegrityError, match="uq_units_building_id_tower_label"):
        await _unit(db, a, "101", tower="T1")


async def test_same_label_in_another_building_or_tower_is_allowed(db: AsyncSession):
    a = await _building(db, "a")
    b = await _building(db, "b")
    await _unit(db, a, "101")

    await _unit(db, b, "101")
    await _unit(db, a, "101", tower="T2")

    count = await db.scalar(select(func.count()).select_from(Unit).where(Unit.label == "101"))
    assert count == 3


# --- 3: RESTRICT for units, CASCADE for features -----------------------------------------------


async def test_deleting_a_building_with_units_is_restricted(db: AsyncSession):
    a = await _building(db, "a")
    unit = await _unit(db, a, "101")

    with pytest.raises(IntegrityError, match="fk_units_building_id_buildings"):
        async with db.begin_nested():
            await db.execute(delete(Building).where(Building.id == a.id))

    assert await db.scalar(select(Building.id).where(Building.id == a.id)) == a.id
    assert await db.scalar(select(Unit.id).where(Unit.id == unit.id)) == unit.id


async def test_deleting_a_building_with_only_features_cascades_them(db: AsyncSession):
    a = await _building(db, "a")
    db.add_all(
        [
            BuildingFeature(building_id=a.id, feature=Feature.PACKAGES),
            BuildingFeature(building_id=a.id, feature=Feature.NOTICES),
        ]
    )
    await db.flush()

    await db.execute(delete(Building).where(Building.id == a.id))

    remaining = await db.scalar(
        text("SELECT count(*) FROM building_features WHERE building_id = :id"), {"id": a.id}
    )
    assert remaining == 0


# --- 4: one row per (building, feature) --------------------------------------------------------


async def test_duplicate_feature_for_a_building_is_rejected(db: AsyncSession):
    a = await _building(db, "a")
    db.add(BuildingFeature(building_id=a.id, feature=Feature.PACKAGES))
    await db.flush()

    with pytest.raises(IntegrityError, match="pk_building_features"):
        await db.execute(
            text("INSERT INTO building_features (building_id, feature) VALUES (:b, 'packages')"),
            {"b": a.id},
        )


async def test_same_feature_in_two_buildings_is_allowed(db: AsyncSession):
    a = await _building(db, "a")
    b = await _building(db, "b")
    db.add_all(
        [
            BuildingFeature(building_id=a.id, feature=Feature.PACKAGES),
            BuildingFeature(building_id=b.id, feature=Feature.PACKAGES),
        ]
    )
    await db.flush()


# --- 5: check constraints on slug and feature ---------------------------------------------------


@pytest.mark.parametrize("slug", ["Maple Tower", "maple_tower", "Maple", ""])
async def test_invalid_slug_is_rejected_by_the_database(db: AsyncSession, slug: str):
    with pytest.raises(IntegrityError, match="ck_buildings_slug_format"):
        await _building(db, slug)


async def test_valid_slug_is_accepted(db: AsyncSession):
    building = await _building(db, "maple-tower-2")
    assert building.slug == "maple-tower-2"


async def test_feature_outside_the_enum_is_rejected_by_the_database(db: AsyncSession):
    a = await _building(db, "a")

    # Raw SQL, so SQLAlchemy's enum validation can't catch it first: the CHECK constraint must.
    with pytest.raises(IntegrityError, match="ck_building_features_feature"):
        await db.execute(
            text("INSERT INTO building_features (building_id, feature) VALUES (:b, 'gym')"),
            {"b": a.id},
        )


def test_feature_enum_values_are_the_lowercase_ticket_list():
    assert [f.value for f in Feature] == [
        "packages",
        "notices",
        "maintenance",
        "amenities",
        "moves",
        "visitors",
        "reports",
        "financials",
    ]


# --- 6: timezone validation ---------------------------------------------------------------------


@pytest.mark.parametrize(
    "tz",
    # localtime follows the host's /etc/localtime; Factory and posixrules aren't real zones.
    ["Mars/Base", "", "america/toronto", "EST5EDT ", "localtime", "Factory", "posixrules"],
)
def test_validate_timezone_rejects_unknown_zones(tz: str):
    with pytest.raises(ValueError, match="timezone"):
        validate_timezone(tz)


def test_validate_timezone_returns_a_known_zone_unchanged():
    assert validate_timezone("America/Toronto") == "America/Toronto"


@pytest.mark.parametrize("tz", ["localtime", "Factory"])
def test_building_rejects_a_host_dependent_or_placeholder_zone(tz: str):
    with pytest.raises(ValueError, match="timezone"):
        Building(slug="a", name="A", address="1 Main St", timezone=tz)


def test_building_rejects_an_invalid_timezone_before_any_sql():
    with pytest.raises(ValueError, match="timezone"):
        Building(slug="a", name="A", address="1 Main St", timezone="Mars/Base")

    building = Building(slug="a", name="A", address="1 Main St", timezone="America/Toronto")
    with pytest.raises(ValueError, match="timezone"):
        building.timezone = "Mars/Base"


# --- 8: slug and join_code uniqueness -----------------------------------------------------------


async def test_duplicate_slug_is_rejected(db: AsyncSession):
    await _building(db, "maple")

    with pytest.raises(IntegrityError, match="uq_buildings_slug"):
        await _building(db, "maple")


async def test_duplicate_join_code_is_rejected(db: AsyncSession):
    await _building(db, "a", join_code="JOIN1234")

    with pytest.raises(IntegrityError, match="uq_buildings_join_code"):
        await _building(db, "b", join_code="JOIN1234")


async def test_many_buildings_may_have_no_join_code(db: AsyncSession):
    await _building(db, "a")
    await _building(db, "b")

    nulls = await db.scalar(
        select(func.count()).select_from(Building).where(Building.join_code.is_(None))
    )
    assert nulls == 2


# --- 9: (building_id, id) is a working composite-FK target (ADR-0005) ---------------------------


async def test_composite_fk_to_units_rejects_a_unit_from_another_building(db: AsyncSession):
    a = await _building(db, "a")
    b = await _building(db, "b")
    unit_in_a = await _unit(db, a, "101")
    # Shaped like a future tenant table (packages): rolled back with the test.
    await db.execute(
        text(
            "CREATE TABLE _unit_ref_probe ("
            " building_id uuid NOT NULL, unit_id uuid NOT NULL,"
            " FOREIGN KEY (building_id, unit_id) REFERENCES units (building_id, id))"
        )
    )
    insert = text("INSERT INTO _unit_ref_probe (building_id, unit_id) VALUES (:b, :u)")

    await db.execute(insert, {"b": a.id, "u": unit_in_a.id})
    with pytest.raises(IntegrityError, match="_unit_ref_probe"):
        await db.execute(insert, {"b": b.id, "u": unit_in_a.id})


# --- 10: defaults ------------------------------------------------------------------------------


async def test_building_feature_and_unit_defaults(db: AsyncSession):
    a = await _building(db, "a")
    feature = BuildingFeature(building_id=a.id, feature=Feature.NOTICES)
    db.add(feature)
    unit = await _unit(db, a, "101")
    db.expunge_all()  # re-read from the database, not the objects just added

    building = await db.get_one(Building, a.id)
    assert (building.locale, building.is_active, building.join_code) == ("en", True, None)
    assert building.created_at is not None
    assert building.updated_at is not None
    stored = await db.get_one(BuildingFeature, (a.id, Feature.NOTICES))
    assert (stored.enabled, stored.config) == (True, {})
    assert (await db.get_one(Unit, unit.id)).is_active is True


async def test_raw_inserts_get_server_defaults(db: AsyncSession):
    building_id: UUID = (
        await db.execute(
            text(
                "INSERT INTO buildings (id, slug, name, address, timezone)"
                " VALUES (gen_random_uuid(), 'raw', 'Raw', '1 Main St', 'America/Toronto')"
                " RETURNING id"
            )
        )
    ).scalar_one()
    await db.execute(
        text("INSERT INTO building_features (building_id, feature) VALUES (:b, 'moves')"),
        {"b": building_id},
    )
    unit_active = (
        await db.execute(
            text(
                "INSERT INTO units (id, building_id, label) VALUES (gen_random_uuid(), :b, '1')"
                " RETURNING is_active"
            ),
            {"b": building_id},
        )
    ).scalar_one()

    building_row = (
        await db.execute(
            text("SELECT locale, is_active FROM buildings WHERE id = :b"), {"b": building_id}
        )
    ).one()
    feature_row = (
        await db.execute(
            text("SELECT enabled, config FROM building_features WHERE building_id = :b"),
            {"b": building_id},
        )
    ).one()
    assert tuple(building_row) == ("en", True)
    assert tuple(feature_row) == (True, {})
    assert unit_active is True


# --- 11: every models module is registered for Alembic -----------------------------------------


def _imported_modules(path: Path) -> set[str]:
    tree = ast.parse(path.read_text())
    names: set[str] = set()
    for node in ast.walk(tree):
        if isinstance(node, ast.Import):
            names.update(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.add(node.module)
            names.update(f"{node.module}.{alias.name}" for alias in node.names)
    return names


def test_every_models_module_is_imported_by_the_registry():
    app_dir = BACKEND_DIR / "app"
    # A feature's tables live in models.py, or in a models/ package (its __init__ imports them).
    paths = [*app_dir.rglob("models.py"), *app_dir.rglob("models/__init__.py")]
    model_modules = {
        ".".join(path.relative_to(BACKEND_DIR).with_suffix("").parts).removesuffix(".__init__")
        for path in paths
    } - {"app.models"}  # the shared base/mixins/types package, not a feature
    registered = _imported_modules(app_dir / "models" / "registry.py")

    assert {"app.buildings.models", "app.units.models"} <= model_modules
    assert model_modules - registered == set()


def test_migrations_env_imports_the_registry():
    assert "app.models.registry" in _imported_modules(BACKEND_DIR / "migrations" / "env.py")


# --- 7: the migration round-trips, and models match it -----------------------------------------


async def _table_names(url: str) -> set[str]:
    engine = create_async_engine(url)
    try:
        async with engine.connect() as conn:
            return set(await conn.run_sync(lambda sync: inspect(sync).get_table_names()))
    finally:
        await engine.dispose()


def test_migration_upgrades_downgrades_and_upgrades_again(scratch_database_url: str):
    # A scratch database, so dropping tables never disturbs the session's test schema.
    scratch = scratch_database_url

    cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    cfg.attributes["database_url"] = scratch
    cfg.attributes["configure_logger"] = False

    # Pinned revisions, not `-1`: later migrations stack on top and must not change what this tests.
    command.upgrade(cfg, P1_01_REVISION)
    assert asyncio.run(_table_names(scratch)) >= TABLES

    command.downgrade(cfg, P1_01_DOWN_REVISION)
    assert asyncio.run(_table_names(scratch)) & TABLES == set()

    command.upgrade(cfg, "head")
    assert asyncio.run(_table_names(scratch)) >= TABLES
    command.check(cfg)  # raises if the models and the migrated schema differ


# --- review round 1 (L1): CHECK constraints match the models -------------------------------------
# `alembic check` doesn't compare CHECK constraints, so a model or enum change without a migration
# would otherwise go unnoticed.


async def _check_definition(db: AsyncSession, name: str) -> str:
    definition = await db.scalar(
        text("SELECT pg_get_constraintdef(oid) FROM pg_constraint WHERE conname = :name"),
        {"name": name},
    )
    assert definition is not None, f"constraint {name} is missing"
    return str(definition)


async def test_feature_check_in_the_database_lists_exactly_the_enum_values(db: AsyncSession):
    definition = await _check_definition(db, "ck_building_features_feature")

    assert set(re.findall(r"'([^']*)'", definition)) == {f.value for f in Feature}


async def test_slug_check_in_the_database_uses_the_models_pattern(db: AsyncSession):
    (model_check,) = (
        c for c in Building.__table__.constraints if c.name == "ck_buildings_slug_format"
    )
    (model_pattern,) = re.findall(r"'([^']*)'", str(model_check.sqltext))  # type: ignore[attr-defined]
    definition = await _check_definition(db, "ck_buildings_slug_format")

    assert re.findall(r"~ '([^']*)'", definition) == [model_pattern]
