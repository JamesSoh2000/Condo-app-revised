"""Managers' decisions on join requests (P4-05b criteria 3-5, 7, 9-14, 17): list, count, approve,
deny. The races are in `test_decisions_concurrency.py`."""

from typing import Any
from uuid import uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select, update
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.models import Building
from app.jobs.models import Job
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.notifications.models import Notification
from app.onboarding import service
from app.onboarding.models import OnboardingRequest, OnboardingStatus
from app.units.models import Unit
from app.users.models import User
from tests.conftest import UserClientFactory
from tests.factories import make_membership, make_unit, make_user
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)
from tests.world import Member, World

pytestmark = pytest.mark.anyio

CODE_A = "MAPLE-23456"


def _base(building: Building) -> str:
    return f"/api/buildings/{building.id}/onboarding-requests"


async def _make_request(
    db: AsyncSession,
    building: Building,
    *,
    unit: Unit | None = None,
    relationship: OccupancyRelationship = OccupancyRelationship.TENANT,
    full_name: str = "Nina New",
) -> tuple[User, BuildingMembership, OnboardingRequest]:
    """A user with a pending membership (role resident) and a pending request, as P4-05a leaves
    them."""
    user = await make_user(db, full_name=full_name)
    membership = await make_membership(user, building, status=MembershipStatus.PENDING)
    unit = unit or await make_unit(db, building)
    request = OnboardingRequest(
        building_id=building.id,
        membership_id=membership.id,
        unit_id=unit.id,
        relationship=relationship,
    )
    db.add(request)
    await db.flush()
    await db.refresh(request, ["created_at"])
    return user, membership, request


@pytest.fixture
async def pending(
    db: AsyncSession, world: World
) -> tuple[User, BuildingMembership, OnboardingRequest]:
    return await _make_request(db, world.a, unit=await make_unit(db, world.a, label="1003", tower="T1"))


@pytest.fixture
async def manager(as_user: UserClientFactory, world: World) -> AsyncClient:
    return await as_user(world.a_manager.user)


async def _fresh[T](db: AsyncSession, model: type[T], id_: Any) -> T:
    row = await db.scalar(
        select(model).where(model.id == id_).execution_options(populate_existing=True)  # type: ignore[attr-defined]
    )
    assert row is not None
    return row


async def _roles(db: AsyncSession, membership_id: Any) -> list[Role]:
    return sorted(
        await db.scalars(
            select(MembershipRole.role).where(MembershipRole.membership_id == membership_id)
        )
    )


async def _counts(db: AsyncSession) -> dict[str, int]:
    tables = {
        "occupancies": UnitOccupancy,
        "notifications": Notification,
        "jobs": Job,
        "audit": AuditEvent,
        "requests": OnboardingRequest,
    }
    return {
        name: await db.scalar(select(func.count()).select_from(model)) or 0
        for name, model in tables.items()
    }


async def _state(
    db: AsyncSession, membership: BuildingMembership, request: OnboardingRequest
) -> tuple[MembershipStatus, OnboardingStatus, list[Role]]:
    m = await _fresh(db, BuildingMembership, membership.id)
    r = await _fresh(db, OnboardingRequest, request.id)
    return m.status, r.status, await _roles(db, membership.id)


# Criterion 3: approve


async def test_manager_approves_a_request(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    as_user: UserClientFactory,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
) -> None:
    user, membership, request = pending
    before = await _counts(db)

    response = await manager.post(f"{_base(world.a)}/{request.id}/approve")

    assert response.status_code == 200, response.text
    body = response.json()
    assert body["decided_at"] is not None
    assert {k: v for k, v in body.items() if k not in {"submitted_at", "decided_at"}} == {
        "id": str(request.id),
        "full_name": "Nina New",
        "email": user.email,
        "unit_id": str(request.unit_id),
        "unit_label": "1003",
        "tower": "T1",
        "relationship": "tenant",
        "status": "approved",
        "decision_reason": None,
    }
    decided = await _fresh(db, OnboardingRequest, request.id)
    assert (decided.status, decided.decided_by_user_id) == (
        OnboardingStatus.APPROVED,
        world.a_manager.user.id,
    )
    activated = await _fresh(db, BuildingMembership, membership.id)
    assert (activated.status, activated.status_changed_by_user_id) == (
        MembershipStatus.ACTIVE,
        world.a_manager.user.id,
    )
    assert await _roles(db, membership.id) == [Role.RESIDENT]
    occupancies = list(
        await db.execute(
            select(UnitOccupancy.unit_id, UnitOccupancy.relationship, UnitOccupancy.ended_at).where(
                UnitOccupancy.membership_id == membership.id
            )
        )
    )
    assert occupancies == [(request.unit_id, OccupancyRelationship.TENANT, None)]
    notified = list(
        await db.execute(
            select(
                Notification.recipient_user_id,
                Notification.kind,
                Notification.entity_type,
                Notification.entity_id,
            ).where(Notification.kind.like("membership.%"))
        )
    )
    assert notified == [(user.id, "membership.approved", "onboarding_request", request.id)]
    [job] = list(await db.scalars(select(Job).where(Job.kind == "email.send")))
    assert (job.payload["to"], job.payload["template"]) == (user.email, "notification")
    assert job.payload["context"]["title"] == "Your join request was approved"
    after = await _counts(db)
    assert {k: after[k] - before[k] for k in after} == {
        "occupancies": 1,
        "notifications": 1,
        "jobs": 1,
        "audit": 2,
        "requests": 0,
    }
    audit = {
        event.action: event
        for event in await db.scalars(
            select(AuditEvent).where(
                AuditEvent.action.in_(["onboarding.approved", "membership.activated"])
            )
        )
    }
    approved, activated_event = audit["onboarding.approved"], audit["membership.activated"]
    assert (approved.entity_type, approved.entity_id, approved.actor_user_id) == (
        "onboarding_request",
        request.id,
        world.a_manager.user.id,
    )
    assert approved.metadata_ == {
        "membership_id": str(membership.id),
        "unit_id": str(request.unit_id),
    }
    assert (activated_event.entity_type, activated_event.entity_id) == (
        "membership",
        membership.id,
    )
    assert activated_event.metadata_ == {"onboarding_request_id": str(request.id)}

    resident = await as_user(user)
    me = (await resident.get("/api/auth/me")).json()
    [mine] = [m for m in me["memberships"] if m["building"]["id"] == str(world.a.id)]
    assert (mine["status"], mine["roles"]) == ("active", ["resident"])
    assert mine["occupancy"]["relationship"] == "tenant"
    assert (await resident.get(f"/api/buildings/{world.a.id}")).status_code == 200


async def test_approval_keeps_the_requested_relationship(
    db: AsyncSession, world: World, manager: AsyncClient
) -> None:
    _, membership, request = await _make_request(
        db, world.a, relationship=OccupancyRelationship.OWNER
    )

    assert (await manager.post(f"{_base(world.a)}/{request.id}/approve")).status_code == 200

    relationship = await db.scalar(
        select(UnitOccupancy.relationship).where(UnitOccupancy.membership_id == membership.id)
    )
    assert relationship == OccupancyRelationship.OWNER


async def test_an_inactive_resident_gets_no_email(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
) -> None:
    user, _, request = pending
    await db.execute(update(User).where(User.id == user.id).values(is_active=False))
    await db.flush()

    assert (await manager.post(f"{_base(world.a)}/{request.id}/approve")).status_code == 200

    assert await db.scalar(select(func.count()).select_from(Job)) == 0
    assert await db.scalar(
        select(func.count()).where(Notification.recipient_user_id == user.id)
    ) == 1


# Criterion 4: a decided request


@pytest.mark.parametrize("first", ["approve", "deny"])
@pytest.mark.parametrize("second", ["approve", "deny"])
async def test_a_decided_request_is_409_already_decided(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
    first: str,
    second: str,
) -> None:
    _, membership, request = pending
    reason = {"reason": "Not on the lease."}
    url = f"{_base(world.a)}/{request.id}"
    assert (await manager.post(f"{url}/{first}", json=reason if first == "deny" else None)).status_code == 200
    state, counts = await _state(db, membership, request), await _counts(db)

    again = await manager.post(f"{url}/{second}", json=reason if second == "deny" else None)

    assert_problem(again, 409, "already_decided")
    assert await _state(db, membership, request) == state
    assert await _counts(db) == counts


# Criterion 5: deny


@pytest.mark.parametrize(
    "body",
    [
        {},
        {"reason": None},
        {"reason": "no"},
        {"reason": "  no  "},
        {"reason": "x" * 501},
        {"reason": "Not on the lease\n"},
        {"reason": "\tNot on the lease"},
        {"reason": "Not on\x00 the lease"},
        {"reason": "Not on the lease", "status": "approved"},
    ],
    ids=["missing", "null", "short", "short-after-trim", "long", "trailing-lf", "leading-tab", "nul", "extra"],
)
async def test_deny_refuses_a_bad_reason(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
    body: dict[str, Any],
) -> None:
    _, membership, request = pending
    counts = await _counts(db)

    response = await manager.post(f"{_base(world.a)}/{request.id}/deny", json=body)

    assert response.status_code == 422, response.text
    assert await _state(db, membership, request) == (
        MembershipStatus.PENDING,
        OnboardingStatus.PENDING,
        [Role.RESIDENT],
    )
    assert await _counts(db) == counts


async def test_deny_accepts_500_characters(
    world: World, manager: AsyncClient, pending: tuple[User, BuildingMembership, OnboardingRequest]
) -> None:
    _, _, request = pending
    response = await manager.post(
        f"{_base(world.a)}/{request.id}/deny", json={"reason": " " + "x" * 500 + " "}
    )
    assert response.status_code == 200, response.text
    assert response.json()["decision_reason"] == "x" * 500


async def test_manager_denies_a_request_and_the_resident_resubmits(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    as_user: UserClientFactory,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
) -> None:
    user, membership, request = pending
    await db.execute(update(Building).where(Building.id == world.a.id).values(join_code=CODE_A))
    await db.flush()
    before = await _counts(db)

    response = await manager.post(
        f"{_base(world.a)}/{request.id}/deny", json={"reason": "  Not on the lease.  "}
    )

    assert response.status_code == 200, response.text
    body = response.json()
    assert (body["status"], body["decision_reason"]) == ("denied", "Not on the lease.")
    denied = await _fresh(db, OnboardingRequest, request.id)
    assert (denied.status, denied.decided_by_user_id, denied.decision_reason) == (
        OnboardingStatus.DENIED,
        world.a_manager.user.id,
        "Not on the lease.",
    )
    assert denied.decided_at is not None
    m = await _fresh(db, BuildingMembership, membership.id)
    assert (m.status, m.status_changed_by_user_id) == (
        MembershipStatus.DENIED,
        world.a_manager.user.id,
    )
    after = await _counts(db)
    assert {k: after[k] - before[k] for k in after} == {
        "occupancies": 0,
        "notifications": 1,
        "jobs": 1,
        "audit": 1,
        "requests": 0,
    }
    notification = await db.scalar(
        select(Notification).where(Notification.kind == "membership.denied")
    )
    assert notification is not None
    assert (notification.recipient_user_id, notification.entity_id) == (user.id, request.id)
    assert "Not on the lease." in notification.body
    [job] = list(await db.scalars(select(Job).where(Job.kind == "email.send")))
    assert (job.payload["to"], job.payload["template"]) == (user.email, "notification")
    assert job.payload["context"]["body"] == notification.body
    audit = await db.scalar(select(AuditEvent).where(AuditEvent.action == "onboarding.denied"))
    assert audit is not None
    assert (audit.entity_type, audit.entity_id, audit.actor_user_id) == (
        "onboarding_request",
        request.id,
        world.a_manager.user.id,
    )
    # IDs only: never the reason (CLAUDE.md rule 10).
    assert audit.metadata_ == {"membership_id": str(membership.id), "unit_id": str(request.unit_id)}

    resident = await as_user(user)
    me = await resident.get(f"/api/buildings/{world.a.id}/onboarding/me")
    assert me.status_code == 200
    assert (me.json()["status"], me.json()["decision_reason"]) == ("denied", "Not on the lease.")

    resubmitted = await resident.post(
        f"/api/join/{CODE_A}/requests",
        json={"unit_id": str(request.unit_id), "relationship": "owner"},
    )
    assert resubmitted.status_code == 201, resubmitted.text
    assert resubmitted.json()["id"] != str(request.id)
    assert (await _fresh(db, BuildingMembership, membership.id)).status == MembershipStatus.PENDING
    listed = (await manager.get(_base(world.a))).json()["items"]
    assert [item["id"] for item in listed] == [resubmitted.json()["id"]]


# Criterion 7: roles and tenancy


@pytest.mark.parametrize("persona", ["a_security", "a_resident1", "a_council"])
async def test_wrong_role_is_403_on_every_route(
    db: AsyncSession,
    world: World,
    as_user: UserClientFactory,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
    persona: str,
) -> None:
    _, membership, request = pending
    member: Member = getattr(world, persona)
    client = await as_user(member.user)
    base = _base(world.a)

    await assert_forbidden_role(client, "GET", base)
    await assert_forbidden_role(client, "GET", f"{base}/summary")
    await assert_forbidden_role(client, "POST", f"{base}/{request.id}/approve")
    await assert_forbidden_role(
        client, "POST", f"{base}/{request.id}/deny", json={"reason": "Not on the lease."}
    )
    assert await _state(db, membership, request) == (
        MembershipStatus.PENDING,
        OnboardingStatus.PENDING,
        [Role.RESIDENT],
    )


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_other_building_pending_and_suspended_members_get_404(
    db: AsyncSession,
    world: World,
    as_user: UserClientFactory,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
    persona: str,
) -> None:
    _, membership, request = pending
    member: Member = getattr(world, persona)
    client = await as_user(member.user)
    base = _base(world.a)

    await assert_cross_building_404(client, "GET", base)
    await assert_cross_building_404(client, "GET", f"{base}/summary")
    await assert_cross_building_404(client, "POST", f"{base}/{request.id}/approve")
    await assert_cross_building_404(
        client, "POST", f"{base}/{request.id}/deny", json={"reason": "Not on the lease."}
    )
    assert (await _state(db, membership, request))[1] == OnboardingStatus.PENDING


async def test_every_route_needs_a_session(
    client: AsyncClient,
    world: World,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
) -> None:
    _, _, request = pending
    base = _base(world.a)
    for method, url, body in (
        ("GET", base, None),
        ("GET", f"{base}/summary", None),
        ("POST", f"{base}/{request.id}/approve", None),
        ("POST", f"{base}/{request.id}/deny", {"reason": "Not on the lease."}),
    ):
        assert_problem(await client.request(method, url, json=body), 401, "not_authenticated")


# Criterion 9: a failed approval


async def test_a_failed_approval_leaves_nothing(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    _, membership, request = pending
    counts = await _counts(db)
    real_audit = service.record_audit

    async def fail_on_activation(db: AsyncSession, **kwargs: Any) -> None:
        # The last write of the approval, after the membership, occupancy and notification.
        if kwargs["action"] == "membership.activated":
            raise RuntimeError("simulated failure")
        await real_audit(db, **kwargs)

    monkeypatch.setattr(service, "record_audit", fail_on_activation)

    with pytest.raises(RuntimeError, match="simulated failure"):
        await manager.post(f"{_base(world.a)}/{request.id}/approve")

    assert await _state(db, membership, request) == (
        MembershipStatus.PENDING,
        OnboardingStatus.PENDING,
        [Role.RESIDENT],
    )
    assert await _counts(db) == counts


# Criteria 10 and 11: the list and the count


async def test_list_shows_the_buildings_pending_requests_newest_first(
    db: AsyncSession, world: World, manager: AsyncClient
) -> None:
    first = await _make_request(db, world.a, full_name="Ann First")
    second = await _make_request(
        db,
        world.a,
        unit=await make_unit(db, world.a, label="1004"),
        relationship=OccupancyRelationship.HOUSEHOLD,
        full_name="Bob Second",
    )
    await _make_request(db, world.b, full_name="Carl Other")

    response = await manager.get(_base(world.a))

    assert response.status_code == 200, response.text
    items = response.json()["items"]
    assert [item["id"] for item in items] == [str(second[2].id), str(first[2].id)]
    assert items[0] == {
        "id": str(second[2].id),
        "full_name": "Bob Second",
        "email": second[0].email,
        "unit_id": str(second[2].unit_id),
        "unit_label": "1004",
        "tower": None,
        "relationship": "household",
        "status": "pending",
        "submitted_at": second[2].created_at.isoformat().replace("+00:00", "Z"),
        "decided_at": None,
        "decision_reason": None,
    }
    summary = await manager.get(f"{_base(world.a)}/summary")
    assert summary.status_code == 200
    assert summary.json() == {"pending_onboarding_count": 2}


async def test_list_filters_by_status_and_paginates(
    db: AsyncSession, world: World, manager: AsyncClient
) -> None:
    requests = [(await _make_request(db, world.a))[2] for _ in range(3)]
    base = _base(world.a)
    await manager.post(f"{base}/{requests[0].id}/approve")
    await manager.post(f"{base}/{requests[1].id}/deny", json={"reason": "Not on the lease."})

    by_status = {
        status: [item["id"] for item in (await manager.get(base, params={"status": status})).json()["items"]]
        for status in ("pending", "approved", "denied")
    }

    assert by_status == {
        "pending": [str(requests[2].id)],
        "approved": [str(requests[0].id)],
        "denied": [str(requests[1].id)],
    }
    assert (await manager.get(base, params={"status": "nope"})).status_code == 422
    more = [(await _make_request(db, world.a))[2] for _ in range(2)]
    page1 = (await manager.get(base, params={"limit": 2})).json()
    page2 = (await manager.get(base, params={"limit": 2, "cursor": page1["next_cursor"]})).json()
    assert [i["id"] for i in page1["items"] + page2["items"]] == [
        str(r.id) for r in (more[1], more[0], requests[2])
    ]
    assert page2["next_cursor"] is None
    assert (await manager.get(f"{base}/summary")).json() == {"pending_onboarding_count": 3}


# Criterion 12: the id's building


async def test_another_buildings_request_is_404_like_a_random_id(
    db: AsyncSession, world: World, manager: AsyncClient
) -> None:
    _, membership, request = await _make_request(db, world.b)
    base = _base(world.a)

    bodies = []
    for request_id in (request.id, uuid4()):
        for action, body in (("approve", None), ("deny", {"reason": "Not on the lease."})):
            response = await manager.post(f"{base}/{request_id}/{action}", json=body)
            bodies.append(without_request_id(assert_problem(response, 404, "onboarding_request_not_found")))

    assert all(body == bodies[0] for body in bodies)
    assert await _state(db, membership, request) == (
        MembershipStatus.PENDING,
        OnboardingStatus.PENDING,
        [Role.RESIDENT],
    )
    assert (await manager.post(f"{base}/not-a-uuid/approve")).status_code == 422


# Criterion 13: the membership changed meanwhile


@pytest.mark.parametrize("action", ["approve", "deny"])
async def test_a_request_whose_membership_was_activated_meanwhile_is_409(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
    action: str,
) -> None:
    _, membership, request = pending
    # As an invitation accept (P4-02b) leaves it: active with the invited roles.
    await db.execute(
        update(BuildingMembership)
        .where(BuildingMembership.id == membership.id)
        .values(status=MembershipStatus.ACTIVE)
    )
    db.add(MembershipRole(building_id=world.a.id, membership_id=membership.id, role=Role.SECURITY))
    await db.flush()
    counts = await _counts(db)

    response = await manager.post(
        f"{_base(world.a)}/{request.id}/{action}",
        json={"reason": "Not on the lease."} if action == "deny" else None,
    )

    assert_problem(response, 409, "membership_not_pending")
    assert await _state(db, membership, request) == (
        MembershipStatus.ACTIVE,
        OnboardingStatus.PENDING,
        [Role.RESIDENT, Role.SECURITY],
    )
    assert await _counts(db) == counts
    assert (await manager.get(_base(world.a))).json()["items"] == []
    assert (await manager.get(f"{_base(world.a)}/summary")).json() == {
        "pending_onboarding_count": 0
    }


# Criterion 14: the unit deactivated meanwhile


async def test_approving_a_request_for_an_inactive_unit_is_409_and_deny_still_works(
    db: AsyncSession,
    world: World,
    manager: AsyncClient,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
) -> None:
    _, membership, request = pending
    await db.execute(update(Unit).where(Unit.id == request.unit_id).values(is_active=False))
    await db.flush()
    counts = await _counts(db)

    response = await manager.post(f"{_base(world.a)}/{request.id}/approve")

    assert_problem(response, 409, "unit_inactive")
    assert await _state(db, membership, request) == (
        MembershipStatus.PENDING,
        OnboardingStatus.PENDING,
        [Role.RESIDENT],
    )
    assert await _counts(db) == counts
    denied = await manager.post(
        f"{_base(world.a)}/{request.id}/deny", json={"reason": "That unit is closed."}
    )
    assert denied.status_code == 200, denied.text


async def test_a_unit_with_an_approved_resident_cannot_be_deactivated(
    world: World,
    manager: AsyncClient,
    pending: tuple[User, BuildingMembership, OnboardingRequest],
) -> None:
    _, _, request = pending
    assert (await manager.post(f"{_base(world.a)}/{request.id}/approve")).status_code == 200

    response = await manager.post(f"/api/buildings/{world.a.id}/units/{request.unit_id}/deactivate")

    assert_problem(response, 409, "unit_has_occupants")
