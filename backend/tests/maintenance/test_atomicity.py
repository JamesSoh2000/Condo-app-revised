"""One commit per write (P6-03b criterion 10, P6-03e criterion 4, P6-03d criterion 8, CLAUDE.md
rule 5): a failure before it leaves nothing, and the photos unattached again."""

import uuid
from typing import Any

import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.files.models import File
from app.maintenance import service
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import MaintenanceRequest
from tests.maintenance.conftest import make_maintenance_file, make_maintenance_request
from tests.maintenance.test_api import base, counts, create, unit_body
from tests.maintenance.test_comments_api import comments_url
from tests.maintenance.test_comments_api import counts as comment_counts
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


async def test_a_failure_after_the_cancel_update_leaves_it_submitted(
    as_user: Any, world: World, db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The audit row is written after the UPDATE, before the commit.
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    monkeypatch.setattr(service, "record_audit", _fail)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await client.post(f"{base(world)}/{request.id}/cancel")

    assert await counts(db) == before
    row = await db.scalar(
        select(MaintenanceRequest)
        .where(MaintenanceRequest.id == request.id)
        .execution_options(populate_existing=True)
    )
    assert row is not None
    assert (row.status, row.cancelled_at, row.cancelled_by_membership_id) == (
        MaintenanceStatus.SUBMITTED,
        None,
        None,
    )


@pytest.mark.parametrize(
    ("persona", "step"),
    [("a_manager", "notify"), ("a_manager", "record_audit"), ("a_resident1", "notify")],
)
async def test_a_failure_after_the_comment_insert_leaves_nothing(
    as_user: Any,
    world: World,
    db: AsyncSession,
    monkeypatch: pytest.MonkeyPatch,
    persona: str,
    step: str,
) -> None:
    # A staff comment's notification also queues an email job; the audit row comes last.
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    client = await as_user(getattr(world, persona).user)
    before = await comment_counts(db)
    monkeypatch.setattr(service, step, _fail)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await client.post(comments_url(world, request.id), json={"body": "On it."})

    assert await comment_counts(db) == before


@pytest.mark.parametrize("internal", [False, True])
async def test_a_comment_is_audited_by_id_and_flag_never_by_body(
    as_user: Any, world: World, db: AsyncSession, internal: bool
) -> None:
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    client = await as_user(world.a_manager.user)

    response = await client.post(
        comments_url(world, request.id), json={"body": "Lockbox 4321", "internal": internal}
    )

    assert response.status_code == 201, response.text
    [event] = await db.scalars(
        select(AuditEvent).where(AuditEvent.action == "maintenance.commented")
    )
    assert (
        event.entity_type,
        event.entity_id,
        event.building_id,
        event.actor_user_id,
        event.metadata_,
    ) == (
        "maintenance_request",
        request.id,
        world.a.id,
        world.a_manager.user.id,
        {"comment_id": str(uuid.UUID(response.json()["id"])), "is_internal": internal},
    )
    assert "Lockbox" not in str(event.metadata_)
