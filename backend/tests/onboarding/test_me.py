"""`GET /api/buildings/{b}/onboarding/me` (P4-05a criterion 10): a member's own onboarding status,
pending included, while the operational routes stay closed to them."""

import pytest
from httpx import AsyncClient
from sqlalchemy import func
from sqlalchemy.ext.asyncio import AsyncSession

from app.memberships.enums import MembershipStatus, OccupancyRelationship
from app.memberships.models import BuildingMembership
from app.onboarding.models import OnboardingRequest, OnboardingStatus
from app.units.models import Unit
from tests.conftest import UserClientFactory
from tests.factories import make_membership, make_unit, make_user
from tests.helpers.tenancy import assert_problem
from tests.world import World

pytestmark = pytest.mark.anyio


def _url(building_id: object) -> str:
    return f"/api/buildings/{building_id}/onboarding/me"


async def _request(
    db: AsyncSession,
    membership: BuildingMembership,
    unit: Unit,
    status: OnboardingStatus = OnboardingStatus.PENDING,
    reason: str | None = None,
    decided_by: object = None,
) -> OnboardingRequest:
    request = OnboardingRequest(
        building_id=membership.building_id,
        membership_id=membership.id,
        unit_id=unit.id,
        relationship=OccupancyRelationship.TENANT,
        status=status,
        decided_at=None if status == OnboardingStatus.PENDING else func.now(),
        decided_by_user_id=decided_by,
        decision_reason=reason,
    )
    db.add(request)
    await db.flush()
    return request


async def test_pending_user_sees_their_status_but_not_the_building(
    db: AsyncSession, world: World, as_user: UserClientFactory
) -> None:
    unit = await make_unit(db, world.a, label="1003", tower="T1")
    await _request(db, world.a_pending.membership, unit)
    client = await as_user(world.a_pending.user)

    operational = await client.get(f"/api/buildings/{world.a.id}")
    response = await client.get(_url(world.a.id))

    assert_problem(operational, 404, "building_not_found")
    assert response.status_code == 200, response.text
    assert response.json() == {
        "status": "pending",
        "unit_label": "1003",
        "tower": "T1",
        "relationship": "tenant",
        "decision_reason": None,
    }


async def test_denied_user_sees_the_reason(
    db: AsyncSession, world: World, as_user: UserClientFactory
) -> None:
    user = await make_user(db)
    membership = await make_membership(user, world.a, status=MembershipStatus.DENIED)
    await _request(
        db,
        membership,
        world.a_101,
        OnboardingStatus.DENIED,
        "Not on the lease.",
        world.a_manager.user.id,
    )
    client = await as_user(user)

    response = await client.get(_url(world.a.id))

    assert response.status_code == 200, response.text
    assert response.json()["status"] == "denied"
    assert response.json()["decision_reason"] == "Not on the lease."


async def test_the_latest_request_is_shown_after_a_resubmission(
    db: AsyncSession, world: World, as_user: UserClientFactory
) -> None:
    user = await make_user(db)
    membership = await make_membership(user, world.a, status=MembershipStatus.PENDING)
    await _request(
        db, membership, world.a_101, OnboardingStatus.DENIED, "Wrong unit.", world.a_manager.user.id
    )
    await _request(db, membership, world.a_102)
    client = await as_user(user)

    body = (await client.get(_url(world.a.id))).json()

    assert (body["status"], body["unit_label"], body["decision_reason"]) == ("pending", "102", None)


async def test_member_without_a_request_gets_null_unit_fields(
    db: AsyncSession, world: World, as_user: UserClientFactory
) -> None:
    client = await as_user(world.a_manager.user)

    response = await client.get(_url(world.a.id))

    assert response.status_code == 200, response.text
    assert response.json() == {
        "status": "active",
        "unit_label": None,
        "tower": None,
        "relationship": None,
        "decision_reason": None,
    }


async def test_another_buildings_member_gets_404(
    db: AsyncSession, world: World, as_user: UserClientFactory
) -> None:
    client = await as_user(world.a_pending.user)

    assert_problem(await client.get(_url(world.b.id)), 404, "building_not_found")


async def test_deactivated_member_gets_404(
    db: AsyncSession, world: World, as_user: UserClientFactory
) -> None:
    user = await make_user(db)
    membership = await make_membership(user, world.a, status=MembershipStatus.DEACTIVATED)
    await _request(
        db, membership, world.a_101, OnboardingStatus.APPROVED, None, world.a_manager.user.id
    )
    client = await as_user(user)

    assert_problem(await client.get(_url(world.a.id)), 404, "building_not_found")


async def test_onboarding_me_needs_a_session(client: AsyncClient, world: World) -> None:
    assert_problem(await client.get(_url(world.a.id)), 401, "not_authenticated")


async def test_another_members_request_never_shows(
    db: AsyncSession, world: World, as_user: UserClientFactory
) -> None:
    await _request(db, world.a_pending.membership, world.a_101)
    client = await as_user(world.a_resident2.user)

    body = (await client.get(_url(world.a.id))).json()

    assert body["unit_label"] is None
