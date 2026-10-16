# P2-03 — Tenant context, guards and fitness tests

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-02, P1-05 |
| Replaces old | M3-T04, M3-T09 (read API), M3-T10 (backend part), M2-T07 (HTTP helpers) |
| Status | todo |

## Goal

Every building-scoped endpoint automatically resolves and enforces the caller's active membership. Role and
feature guards exist, and CI fails if any future endpoint skips tenancy or auth.

## Why

This is the most important security mechanism in the system
([ADR-0004](../adr/0004-path-scoped-tenancy.md)). The fitness tests mean a rushed future change (human or
agent) cannot silently bypass it.

## Scope

- In:
  - **`app/tenancy/context.py`:** a frozen `TenantContext` dataclass (`user_id`, `building_id`,
    `membership_id`, `roles: frozenset[Role]`, `features: frozenset[Feature]`) with `has_any(*roles)` and
    `is_staff`.
  - **`app/tenancy/deps.py`:**
    - **`get_tenant_context(building_id: UUID, user=Depends(get_current_user), db=...)`:**
      - one query: membership `status='active'`, building `is_active`, roles aggregated, enabled features
        aggregated
      - otherwise **404** `building_not_found`, with the same body for "does not exist", "not a member",
        "pending/suspended/denied" and "building inactive"
      - stores `building_id` and `user_id` on `request.state` and in the logging context
    - **`require_roles(*roles)`:** a dependency factory giving 403 `forbidden_role`.
    - **`require_feature(feature)`:** 403 `feature_disabled`.
    - **`get_own_membership(building_id, ...)`:** for onboarding only. Allows any non-deactivated status, and
      returns the membership row, not a `TenantContext`.
  - **`app/tenancy/router.py`:** `building_router()` returns an `APIRouter(prefix="/api/buildings/{building_id}",
    dependencies=[Depends(get_tenant_context)])`. Every feature router is built from it.
  - **First endpoint:** `GET /api/buildings/{building_id}` returns `{id, name, slug, timezone, locale,
    my_roles, features}`. It replaces the old `/buildings/me/features`.
  - **Fitness tests** (`tests/test_architecture.py`):
    1. Every route whose path starts with `/api/buildings/{building_id}` has `get_tenant_context` **or**
       `get_own_membership` in its dependency tree (walk `route.dependant` recursively).
    2. Every `/api/*` route has `get_current_user` or `get_current_session` in its tree, **unless** it is in
       the explicit `AUTH_ALLOWLIST` (health, ready, version, login, logout, password-reset request/confirm,
       invitation get/accept, join-code lookup, signup). The allowlist lives in one place, in
       `app/auth/allowlist.py`.
    3. **Parametrized:** for every route under the building prefix, call it as `b_resident1` with
       `building_id` = building A and random UUIDs for the other path params, and expect **404** (an empty
       JSON body for unsafe methods).
    4. `.commit(` appears only in `app/**/service.py`, `app/cli.py`, `app/seed.py`, `app/worker.py` and
       `app/jobs/worker.py` (source grep).
    - **Meta-test:** registering an unguarded route in a test app makes tests 1 and 2 fail.
  - **HTTP helpers** (`tests/helpers/tenancy.py`):
    - `as_user(user) -> AsyncClient`, logged in
    - `assert_cross_building_404(...)`, `assert_forbidden_role(...)`, `assert_not_visible(...)`
  - Document the 10-case pattern with examples in `tests/README.md`.
- Out:
  - feature configuration endpoints (later)
  - council "view as" presentation (frontend only, P2-06; never a backend role change)

## Interfaces

Dependencies above, plus `GET /api/buildings/{building_id}` (`buildings_get`).

## Acceptance criteria

1. **Given** `a_manager`, **when** `GET /api/buildings/{A}`, **then** 200 with `my_roles=["property_management"]`
   and the 3 features.
2. **Given** `b_resident1` → A, a nonexistent building ID, `a_pending` → A, or `a_suspended` → A, **then** all
   get 404 with an identical body.
3. **Given** a test route with `require_roles(property_management)`, **when** `a_security` calls it, **then**
   403 `forbidden_role`.
4. **Given** the `maintenance` feature is disabled for A, **when** calling a test route with
   `require_feature(maintenance)`, **then** 403 `feature_disabled`.
5. **Given** `a_manager`'s role is removed in the DB between two requests with the same session, **then** the
   second request reflects it (403).
6. **Given** `multi`, **then** A routes see the resident roles and B routes see the security role, within the
   same session.
7. The fitness tests pass on the codebase, and the meta-test proves they fail on an unguarded route.

## Test plan

- `tests/tenancy/test_context.py` (criteria 1–6)
- `tests/test_architecture.py` (criterion 7)
- Commands: `make test`

## Likely files

`backend/app/tenancy/{context,deps,router}.py`, `backend/app/buildings/{router,schemas,service}.py`,
`backend/app/auth/allowlist.py`, `backend/app/main.py`, `backend/tests/test_architecture.py`,
`backend/tests/helpers/tenancy.py`, `backend/tests/README.md`.

## Must explain (learning checkpoint)

1. Why is the building ID in the URL safe, even though "never trust the client" is a rule?
2. Why does a pending member get 404 on operational routes, and how do onboarding routes still work?
3. How does fitness test #1 walk FastAPI's dependency tree? What would make it miss a route?
4. Why does a role change apply on the next request, with no logout needed?

## Carried from P1-05 (decide while framing)

Test-infrastructure follow-ups from PR #50 (P1-05); take in scope or move each to a named ticket:
- `condo_test` is one per server: two concurrent full suites (worktrees, reviewers) drop each other's schema.
  Give the session test database a per-run name too (Makefile, CI, `tests/conftest.py`), keeping the `_test`
  guard, or keep passing distinct `TEST_DATABASE_URL`s.
- Review round 2 L5: type `tests/helpers/db.py::assert_integrity_error`'s parameter as `Coroutine` (or assert
  `inspect.iscoroutine`), so a pre-scheduled task can't run outside the savepoint.
- Review round 2 L6: in `tests/conftest.py::scratch_database_url`, recreate inside the `try`, so a failed setup
  still drops the scratch database. Round 1 L3 (accepted): the name is per PID, so containers with equal PIDs
  sharing one server would collide.
- `make check` runs mypy on `app/` only; the P1-05 test modules pass it when named explicitly. Adding
  `tests/` to the gate tightens it.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
