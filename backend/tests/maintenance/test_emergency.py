"""The emergency phone (P6-03b criterion 7, ADR-0021): an `emergency` request carries the building's
phone from the maintenance feature's `config`; set by the seed and `bootstrap-building`."""

from typing import Any

import pytest
from pydantic import ValidationError
from sqlalchemy import select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.buildings.service import bootstrap_building
from app.seed import seed
from tests.cli.test_bootstrap import _input
from tests.maintenance.conftest import make_maintenance_request
from tests.maintenance.test_api import base, common_body, create, unit_body
from tests.world import World

pytestmark = pytest.mark.anyio

PHONE = "+1 416-555-0100"


async def _set_config(db: AsyncSession, world: World, config: dict[str, Any]) -> None:
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
        .values(config=config)
    )


async def test_an_emergency_request_carries_the_phone_on_every_read(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    await _set_config(db, world, {"emergency_phone": PHONE})
    resident = await as_user(world.a_resident1.user)

    created = await create(resident, world, unit_body(world.a_101, category="emergency"))

    assert created.status_code == 201, created.text
    assert created.json()["emergency_phone"] == PHONE
    request_id = created.json()["id"]
    for persona in ("a_resident1", "a_manager", "a_security"):
        client = await as_user(getattr(world, persona).user)
        one = await client.get(f"{base(world)}/{request_id}")
        assert one.json()["emergency_phone"] == PHONE, persona
        [item] = (await client.get(base(world))).json()["items"]
        assert item["emergency_phone"] == PHONE, persona
    # Cancel answers with the request too.
    cancelled = await resident.post(f"{base(world)}/{request_id}/cancel")
    assert cancelled.json()["emergency_phone"] == PHONE


async def test_no_other_category_carries_the_phone(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    await _set_config(db, world, {"emergency_phone": PHONE})
    client = await as_user(world.a_resident1.user)
    for category in ("plumbing", "electrical", "other"):
        created = await create(client, world, common_body(category=category))
        assert created.status_code == 201, created.text
        assert created.json()["emergency_phone"] is None
    items = (await client.get(base(world))).json()["items"]
    assert all(item["emergency_phone"] is None for item in items)


@pytest.mark.parametrize(
    "config",
    [
        {},
        {"emergency_phone": None},
        {"emergency_phone": ""},
        {"emergency_phone": "  "},
        {"emergency_phone": 4165550100},
        {"emergency_phone": ["x"]},
        {"emergency_phone": "x" * 33},
    ],
)
async def test_a_building_without_a_usable_phone_gives_null(
    as_user: Any, world: World, db: AsyncSession, config: dict[str, Any]
) -> None:
    await _set_config(db, world, config)
    client = await as_user(world.a_resident1.user)
    created = await create(client, world, common_body(category="emergency"))
    assert created.status_code == 201, created.text
    assert created.json()["emergency_phone"] is None


async def test_another_buildings_phone_is_never_shown(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.b.id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
        .values(config={"emergency_phone": PHONE})
    )
    request = await make_maintenance_request(
        db, world.a_resident1.membership, world.a_101, category="emergency"
    )
    client = await as_user(world.a_resident1.user)
    assert (await client.get(f"{base(world)}/{request.id}")).json()["emergency_phone"] is None


async def test_the_seed_sets_maples_phone(db: AsyncSession) -> None:
    await seed(db, app_env="dev")
    config = await db.scalar(
        select(BuildingFeature.config)
        .join(Building, Building.id == BuildingFeature.building_id)
        .where(Building.slug == "maple", BuildingFeature.feature == Feature.MAINTENANCE)
    )
    assert config is not None and isinstance(config.get("emergency_phone"), str)
    assert config["emergency_phone"].strip()


async def test_bootstrap_sets_the_phone_on_the_maintenance_feature(
    db: AsyncSession, world: World
) -> None:
    result = await bootstrap_building(db, _input(emergency_phone=PHONE), None, dry_run=False)
    rows: dict[Feature, dict[str, Any]] = dict(
        (
            await db.execute(
                select(BuildingFeature.feature, BuildingFeature.config).where(
                    BuildingFeature.building_id == result.building_id
                )
            )
        ).all()
    )
    assert rows == {
        Feature.PACKAGES: {},
        Feature.NOTICES: {},
        Feature.MAINTENANCE: {"emergency_phone": PHONE},
    }


async def test_bootstrap_without_a_phone_leaves_config_empty(
    db: AsyncSession, world: World
) -> None:
    result = await bootstrap_building(db, _input(), None, dry_run=False)
    configs = await db.scalars(
        select(BuildingFeature.config).where(BuildingFeature.building_id == result.building_id)
    )
    assert list(configs) == [{}, {}, {}]


@pytest.mark.parametrize(
    ("overrides", "field"),
    [
        ({"emergency_phone": PHONE, "features": [Feature.PACKAGES]}, "emergency_phone"),
        ({"emergency_phone": ""}, "emergency_phone"),
        ({"emergency_phone": "x" * 33}, "emergency_phone"),
        ({"emergency_phone": "416\n555"}, "emergency_phone"),
        ({"emergency_phone": "\t416 555 0100"}, "emergency_phone"),
    ],
)
def test_bootstrap_refuses_a_bad_phone(overrides: dict[str, Any], field: str) -> None:
    with pytest.raises(ValidationError) as caught:
        _input(**overrides)
    assert caught.value.errors()[0]["loc"][0] == field


def test_bootstrap_strips_the_phone() -> None:
    assert _input(emergency_phone="  416 555 0100 ").emergency_phone == "416 555 0100"
