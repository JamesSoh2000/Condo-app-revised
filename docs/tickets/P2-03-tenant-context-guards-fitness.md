# P2-03 — Tenant context, guards and fitness tests

| Field | Value |
|---|---|
| Phase / lane | P2 / A |
| Risk tier | 1 |
| Depends on | P2-02, P1-05 |
| Replaces old | M3-T04, M3-T09 (read API), M3-T10 (backend part), M2-T07 (HTTP helpers) |
| Status | done |

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

## Carried from P2-02 (decide while framing)

- Review round 1 Low 1 (PR #58): nothing in `backend/app` sets `Cache-Control`. Authenticated API responses
  (`/api/auth/me`, `/api/auth/sessions`, and every building route this ticket adds) should send
  `Cache-Control: no-store`, so a browser or proxy cache can't keep a user's data after logout. One place for
  all of them (a middleware or the building router), with a test, rather than per route.
- From the P2-01b step 8 note (`docs/AGENT_MISTAKES_LOG.md`): `make check`'s ruff steps should run with
  `--no-cache`, so a stale `.ruff_cache` can't hide a lint error locally (tightens a gate; P2-02 ran
  `ruff check --no-cache` by hand).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened (the numbered criteria above stay; these make them exact and add cases):
  - **1.** `a_manager`: 200 with exactly `{id, name: "Maple Court", slug: "maple", timezone, locale,
    my_roles: ["property_management"], features: ["maintenance", "notices", "packages"]}`. Both lists are
    sorted by value, as `/api/auth/me` sorts roles (D4). Also 200 for `a_security`, `a_resident1` and
    `a_council` (`["council", "resident"]`): the route has no role restriction (tenant row 1).
  - **2.** 404 `building_not_found` for `b_resident1` → A, a random building id, `a_pending` → A and
    `a_suspended` → A, **plus** (added) a `denied` and a `deactivated` membership in A, `no_membership` →
    A, and `a_manager` → A after A is set `is_active = false`. "Identical body" means identical except
    `request_id` (which differs per request by design); content type `application/problem+json` for all.
  - **2b (added).** No session cookie → 401 `not_authenticated` on the building route (authentication is
    checked before tenancy; tenant row 2). An authenticated caller with a building id that isn't a UUID
    gets 422 `validation_error`, not a 500.
  - **3.** Test route under `building_router()` with `require_roles(Role.PROPERTY_MANAGEMENT)`: `a_security`
    → 403 `forbidden_role`; `a_manager` → 200; `b_manager` → 404 `building_not_found` (tenancy runs
    before the role check, so another building's manager learns nothing). `require_roles()` with no roles
    raises `ValueError` when the route is declared.
  - **4.** `require_feature(Feature.MAINTENANCE)`: 403 `feature_disabled` when A's row has
    `enabled = false` **and** (added) when A has no row for the feature at all; 200 when enabled.
  - **5.** Same session cookie, two requests: `a_manager` gets 200 on the `require_roles(property_management)`
    route, the role row is deleted in the DB, the second request gets 403 `forbidden_role`. Added: the
    membership set to `suspended` between two requests → 404; the feature disabled between two requests →
    403 `feature_disabled`. Nothing about the membership is cached in the session.
  - **6.** `multi` with one session: `GET /api/buildings/{A}` has `my_roles ["resident"]`,
    `GET /api/buildings/{B}` has `["security"]`; the A test route with `require_roles(security)` is 403 and
    the B one is 200.
  - **7.** Fitness tests in `tests/test_architecture.py`, each a function over an app (or a source tree)
    that returns the violations, so the meta-tests can run it on a test app:
    1. every route whose path starts with `/api/buildings/` starts with `/api/buildings/{building_id}`
       and has `get_tenant_context` or `get_own_membership` in its dependency tree (recursive walk of
       `route.dependant`); **added:** no route outside that prefix depends on either (there, `building_id`
       would silently become a query parameter); **added:** every route under `/api` is an `APIRoute`
       except FastAPI's own docs routes (a `Mount` or plain Starlette route has no `dependant` to walk);
    2. every `/api/*` route has `get_current_user` or `get_current_session` in its tree unless its
       `(method, path)` is in `AUTH_ALLOWLIST` (`app/auth/allowlist.py`); **added:** every allowlist entry
       names a route that exists (D1);
    3. parametrized over every route under the building prefix of the real app, as `b_resident1` with
       building A and random UUIDs for the other path parameters: 404 `building_not_found` (body `{}` for
       unsafe methods). **Added:** the same routes without a session → 401 `not_authenticated`;
    4. `.commit(` appears only in `app/**/service.py`, `app/cli.py`, `app/seed.py`, `app/worker.py`,
       `app/jobs/worker.py`.
    - Meta-tests: an unguarded route under the building prefix makes 1 fail; an unauthenticated
      non-allowlisted route makes 2 fail; a route outside the prefix using `get_tenant_context`, a `Mount`
      under `/api`, a stale allowlist entry and a `.commit(` in a non-service file each make their check
      fail.
  - **8 (added).** `get_own_membership` (test route): returns the membership row for `pending`, `active`,
    `suspended` and `denied`; 404 `building_not_found` (same body) for `deactivated`, non-members, an
    inactive building (D3) and a random id; 401 without a session.
  - **9 (added).** One query: a request to a route with the router guard **plus** `require_roles` and
    `require_feature` runs exactly one SQL statement that reads `building_memberships` (FastAPI's
    per-request dependency cache), and that statement also returns the roles and enabled features.
  - **10 (added).** Logging: the `request_completed` log line of a building request carries `building_id`
    and `user_id`, so does a log emitted inside the endpoint; the next, non-building request's line has
    neither.
  - **11 (added, carried from P2-02).** Every `/api` response (200, 401, 404 problem+json, health) has
    `Cache-Control: no-store` unless the route set its own `Cache-Control` (D5).
  - Tenant table (ENGINEERING_PRACTICES §7) for `GET /api/buildings/{id}`: row 1 → criterion 1; row 2 →
    2b; row 3 → 2 (`b_resident1`) and 6 (`multi`); row 4 → n/a (any role may read its building) but the
    guard itself is 3; row 6 → 2; rows 5, 7–10 → n/a (no record, no body, no state change).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **D1** (autonomous, stricter than the ticket): `AUTH_ALLOWLIST` lists only routes that exist today
    (health, ready, version, login, logout). Password reset, invitations, join-code lookup and signup are
    added by the tickets that build them (P4-02, P4-04, P4-05); a fitness check fails on an entry with no
    route, so the list can't pre-approve a path nobody reviewed.
  - **D2** (ticket + autonomous): fitness test 1 also rejects tenant guards outside the prefix and non-`APIRoute`
    routes under `/api` (criterion 7), the two ways a route could escape the dependency walk.
  - **D3** (autonomous): `get_own_membership` refuses an inactive building (404) as `get_tenant_context`
    does, consistent with P2-02 D1 (`/me` leaves inactive buildings out).
  - **D4** (convention): `my_roles` and `features` sorted by value, like `/me`'s roles.
  - **D5** (carried from P2-02): `Cache-Control: no-store` set in one place, a small ASGI middleware for
    every `/api` response that has no `Cache-Control` of its own. The 500 that Starlette's outermost error
    middleware writes is outside it (follow-up note, not a gap in the success path).
  - **D6** (ticket): the guard stores `building_id`/`user_id` on `request.state` (read by the request log
    middleware, which runs in another task) and in context variables read by the JSON log formatter.
  - **D7** (ARCHITECTURE §7 "one query"): roles and enabled features are aggregated by correlated
    `ARRAY(SELECT …)` subqueries in the same statement as the membership/building check.
  - **Carried from P1-05:** L5 (`assert_integrity_error` takes a `Coroutine`) and L6 (the scratch
    database is recreated inside the `try`) are taken. The per-run name for `condo_test` and adding
    `tests/` to mypy (123 errors today in 13 files) move to a new Tier 3 ticket **P2-07** "Test
    infrastructure hardening", added to the index in this ticket's bookkeeping commit. Until then
    concurrent suites (reviewers) pass distinct `TEST_DATABASE_URL`s.
  - **Carried from P2-02:** `Cache-Control` taken (D5, criterion 11); `ruff --no-cache` in `make lint`
    taken (tightens a gate).
- Split: none. Estimate ~340 non-test lines (tenancy package ~160, buildings endpoint ~65, allowlist ~30,
  middleware and logging ~45, Makefile and docs ~40), under the ~400 limit.
