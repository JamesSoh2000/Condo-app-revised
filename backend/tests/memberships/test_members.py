"""Membership administration over HTTP (P4-06a criteria 1, 4, 6-14, 16): the member list, role
changes, suspend and reactivate. The races are in `test_members_concurrency.py`."""

from typing import Any
from uuid import UUID, uuid4

import pytest
from httpx import AsyncClient
from sqlalchemy import func, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.audit.models import AuditEvent
from app.buildings.models import Building
from app.core.config import settings
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from tests.conftest import FrozenClock, UserClientFactory
from tests.factories import make_membership, make_user
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)
from tests.world import Member, World

pytestmark = pytest.mark.anyio

REASON = {"reason": "Unpaid fees"}


def _members(building: Building) -> str:
    return f"/api/buildings/{building.id}/members"


def _member(building: Building, membership_id: UUID, action: str) -> str:
    return f"{_members(building)}/{membership_id}/{action}"


@pytest.fixture
async def manager(as_user: UserClientFactory, world: World) -> AsyncClient:
    return await as_user(world.a_manager.user)


async def _roles(db: AsyncSession, membership_id: UUID) -> list[str]:
    rows = await db.scalars(
        select(MembershipRole.role).where(MembershipRole.membership_id == membership_id)
    )
    return sorted(rows)


async def _status(db: AsyncSession, membership_id: UUID) -> tuple[MembershipStatus, str | None]:
    row = (
        await db.execute(
            select(BuildingMembership.status, BuildingMembership.status_reason)
            .where(BuildingMembership.id == membership_id)
            .execution_options(populate_existing=True)
        )
    ).one()
    return row.status, row.status_reason


async def _events(db: AsyncSession, action: str) -> list[AuditEvent]:
    return list(
        await db.scalars(
            select(AuditEvent).where(AuditEvent.action == action).order_by(AuditEvent.id)
        )
    )


async def _second_manager(db: AsyncSession, world: World) -> Member:
    user = await make_user(db, email="second_manager@example.com", full_name="second manager")
    membership = await make_membership(user, world.a, roles=(Role.PROPERTY_MANAGEMENT,))
    return Member(user, membership)


# Criterion 8: the list.


def _member_body(member: Member, **overrides: Any) -> dict[str, Any]:
    return {
        "membership_id": str(member.membership.id),
        "user_id": str(member.user.id),
        "full_name": member.user.full_name,
        "email": member.user.email,
        "status": "active",
        "status_reason": None,
        "roles": ["resident"],
        "unit_id": None,
        "unit_label": None,
        "tower": None,
        "relationship": None,
    } | overrides


async def _all_pages(client: AsyncClient, url: str, **params: Any) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    cursor = None
    while True:
        query = params | ({"cursor": cursor} if cursor else {})
        r = await client.get(url, params=query)
        assert r.status_code == 200, r.text
        items += r.json()["items"]
        cursor = r.json()["next_cursor"]
        if cursor is None:
            return items


async def test_list_returns_the_buildings_members_with_their_unit(
    manager: AsyncClient, world: World
) -> None:
    items = await _all_pages(manager, _members(world.a), limit=2)

    by_id = {item["membership_id"]: item for item in items}
    a_members = [
        world.a_manager,
        world.a_security,
        world.a_resident1,
        world.a_resident2,
        world.a_council,
        world.a_pending,
        world.a_suspended,
        world.a_former,
    ]
    expected_ids = {str(m.membership.id) for m in a_members} | {str(world.multi_in_a.id)}
    assert set(by_id) == expected_ids
    # Newest first: uuid7 ids, descending.
    assert [item["membership_id"] for item in items] == sorted(by_id, reverse=True)
    assert by_id[str(world.a_resident1.membership.id)] == _member_body(
        world.a_resident1,
        unit_id=str(world.a_101.id),
        unit_label="101",
        relationship="tenant",
    )
    assert by_id[str(world.a_manager.membership.id)] == _member_body(
        world.a_manager, roles=["property_management"]
    )
    assert by_id[str(world.a_council.membership.id)]["roles"] == ["council", "resident"]
    # a_former's current unit, not the one they left.
    assert by_id[str(world.a_former.membership.id)]["unit_label"] == "102"
    # multi's A membership, with A's roles only.
    assert by_id[str(world.multi_in_a.id)]["roles"] == ["resident"]


async def test_list_filters_by_role_status_and_search(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    url = _members(world.a)
    staff = await _all_pages(manager, url, role="security")
    assert [item["membership_id"] for item in staff] == [str(world.a_security.membership.id)]

    suspended = await _all_pages(manager, url, status="suspended")
    assert [item["membership_id"] for item in suspended] == [str(world.a_suspended.membership.id)]

    # Name or email, any case, anywhere in it.
    found = await _all_pages(manager, url, search="RESIDENT")
    assert {item["membership_id"] for item in found} == {
        str(world.a_resident1.membership.id),
        str(world.a_resident2.membership.id),
    }
    found = await _all_pages(manager, url, search="anager@EXAMPLE")
    assert [item["membership_id"] for item in found] == [str(world.a_manager.membership.id)]

    # Combined.
    combined = await _all_pages(manager, url, search="a_", role="council", status="active")
    assert [item["membership_id"] for item in combined] == [str(world.a_council.membership.id)]


async def test_list_search_matches_wildcards_literally(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    percent = await make_user(db, full_name="Zed 50% Off")
    plain = await make_user(db, full_name="Zed 500 Off")
    underscore = await make_user(db, full_name="Zed x_y")
    backslash = await make_user(db, full_name="Zed a\\b")
    for user in (percent, plain, underscore, backslash):
        await make_membership(user, world.a)
    url = _members(world.a)

    async def names(search: str) -> list[str]:
        return [item["full_name"] for item in await _all_pages(manager, url, search=search)]

    assert await names("50%") == ["Zed 50% Off"]
    assert await names("x_y") == ["Zed x_y"]
    assert await names("a\\b") == ["Zed a\\b"]


@pytest.mark.parametrize(
    "params",
    [{"role": "owner"}, {"status": "gone"}, {"search": "x" * 101}, {"cursor": "nope"}],
    ids=["role", "status", "search-length", "cursor"],
)
async def test_list_refuses_bad_parameters(
    manager: AsyncClient, world: World, params: dict[str, str]
) -> None:
    r = await manager.get(_members(world.a), params=params)
    assert r.status_code in (400, 422), r.text
    if "cursor" in params:
        assert_problem(r, 400, "invalid_cursor")


async def test_list_never_shows_another_buildings_members(
    as_user: UserClientFactory, world: World
) -> None:
    b_manager = await as_user(world.b_manager.user)
    items = await _all_pages(b_manager, _members(world.b))
    assert {item["membership_id"] for item in items} == {
        str(world.b_manager.membership.id),
        str(world.b_resident1.membership.id),
        str(world.multi_in_b.id),
    }
    multi = next(i for i in items if i["membership_id"] == str(world.multi_in_b.id))
    assert multi["roles"] == ["security"]


# Criterion 6 and tenant rows 2, 3, 4, 6.


def _requests(world: World) -> list[tuple[str, str, Any]]:
    target = world.a_resident2.membership.id
    return [
        ("GET", _members(world.a), None),
        ("POST", _member(world.a, target, "roles"), {"add": ["council"], "remove": []}),
        ("POST", _member(world.a, target, "suspend"), REASON),
        ("POST", _member(world.a, world.a_suspended.membership.id, "reactivate"), None),
    ]


@pytest.mark.parametrize("persona", ["a_security", "a_resident1", "a_council"])
async def test_non_managers_get_403_on_every_route(
    as_user: UserClientFactory, world: World, db: AsyncSession, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    for method, url, body in _requests(world):
        await assert_forbidden_role(client, method, url, json=body)
    assert await _roles(db, world.a_resident2.membership.id) == ["resident"]
    assert (await _status(db, world.a_suspended.membership.id))[0] == MembershipStatus.SUSPENDED


@pytest.mark.parametrize("persona", ["b_manager", "a_pending", "a_suspended"])
async def test_other_building_and_inactive_members_get_404(
    as_user: UserClientFactory, world: World, persona: str
) -> None:
    client = await as_user(getattr(world, persona).user)
    for method, url, body in _requests(world):
        await assert_cross_building_404(client, method, url, json=body)


async def test_unauthenticated_gets_401(client: AsyncClient, world: World) -> None:
    for method, url, body in _requests(world):
        assert_problem(await client.request(method, url, json=body), 401, "not_authenticated")


# Criterion 9: the target's tenancy.


@pytest.mark.parametrize(
    ("action", "body"),
    [("roles", {"add": ["council"], "remove": []}), ("suspend", REASON), ("reactivate", None)],
)
async def test_another_buildings_member_is_not_found(
    manager: AsyncClient, world: World, db: AsyncSession, action: str, body: Any
) -> None:
    other = await assert_cross_building_404(
        manager,
        "POST",
        _member(world.a, world.b_resident1.membership.id, action),
        json=body,
        code="member_not_found",
    )
    missing = await assert_cross_building_404(
        manager, "POST", _member(world.a, uuid4(), action), json=body, code="member_not_found"
    )
    assert without_request_id(other) == without_request_id(missing)
    assert await _roles(db, world.b_resident1.membership.id) == ["resident"]
    assert (await _status(db, world.b_resident1.membership.id))[0] == MembershipStatus.ACTIVE


# Criteria 1 and 11: suspend and reactivate.


async def test_suspended_resident_loses_access_on_next_request(
    manager: AsyncClient, as_user: UserClientFactory, world: World, db: AsyncSession
) -> None:
    resident = await as_user(world.a_resident1.user)
    building_url = f"/api/buildings/{world.a.id}"
    assert (await resident.get(building_url)).status_code == 200

    r = await manager.post(
        _member(world.a, world.a_resident1.membership.id, "suspend"),
        json={"reason": "  Unpaid fees  "},
    )

    assert r.status_code == 200, r.text
    assert r.json() == _member_body(
        world.a_resident1,
        status="suspended",
        status_reason="Unpaid fees",
        unit_id=str(world.a_101.id),
        unit_label="101",
        relationship="tenant",
    )
    changed_by = await db.scalar(
        select(BuildingMembership.status_changed_by_user_id)
        .where(BuildingMembership.id == world.a_resident1.membership.id)
        .execution_options(populate_existing=True)
    )
    assert changed_by == world.a_manager.user.id
    # The same session, no new login.
    await assert_cross_building_404(resident, "GET", building_url)
    me = (await resident.get("/api/auth/me")).json()
    assert [(m["building"]["id"], m["status"]) for m in me["memberships"]] == [
        (str(world.a.id), "suspended")
    ]
    [event] = await _events(db, "membership.suspended")
    assert (event.entity_type, event.entity_id, event.actor_user_id, event.building_id) == (
        "membership",
        world.a_resident1.membership.id,
        world.a_manager.user.id,
        world.a.id,
    )
    # Never the reason (CLAUDE.md rule 10).
    assert "Unpaid" not in str(event.metadata_)


async def test_suspension_in_one_building_leaves_the_other(
    manager: AsyncClient, as_user: UserClientFactory, world: World
) -> None:
    multi = await as_user(world.multi)
    r = await manager.post(_member(world.a, world.multi_in_a.id, "suspend"), json=REASON)
    assert r.status_code == 200, r.text
    await assert_cross_building_404(multi, "GET", f"/api/buildings/{world.a.id}")
    assert (await multi.get(f"/api/buildings/{world.b.id}")).status_code == 200


async def test_reactivated_member_regains_access(
    manager: AsyncClient, as_user: UserClientFactory, world: World, db: AsyncSession
) -> None:
    suspended = await as_user(world.a_suspended.user)
    building_url = f"/api/buildings/{world.a.id}"
    await assert_cross_building_404(suspended, "GET", building_url)

    r = await manager.post(_member(world.a, world.a_suspended.membership.id, "reactivate"))

    assert r.status_code == 200, r.text
    assert r.json()["status"] == "active"
    assert r.json()["status_reason"] is None
    assert (await suspended.get(building_url)).status_code == 200
    [event] = await _events(db, "membership.reactivated")
    assert event.entity_id == world.a_suspended.membership.id


async def test_reactivate_clears_the_suspension_reason(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_resident2.membership.id
    assert (await manager.post(_member(world.a, target, "suspend"), json=REASON)).status_code == 200
    assert await _status(db, target) == (MembershipStatus.SUSPENDED, "Unpaid fees")
    assert (await manager.post(_member(world.a, target, "reactivate"))).status_code == 200
    assert await _status(db, target) == (MembershipStatus.ACTIVE, None)


@pytest.mark.parametrize(
    "reason",
    [None, "  ab  ", "x" * 501, "Late\nfees", "\tLate fees", "Late\u200bfees", "Late\u2028fees", 5],
    ids=["missing", "short", "long", "newline", "leading-tab", "zero-width", "line-sep", "number"],
)
async def test_suspend_reason_validation(
    manager: AsyncClient, world: World, db: AsyncSession, reason: Any
) -> None:
    body = {} if reason is None else {"reason": reason}
    r = await manager.post(_member(world.a, world.a_resident2.membership.id, "suspend"), json=body)
    assert r.status_code == 422, r.text
    assert (await _status(db, world.a_resident2.membership.id))[0] == MembershipStatus.ACTIVE


async def test_suspend_refuses_extra_fields(manager: AsyncClient, world: World) -> None:
    r = await manager.post(
        _member(world.a, world.a_resident2.membership.id, "suspend"),
        json=REASON | {"status": "deactivated"},
    )
    assert r.status_code == 422, r.text


async def test_manager_cannot_suspend_self(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    await _second_manager(db, world)
    r = await manager.post(_member(world.a, world.a_manager.membership.id, "suspend"), json=REASON)
    assert_problem(r, 409, "cannot_target_self")
    assert (await _status(db, world.a_manager.membership.id))[0] == MembershipStatus.ACTIVE


async def test_manager_can_suspend_another_manager(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    second = await _second_manager(db, world)
    r = await manager.post(_member(world.a, second.membership.id, "suspend"), json=REASON)
    assert r.status_code == 200, r.text


# Criterion 10: invalid transitions.


@pytest.mark.parametrize(
    ("persona", "action", "body", "code"),
    [
        ("a_pending", "suspend", REASON, "invalid_transition"),
        ("a_suspended", "suspend", REASON, "invalid_transition"),
        ("a_resident1", "reactivate", None, "invalid_transition"),
        ("a_pending", "reactivate", None, "invalid_transition"),
        ("a_pending", "roles", {"add": ["council"], "remove": []}, "membership_not_active"),
        ("a_suspended", "roles", {"add": ["council"], "remove": []}, "membership_not_active"),
    ],
)
async def test_invalid_transitions(
    manager: AsyncClient,
    world: World,
    db: AsyncSession,
    persona: str,
    action: str,
    body: Any,
    code: str,
) -> None:
    member: Member = getattr(world, persona)
    before = (await _status(db, member.membership.id), await _roles(db, member.membership.id))
    r = await manager.post(_member(world.a, member.membership.id, action), json=body)
    assert_problem(r, 409, code)
    after = (await _status(db, member.membership.id), await _roles(db, member.membership.id))
    assert after == before
    assert await db.scalar(select(func.count()).select_from(AuditEvent)) == 0


@pytest.mark.parametrize("status", [MembershipStatus.DENIED, MembershipStatus.DEACTIVATED])
async def test_denied_and_deactivated_members_are_not_suspended_or_reactivated(
    manager: AsyncClient, world: World, db: AsyncSession, status: MembershipStatus
) -> None:
    membership = await make_membership(await make_user(db), world.a, status=status)
    for action, body in (("suspend", REASON), ("reactivate", None)):
        r = await manager.post(_member(world.a, membership.id, action), json=body)
        assert_problem(r, 409, "invalid_transition")
    r = await manager.post(
        _member(world.a, membership.id, "roles"), json={"add": ["council"], "remove": []}
    )
    assert_problem(r, 409, "membership_not_active")


# Criteria 4, 7, 12, 16: roles.


async def test_roles_change_audits_exact_lists(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_council.membership.id
    r = await manager.post(
        _member(world.a, target, "roles"),
        # security is new; council is held (removed); resident is already held (not "added").
        json={"add": ["security", "resident"], "remove": ["council", "property_management"]},
    )

    assert r.status_code == 200, r.text
    assert r.json()["roles"] == ["resident", "security"]
    assert await _roles(db, target) == ["resident", "security"]
    [event] = await _events(db, "membership.roles_changed")
    assert (event.entity_type, event.entity_id, event.actor_user_id) == (
        "membership",
        target,
        world.a_manager.user.id,
    )
    assert event.metadata_ == {"added": ["security"], "removed": ["council"]}


async def test_roles_noop_writes_no_audit(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_resident2.membership.id
    r = await manager.post(
        _member(world.a, target, "roles"), json={"add": ["resident"], "remove": ["security"]}
    )
    assert r.status_code == 200, r.text
    assert r.json()["roles"] == ["resident"]
    assert await _events(db, "membership.roles_changed") == []


@pytest.mark.parametrize(
    "body",
    [
        {"add": [], "remove": []},
        {"add": ["council"], "remove": ["council"]},
        {"add": ["owner"], "remove": []},
        {"add": ["council"], "remove": [], "status": "active"},
        {"add": "council", "remove": []},
        {},
    ],
    ids=["both-empty", "overlap", "unknown-role", "extra-field", "not-a-list", "missing"],
)
async def test_roles_body_validation(
    manager: AsyncClient, world: World, db: AsyncSession, body: dict[str, Any]
) -> None:
    target = world.a_resident2.membership.id
    r = await manager.post(_member(world.a, target, "roles"), json=body)
    assert r.status_code == 422, r.text
    assert await _roles(db, target) == ["resident"]


async def test_cannot_remove_last_role(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_security.membership.id
    r = await manager.post(
        _member(world.a, target, "roles"), json={"add": [], "remove": ["security"]}
    )
    assert_problem(r, 409, "no_roles_left")
    assert await _roles(db, target) == ["security"]


async def test_cannot_remove_resident_with_unit(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_council.membership.id
    r = await manager.post(
        _member(world.a, target, "roles"), json={"add": [], "remove": ["resident"]}
    )
    assert_problem(r, 409, "resident_has_unit")
    assert await _roles(db, target) == ["council", "resident"]


async def test_resident_without_unit_can_lose_the_role(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    membership = await make_membership(
        await make_user(db), world.a, roles=(Role.RESIDENT, Role.COUNCIL)
    )
    r = await manager.post(
        _member(world.a, membership.id, "roles"), json={"add": [], "remove": ["resident"]}
    )
    assert r.status_code == 200, r.text
    assert await _roles(db, membership.id) == ["council"]


async def test_single_manager_cannot_remove_own_manager_role(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    target = world.a_manager.membership.id
    r = await manager.post(
        _member(world.a, target, "roles"),
        json={"add": ["council"], "remove": ["property_management"]},
    )
    assert_problem(r, 409, "last_manager")
    # Criterion 16: the council role added in the same request was rolled back too.
    assert await _roles(db, target) == ["property_management"]
    assert await _events(db, "membership.roles_changed") == []


async def test_manager_can_drop_own_role_when_another_remains(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    await _second_manager(db, world)
    target = world.a_manager.membership.id
    r = await manager.post(
        _member(world.a, target, "roles"),
        json={"add": ["council"], "remove": ["property_management"]},
    )
    assert r.status_code == 200, r.text
    assert await _roles(db, target) == ["council"]
    # Their next request is no longer a manager's.
    await assert_forbidden_role(manager, "GET", _members(world.a))


async def test_last_manager_counts_only_active_managers(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    # A suspended manager is not a manager the building can rely on.
    other = await make_membership(
        await make_user(db),
        world.a,
        roles=(Role.PROPERTY_MANAGEMENT,),
        status=MembershipStatus.SUSPENDED,
    )
    assert other.status == MembershipStatus.SUSPENDED
    r = await manager.post(
        _member(world.a, world.a_manager.membership.id, "roles"),
        json={"add": ["council"], "remove": ["property_management"]},
    )
    assert_problem(r, 409, "last_manager")


async def test_a_manager_whose_account_is_inactive_does_not_count(
    manager: AsyncClient, world: World, db: AsyncSession
) -> None:
    # Review round 1 (Claude residual): an inactive user can't log in (`resolve_session`), so the
    # building would be left with no manager who can act.
    second = await _second_manager(db, world)
    second.user.is_active = False
    await db.flush()
    r = await manager.post(
        _member(world.a, world.a_manager.membership.id, "roles"),
        json={"add": ["council"], "remove": ["property_management"]},
    )
    assert_problem(r, 409, "last_manager")


async def test_another_buildings_manager_does_not_count(manager: AsyncClient, world: World) -> None:
    # b_manager is active, in building B: A would still have none.
    r = await manager.post(
        _member(world.a, world.a_manager.membership.id, "roles"),
        json={"add": ["council"], "remove": ["property_management"]},
    )
    assert_problem(r, 409, "last_manager")


# Criterion 14: sessions follow.


async def test_staff_role_caps_existing_sessions(
    manager: AsyncClient, as_user: UserClientFactory, world: World, frozen_clock: FrozenClock
) -> None:
    resident = await as_user(world.a_resident1.user)
    r = await manager.post(
        _member(world.a, world.a_resident1.membership.id, "roles"),
        json={"add": ["security"], "remove": []},
    )
    assert r.status_code == 200, r.text

    frozen_clock.advance(hours=settings.session_idle_staff_hours, minutes=1)
    assert_problem(await resident.get("/api/auth/me"), 401, "not_authenticated")


async def test_reactivating_staff_caps_existing_sessions(
    manager: AsyncClient,
    as_user: UserClientFactory,
    world: World,
    db: AsyncSession,
    frozen_clock: FrozenClock,
) -> None:
    guard = await make_user(db)
    membership = await make_membership(
        guard, world.a, roles=(Role.SECURITY,), status=MembershipStatus.SUSPENDED
    )
    # Suspended, the session got the resident window (7 days).
    client = await as_user(guard)
    r = await manager.post(_member(world.a, membership.id, "reactivate"))
    assert r.status_code == 200, r.text

    frozen_clock.advance(hours=settings.session_idle_staff_hours, minutes=1)
    assert_problem(await client.get("/api/auth/me"), 401, "not_authenticated")


async def test_without_a_staff_role_the_resident_window_is_kept(
    manager: AsyncClient, as_user: UserClientFactory, world: World, frozen_clock: FrozenClock
) -> None:
    # The control for the two tests above: a role change without a staff role keeps 7 days.
    resident = await as_user(world.a_resident2.user)
    r = await manager.post(
        _member(world.a, world.a_resident2.membership.id, "roles"),
        json={"add": ["resident"], "remove": []},
    )
    assert r.status_code == 200, r.text
    frozen_clock.advance(hours=settings.session_idle_staff_hours, minutes=1)
    assert (await resident.get("/api/auth/me")).status_code == 200
    frozen_clock.advance(days=settings.session_idle_resident_days)
    assert_problem(await resident.get("/api/auth/me"), 401, "not_authenticated")
