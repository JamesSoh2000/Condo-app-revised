"""One commit per create (P6-03b criterion 10, CLAUDE.md rule 5): a failure before it leaves
nothing, and the photos unattached again."""

from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.files.models import File
from app.maintenance import service
from tests.maintenance.conftest import make_maintenance_file
from tests.maintenance.test_api import counts, create, unit_body
from tests.world import World

pytestmark = pytest.mark.anyio


async def _fail(*args: Any, **kwargs: Any) -> None:
    raise RuntimeError("simulated failure")


@pytest.mark.parametrize("step", ["notify", "record_audit"])
async def test_a_failure_after_the_insert_and_claims_leaves_nothing(
    as_user: Any, world: World, db: AsyncSession, monkeypatch: pytest.MonkeyPatch, step: str
) -> None:
    # An emergency, so the audit failure comes after the notifications and their email jobs.
    photos = [
        await make_maintenance_file(db, world.a.id, world.a_resident1.user.id) for _ in range(2)
    ]
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    monkeypatch.setattr(service, step, _fail)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await create(
            client,
            world,
            unit_body(
                world.a_101,
                category="emergency",
                photo_file_ids=[str(photo.id) for photo in photos],
            ),
        )

    assert await counts(db) == before
    for photo in photos:
        attached = await db.scalar(
            select(File.attached_id)
            .where(File.id == photo.id)
            .execution_options(populate_existing=True)
        )
        assert attached is None
