"""Cancel (P6-03e criteria 1 and 3: tenant rows 1, 4, 5, 7 and 8 on `POST …/{id}/cancel`). Rows 2,
3 and 6 and the feature switch are in `test_api.py`; the two concurrent cancels and the
start-vs-cancel race in `test_concurrency.py`."""

import uuid
from datetime import timedelta
from typing import Any

import pytest
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.maintenance.enums import MaintenanceStatus
from app.maintenance.models import MaintenanceRequest
from tests.helpers.tenancy import (
    assert_forbidden_role,
    assert_not_visible,
    assert_problem,
    without_request_id,
)
from tests.maintenance.conftest import make_maintenance_request
from tests.maintenance.test_api import base, counts
from tests.world import World

pytestmark = pytest.mark.anyio


async def _row(db: AsyncSession, request_id: uuid.UUID) -> MaintenanceRequest:
    row = await db.scalar(
        select(MaintenanceRequest)
        .where(MaintenanceRequest.id == request_id)
        .execution_options(populate_existing=True)
    )
    assert row is not None
    return row


async def test_requester_cancels_a_submitted_request(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    client = await as_user(world.a_resident1.user)

    response = await client.post(f"{base(world)}/{request.id}/cancel")

    assert response.status_code == 200, response.text
    row = await _row(db, request.id)
    assert row.status == MaintenanceStatus.CANCELLED
    assert row.cancelled_by_membership_id == world.a_resident1.membership.id
    now = await db.scalar(select(func.clock_timestamp()))
    assert row.cancelled_at is not None and now is not None
    assert row.submitted_at <= row.cancelled_at <= now
    body = response.json()
    assert (body["status"], body["cancelled_at"]) == (
        "cancelled",
        row.cancelled_at.isoformat().replace("+00:00", "Z"),
    )
    events = list(await db.scalars(select(AuditEvent).where(AuditEvent.entity_id == request.id)))
    assert [(e.action, e.entity_type, e.actor_user_id, e.metadata_) for e in events] == [
        (
            "maintenance.cancelled",
            "maintenance_request",
            world.a_resident1.user.id,
            {"from_status": "submitted"},
        )
    ]


async def test_a_common_area_request_is_cancelled_by_its_requester(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await make_maintenance_request(db, world.a_resident2.membership, None)
    client = await as_user(world.a_resident2.user)
    response = await client.post(f"{base(world)}/{request.id}/cancel")
    assert response.status_code == 200, response.text
    assert response.json()["location"] == "common_area"


async def test_a_requester_who_moved_out_still_cancels_their_own(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # 1c: a_former filed for 101 before T1 and lives in 102 now. Visibility follows the requester;
    # a_resident1, in 101 now but not then, can't see it (the occupancy window).
    request = await make_maintenance_request(
        db, world.a_former.membership, world.a_101, submitted_at=world.T0 + timedelta(days=1)
    )
    current = await as_user(world.a_resident1.user)
    await assert_not_visible(
        current, "POST", f"{base(world)}/{request.id}/cancel", code="maintenance_request_not_found"
    )
    assert (await _row(db, request.id)).status == MaintenanceStatus.SUBMITTED

    former = await as_user(world.a_former.user)
    response = await former.post(f"{base(world)}/{request.id}/cancel")

    assert response.status_code == 200, response.text
    row = await _row(db, request.id)
    assert (row.status, row.cancelled_by_membership_id) == (
        MaintenanceStatus.CANCELLED,
        world.a_former.membership.id,
    )


async def test_a_council_resident_cancels_their_own(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # Council + resident passes `require_roles(RESIDENT)`.
    request = await make_maintenance_request(db, world.a_council.membership, world.a_201)
    client = await as_user(world.a_council.user)
    response = await client.post(f"{base(world)}/{request.id}/cancel")
    assert response.status_code == 200, response.text
    assert response.json()["status"] == "cancelled"
    # A resident's answer never names the requester (P6-03b D8).
    assert response.json()["requester_name"] is None


async def test_a_co_occupant_who_sees_the_request_may_not_cancel_it(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # a_former lives in 102 since T1, so sees a_resident2's 102 request.
    request = await make_maintenance_request(db, world.a_resident2.membership, world.a_102)
    client = await as_user(world.a_former.user)
    assert (await client.get(f"{base(world)}/{request.id}")).status_code == 200
    before = await counts(db)

    response = await client.post(f"{base(world)}/{request.id}/cancel")

    assert_problem(response, 403, "not_requester")
    assert await counts(db) == before
    assert (await _row(db, request.id)).status == MaintenanceStatus.SUBMITTED


async def test_a_co_occupant_gets_not_requester_even_once_it_was_started(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    # Ownership is answered before the status: the caller could never cancel it.
    request = await make_maintenance_request(
        db,
        world.a_resident2.membership,
        world.a_102,
        status=MaintenanceStatus.IN_PROGRESS,
        acted_by=world.a_manager.membership,
    )
    client = await as_user(world.a_former.user)
    assert_problem(await client.post(f"{base(world)}/{request.id}/cancel"), 403, "not_requester")


async def test_another_residents_request_is_the_same_404_as_none(
    as_user: Any, world: World, db: AsyncSession
) -> None:
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    b_request = await make_maintenance_request(db, world.b_resident1.membership, world.b_101)
    client = await as_user(world.a_resident2.user)
    code = "maintenance_request_not_found"
    before = await counts(db)
    hidden = await assert_not_visible(
        client, "POST", f"{base(world)}/{request.id}/cancel", code=code
    )
    missing = await assert_not_visible(
        client, "POST", f"{base(world)}/{uuid.uuid4()}/cancel", code=code
    )
    assert without_request_id(hidden) == without_request_id(missing)
    # A B request on A's URL, by a resident of A.
    await assert_not_visible(client, "POST", f"{base(world)}/{b_request.id}/cancel", code=code)
    assert await counts(db) == before
    assert (await _row(db, request.id)).status == MaintenanceStatus.SUBMITTED


@pytest.mark.parametrize("persona", ["a_manager", "a_security"])
async def test_staff_may_not_cancel(
    as_user: Any, world: World, db: AsyncSession, persona: str
) -> None:
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    client = await as_user(getattr(world, persona).user)
    await assert_forbidden_role(client, "POST", f"{base(world)}/{request.id}/cancel")
    assert (await _row(db, request.id)).status == MaintenanceStatus.SUBMITTED


@pytest.mark.parametrize(
    "status",
    [
        MaintenanceStatus.IN_PROGRESS,
        MaintenanceStatus.ON_HOLD,
        MaintenanceStatus.RESOLVED,
        MaintenanceStatus.CANCELLED,
    ],
)
async def test_only_a_submitted_request_can_be_cancelled(
    as_user: Any, world: World, db: AsyncSession, status: MaintenanceStatus
) -> None:
    request = await make_maintenance_request(
        db, world.a_resident1.membership, world.a_101, status=status
    )
    client = await as_user(world.a_resident1.user)
    before = await counts(db)
    assert_problem(
        await client.post(f"{base(world)}/{request.id}/cancel"), 409, "invalid_transition"
    )
    assert await counts(db) == before
    assert (await _row(db, request.id)).status == status


async def test_a_body_is_ignored(as_user: Any, world: World, db: AsyncSession) -> None:
    # 1a: no body is defined, so an unexpected one is ignored, never read as an instruction.
    request = await make_maintenance_request(db, world.a_resident1.membership, world.a_101)
    client = await as_user(world.a_resident1.user)
    response = await client.post(
        f"{base(world)}/{request.id}/cancel",
        json={"cancelled_by_membership_id": str(world.a_manager.membership.id)},
    )
    assert response.status_code == 200, response.text
    assert (await _row(db, request.id)).cancelled_by_membership_id == (
        world.a_resident1.membership.id
    )


async def test_the_update_itself_refuses_someone_elses_request(
    as_user: Any, world: World, db: AsyncSession, monkeypatch: pytest.MonkeyPatch
) -> None:
    # Criterion 1: the requester is in the UPDATE's WHERE, not only in the early check. Skip the
    # early check once; the UPDATE must still match nothing, and the re-read answers 403.
    from app.maintenance import service

    request = await make_maintenance_request(db, world.a_resident2.membership, world.a_102)
    real = service._for_cancel
    calls: list[uuid.UUID] = []

    async def skip_first(db: AsyncSession, ctx: Any, request_id: uuid.UUID) -> Any:
        calls.append(request_id)
        if len(calls) == 1:
            return await service._visible(db, ctx, request_id)
        return await real(db, ctx, request_id)

    monkeypatch.setattr(service, "_for_cancel", skip_first)
    client = await as_user(world.a_former.user)
    before = await counts(db)

    assert_problem(await client.post(f"{base(world)}/{request.id}/cancel"), 403, "not_requester")

    assert len(calls) == 2
    assert await counts(db) == before
    assert (await _row(db, request.id)).status == MaintenanceStatus.SUBMITTED
