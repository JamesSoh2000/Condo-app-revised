"""The join routes (P4-05a criteria 4-9): the code lookup, the unit options and the request."""

from collections.abc import AsyncIterator
from typing import Any

import pytest
from httpx import ASGITransport, AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.models import Building
from app.core.config import Settings, settings
from app.jobs.models import Job
from app.main import app
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.notifications.models import Notification
from app.onboarding.models import OnboardingRequest, OnboardingStatus
from app.rate_limits.service import RateLimiter, get_rate_limiter
from app.units.models import Unit
from tests.conftest import CSRF_HEADERS, UserClientFactory
from tests.factories import make_membership, make_unit, make_user
from tests.helpers.tenancy import assert_problem, without_request_id
from tests.test_rate_limit import committing  # noqa: F401 (a fixture)
from tests.world import World

pytestmark = pytest.mark.anyio

CODE_A = "MAPLE-23456"
CODE_B = "BIRCH-23456"


@pytest.fixture
async def codes(db: AsyncSession, world: World) -> None:
    for building, code in ((world.a, CODE_A), (world.b, CODE_B)):
        await db.execute(update(Building).where(Building.id == building.id).values(join_code=code))
    await db.flush()


@pytest.fixture
async def other_ip_client() -> AsyncIterator[AsyncClient]:
    transport = ASGITransport(app=app, client=("203.0.113.9", 4321))
    async with AsyncClient(
        transport=transport, base_url="http://test", headers=CSRF_HEADERS
    ) as other:
        yield other


def _requests_url(code: str = CODE_A) -> str:
    return f"/api/join/{code}/requests"


async def _counts(db: AsyncSession) -> dict[str, int]:
    tables = {
        "memberships": BuildingMembership,
        "roles": MembershipRole,
        "requests": OnboardingRequest,
        "notifications": Notification,
        "audit": AuditEvent,
        "jobs": Job,
    }
    return {
        name: await db.scalar(select(func.count()).select_from(model)) or 0
        for name, model in tables.items()
    }


async def _membership(db: AsyncSession, building: Building, user_id: Any) -> BuildingMembership:
    membership = await db.scalar(
        select(BuildingMembership)
        .where(BuildingMembership.building_id == building.id, BuildingMembership.user_id == user_id)
        .execution_options(populate_existing=True)
    )
    assert membership is not None
    return membership


async def _roles(db: AsyncSession, membership_id: Any) -> list[Role]:
    return sorted(
        await db.scalars(
            select(MembershipRole.role).where(MembershipRole.membership_id == membership_id)
        )
    )


async def _requests(db: AsyncSession, membership_id: Any) -> list[OnboardingRequest]:
    return list(
        await db.scalars(
            select(OnboardingRequest)
            .where(OnboardingRequest.membership_id == membership_id)
            .order_by(OnboardingRequest.id)
            .execution_options(populate_existing=True)
        )
    )


# Criterion 4: the lookup


async def test_join_lookup_without_a_session_names_the_building(
    client: AsyncClient, world: World, codes: None
) -> None:
    response = await client.get(f"/api/join/{CODE_A}")

    assert response.status_code == 200, response.text
    assert response.json() == {"building_id": str(world.a.id), "building_name": world.a.name}


@pytest.mark.parametrize(
    "code",
    [
        "NOPE-NOPE1",
        "maple-23456",
        "MAPLE-23456-TOO-LONG",
        "MAPLE 23456",
        "MAPLE%0023456",
        "%F0%9F%8F%A0",
    ],
)
async def test_join_lookup_of_a_bad_code_is_404(
    client: AsyncClient, codes: None, code: str
) -> None:
    response = await client.get(f"/api/join/{code}")

    assert_problem(response, 404, "join_code_invalid")


async def test_join_lookup_bodies_do_not_tell_bad_codes_apart(
    client: AsyncClient, db: AsyncSession, world: World, codes: None
) -> None:
    await db.execute(update(Building).where(Building.id == world.b.id).values(is_active=False))
    await db.flush()

    bodies = [
        without_request_id((await client.get(f"/api/join/{code}")).json())
        for code in ("NOPE-NOPE1", "bad!code", CODE_B)
    ]

    assert bodies[0] == bodies[1] == bodies[2]
    assert bodies[0]["code"] == "join_code_invalid"


async def test_the_21st_join_lookup_from_one_ip_is_429(
    client: AsyncClient, codes: None, other_ip_client: AsyncClient
) -> None:
    limit = settings.rate_limit_join_ip.limit
    assert limit < 30
    statuses = [(await client.get(f"/api/join/{CODE_A}")).status_code for _ in range(30)]

    assert statuses[:limit] == [200] * limit
    assert set(statuses[limit:]) == {429}
    limited = await client.get(f"/api/join/{CODE_A}")
    assert_problem(limited, 429, "rate_limited")
    assert int(limited.headers["Retry-After"]) >= 1
    assert (await other_ip_client.get(f"/api/join/{CODE_A}")).status_code == 200


def test_join_rate_policy_is_20_per_10_minutes() -> None:
    default = Settings.model_fields["rate_limit_join_ip"].default
    assert (default.limit, default.window_seconds) == (20, 600)


# Criterion 5: the unit options


async def test_join_units_lists_the_buildings_active_units_by_prefix(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    await make_unit(db, world.a, label="1003")
    await make_unit(db, world.a, label="1004", is_active=False)
    await make_unit(db, world.b, label="1005")
    client = await as_user(await make_user(db))

    response = await client.get(f"/api/join/{CODE_A}/units", params={"search": "100"})

    assert response.status_code == 200, response.text
    assert [(u["label"], set(u)) for u in response.json()] == [("1003", {"id", "tower", "label"})]
    everything = await client.get(f"/api/join/{CODE_A}/units")
    labels = [u["label"] for u in everything.json()]
    assert "1004" not in labels and "1005" not in labels
    assert len(labels) <= 20


async def test_join_units_needs_a_session(client: AsyncClient, codes: None) -> None:
    assert_problem(await client.get(f"/api/join/{CODE_A}/units"), 401, "not_authenticated")


async def test_join_units_of_a_bad_code_is_404(
    db: AsyncSession, codes: None, as_user: UserClientFactory
) -> None:
    client = await as_user(await make_user(db))

    assert_problem(await client.get("/api/join/NOPE-NOPE1/units"), 404, "join_code_invalid")


@pytest.mark.parametrize("search", ["1" * 21, "10\n", "10\x00"])
async def test_join_units_refuses_a_bad_search(
    db: AsyncSession, codes: None, as_user: UserClientFactory, search: str
) -> None:
    client = await as_user(await make_user(db))

    response = await client.get(f"/api/join/{CODE_A}/units", params={"search": search})

    assert response.status_code == 422, response.text


async def test_join_units_is_rate_limited_in_a_bucket_of_its_own(
    db: AsyncSession, codes: None, as_user: UserClientFactory
) -> None:
    client = await as_user(await make_user(db))
    limit = settings.rate_limit_join_units_ip.limit
    for _ in range(limit):
        assert (await client.get(f"/api/join/{CODE_A}/units")).status_code == 200

    assert_problem(await client.get(f"/api/join/{CODE_A}/units"), 429, "rate_limited")
    # The lookup's bucket is untouched (D3).
    assert (await client.get(f"/api/join/{CODE_A}")).status_code == 200


# Criterion 6: a new user signs up and submits


async def test_new_user_signs_up_and_submits_a_request(
    client: AsyncClient, db: AsyncSession, world: World, codes: None
) -> None:
    unit = await make_unit(db, world.a, label="1003", tower="T1")
    jobs_before = (await _counts(db))["jobs"]
    signup = await client.post(
        "/api/auth/signup",
        json={
            "email": "nina@example.test",
            "full_name": "Nina New",
            "password": "a long enough pass",
        },
    )
    assert signup.status_code == 201, signup.text
    user_id = signup.json()["id"]

    response = await client.post(
        _requests_url(), json={"unit_id": str(unit.id), "relationship": "tenant"}
    )

    assert response.status_code == 201, response.text
    body = response.json()
    assert {k: v for k, v in body.items() if k not in {"id", "submitted_at"}} == {
        "building_id": str(world.a.id),
        "status": "pending",
        "unit_id": str(unit.id),
        "unit_label": "1003",
        "tower": "T1",
        "relationship": "tenant",
    }
    membership = await _membership(db, world.a, user_id)
    assert membership.status == MembershipStatus.PENDING
    assert await _roles(db, membership.id) == [Role.RESIDENT]
    [request] = await _requests(db, membership.id)
    assert (str(request.id), request.status, request.unit_id, request.relationship) == (
        body["id"],
        OnboardingStatus.PENDING,
        unit.id,
        OccupancyRelationship.TENANT,
    )
    assert request.decided_at is None and request.decision_reason is None
    notified = list(
        await db.execute(
            select(
                Notification.recipient_user_id,
                Notification.building_id,
                Notification.kind,
                Notification.entity_type,
                Notification.entity_id,
                Notification.link,
            )
        )
    )
    assert notified == [
        (
            world.a_manager.user.id,
            world.a.id,
            "onboarding.submitted",
            "onboarding_request",
            request.id,
            None,
        )
    ]
    assert (await _counts(db))["jobs"] == jobs_before
    audit = (
        await db.execute(select(AuditEvent).where(AuditEvent.action == "onboarding.submitted"))
    ).scalar_one()
    assert (audit.building_id, audit.actor_user_id, audit.entity_type, audit.entity_id) == (
        world.a.id,
        membership.user_id,
        "onboarding_request",
        request.id,
    )
    assert audit.metadata_ == {"membership_id": str(membership.id), "unit_id": str(unit.id)}


async def test_every_active_manager_is_notified_and_nobody_else(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    second = await make_user(db)
    await make_membership(second, world.a, roles=(Role.PROPERTY_MANAGEMENT, Role.RESIDENT))
    suspended = await make_user(db)
    await make_membership(
        suspended, world.a, roles=(Role.PROPERTY_MANAGEMENT,), status=MembershipStatus.SUSPENDED
    )
    client = await as_user(await make_user(db))

    response = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "owner"}
    )

    assert response.status_code == 201, response.text
    recipients = set(await db.scalars(select(Notification.recipient_user_id)))
    assert recipients == {world.a_manager.user.id, second.id}


# Criterion 7: idempotent


async def test_a_second_submission_returns_the_pending_request(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    client = await as_user(await make_user(db))
    first = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "tenant"}
    )
    assert first.status_code == 201
    before = await _counts(db)

    again = await client.post(
        _requests_url(), json={"unit_id": str(world.a_102.id), "relationship": "owner"}
    )

    assert again.status_code == 200, again.text
    assert again.json() == first.json()
    assert await _counts(db) == before


# Review round 1 (Codex F1): the unit was checked before the pending request was found, so a retry
# after the unit's deactivation was 404, not the request (criterion 7).
@pytest.mark.parametrize("retry_unit", ["same", "inactive-other", "other-building", "unknown"])
async def test_a_retry_returns_the_pending_request_whatever_its_unit(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory, retry_unit: str
) -> None:
    client = await as_user(await make_user(db))
    first = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "tenant"}
    )
    assert first.status_code == 201
    await db.execute(update(Unit).where(Unit.id == world.a_101.id).values(is_active=False))
    await db.flush()
    unit_id = {
        "same": world.a_101.id,
        "inactive-other": (await make_unit(db, world.a, is_active=False)).id,
        "other-building": world.b_101.id,
        "unknown": "0190b4a4-0000-7000-8000-000000000000",
    }[retry_unit]
    before = await _counts(db)

    again = await client.post(
        _requests_url(), json={"unit_id": str(unit_id), "relationship": "owner"}
    )

    assert again.status_code == 200, again.text
    assert again.json() == first.json()
    assert await _counts(db) == before


async def test_a_pending_membership_without_a_request_gets_only_the_resident_role(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    # Review round 1 (Claude L4): nothing creates such a membership today, but approval (P4-05b)
    # activates whatever roles a pending membership holds.
    user = await make_user(db)
    membership = await make_membership(
        user, world.a, roles=(Role.SECURITY,), status=MembershipStatus.PENDING
    )
    client = await as_user(user)

    response = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "tenant"}
    )

    assert response.status_code == 201, response.text
    assert await _roles(db, membership.id) == [Role.RESIDENT]


# Criterion 8: membership states


@pytest.mark.parametrize("roles", [(Role.RESIDENT,), (Role.SECURITY,)])
async def test_active_member_gets_409_already_member(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory, roles: tuple[Role, ...]
) -> None:
    user = await make_user(db)
    await make_membership(user, world.a, roles=roles)
    client = await as_user(user)
    before = await _counts(db)

    response = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "tenant"}
    )

    assert_problem(response, 409, "already_member")
    assert await _counts(db) == before


@pytest.mark.parametrize("status", [MembershipStatus.SUSPENDED, MembershipStatus.DEACTIVATED])
async def test_suspended_or_deactivated_member_gets_409_membership_not_eligible(
    db: AsyncSession,
    world: World,
    codes: None,
    as_user: UserClientFactory,
    status: MembershipStatus,
) -> None:
    user = await make_user(db)
    membership = await make_membership(user, world.a, status=status)
    client = await as_user(user)
    before = await _counts(db)

    response = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "tenant"}
    )

    assert_problem(response, 409, "membership_not_eligible")
    assert await _counts(db) == before
    assert (await _membership(db, world.a, user.id)).status == status
    assert await _requests(db, membership.id) == []


async def test_denied_membership_is_reopened_with_only_the_resident_role(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    user = await make_user(db)
    membership = await make_membership(
        user, world.a, roles=(Role.RESIDENT, Role.SECURITY), status=MembershipStatus.DENIED
    )
    old = OnboardingRequest(
        building_id=world.a.id,
        membership_id=membership.id,
        unit_id=world.a_101.id,
        relationship=OccupancyRelationship.TENANT,
        status=OnboardingStatus.DENIED,
        decided_by_user_id=world.a_manager.user.id,
        decided_at=func.now(),
        decision_reason="No such tenant on the lease.",
    )
    db.add(old)
    await db.flush()
    client = await as_user(user)

    response = await client.post(
        _requests_url(), json={"unit_id": str(world.a_102.id), "relationship": "owner"}
    )

    assert response.status_code == 201, response.text
    reopened = await _membership(db, world.a, user.id)
    assert reopened.id == membership.id
    assert reopened.status == MembershipStatus.PENDING
    assert reopened.status_changed_by_user_id == user.id
    assert await _roles(db, membership.id) == [Role.RESIDENT]
    first, second = await _requests(db, membership.id)
    assert (first.id, first.status) == (old.id, OnboardingStatus.DENIED)
    assert (second.status, second.unit_id) == (OnboardingStatus.PENDING, world.a_102.id)


async def test_a_member_of_another_building_joins_this_one(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    client = await as_user(world.b_resident1.user)

    response = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "household"}
    )

    assert response.status_code == 201, response.text
    assert (await _membership(db, world.a, world.b_resident1.user.id)).status == (
        MembershipStatus.PENDING
    )
    assert (await _membership(db, world.b, world.b_resident1.user.id)).status == (
        MembershipStatus.ACTIVE
    )


# Criterion 9: related IDs and refused requests write nothing


async def test_unit_from_another_building_is_404_and_writes_nothing(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    user = await make_user(db)
    client = await as_user(user)
    inactive = await make_unit(db, world.a, is_active=False)
    unknown = "0190b4a4-0000-7000-8000-000000000000"
    before = await _counts(db)

    for unit_id in (world.b_101.id, inactive.id, unknown):
        response = await client.post(
            _requests_url(), json={"unit_id": str(unit_id), "relationship": "tenant"}
        )
        assert_problem(response, 404, "unit_not_found")

    assert await _counts(db) == before


async def test_submit_to_a_bad_code_is_404(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    client = await as_user(await make_user(db))
    await db.execute(update(Building).where(Building.id == world.b.id).values(is_active=False))
    await db.flush()
    before = await _counts(db)

    for code in ("NOPE-NOPE1", CODE_B, "x" * 17):
        response = await client.post(
            _requests_url(code), json={"unit_id": str(world.b_101.id), "relationship": "tenant"}
        )
        assert_problem(response, 404, "join_code_invalid")

    assert await _counts(db) == before


async def test_submit_needs_a_session(client: AsyncClient, world: World, codes: None) -> None:
    response = await client.post(
        _requests_url(), json={"unit_id": str(world.a_101.id), "relationship": "tenant"}
    )

    assert_problem(response, 401, "not_authenticated")


UNIT = "<a_101>"


@pytest.mark.parametrize(
    "body",
    [
        {"relationship": "tenant"},
        {"unit_id": UNIT},
        {"unit_id": "not-a-uuid", "relationship": "tenant"},
        {"unit_id": UNIT, "relationship": "landlord"},
        {"unit_id": UNIT, "relationship": "tenant", "status": "active"},
        {"unit_id": UNIT, "relationship": "tenant", "roles": ["property_management"]},
    ],
)
async def test_submit_refuses_a_bad_body(
    db: AsyncSession,
    world: World,
    codes: None,
    as_user: UserClientFactory,
    body: dict[str, Any],
) -> None:
    client = await as_user(await make_user(db))
    body = {k: str(world.a_101.id) if v == UNIT else v for k, v in body.items()}
    before = await _counts(db)

    response = await client.post(_requests_url(), json=body)

    assert response.status_code == 422, response.text
    assert await _counts(db) == before


async def test_submit_without_csrf_headers_is_refused(
    db: AsyncSession, world: World, codes: None, as_user: UserClientFactory
) -> None:
    client = await as_user(await make_user(db))
    before = await _counts(db)

    response = await client.post(
        _requests_url(),
        json={"unit_id": str(world.a_101.id), "relationship": "tenant"},
        headers={"Origin": "https://evil.example"},
    )

    assert response.status_code == 403
    assert await _counts(db) == before


# P4-05b criterion 15: the per-user limit on join requests


async def test_the_11th_join_request_from_one_user_in_an_hour_is_429(
    db: AsyncSession,
    world: World,
    codes: None,
    as_user: UserClientFactory,
    committing: RateLimiter,
) -> None:
    # A limiter that commits on connections of its own, as in production: the harness's limiter
    # counts in a savepoint inside the request's, so a request that doesn't commit (a retry's 200)
    # would take its count back with it.
    app.dependency_overrides[get_rate_limiter] = lambda: committing
    limit = settings.rate_limit_join_request_user.limit
    client = await as_user(await make_user(db))
    body = {"unit_id": str(world.a_101.id), "relationship": "tenant"}

    statuses = [(await client.post(_requests_url(), json=body)).status_code for _ in range(limit)]
    limited = await client.post(_requests_url(), json=body)

    # The first creates the request; the retries return it.
    assert statuses == [201] + [200] * (limit - 1)
    assert_problem(limited, 429, "rate_limited")
    assert int(limited.headers["Retry-After"]) >= 1
    other = await as_user(await make_user(db))
    assert (await other.post(_requests_url(), json=body)).status_code == 201


def test_join_request_rate_policy_is_10_per_hour() -> None:
    default = Settings.model_fields["rate_limit_join_request_user"].default
    assert (default.limit, default.window_seconds) == (10, 3600)
