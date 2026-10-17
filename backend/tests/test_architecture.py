"""Fitness tests: the architecture checks itself (P2-03 criterion 7, ADR-0004, CLAUDE.md rule 5).

Each check is a function over an app (or a source tree) returning its violations, so the meta-tests
at the bottom can prove it fails on a bad route, not just that it passes on today's code.
"""

import re
import uuid
from collections.abc import Callable, Iterator
from pathlib import Path
from typing import Annotated, Any

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from starlette.routing import BaseRoute, Mount, Route

from app.auth.allowlist import AUTH_ALLOWLIST
from app.auth.deps import get_current_session, get_current_user
from app.main import app, create_app
from app.tenancy.context import TenantContext
from app.tenancy.deps import get_own_membership, get_tenant_context
from tests.helpers.auth import login_as
from tests.helpers.tenancy import assert_cross_building_404, assert_problem

APP_DIR = Path(__file__).resolve().parent.parent / "app"
BUILDING_PREFIX = "/api/buildings/{building_id}"
TENANT_GUARDS = frozenset({get_tenant_context, get_own_membership})
AUTH_DEPENDENCIES = frozenset({get_current_user, get_current_session})
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
# The only places allowed to commit (CLAUDE.md rule 5): write use-cases and process entry points.
COMMIT_ALLOWED = ("**/service.py", "cli.py", "seed.py", "worker.py", "jobs/worker.py")


def dependency_calls(dependant: Dependant) -> Iterator[Callable[..., Any]]:
    """Every callable in a route's dependency tree: router-level, decorator-level, parameters,
    and their own dependencies, however deep."""
    for sub in dependant.dependencies:
        if sub.call is not None:
            yield sub.call
        yield from dependency_calls(sub)


def _docs_paths(application: FastAPI) -> frozenset[str]:
    """FastAPI's own documentation routes: plain Starlette routes, with nothing to walk."""
    paths = {application.openapi_url, application.docs_url, application.redoc_url}
    if application.docs_url:
        paths.add(application.swagger_ui_oauth2_redirect_url)
    return frozenset(p for p in paths if p)


def _under(path: str, prefix: str) -> bool:
    return path == prefix or path.startswith(prefix + "/")


def _api_routes(application: FastAPI) -> Iterator[APIRoute]:
    for route in application.routes:
        if isinstance(route, APIRoute) and _under(route.path, "/api"):
            yield route


def _methods(route: APIRoute) -> list[str]:
    return sorted(route.methods or ())


def opaque_api_routes(application: FastAPI) -> list[str]:
    """Routes under /api the walks below can't see into: a `Mount` or a plain Starlette route."""
    docs = _docs_paths(application)
    violations = []
    for route in application.routes:
        path = getattr(route, "path", "")
        if isinstance(route, APIRoute) or not _under(path, "/api") or path in docs:
            continue
        violations.append(f"{type(route).__name__} {path}")
    return violations


def unguarded_building_routes(application: FastAPI) -> list[str]:
    """Fitness test 1: every route under the building prefix depends on a tenant guard, the prefix
    names `{building_id}` exactly, and no route outside it depends on one (there, `building_id`
    would become a query parameter)."""
    violations = []
    for route in _api_routes(application):
        guarded = not TENANT_GUARDS.isdisjoint(dependency_calls(route.dependant))
        in_prefix = _under(route.path, BUILDING_PREFIX)
        if _under(route.path, "/api/buildings") and not in_prefix:
            violations.append(f"{route.path}: building routes start with {BUILDING_PREFIX}")
        elif in_prefix and not guarded:
            violations.append(f"{route.path}: no get_tenant_context or get_own_membership")
        elif guarded and not in_prefix:
            violations.append(f"{route.path}: a tenant guard outside {BUILDING_PREFIX}")
    return violations


def unauthenticated_routes(application: FastAPI) -> list[str]:
    """Fitness test 2: every /api route needs a session, unless `AUTH_ALLOWLIST` names it."""
    violations = []
    for route in _api_routes(application):
        if not AUTH_DEPENDENCIES.isdisjoint(dependency_calls(route.dependant)):
            continue
        for method in _methods(route):
            if (method, route.path) not in AUTH_ALLOWLIST:
                violations.append(f"{method} {route.path}")
    return violations


def stale_allowlist_entries(application: FastAPI) -> list[str]:
    """Every allowlisted (method, path) is a real route, so the list can't pre-approve one."""
    existing = {(m, r.path) for r in _api_routes(application) for m in _methods(r)}
    return sorted(f"{m} {p}" for m, p in AUTH_ALLOWLIST if (m, p) not in existing)


_COMMIT = re.compile(r"\.commit\(")


def files_that_commit(root: Path) -> list[str]:
    """Fitness test 4: `.commit(` only where COMMIT_ALLOWED says."""
    allowed = {p for pattern in COMMIT_ALLOWED for p in root.glob(pattern)}
    return sorted(
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if path not in allowed and _COMMIT.search(path.read_text())
    )


# The checks on the real app


def test_every_api_route_is_an_api_route():
    assert opaque_api_routes(app) == []


def test_every_building_route_is_tenant_guarded():
    assert unguarded_building_routes(app) == []


def test_every_api_route_requires_a_session_unless_allowlisted():
    assert unauthenticated_routes(app) == []


def test_every_allowlist_entry_is_a_real_route():
    assert stale_allowlist_entries(app) == []


def test_only_services_and_entry_points_commit():
    assert files_that_commit(APP_DIR) == []


def test_the_checks_see_the_building_route():
    """Not vacuous: the walk finds today's building route and its guard."""
    [route] = [r for r in _api_routes(app) if r.path == BUILDING_PREFIX]
    assert get_tenant_context in set(dependency_calls(route.dependant))
    assert get_current_user in set(dependency_calls(route.dependant))


# Fitness test 3: every building route, called by another building's member


def _building_routes() -> list[tuple[str, str]]:
    return [
        (method, route.path)
        for route in _api_routes(app)
        if _under(route.path, BUILDING_PREFIX)
        for method in _methods(route)
        if method not in {"HEAD", "OPTIONS"}
    ]


def _concrete(path: str, building_id: uuid.UUID) -> str:
    path = path.replace("{building_id}", str(building_id))
    return re.sub(r"\{[^}]+\}", lambda _: str(uuid.uuid4()), path)


BUILDING_ROUTES = _building_routes()


def test_there_are_building_routes_to_parametrize():
    assert BUILDING_ROUTES


@pytest.mark.anyio
@pytest.mark.parametrize(("method", "path"), BUILDING_ROUTES)
async def test_another_buildings_member_gets_404_on_every_building_route(
    client, db, world, method, path
):
    await login_as(db, client, world.b_resident1.user)

    await assert_cross_building_404(
        client,
        method,
        _concrete(path, world.a.id),
        json=None if method in SAFE_METHODS else {},
    )


@pytest.mark.anyio
@pytest.mark.parametrize(("method", "path"), BUILDING_ROUTES)
async def test_every_building_route_without_a_session_is_401(client, world, method, path):
    response = await client.request(
        method, _concrete(path, world.a.id), json=None if method in SAFE_METHODS else {}
    )

    assert_problem(response, 401, "not_authenticated")


# Meta-tests: each check fails on the thing it exists to catch


def _app_with(*routes: APIRouter | BaseRoute) -> FastAPI:
    test_app = create_app()
    for item in routes:
        if isinstance(item, APIRouter):
            test_app.include_router(item)
        else:
            test_app.router.routes.append(item)
    return test_app


async def _ok() -> dict[str, str]:
    return {}


def test_meta_unguarded_building_route_fails_checks_1_and_2():
    router = APIRouter(prefix=BUILDING_PREFIX, tags=["meta"])
    router.get("/leak")(_ok)

    test_app = _app_with(router)

    assert unguarded_building_routes(test_app) == [
        f"{BUILDING_PREFIX}/leak: no get_tenant_context or get_own_membership"
    ]
    assert unauthenticated_routes(test_app) == [f"GET {BUILDING_PREFIX}/leak"]


def test_meta_guard_deep_in_the_tree_counts():
    async def nested(ctx: Annotated[TenantContext, Depends(get_tenant_context)]) -> None:
        return None

    router = APIRouter(prefix=BUILDING_PREFIX, tags=["meta"])
    router.get("/nested", dependencies=[Depends(nested)])(_ok)

    test_app = _app_with(router)

    assert unguarded_building_routes(test_app) == []
    assert unauthenticated_routes(test_app) == []


def test_meta_unauthenticated_route_fails_check_2():
    router = APIRouter(prefix="/api/things", tags=["meta"])
    router.post("")(_ok)

    assert unauthenticated_routes(_app_with(router)) == ["POST /api/things"]


def test_meta_tenant_guard_outside_the_prefix_fails_check_1():
    router = APIRouter(prefix="/api/things", tags=["meta"])
    router.get("", dependencies=[Depends(get_tenant_context)])(_ok)

    assert unguarded_building_routes(_app_with(router)) == [
        f"/api/things: a tenant guard outside {BUILDING_PREFIX}"
    ]


def test_meta_building_path_with_another_parameter_name_fails_check_1():
    router = APIRouter(prefix="/api/buildings/{bid}", tags=["meta"])
    router.get("", dependencies=[Depends(get_tenant_context)])(_ok)

    assert unguarded_building_routes(_app_with(router)) == [
        f"/api/buildings/{{bid}}: building routes start with {BUILDING_PREFIX}"
    ]


def test_meta_mount_or_plain_route_under_api_is_reported():
    test_app = _app_with(
        Mount("/api/legacy", app=FastAPI()), Route("/api/raw", endpoint=lambda r: None)
    )

    assert opaque_api_routes(test_app) == ["Mount /api/legacy", "Route /api/raw"]


def test_meta_stale_allowlist_entry_is_reported(monkeypatch):
    monkeypatch.setattr(
        "tests.test_architecture.AUTH_ALLOWLIST",
        AUTH_ALLOWLIST | {("POST", "/api/auth/signup")},
    )

    assert stale_allowlist_entries(app) == ["POST /api/auth/signup"]


def test_meta_commit_outside_a_service_is_reported(tmp_path):
    for name, code in {
        "packages/service.py": "await db.commit()",
        "packages/router.py": "await db.commit()",
        "core/helpers.py": "session.commit()",
        "cli.py": "await db.commit()",
        "jobs/worker.py": "await db.commit()",
        "notices/router.py": "# no commits here",
    }.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(code)

    assert files_that_commit(tmp_path) == ["core/helpers.py", "packages/router.py"]
