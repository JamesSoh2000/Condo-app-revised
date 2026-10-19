"""`search_unit_options`, the join flow's unit query (P4-01 criterion 6)."""

import pytest

from app.units.schemas import UnitOption
from app.units.service import search_unit_options
from tests.factories import make_unit

pytestmark = pytest.mark.anyio


async def test_options_return_only_id_tower_label_of_active_units(db, world):
    inactive = await make_unit(db, world.a, label="103", is_active=False)

    options = await search_unit_options(db, world.a.id, "10")

    assert set(UnitOption.model_fields) == {"id", "tower", "label"}
    assert [o.model_dump() for o in options] == [
        {"id": world.a_101.id, "tower": None, "label": "101"},
        {"id": world.a_102.id, "tower": None, "label": "102"},
    ]
    assert inactive.id not in {o.id for o in options}


async def test_options_are_scoped_to_the_building(db, world):
    options = await search_unit_options(db, world.b.id, "")

    assert [o.id for o in options] == [world.b_101.id]


async def test_options_limit_and_order(db, world):
    await make_unit(db, world.a, tower="B", label="100")
    await make_unit(db, world.a, tower="A", label="100")

    options = await search_unit_options(db, world.a.id, "10", limit=3)

    assert [(o.tower, o.label) for o in options] == [(None, "101"), (None, "102"), ("A", "100")]


@pytest.mark.parametrize(("limit", "expected"), [(0, 1), (-5, 1), (1000, 50)])
async def test_options_limit_is_clamped(db, world, limit, expected):
    for n in range(60):
        await make_unit(db, world.a, label=f"9{n:02d}")

    options = await search_unit_options(db, world.a.id, "9", limit=limit)

    assert len(options) == expected


@pytest.mark.parametrize("search", ["1_1", "%", "1%"])
async def test_options_search_treats_wildcards_literally(db, world, search):
    assert await search_unit_options(db, world.a.id, search) == []


async def test_options_search_is_a_case_insensitive_prefix(db, world):
    unit = await make_unit(db, world.a, label="PH2")
    await make_unit(db, world.a, label="APH2")

    options = await search_unit_options(db, world.a.id, "ph")

    assert [o.id for o in options] == [unit.id]
