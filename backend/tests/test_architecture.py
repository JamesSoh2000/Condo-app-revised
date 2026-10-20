"""Fitness tests: the architecture checks itself (P2-03 criterion 7, ADR-0004, CLAUDE.md rule 5).

Each check is a function over an app (or a source tree) returning its violations, so the meta-tests
at the bottom can prove it fails on a bad route, not just that it passes on today's code.
"""

import ast
import re
import uuid
from collections.abc import Callable, Iterable, Iterator
from pathlib import Path
from typing import Annotated, Any, get_args, get_origin

import pytest
from fastapi import APIRouter, Depends, FastAPI
from fastapi.dependencies.models import Dependant
from fastapi.routing import APIRoute
from pydantic import AfterValidator, BaseModel, BeforeValidator, ConfigDict, Field
from starlette.routing import BaseRoute, Host, Mount, Route, WebSocketRoute

from app.auth.allowlist import AUTH_ALLOWLIST
from app.auth.deps import get_current_session, get_current_user
from app.core.schemas import InputModel
from app.main import app, create_app
from app.tenancy.context import TenantContext
from app.tenancy.deps import get_own_membership, get_tenant_context
from app.units.schemas import printable, printable_before_strip
from tests.helpers.auth import login_as
from tests.helpers.tenancy import assert_cross_building_404, assert_problem

APP_DIR = Path(__file__).resolve().parent.parent / "app"
MIGRATIONS_DIR = APP_DIR.parent / "migrations"
BUILDING_PREFIX = "/api/buildings/{building_id}"
TENANT_GUARDS = frozenset({get_tenant_context, get_own_membership})
AUTH_DEPENDENCIES = frozenset({get_current_user, get_current_session})
SAFE_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})
# The only places allowed to commit (CLAUDE.md rule 5): write use-cases and process entry points.
COMMIT_ALLOWED = ("**/service.py", "cli.py", "seed.py", "worker.py", "jobs/worker.py")
# Helpers that live in an allowed module but must never commit themselves (CLAUDE.md rule 5): the
# file rule can't see them (P2-04 mutation M2). Add `attach_file` with it.
NON_COMMITTING_HELPERS: dict[str, tuple[str, ...]] = {
    "audit/service.py": ("record_audit",),
    "jobs/service.py": (
        "enqueue",
        "delete_old_succeeded_jobs",
        "scrub_dead_jobs",
        "job_status",
        "retry_dead_job",
    ),
    "auth/service.py": ("delete_ended_sessions",),
    "notifications/service.py": ("notify", "staff_user_ids", "unit_resident_user_ids"),
    "email/service.py": ("queue_email",),
    "rate_limits/service.py": ("delete_expired_rate_limits",),
}


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
    """Every `APIRoute`, under /api or not: one at `/admin/export` is reachable too (P2-03 review
    round 2, L1). FastAPI's docs routes are plain Starlette routes, so they aren't among them."""
    for route in application.routes:
        if isinstance(route, APIRoute):
            yield route


def _methods(route: APIRoute) -> list[str]:
    return sorted(route.methods or ())


def opaque_routes(application: FastAPI) -> list[str]:
    """Routes the walks below can't see into: any `Mount`, `Host` or plain Starlette route, wherever
    it sits. A mount outside /api still serves /api paths when its prefix covers them (`/`), so
    only FastAPI's own docs routes are let through (Codex review round 1)."""
    docs = _docs_paths(application)
    return [
        f"{type(route).__name__} {getattr(route, 'path', '') or '/'}"
        for route in application.routes
        if not isinstance(route, APIRoute) and getattr(route, "path", None) not in docs
    ]


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


# `get_own_membership` lets a pending, denied or suspended member through, so it may guard only
# these onboarding routes: an operational route using it would open to them (P2-03 round 1, L3).
OWN_MEMBERSHIP_ROUTES = frozenset({("GET", f"{BUILDING_PREFIX}/onboarding/me")})


def routes_using_own_membership(application: FastAPI) -> list[str]:
    """Fitness test 1b: every route that depends on `get_own_membership` is in
    `OWN_MEMBERSHIP_ROUTES`."""
    return [
        f"{method} {route.path}"
        for route in _api_routes(application)
        if get_own_membership in set(dependency_calls(route.dependant))
        for method in _methods(route)
        if (method, route.path) not in OWN_MEMBERSHIP_ROUTES
    ]


def unauthenticated_routes(application: FastAPI) -> list[str]:
    """Fitness test 2: every route needs a session, unless `AUTH_ALLOWLIST` names it."""
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


# `.commit(`, and its neighbours that commit too: an alias (`save = db.commit`), raw SQL `COMMIT`
# (not `COMMITTED`), and `.begin()`, whose context manager commits on exit (Claude review round 1).
# Also a string that starts with SQL `commit` in any case, and the quoted `AUTOCOMMIT` isolation
# level; not a bare case-insensitive word, which comments and `autocommit=False` contain (P2-07).
_COMMIT = re.compile(
    r"\.commit\b|\bCOMMIT\b|\.begin\("
    r"|(?i:[\"']\s*commit\b)"
    r"|(?i:[\"']autocommit[\"'])"
)


def _helper_commits(root: Path) -> Iterator[str]:
    """Each `NON_COMMITTING_HELPERS` function whose own body commits, or that no longer exists."""
    for name, helpers in NON_COMMITTING_HELPERS.items():
        path = root / name
        if not path.is_file():
            yield from (f"{name}::{helper}: no such file" for helper in helpers)
            continue
        source = path.read_text()
        # Module level only: a method of the same name is another function (Codex review round 2).
        functions = {
            node.name: node
            for node in ast.parse(source).body
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        }
        for helper in helpers:
            if helper not in functions:
                yield f"{name}::{helper}: no such function"
            elif _COMMIT.search(ast.get_source_segment(source, functions[helper]) or ""):
                yield f"{name}::{helper}"


def files_that_commit(root: Path) -> list[str]:
    """Fitness test 4: committing (see `_COMMIT`) only where COMMIT_ALLOWED says, and never inside a
    `NON_COMMITTING_HELPERS` function."""
    allowed = {p for pattern in COMMIT_ALLOWED for p in root.glob(pattern)}
    outside = [
        str(path.relative_to(root))
        for path in root.rglob("*.py")
        if path not in allowed and _COMMIT.search(path.read_text())
    ]
    return sorted([*outside, *_helper_commits(root)])


# Writing to audit_events other than by INSERT: the ORM statements, the Core table's own, a legacy
# Query, and raw SQL (P2-04 criterion 6). seed.py's dev-only TRUNCATE names its tables at run time.
_AUDIT_MUTATION = re.compile(
    r"\b(?:update|delete)\(\s*AuditEvent\b"
    r"|\bAuditEvent\.__table__\.(?:update|delete)\("
    r"|\bquery\(\s*AuditEvent\b.*\.(?:update|delete)\("
    r"|(?i:\bupdate\s+\"?audit_events\b|\bdelete\s+from\s+\"?audit_events\b)"
    r"|(?i:\btruncate\b.*\baudit_events\b)"
)


def files_that_mutate_audit_events(*roots: Path) -> list[str]:
    """Fitness test 5: audit events are append-only; no code path updates or deletes one."""
    return sorted(
        f"{path.relative_to(root)}: {match.group(0)}"
        for root in roots
        for path in root.rglob("*.py")
        for match in [_AUDIT_MUTATION.search(path.read_text())]
        if match
    )


# The checks on the real app


def test_every_route_is_an_api_route():
    assert opaque_routes(app) == []


def test_every_building_route_is_tenant_guarded():
    assert unguarded_building_routes(app) == []


def test_only_onboarding_routes_use_get_own_membership():
    assert routes_using_own_membership(app) == []


def test_every_listed_onboarding_route_exists_and_uses_get_own_membership():
    found = {
        (method, route.path)
        for route in _api_routes(app)
        if get_own_membership in set(dependency_calls(route.dependant))
        for method in _methods(route)
    }
    assert found >= OWN_MEMBERSHIP_ROUTES


def test_every_api_route_requires_a_session_unless_allowlisted():
    assert unauthenticated_routes(app) == []


def test_every_allowlist_entry_is_a_real_route():
    assert stale_allowlist_entries(app) == []


def test_only_services_and_entry_points_commit():
    assert files_that_commit(APP_DIR) == []


def test_no_code_updates_or_deletes_audit_events():
    assert files_that_mutate_audit_events(APP_DIR, MIGRATIONS_DIR) == []


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


def test_meta_unlisted_route_using_get_own_membership_fails_check_1b():
    async def own(membership: Annotated[Any, Depends(get_own_membership)]) -> None:
        return None

    router = APIRouter(prefix=BUILDING_PREFIX, tags=["meta"])
    router.get("/packages", dependencies=[Depends(own)])(_ok)

    test_app = _app_with(router)

    # Check 1 is satisfied (a tenant guard), so only 1b catches it.
    assert unguarded_building_routes(test_app) == []
    assert routes_using_own_membership(test_app) == [f"GET {BUILDING_PREFIX}/packages"]


def test_meta_unauthenticated_route_fails_check_2():
    router = APIRouter(prefix="/api/things", tags=["meta"])
    router.post("")(_ok)

    assert unauthenticated_routes(_app_with(router)) == ["POST /api/things"]


def test_meta_unauthenticated_route_outside_api_fails_check_2():
    """P2-03 review round 2, L1: the walk covered only /api routes (P2-07 criterion 3)."""
    router = APIRouter(prefix="/admin", tags=["meta"])
    router.get("/export")(_ok)

    assert unauthenticated_routes(_app_with(router)) == ["GET /admin/export"]


def test_meta_tenant_guard_outside_api_fails_check_1():
    router = APIRouter(prefix="/admin", tags=["meta"])
    router.get("/export", dependencies=[Depends(get_tenant_context)])(_ok)

    assert unguarded_building_routes(_app_with(router)) == [
        f"/admin/export: a tenant guard outside {BUILDING_PREFIX}"
    ]


def test_meta_allowlist_entry_outside_api_is_a_real_route(monkeypatch):
    monkeypatch.setattr(
        "tests.test_architecture.AUTH_ALLOWLIST", AUTH_ALLOWLIST | {("GET", "/admin/export")}
    )
    router = APIRouter(prefix="/admin", tags=["meta"])
    router.get("/export")(_ok)
    test_app = _app_with(router)

    assert stale_allowlist_entries(test_app) == []
    assert unauthenticated_routes(test_app) == []


def test_docs_routes_stay_out_of_checks_1_and_2():
    """FastAPI's docs routes are plain Starlette routes: no dependency tree to walk."""
    paths = {getattr(r, "path", None) for r in app.routes if not isinstance(r, APIRoute)}

    assert _docs_paths(app) <= paths
    assert unauthenticated_routes(app) == []


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


def test_meta_root_mount_is_reported():
    """A sub-app mounted at `/` serves any path, /api/... included, out of the walk's sight
    (Codex review round 1)."""
    legacy = FastAPI()

    @legacy.get("/api/buildings/{building_id}/private-records")
    async def private_records(building_id: uuid.UUID) -> dict[str, str]:
        return {}

    async def ws(websocket: object) -> None:
        return None

    test_app = _app_with(
        Mount("/", app=legacy),
        Mount("/static", app=FastAPI()),
        Host("api.example.com", app=legacy),
        WebSocketRoute("/ws", endpoint=ws),
    )

    assert opaque_routes(test_app) == [
        "Mount /",
        "Mount /static",
        "Host /",
        "WebSocketRoute /ws",
    ]


def test_meta_mount_or_plain_route_under_api_is_reported():
    test_app = _app_with(
        Mount("/api/legacy", app=FastAPI()), Route("/api/raw", endpoint=lambda r: None)
    )

    assert opaque_routes(test_app) == ["Mount /api/legacy", "Route /api/raw"]


def test_meta_stale_allowlist_entry_is_reported(monkeypatch):
    monkeypatch.setattr(
        "tests.test_architecture.AUTH_ALLOWLIST",
        AUTH_ALLOWLIST | {("POST", "/api/auth/no-such-route")},
    )

    assert stale_allowlist_entries(app) == ["POST /api/auth/no-such-route"]


def test_meta_commit_outside_a_service_is_reported(tmp_path, monkeypatch):
    # The helper check has its own meta-tests; this tree has no audit/service.py.
    monkeypatch.setattr("tests.test_architecture.NON_COMMITTING_HELPERS", {})
    for name, code in {
        "packages/service.py": "await db.commit()",
        "packages/router.py": "await db.commit()",
        "core/helpers.py": "session.commit()",
        "cli.py": "await db.commit()",
        "jobs/worker.py": "await db.commit()",
        "notices/router.py": "# no commits here; READ COMMITTED isolation",
        # Neighbours of `.commit(` that also commit (Claude review round 1, L4):
        "units/router.py": "save = db.commit",
        "files/router.py": 'await db.execute(text("COMMIT"))',
        "moves/router.py": "async with db.begin():",
        "moves/service.py": "async with db.begin():",
        # Lower-case SQL and AUTOCOMMIT (P2-07 criterion 4):
        "raw/lower.py": 'await db.execute(text("commit"))',
        "raw/semicolon.py": "await db.execute(text('COMMIT;'))",
        "raw/triple.py": 'await db.execute(text("""\n    commit;\n"""))',
        "raw/isolation.py": 'engine = create_async_engine(url, isolation_level="AUTOCOMMIT")',
        "raw/options.py": "conn.execution_options(isolation_level='autocommit')",
        # Not commits: a session keyword, the word in comments and in an isolation level's name.
        "ok/keyword.py": "sessionmaker(autocommit=False, expire_on_commit=False)",
        "ok/comment.py": "# its refresh commits; (commit 2153) caller commits\nREAD_COMMITTED=1",
    }.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(code)

    assert files_that_commit(tmp_path) == [
        "core/helpers.py",
        "files/router.py",
        "moves/router.py",
        "packages/router.py",
        "raw/isolation.py",
        "raw/lower.py",
        "raw/options.py",
        "raw/semicolon.py",
        "raw/triple.py",
        "units/router.py",
    ]


def test_meta_commit_inside_a_non_committing_helper_is_reported(tmp_path, monkeypatch):
    """`record_audit` lives in a service module, which may commit; its body may not (P2-04 M2)."""
    monkeypatch.setattr(
        "tests.test_architecture.NON_COMMITTING_HELPERS",
        {"audit/service.py": ("record_audit", "other_helper")},
    )
    (tmp_path / "audit").mkdir()
    (tmp_path / "audit/service.py").write_text(
        "async def record_audit(db):\n"
        "    db.add(1)\n"
        "    await db.commit()\n"
        "\n"
        "async def other_helper(db):\n"
        "    db.add(1)\n"
        "\n"
        "async def use_case(db):\n"
        "    await record_audit(db)\n"
        "    await db.commit()\n"
    )

    assert files_that_commit(tmp_path) == ["audit/service.py::record_audit"]


def test_meta_helper_is_the_module_level_function(tmp_path, monkeypatch):
    """A method of the same name neither hides a committing helper nor stands in for a missing one
    (Codex review round 2)."""
    monkeypatch.setattr(
        "tests.test_architecture.NON_COMMITTING_HELPERS",
        {"shadowed/service.py": ("record_audit",), "stale/service.py": ("record_audit",)},
    )
    method = "class Recorder:\n    def record_audit(self):\n        return None\n"
    for name, code in {
        "shadowed/service.py": "async def record_audit(db):\n    await db.commit()\n\n" + method,
        "stale/service.py": method,
    }.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(code)

    assert files_that_commit(tmp_path) == [
        "shadowed/service.py::record_audit",
        "stale/service.py::record_audit: no such function",
    ]


def test_meta_stale_non_committing_helper_is_reported(tmp_path, monkeypatch):
    monkeypatch.setattr(
        "tests.test_architecture.NON_COMMITTING_HELPERS",
        {"audit/service.py": ("record_audit",), "jobs/service.py": ("enqueue",)},
    )
    (tmp_path / "audit").mkdir()
    (tmp_path / "audit/service.py").write_text("async def renamed_record_audit(db):\n    pass\n")

    assert files_that_commit(tmp_path) == [
        "audit/service.py::record_audit: no such function",
        "jobs/service.py::enqueue: no such file",
    ]


def test_meta_audit_event_update_or_delete_is_reported(tmp_path):
    for name, code in {
        "audit/service.py": "await db.execute(update(AuditEvent).values(action='x'))",
        "audit/purge.py": "await db.execute(sa.delete( AuditEvent).where(AuditEvent.id == i))",
        "core/table.py": "await db.execute(AuditEvent.__table__.update().values(action='x'))",
        "core/table2.py": "await db.execute(AuditEvent.__table__.delete())",
        "core/legacy.py": "session.query(AuditEvent).filter_by(id=i).delete()",
        "core/raw.py": "await db.execute(text(\"Update audit_events SET action = 'x'\"))",
        "core/raw2.py": 'await db.execute(text("DELETE FROM audit_events"))',
        "core/raw3.py": "op.execute('delete from \"audit_events\" where true')",
        "core/raw4.py": 'await db.execute(text("TRUNCATE sessions, audit_events"))',
        # Not mutations: inserting, reading, and names that only contain the words.
        "audit/ok.py": "db.add(AuditEvent(action='x'))\nselect(AuditEvent)\nrecord_audit_events()",
        "auth/ok.py": "await db.execute(update(AuthSession).values(revoked_at=now))",
    }.items():
        (tmp_path / name).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / name).write_text(code)

    reported = files_that_mutate_audit_events(tmp_path)

    assert [line.split(":")[0] for line in reported] == [
        "audit/purge.py",
        "audit/service.py",
        "core/legacy.py",
        "core/raw.py",
        "core/raw2.py",
        "core/raw3.py",
        "core/raw4.py",
        "core/table.py",
        "core/table2.py",
    ]


# Fitness test 6 (P4-05b, the pattern promoted from P3-04a and P4-05a): a control-character check
# on a stripped input string must run before the strip, or `"Rosa\n"` is stored as `"Rosa"`.


def _validators(annotation: Any, metadata: Iterable[Any] = ()) -> Iterator[Any]:
    """Every validator object in a field's metadata and, recursively, inside its annotation's
    `Annotated` and union members (`Tower` is `Annotated[Label | None, …]`)."""
    yield from metadata
    if get_origin(annotation) is Annotated:
        yield from _validators(get_args(annotation)[0], annotation.__metadata__)
    else:
        for arg in get_args(annotation):
            yield from _validators(arg)


def _subclasses[T](cls: type[T]) -> Iterator[type[T]]:
    for sub in cls.__subclasses__():
        yield sub
        yield from _subclasses(sub)


def printable_after_strip(models: Iterable[type[BaseModel]]) -> list[str]:
    """Fields of the given models whose `printable` check is an `AfterValidator`."""
    return sorted(
        f"{model.__name__}.{name}"
        for model in models
        for name, field in model.model_fields.items()
        if any(
            isinstance(v, AfterValidator) and v.func is printable
            for v in _validators(field.annotation, field.metadata)
        )
    )


def test_no_input_field_checks_control_characters_after_the_strip():
    assert printable_after_strip(_subclasses(InputModel)) == []


def test_the_check_sees_the_fields_checked_before_the_strip():
    """Not vacuous: the walk finds the before-strip check on today's fields, nested ones too."""
    found = {
        f"{model.__name__}.{name}"
        for model in _subclasses(InputModel)
        for name, field in model.model_fields.items()
        if any(
            isinstance(v, BeforeValidator) and v.func is printable_before_strip
            for v in _validators(field.annotation, field.metadata)
        )
    }
    assert {
        "UnitCreate.label",
        "UnitCreate.tower",
        "SignupIn.full_name",
        "BootstrapInput.name",
        "OnboardingDecisionIn.reason",
    } <= found


def test_meta_printable_after_the_strip_is_reported():
    # A plain BaseModel, not an InputModel subclass: the real check above must not see it.
    class Bad(BaseModel):
        model_config = ConfigDict(str_strip_whitespace=True)

        name: Annotated[str, AfterValidator(printable)]
        tower: Annotated[Annotated[str, AfterValidator(printable)] | None, Field()] = None

    assert printable_after_strip([Bad]) == ["Bad.name", "Bad.tower"]
