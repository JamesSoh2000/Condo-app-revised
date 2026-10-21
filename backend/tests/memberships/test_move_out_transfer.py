"""Move-out and transfer over HTTP (P4-06b criteria 1-7, 11, 13): `deactivate` and `transfer`, and
the open invitations of a member who stops being a manager. The races are in
`test_members_concurrency.py`."""

from datetime import datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import DateTime, Uuid, func, literal, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.models import Building
from app.core import clock
from app.core.config import settings
from app.core.security import generate_token, hash_token
from app.invitations.models import Invitation
from app.memberships import service
from app.memberships.enums import MembershipStatus, OccupancyRelationship, Role
from app.memberships.models import BuildingMembership, MembershipRole, UnitOccupancy
from app.memberships.occupancy import occupancy_window_clause
from app.onboarding.models import OnboardingRequest
from app.units.models import Unit
from tests.conftest import FrozenClock, UserClientFactory
from tests.factories import make_membership, make_occupancy, make_unit, make_user
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)
from tests.world import Member, World

pytestmark = pytest.mark.anyio

REASON = {"reason": "Moved out"}
TENANT = OccupancyRelationship.TENANT


def _member(building: Building, membership_id: UUID, action: str) -> str:
    return f"/api/buildings/{building.id}/members/{membership_id}/{action}"


def _to(unit: Unit, relationship: str = "tenant") -> dict[str, str]:
    return {"unit_id": str(unit.id), "relationship": relationship}


@pytest.fixture
async def manager(as_user: UserClientFactory, world: World) -> AsyncClient:
    return await as_user(world.a_manager.user)


async def _status(db: AsyncSession, membership_id: UUID) -> tuple[MembershipStatus, str | None]:
    row = (
        await db.execute(
            select(BuildingMembership.status, BuildingMembership.status_reason)
            .where(BuildingMembership.id == membership_id)
            .execution_options(populate_existing=True)
        )
    ).one()
    return row.status, row.status_reason


async def _occupancies(db: AsyncSession, membership_id: UUID) -> list[tuple[Any, ...]]:
    """(unit_id, relationship, started_at, ended_at), oldest first."""
    rows = await db.execute(
        select(
            UnitOccupancy.unit_id,
            UnitOccupancy.relationship,
            UnitOccupancy.started_at,
            UnitOccupancy.ended_at,
        )
        .where(UnitOccupancy.membership_id == membership_id)
        .order_by(UnitOccupancy.started_at, UnitOccupancy.ended_at.nulls_last())
        .execution_options(populate_existing=True)
    )
    return [tuple(row) for row in rows]


async def _roles(db: AsyncSession, membership_id: UUID) -> list[str]:
    rows = await db.scalars(
        select(MembershipRole.role).where(MembershipRole.membership_id == membership_id)
    )
    return sorted(rows)


async def _events(db: AsyncSession, action: str) -> list[AuditEvent]:
    return list(
        await db.scalars(
            select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)
        )
    )


async def _audit_count(db: AsyncSession) -> int:
    return await db.scalar(select(func.count()).select_from(AuditEvent)) or 0


async def _in_window(db: AsyncSession, membership_id: UUID, unit: Unit, at: datetime) -> bool:
    """Would a record for `unit` stamped `at` be visible to the membership (ADR-0010)?"""
    visible = await db.scalar(
        select(
            occupancy_window_clause(
                membership_id,
                literal(unit.id, Uuid(as_uuid=True)),
                literal(at, DateTime(timezone=True)),
            )
        )
    )
    return bool(visible)


async def _second_manager(db: AsyncSession, world: World) -> Member:
    user = await make_user(db, email="second_manager@example.com", full_name="second manager")
    membership = await make_membership(user, world.a, roles=(Role.PROPERTY_MANAGEMENT,))
    return Member(user, membership)


async def _snapshot(db: AsyncSession, membership_id: UUID) -> tuple[Any, ...]:
    return (
        await _status(db, membership_id),
        await _roles(db, membership_id),
        await _occupancies(db, membership_id),
        await _audit_count(db),
    )


# Criteria 1, 2 and 3: deactivate.


async def test_deactivate_moves_the_resident_out(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_resident1.membership.id
    assert await _in_window(db, target, world.a_101, World.T2 + timedelta(days=1))

    r = await manager.post(_member(world.a, target, "deactivate"), json={"reason": " Moved out "})

    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["status"], body["status_reason"]) == ("deactivated", "Moved out")
    assert (body["unit_id"], body["unit_label"], body["relationship"]) == (None, None, None)
    assert body["roles"] == ["resident"]
    assert await _status(db, target) == (MembershipStatus.DEACTIVATED, "Moved out")
    assert await _roles(db, target) == ["resident"]
    [(unit_id, _, started_at, ended_at)] = await _occupancies(db, target)
    assert (unit_id, started_at) == (world.a_101.id, World.T2)
    # The transaction's now(): the test's outer transaction began before the request.
    assert ended_at == await db.scalar(select(func.now()))
    # Criterion 2: a record for 101 stamped inside the old window is still theirs, one stamped
    # from the move-out on is not.
    assert await _in_window(db, target, world.a_101, World.T2 + timedelta(days=1))
    assert not await _in_window(db, target, world.a_101, ended_at)
    assert not await _in_window(db, target, world.a_101, ended_at + timedelta(days=1))
    [event] = await _events(db, "membership.deactivated")
    assert (event.entity_type, event.entity_id, event.actor_user_id, event.building_id) == (
        "membership",
        target,
        world.a_manager.user.id,
        world.a.id,
    )
    assert event.metadata_ == {"unit_id": str(world.a_101.id)}
    assert "Moved" not in str(event.metadata_)


async def test_deactivated_member_loses_access_here_only(
    manager: AsyncClient, as_user: UserClientFactory, world: World
) -> None:
    multi = await as_user(world.multi)
    assert (await multi.get(f"/api/buildings/{world.a.id}")).status_code == 200

    r = await manager.post(_member(world.a, world.multi_in_a.id, "deactivate"), json=REASON)

    assert r.status_code == 200, r.text
    # The same session, no new login.
    await assert_cross_building_404(multi, "GET", f"/api/buildings/{world.a.id}")
    assert (await multi.get(f"/api/buildings/{world.b.id}")).status_code == 200


async def test_deactivate_suspended_member(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_suspended.membership.id
    r = await manager.post(_member(world.a, target, "deactivate"), json=REASON)
    assert r.status_code == 200, r.text
    assert await _status(db, target) == (MembershipStatus.DEACTIVATED, "Moved out")
    [(_, _, _, ended_at)] = await _occupancies(db, target)
    assert ended_at is not None


async def test_deactivate_staff_without_unit(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_security.membership.id
    r = await manager.post(_member(world.a, target, "deactivate"), json=REASON)
    assert r.status_code == 200, r.text
    assert r.json()["roles"] == ["security"]
    [event] = await _events(db, "membership.deactivated")
    assert event.metadata_ == {"unit_id": None}


async def test_deactivated_staff_session_is_not_lengthened(
    manager: AsyncClient,
    as_user: UserClientFactory,
    world: World,
    frozen_clock: FrozenClock,
) -> None:
    # Sessions follow (apply_role_change): without the staff role the window would be 7 days, but
    # a live session's deadline is only ever capped, never extended.
    guard = await as_user(world.a_security.user)
    r = await manager.post(
        _member(world.a, world.a_security.membership.id, "deactivate"), json=REASON
    )
    assert r.status_code == 200, r.text
    frozen_clock.advance(hours=settings.session_idle_staff_hours, minutes=1)
    assert_problem(await guard.get("/api/auth/me"), 401, "not_authenticated")


async def test_manager_cannot_deactivate_self(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    await _second_manager(db, world)
    target = world.a_manager.membership.id
    before = await _snapshot(db, target)
    r = await manager.post(_member(world.a, target, "deactivate"), json=REASON)
    assert_problem(r, 409, "cannot_target_self")
    assert await _snapshot(db, target) == before


@pytest.mark.parametrize(
    "status", [MembershipStatus.PENDING, MembershipStatus.DENIED, MembershipStatus.DEACTIVATED]
)
async def test_deactivate_refuses_members_not_active_or_suspended(
    manager: AsyncClient, world: World, db: AsyncSession, status: MembershipStatus
) -> None:
    membership = await make_membership(
        await make_user(db), world.a, status=status, status_reason="Earlier"
    )
    before = await _snapshot(db, membership.id)
    r = await manager.post(_member(world.a, membership.id, "deactivate"), json=REASON)
    body = assert_problem(r, 409, "invalid_transition")
    assert body["detail"] == "Only an active or suspended member can be deactivated."
    assert await _snapshot(db, membership.id) == before


@pytest.mark.parametrize(
    "body",
    [{}, {"reason": "  ab  "}, {"reason": "x" * 501}, {"reason": "Moved\nout"}, {"reason": 5}],
    ids=["missing", "short", "long", "newline", "number"],
)
async def test_deactivate_reason_validation(
    manager: AsyncClient, world: World, db: AsyncSession, body: dict[str, Any]
) -> None:
    target = world.a_resident2.membership.id
    before = await _snapshot(db, target)
    r = await manager.post(_member(world.a, target, "deactivate"), json=body)
    assert r.status_code == 422, r.text
    assert await _snapshot(db, target) == before


# Criteria 4 and 5: transfer.


async def test_transfer_moves_the_resident(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_former.membership.id
    history_before = await _occupancies(db, target)
    inside_old = World.T1 + timedelta(days=1)

    r = await manager.post(_member(world.a, target, "transfer"), json=_to(world.a_201, "owner"))

    assert r.status_code == 200, r.text
    body = r.json()
    assert (body["status"], body["unit_id"], body["unit_label"], body["relationship"]) == (
        "active",
        str(world.a_201.id),
        "201",
        "owner",
    )
    now = await db.scalar(select(func.now()))
    history = await _occupancies(db, target)
    # Earlier rows unchanged; the current one ended at the instant the new one starts.
    assert history[0] == history_before[0]
    assert history[1] == (*history_before[1][:3], now)
    assert history[2] == (world.a_201.id, OccupancyRelationship.OWNER, now, None)
    assert await _in_window(db, target, world.a_102, inside_old)
    assert not await _in_window(db, target, world.a_102, now)
    assert await _in_window(db, target, world.a_201, now)
    assert not await _in_window(db, target, world.a_201, inside_old)
    [event] = await _events(db, "occupancy.transferred")
    assert (event.entity_type, event.entity_id, event.actor_user_id) == (
        "membership",
        target,
        world.a_manager.user.id,
    )
    assert event.metadata_ == {
        "from_unit_id": str(world.a_102.id),
        "to_unit_id": str(world.a_201.id),
    }


async def test_transfer_criterion_5_resident1_to_102(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_resident1.membership.id
    r = await manager.post(_member(world.a, target, "transfer"), json=_to(world.a_102))
    assert r.status_code == 200, r.text
    now = await db.scalar(select(func.now()))
    assert await _occupancies(db, target) == [
        (world.a_101.id, TENANT, World.T2, now),
        (world.a_102.id, TENANT, now, None),
    ]


async def test_transfer_assigns_a_unit_to_a_resident_without_one(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    membership = await make_membership(await make_user(db), world.a)
    r = await manager.post(_member(world.a, membership.id, "transfer"), json=_to(world.a_101))
    assert r.status_code == 200, r.text
    now = await db.scalar(select(func.now()))
    assert await _occupancies(db, membership.id) == [(world.a_101.id, TENANT, now, None)]
    [event] = await _events(db, "occupancy.transferred")
    assert event.metadata_ == {"from_unit_id": None, "to_unit_id": str(world.a_101.id)}


async def test_transfer_same_unit_new_relationship(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_resident1.membership.id
    r = await manager.post(_member(world.a, target, "transfer"), json=_to(world.a_101, "owner"))
    assert r.status_code == 200, r.text
    assert r.json()["relationship"] == "owner"
    now = await db.scalar(select(func.now()))
    assert await _occupancies(db, target) == [
        (world.a_101.id, TENANT, World.T2, now),
        (world.a_101.id, OccupancyRelationship.OWNER, now, None),
    ]
    assert len(await _events(db, "occupancy.transferred")) == 1


async def test_transfer_same_unit_and_relationship_is_a_noop(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_resident1.membership.id
    before = await _snapshot(db, target)
    r = await manager.post(_member(world.a, target, "transfer"), json=_to(world.a_101))
    assert r.status_code == 200, r.text
    assert (r.json()["unit_id"], r.json()["relationship"]) == (str(world.a_101.id), "tenant")
    assert await _snapshot(db, target) == before


@pytest.mark.parametrize(
    ("persona", "code"),
    [
        ("a_pending", "membership_not_active"),
        ("a_suspended", "membership_not_active"),
        ("a_security", "not_a_resident"),
    ],
)
async def test_transfer_refuses_members(
    manager: AsyncClient, world: World, db: AsyncSession, persona: str, code: str
) -> None:
    target = getattr(world, persona).membership.id
    before = await _snapshot(db, target)
    r = await manager.post(_member(world.a, target, "transfer"), json=_to(world.a_102))
    assert_problem(r, 409, code)
    assert await _snapshot(db, target) == before


async def test_transfer_refuses_a_deactivated_member(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    membership = await make_membership(
        await make_user(db), world.a, status=MembershipStatus.DEACTIVATED
    )
    r = await manager.post(_member(world.a, membership.id, "transfer"), json=_to(world.a_102))
    assert_problem(r, 409, "membership_not_active")
    assert await _occupancies(db, membership.id) == []


async def test_transfer_to_an_inactive_unit_is_refused(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    unit = await make_unit(db, world.a, label="301", is_active=False)
    target = world.a_resident1.membership.id
    before = await _snapshot(db, target)
    r = await manager.post(_member(world.a, target, "transfer"), json=_to(unit))
    assert_problem(r, 409, "unit_inactive")
    assert await _snapshot(db, target) == before


async def test_transfer_to_another_buildings_unit_is_not_found(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    # Tenant row 7: the same answer as for no unit at all, and nothing written.
    target = world.a_resident1.membership.id
    before = await _snapshot(db, target)
    url = _member(world.a, target, "transfer")
    other = assert_problem(await manager.post(url, json=_to(world.b_101)), 404, "unit_not_found")
    missing = assert_problem(
        await manager.post(url, json={"unit_id": str(uuid4()), "relationship": "tenant"}),
        404,
        "unit_not_found",
    )
    assert without_request_id(other) == without_request_id(missing)
    assert await _snapshot(db, target) == before


@pytest.mark.parametrize(
    "body",
    [
        {"relationship": "tenant"},
        {"unit_id": "nope", "relationship": "tenant"},
        {"unit_id": str(uuid4()), "relationship": "landlord"},
        {"unit_id": str(uuid4())},
    ],
    ids=["no-unit", "bad-unit", "bad-relationship", "no-relationship"],
)
async def test_transfer_body_validation(
    manager: AsyncClient, world: World, body: dict[str, Any]
) -> None:
    r = await manager.post(_member(world.a, world.a_resident1.membership.id, "transfer"), json=body)
    assert r.status_code == 422, r.text


# Criterion 6 and tenant rows 2, 3, 4, 6.


def _requests(world: World) -> list[tuple[str, Any]]:
    target = world.a_resident2.membership.id
    return [
        (_member(world.a, target, "deactivate"), REASON),
        (_member(world.a, target, "transfer"), _to(world.a_201)),
    ]


@pytest.mark.parametrize("persona", ["a_security", "a_resident1", "a_council"])
async def test_non_managers_get_403(
    as_user: UserClientFactory, world: World, db: AsyncSession, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    before = await _snapshot(db, world.a_resident2.membership.id)
    for url, body in _requests(world):
        await assert_forbidden_role(client, "POST", url, json=body)
    assert await _snapshot(db, world.a_resident2.membership.id) == before


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_other_building_and_inactive_callers_get_404(
    as_user: UserClientFactory, world: World, db: AsyncSession, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    before = await _snapshot(db, world.a_resident2.membership.id)
    for url, body in _requests(world):
        await assert_cross_building_404(client, "POST", url, json=body)
    assert await _snapshot(db, world.a_resident2.membership.id) == before


async def test_unauthenticated_gets_401(client: AsyncClient, world: World) -> None:
    for url, body in _requests(world):
        assert_problem(await client.post(url, json=body), 401, "not_authenticated")


@pytest.mark.parametrize(
    ("action", "body"), [("deactivate", REASON), ("transfer", {"relationship": "tenant"})]
)
async def test_another_buildings_member_is_not_found(
    manager: AsyncClient, world: World, db: AsyncSession, action: str, body: dict[str, Any]
) -> None:
    if action == "transfer":
        body = _to(world.a_201)
    target = world.b_resident1.membership.id
    before = await _snapshot(db, target)
    other = await assert_cross_building_404(
        manager, "POST", _member(world.a, target, action), json=body, code="member_not_found"
    )
    missing = await assert_cross_building_404(
        manager, "POST", _member(world.a, uuid4(), action), json=body, code="member_not_found"
    )
    assert without_request_id(other) == without_request_id(missing)
    assert await _snapshot(db, target) == before


# Criterion 7: no client time.


@pytest.mark.parametrize(
    ("action", "extra"),
    [("deactivate", REASON), ("transfer", {"relationship": "tenant"})],
)
async def test_bodies_refuse_a_client_time(
    manager: AsyncClient, world: World, db: AsyncSession, action: str, extra: dict[str, Any]
) -> None:
    body = extra | {"at": "2025-01-02T00:00:00Z"}
    if action == "transfer":
        body |= {"unit_id": str(world.a_102.id)}
    target = world.a_resident1.membership.id
    before = await _snapshot(db, target)
    r = await manager.post(_member(world.a, target, action), json=body)
    assert r.status_code == 422, r.text
    assert await _snapshot(db, target) == before


async def test_helpers_are_called_without_at(
    manager: AsyncClient, world: World, monkeypatch: pytest.MonkeyPatch
) -> None:
    calls: list[tuple[str, dict[str, Any]]] = []

    def spy(name: str) -> Any:
        real = getattr(service, name)

        async def wrapper(*args: Any, **kwargs: Any) -> Any:
            calls.append((name, kwargs))
            return await real(*args, **kwargs)

        return wrapper

    for name in ("end_occupancy", "transfer_occupancy"):
        monkeypatch.setattr(service, name, spy(name))

    r = await manager.post(
        _member(world.a, world.a_resident1.membership.id, "transfer"), json=_to(world.a_102)
    )
    assert r.status_code == 200, r.text
    r = await manager.post(
        _member(world.a, world.a_resident2.membership.id, "deactivate"), json=REASON
    )
    assert r.status_code == 200, r.text

    assert [name for name, _ in calls] == ["transfer_occupancy", "end_occupancy"]
    assert all("at" not in kwargs for _, kwargs in calls)


# Criterion 11: a member who stops being a manager loses their open invitations.


async def _invitation(
    db: AsyncSession, world: World, creator: Member, email: str, **values: Any
) -> Invitation:
    fields: dict[str, Any] = {
        "building_id": world.a.id,
        "email": email,
        "roles": ["security"],
        "token_hash": hash_token(generate_token()),
        "expires_at": clock.now() + timedelta(days=7),
        "created_by_user_id": creator.user.id,
    }
    invitation = Invitation(**(fields | values))
    db.add(invitation)
    await db.flush()
    return invitation


async def _revoked(db: AsyncSession, invitation_id: UUID) -> bool:
    revoked_at = await db.scalar(
        select(Invitation.revoked_at)
        .where(Invitation.id == invitation_id)
        .execution_options(populate_existing=True)
    )
    return revoked_at is not None


@pytest.mark.parametrize(
    ("action", "body"),
    [
        ("roles", {"add": ["council"], "remove": ["property_management"]}),
        ("suspend", {"reason": "Left the company"}),
        ("deactivate", REASON),
    ],
    ids=["role-removed", "suspended", "deactivated"],
)
async def test_lost_manager_invitations_are_revoked(
    manager: AsyncClient, world: World, db: AsyncSession, action: str, body: dict[str, Any]
) -> None:
    second = await _second_manager(db, world)
    open_one = await _invitation(db, world, second, "open@example.test")
    expired = await _invitation(
        db, world, second, "expired@example.test", expires_at=clock.now() - timedelta(days=1)
    )
    accepted = await _invitation(
        db, world, second, "accepted@example.test", accepted_at=clock.now()
    )
    by_first = await _invitation(db, world, world.a_manager, "kept@example.test")

    r = await manager.post(_member(world.a, second.membership.id, action), json=body)

    assert r.status_code == 200, r.text
    assert await _revoked(db, open_one.id)
    assert await _revoked(db, expired.id)
    assert not await _revoked(db, accepted.id)
    assert not await _revoked(db, by_first.id)
    events = await _events(db, "invitation.revoked")
    assert sorted(e.entity_id for e in events) == sorted([open_one.id, expired.id])
    for event in events:
        assert (event.entity_type, event.actor_user_id, event.building_id) == (
            "invitation",
            world.a_manager.user.id,
            world.a.id,
        )
        assert event.metadata_ == {"membership_id": str(second.membership.id)}


async def test_managers_keep_their_invitations_through_other_changes(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    # The neighbour: a change that leaves them an active manager revokes nothing.
    second = await _second_manager(db, world)
    invitation = await _invitation(db, world, second, "open@example.test")
    r = await manager.post(
        _member(world.a, second.membership.id, "roles"), json={"add": ["resident"], "remove": []}
    )
    assert r.status_code == 200, r.text
    r = await manager.post(
        _member(world.a, second.membership.id, "transfer"), json=_to(world.a_101)
    )
    assert r.status_code == 200, r.text
    assert not await _revoked(db, invitation.id)
    assert await _events(db, "invitation.revoked") == []


async def test_another_buildings_invitations_of_the_same_user_are_kept(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    second = await _second_manager(db, world)
    await make_membership(second.user, world.b, roles=(Role.PROPERTY_MANAGEMENT,))
    in_b = Invitation(
        building_id=world.b.id,
        email="b@example.test",
        roles=["security"],
        token_hash=hash_token(generate_token()),
        expires_at=clock.now() + timedelta(days=7),
        created_by_user_id=second.user.id,
    )
    db.add(in_b)
    await db.flush()
    r = await manager.post(_member(world.a, second.membership.id, "deactivate"), json=REASON)
    assert r.status_code == 200, r.text
    assert not await _revoked(db, in_b.id)


# Criterion 13 (the P4-05b carry): a join request an invitation left pending.


async def test_orphan_join_request_stays_hidden_after_deactivation(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    user = await make_user(db)
    membership = await make_membership(user, world.a)
    await make_occupancy(membership, world.a_102)
    request = OnboardingRequest(
        building_id=world.a.id,
        membership_id=membership.id,
        unit_id=world.a_102.id,
        relationship=TENANT,
    )
    db.add(request)
    await db.flush()
    base = f"/api/buildings/{world.a.id}/onboarding-requests"

    r = await manager.post(_member(world.a, membership.id, "deactivate"), json=REASON)

    assert r.status_code == 200, r.text
    listed = (await manager.get(base, params={"status": "pending"})).json()["items"]
    assert str(request.id) not in {item["id"] for item in listed}
    assert (await manager.get(f"{base}/summary")).json() == {"pending_onboarding_count": 0}
    assert_problem(
        await manager.post(f"{base}/{request.id}/approve"), 409, "membership_not_pending"
    )
    assert await _status(db, membership.id) == (MembershipStatus.DEACTIVATED, "Moved out")
