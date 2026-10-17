"""The tenant context and its guards (P2-03 criteria 1-6, 8-10; ADR-0004)."""

import asyncio
import json
import logging
import uuid
from typing import Annotated

import pytest
from fastapi import APIRouter, Depends
from sqlalchemy import delete, event, update
from starlette.requests import Request

from app.buildings.enums import Feature
from app.buildings.models import Building, BuildingFeature
from app.logging_config import JsonFormatter, building_id_ctx, user_id_ctx
from app.memberships.enums import MembershipStatus, Role
from app.memberships.models import BuildingMembership, MembershipRole
from app.tenancy.context import TenantContext
from app.tenancy.deps import get_own_membership, get_tenant_context, require_feature, require_roles
from app.tenancy.router import building_router
from tests.factories import make_membership, make_user
from tests.helpers.auth import login_as
from tests.helpers.tenancy import (
    assert_cross_building_404,
    assert_forbidden_role,
    assert_problem,
    without_request_id,
)

pytestmark = pytest.mark.anyio

probe_logger = logging.getLogger("tests.tenancy.probe")


def _probe_router() -> APIRouter:
    """Test-only routes under the building prefix, one per guard."""
    router = building_router(tags=["probe"])
    Ctx = Annotated[TenantContext, Depends(get_tenant_context)]

    def _out(ctx: TenantContext) -> dict[str, object]:
        return {"membership_id": str(ctx.membership_id), "roles": sorted(ctx.roles)}

    @router.get("/probe/any")
    async def any_member(ctx: Ctx) -> dict[str, object]:
        probe_logger.info("probe_called")
        return _out(ctx)

    @router.get(
        "/probe/manager", dependencies=[Depends(require_roles(Role.PROPERTY_MANAGEMENT))]
    )
    async def manager(ctx: Ctx) -> dict[str, object]:
        return _out(ctx)

    @router.get("/probe/security", dependencies=[Depends(require_roles(Role.SECURITY))])
    async def security(ctx: Ctx) -> dict[str, object]:
        return _out(ctx)

    @router.get("/probe/maintenance", dependencies=[Depends(require_feature(Feature.MAINTENANCE))])
    async def maintenance(ctx: Ctx) -> dict[str, object]:
        return _out(ctx)

    @router.get(
        "/probe/both",
        dependencies=[
            Depends(require_roles(Role.PROPERTY_MANAGEMENT)),
            Depends(require_feature(Feature.PACKAGES)),
        ],
    )
    async def both(ctx: Ctx) -> dict[str, object]:
        return _out(ctx)

    return router


def _onboarding_router() -> APIRouter:
    """A test-only onboarding route: `get_own_membership` instead of the tenant context."""
    router = APIRouter(prefix="/api/buildings/{building_id}", tags=["probe"])

    @router.get("/probe/own")
    async def own(
        membership: Annotated[BuildingMembership, Depends(get_own_membership)],
    ) -> dict[str, str]:
        return {"membership_id": str(membership.id), "status": membership.status.value}

    return router


@pytest.fixture
def probe(app_client):
    """`async with probe() as c:` a client for an app with the probe routes."""
    return lambda: app_client(_probe_router(), _onboarding_router(), prefix="")


def building_url(building_id: object) -> str:
    return f"/api/buildings/{building_id}"


# Criterion 1


@pytest.mark.parametrize(
    ("persona", "roles"),
    [
        ("a_manager", ["property_management"]),
        ("a_security", ["security"]),
        ("a_resident1", ["resident"]),
        ("a_council", ["council", "resident"]),
    ],
)
async def test_active_member_gets_their_building_with_roles_and_features(
    as_user, world, persona, roles
):
    client = await as_user(getattr(world, persona).user)

    response = await client.get(building_url(world.a.id))

    assert response.status_code == 200, response.text
    assert response.json() == {
        "id": str(world.a.id),
        "name": "Maple Court",
        "slug": "maple",
        "timezone": "America/Toronto",
        "locale": "en",
        "my_roles": roles,
        "features": ["maintenance", "notices", "packages"],
    }


async def test_disabled_feature_is_not_listed(as_user, db, world):
    await db.execute(
        update(BuildingFeature)
        .where(
            BuildingFeature.building_id == world.a.id,
            BuildingFeature.feature == Feature.NOTICES,
        )
        .values(enabled=False)
    )
    client = await as_user(world.a_manager.user)

    response = await client.get(building_url(world.a.id))

    assert response.json()["features"] == ["maintenance", "packages"]


# Criterion 2


async def test_every_caller_without_an_active_membership_gets_the_same_404(as_user, db, world):
    denied = await make_user(db)
    await make_membership(denied, world.a, status=MembershipStatus.DENIED)
    deactivated = await make_user(db)
    await make_membership(deactivated, world.a, status=MembershipStatus.DEACTIVATED)
    callers = [
        (world.b_resident1.user, world.a.id),
        (world.b_resident1.user, uuid.uuid4()),
        (world.a_pending.user, world.a.id),
        (world.a_suspended.user, world.a.id),
        (denied, world.a.id),
        (deactivated, world.a.id),
        (world.no_membership, world.a.id),
    ]

    bodies = []
    for user, building_id in callers:
        client = await as_user(user)
        bodies.append(
            without_request_id(
                await assert_cross_building_404(client, "GET", building_url(building_id))
            )
        )

    assert bodies == [bodies[0]] * len(callers)
    assert bodies[0] == {
        "type": "/problems/building-not-found",
        "title": "Not Found",
        "status": 404,
        "code": "building_not_found",
        "detail": "Building not found.",
    }


async def test_inactive_building_is_a_404_even_for_its_manager(as_user, db, world):
    client = await as_user(world.a_manager.user)
    before = await client.get(building_url(world.a.id))
    await db.execute(update(Building).where(Building.id == world.a.id).values(is_active=False))

    body = await assert_cross_building_404(client, "GET", building_url(world.a.id))

    assert before.status_code == 200
    other = await as_user(world.b_resident1.user)
    assert without_request_id(body) == without_request_id(
        await assert_cross_building_404(other, "GET", building_url(world.a.id))
    )


# Criterion 2b (added)


async def test_building_route_without_a_session_is_401(client, world):
    assert_problem(await client.get(building_url(world.a.id)), 401, "not_authenticated")


async def test_building_id_that_is_not_a_uuid_is_422(as_user, world):
    client = await as_user(world.a_manager.user)

    assert_problem(await client.get(building_url("maple")), 422, "validation_error")


# Criterion 3


async def test_wrong_role_gets_403_forbidden_role(probe, db, world):
    async with probe() as c:
        await login_as(db, c, world.a_security.user)
        await assert_forbidden_role(c, "GET", f"{building_url(world.a.id)}/probe/manager")

        await login_as(db, c, world.a_manager.user)
        allowed = await c.get(f"{building_url(world.a.id)}/probe/manager")

    assert allowed.status_code == 200, allowed.text
    assert allowed.json() == {
        "membership_id": str(world.a_manager.membership.id),
        "roles": ["property_management"],
    }


async def test_another_buildings_manager_gets_404_not_403_on_a_role_route(probe, db, world):
    async with probe() as c:
        await login_as(db, c, world.b_manager.user)
        await assert_cross_building_404(c, "GET", f"{building_url(world.a.id)}/probe/manager")


def test_require_roles_needs_at_least_one_role():
    with pytest.raises(ValueError, match="at least one role"):
        require_roles()


# Criterion 4


async def _set_feature(db, building, feature: Feature, *, enabled: bool) -> None:
    await db.execute(
        update(BuildingFeature)
        .where(BuildingFeature.building_id == building.id, BuildingFeature.feature == feature)
        .values(enabled=enabled)
    )


async def test_disabled_feature_gets_403_feature_disabled(probe, db, world):
    await _set_feature(db, world.a, Feature.MAINTENANCE, enabled=False)

    async with probe() as c:
        await login_as(db, c, world.a_resident1.user)
        response = await c.get(f"{building_url(world.a.id)}/probe/maintenance")

    assert_problem(response, 403, "feature_disabled")


async def test_feature_without_a_row_is_disabled(probe, db, world):
    await db.execute(
        delete(BuildingFeature).where(
            BuildingFeature.building_id == world.a.id,
            BuildingFeature.feature == Feature.MAINTENANCE,
        )
    )

    async with probe() as c:
        await login_as(db, c, world.a_resident1.user)
        response = await c.get(f"{building_url(world.a.id)}/probe/maintenance")

    assert_problem(response, 403, "feature_disabled")


async def test_enabled_feature_passes(probe, db, world):
    async with probe() as c:
        await login_as(db, c, world.a_resident1.user)
        response = await c.get(f"{building_url(world.a.id)}/probe/maintenance")

    assert response.status_code == 200, response.text


# Criterion 5


async def test_role_removed_between_requests_applies_to_the_next_request(probe, db, world):
    url = f"{building_url(world.a.id)}/probe/manager"
    async with probe() as c:
        await login_as(db, c, world.a_manager.user)
        first = await c.get(url)
        await db.execute(
            delete(MembershipRole).where(
                MembershipRole.membership_id == world.a_manager.membership.id
            )
        )
        second = await c.get(url)

    assert first.status_code == 200, first.text
    assert_problem(second, 403, "forbidden_role")


async def test_membership_suspended_between_requests_is_404_on_the_next_request(
    probe, db, world
):
    url = f"{building_url(world.a.id)}/probe/any"
    async with probe() as c:
        await login_as(db, c, world.a_resident1.user)
        first = await c.get(url)
        await db.execute(
            update(BuildingMembership)
            .where(BuildingMembership.id == world.a_resident1.membership.id)
            .values(status=MembershipStatus.SUSPENDED)
        )
        second = await c.get(url)

    assert first.status_code == 200, first.text
    assert_problem(second, 404, "building_not_found")


async def test_feature_disabled_between_requests_applies_to_the_next_request(probe, db, world):
    url = f"{building_url(world.a.id)}/probe/maintenance"
    async with probe() as c:
        await login_as(db, c, world.a_resident1.user)
        first = await c.get(url)
        await _set_feature(db, world.a, Feature.MAINTENANCE, enabled=False)
        second = await c.get(url)

    assert first.status_code == 200, first.text
    assert_problem(second, 403, "feature_disabled")


# Criterion 6


async def test_multi_building_user_gets_each_buildings_own_roles(probe, as_user, db, world):
    client = await as_user(world.multi)

    in_a = await client.get(building_url(world.a.id))
    in_b = await client.get(building_url(world.b.id))

    assert in_a.json()["my_roles"] == ["resident"]
    assert in_b.json()["my_roles"] == ["security"]
    async with probe() as c:
        await login_as(db, c, world.multi)
        await assert_forbidden_role(c, "GET", f"{building_url(world.a.id)}/probe/security")
        allowed = await c.get(f"{building_url(world.b.id)}/probe/security")
    assert allowed.json()["membership_id"] == str(world.multi_in_b.id)


# Criterion 8 (added): get_own_membership


@pytest.mark.parametrize(
    "status",
    [
        MembershipStatus.PENDING,
        MembershipStatus.ACTIVE,
        MembershipStatus.SUSPENDED,
        MembershipStatus.DENIED,
    ],
)
async def test_own_membership_allows_every_status_but_deactivated(probe, db, world, status):
    user = await make_user(db)
    membership = await make_membership(user, world.a, status=status)

    async with probe() as c:
        await login_as(db, c, user)
        response = await c.get(f"{building_url(world.a.id)}/probe/own")

    assert response.status_code == 200, response.text
    assert response.json() == {"membership_id": str(membership.id), "status": status.value}


async def test_own_membership_refuses_deactivated_non_members_and_inactive_buildings(
    probe, db, world
):
    deactivated = await make_user(db)
    await make_membership(deactivated, world.a, status=MembershipStatus.DEACTIVATED)
    closed = await make_user(db)
    await make_membership(closed, world.b, status=MembershipStatus.PENDING)
    await db.execute(update(Building).where(Building.id == world.b.id).values(is_active=False))
    cases = [
        (deactivated, world.a.id),
        (world.b_resident1.user, world.a.id),
        (world.no_membership, world.a.id),
        (closed, world.b.id),
        (world.a_pending.user, uuid.uuid4()),
    ]

    bodies = []
    async with probe() as c:
        for user, building_id in cases:
            await login_as(db, c, user)
            bodies.append(
                without_request_id(
                    await assert_cross_building_404(
                        c, "GET", f"{building_url(building_id)}/probe/own"
                    )
                )
            )

    assert bodies == [bodies[0]] * len(cases)


async def test_own_membership_without_a_session_is_401(probe, world):
    async with probe() as c:
        response = await c.get(f"{building_url(world.a.id)}/probe/own")

    assert_problem(response, 401, "not_authenticated")


# Criterion 9 (added): one query, once per request


async def test_tenant_context_is_one_query_even_with_role_and_feature_guards(
    probe, db, db_connection, world
):
    statements: list[str] = []

    def record(_conn, _cursor, statement, *_args) -> None:
        statements.append(statement)

    async with probe() as c:
        await login_as(db, c, world.a_manager.user)
        event.listen(db_connection.sync_connection, "before_cursor_execute", record)
        try:
            response = await c.get(f"{building_url(world.a.id)}/probe/both")
        finally:
            event.remove(db_connection.sync_connection, "before_cursor_execute", record)

    assert response.status_code == 200, response.text
    tenant = [s for s in statements if "building_memberships" in s]
    assert len(tenant) == 1, statements
    assert "membership_roles" in tenant[0]
    assert "building_features" in tenant[0]


async def test_tenant_context_carries_the_membership_roles_and_enabled_features(db, world):
    request = Request({"type": "http", "method": "GET", "path": "/", "headers": []})

    # In a context of its own: outside a request, nothing resets the log context variables.
    ctx = await asyncio.create_task(
        get_tenant_context(request, world.a.id, world.a_council.user, db)
    )

    assert ctx == TenantContext(
        user_id=world.a_council.user.id,
        building_id=world.a.id,
        membership_id=world.a_council.membership.id,
        roles=frozenset({Role.COUNCIL, Role.RESIDENT}),
        features=frozenset({Feature.PACKAGES, Feature.NOTICES, Feature.MAINTENANCE}),
    )
    assert ctx.has_any(Role.SECURITY, Role.COUNCIL)
    assert not ctx.has_any(Role.SECURITY)
    assert ctx.is_staff
    assert request.state.building_id == world.a.id
    assert request.state.user_id == world.a_council.user.id


def test_resident_only_context_is_not_staff():
    ctx = TenantContext(
        user_id=uuid.uuid4(),
        building_id=uuid.uuid4(),
        membership_id=uuid.uuid4(),
        roles=frozenset({Role.RESIDENT}),
        features=frozenset(),
    )

    assert not ctx.is_staff
    with pytest.raises(AttributeError):
        ctx.building_id = uuid.uuid4()  # type: ignore[misc]


# Criterion 10 (added): logging context


class _JsonLines(logging.Handler):
    """Formats each record when it is emitted, in the emitting task's context, as production does."""

    def __init__(self) -> None:
        super().__init__()
        self.setFormatter(JsonFormatter())
        self.lines: list[dict[str, object]] = []

    def emit(self, record: logging.LogRecord) -> None:
        self.lines.append(json.loads(self.format(record)))


@pytest.fixture
def json_logs():
    handler = _JsonLines()
    loggers = [logging.getLogger("app.request"), probe_logger]
    previous = [lg.level for lg in loggers]
    for lg in loggers:
        lg.addHandler(handler)
        lg.setLevel(logging.INFO)
    try:
        yield handler.lines
    finally:
        for lg, level in zip(loggers, previous, strict=True):
            lg.removeHandler(handler)
            lg.setLevel(level)


async def test_building_request_logs_carry_building_and_user(probe, db, world, json_logs):
    # A value left in the caller's context (a direct call, a script) must not reach any request.
    building_id_ctx.set("stale")
    user_id_ctx.set("stale")
    async with probe() as c:
        await login_as(db, c, world.a_resident1.user)
        await c.get(f"{building_url(world.a.id)}/probe/any")
        await c.get("/api/auth/me")

    probe_line, building_line, me_line = (
        next(line for line in json_logs if line["message"] == "probe_called"),
        *[line for line in json_logs if line["message"] == "request_completed"],
    )
    ids = {"building_id": str(world.a.id), "user_id": str(world.a_resident1.user.id)}
    assert probe_line.items() >= ids.items()
    assert building_line.items() >= ids.items()
    assert "building_id" not in me_line
    assert "user_id" not in me_line
    building_id_ctx.set(None)
    user_id_ctx.set(None)
