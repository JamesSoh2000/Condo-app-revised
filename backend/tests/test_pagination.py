"""Keyset pagination (P1-04 criteria 5-6) over real `buildings` rows."""

from typing import Annotated, Any
from uuid import UUID, uuid4

import pytest
from fastapi import APIRouter, Depends
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.buildings.models import Building
from app.core.dependencies import get_db_session
from app.core.pagination import CursorParams, Page, encode_cursor, paginate
from app.core.schemas import APIModel

router = APIRouter(prefix="/probe", tags=["probe"])


class BuildingItem(APIModel):
    id: UUID
    slug: str


@router.get("/buildings")
async def list_buildings(
    params: Annotated[CursorParams, Depends()],
    db: Annotated[AsyncSession, Depends(get_db_session)],
) -> Page[BuildingItem]:
    # The caller's filter must survive pagination: rows outside it are never listed.
    stmt = select(Building).where(Building.slug.startswith("page-"))
    return await paginate(db, stmt, Building.id, params, BuildingItem.model_validate)


async def add_buildings(db: AsyncSession, count: int, prefix: str = "page") -> list[UUID]:
    """Insert `count` buildings one flush at a time (uuid7 ids ascend); return ids newest first."""
    ids = []
    for _ in range(count):
        building = Building(
            slug=f"{prefix}-{uuid4().hex}",
            name="Probe",
            address="1 Probe St",
            timezone="America/Toronto",
        )
        db.add(building)
        await db.flush()
        ids.append(building.id)
    return ids[::-1]


async def follow_pages(c, limit: int) -> list[dict[str, Any]]:
    pages: list[dict[str, Any]] = []
    params: dict[str, object] = {"limit": limit}
    while True:
        response = await c.get("/api/probe/buildings", params=params)
        assert response.status_code == 200, response.text
        page = response.json()
        pages.append(page)
        if page["next_cursor"] is None:
            return pages
        params = {"limit": limit, "cursor": page["next_cursor"]}


# Criterion 5


@pytest.mark.anyio
async def test_following_next_cursor_lists_every_row_once_newest_first(app_client, db):
    expected = await add_buildings(db, 60)
    await add_buildings(db, 5, prefix="other")
    await db.commit()

    async with app_client(router) as c:
        pages = await follow_pages(c, limit=25)

    assert [len(p["items"]) for p in pages] == [25, 25, 10]
    ids = [UUID(item["id"]) for p in pages for item in p["items"]]
    assert len(set(ids)) == 60
    assert ids == expected
    assert pages[-1]["next_cursor"] is None


@pytest.mark.anyio
async def test_exact_multiple_of_limit_has_no_empty_last_page(app_client, db):
    await add_buildings(db, 60)
    await db.commit()

    async with app_client(router) as c:
        pages = await follow_pages(c, limit=20)

    assert [len(p["items"]) for p in pages] == [20, 20, 20]
    assert pages[-1]["next_cursor"] is None


@pytest.mark.anyio
async def test_row_inserted_between_requests_does_not_shift_later_pages(app_client, db):
    expected = await add_buildings(db, 60)
    await db.commit()

    async with app_client(router) as c:
        first = (await c.get("/api/probe/buildings", params={"limit": 25})).json()
        await add_buildings(db, 1)
        await db.commit()
        second = (
            await c.get(
                "/api/probe/buildings", params={"limit": 25, "cursor": first["next_cursor"]}
            )
        ).json()

    assert [UUID(i["id"]) for i in second["items"]] == expected[25:50]


@pytest.mark.anyio
async def test_no_limit_means_25(app_client, db):
    await add_buildings(db, 30)
    await db.commit()

    async with app_client(router) as c:
        response = await c.get("/api/probe/buildings")

    assert len(response.json()["items"]) == 25


@pytest.mark.anyio
async def test_paginate_replaces_the_callers_order_and_limit(db):
    expected = await add_buildings(db, 6)

    stmt = select(Building).order_by(Building.slug).limit(2).offset(3)
    page = await paginate(db, stmt, Building.id, CursorParams(limit=4), BuildingItem.model_validate)

    assert [item.id for item in page.items] == expected[:4]
    assert page.next_cursor == encode_cursor(expected[3])


# Criterion 6


@pytest.mark.anyio
@pytest.mark.parametrize("limit", ["0", "101", "-1", "ten"])
async def test_limit_outside_1_to_100_is_validation_error(app_client, limit):
    async with app_client(router) as c:
        response = await c.get("/api/probe/buildings", params={"limit": limit})

    assert response.status_code == 422
    assert response.json()["code"] == "validation_error"
    assert response.json()["errors"][0]["loc"] == ["query", "limit"]


def _non_canonical(cursor: str) -> str:
    # 22 base64url characters carry 132 bits for 16 bytes: the last character's low 4 bits are
    # padding, so flipping its lowest bit decodes to the same id.
    alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_"
    return cursor[:-1] + alphabet[alphabet.index(cursor[-1]) ^ 1]


@pytest.mark.anyio
@pytest.mark.parametrize(
    "cursor",
    [
        "garbage!",
        "abc",
        "",
        encode_cursor(UUID(int=7)) + "A",
        encode_cursor(UUID(int=7)) + "==",
        _non_canonical(encode_cursor(UUID(int=7))),
        "AAAAAAAAAAAAAAAAAAAA+/",
    ],
)
async def test_garbage_cursor_is_400_invalid_cursor(app_client, cursor):
    async with app_client(router) as c:
        response = await c.get("/api/probe/buildings", params={"cursor": cursor})

    assert response.status_code == 400
    assert response.headers["content-type"] == "application/problem+json"
    assert response.json()["code"] == "invalid_cursor"


@pytest.mark.anyio
async def test_overlong_cursor_is_validation_error(app_client):
    async with app_client(router) as c:
        response = await c.get("/api/probe/buildings", params={"cursor": "A" * 65})

    assert response.status_code == 422
    assert response.json()["errors"][0]["loc"] == ["query", "cursor"]


def test_cursor_round_trips_and_is_url_safe():
    some_id = UUID("01920000-0000-7000-8000-00000000ffff")

    cursor = encode_cursor(some_id)

    assert len(cursor) == 22
    assert cursor.replace("-", "").replace("_", "").isalnum()
    assert CursorParams(cursor=cursor).after_id == some_id
