# Explanation — P2-03 Tenant context, guards and fitness tests

> **PR:** #59 · **Source revision:** `9951896`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 59 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> contains `origin/main` (`9d6c7df`).
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `9951896` the diff (`git diff origin/main...HEAD`, 26 files), the whole of
> `backend/app/tenancy/{deps,context,router}.py`, `backend/app/buildings/{router,service}.py`,
> `backend/app/middleware/cache_control.py`, `backend/app/auth/allowlist.py`, the diffs of `backend/app/main.py`,
> `backend/app/logging_config.py` and `backend/app/middleware/request_logging.py`, the check functions of
> `backend/tests/test_architecture.py`, and the assertions of the tests cited below. Ran
> `backend/tests/tenancy tests/test_architecture.py tests/test_cache_control.py tests/test_db_isolation.py`: **80
> passed**; the full backend suite: **706 passed**. The SQL in §3 was captured at this revision from a
> request by the world's `a_council` (a scratch test with a `before_cursor_execute` listener, deleted
> afterwards). Mutation results are quoted from the PR (run at `8f0a1a1` and `9951896`), not re-run for this
> text. Differences from the plan: two deliberate ones, both in the PR (§2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A (`GET /api/buildings/{building_id}`).

## 1. What was built and why

Until now no endpoint was building-scoped. This ticket builds the mechanism every later building feature
(packages, notices, units, files) sits on ([ADR-0004](../adr/0004-path-scoped-tenancy.md)):

- **`get_tenant_context`**: on every request under `/api/buildings/{building_id}`, one query checks the
  caller's **active** membership in that building (and that the building is active), and returns a frozen
  `TenantContext` with the membership's roles and the building's enabled features. Anything else is one
  identical 404 `building_not_found`.
- **`require_roles(...)` / `require_feature(...)`** (403 `forbidden_role` / `feature_disabled`),
  **`get_own_membership`** (onboarding: any status but deactivated) and **`building_router()`**, the only way
  to declare building routes.
- The first building endpoint, **`GET /api/buildings/{building_id}`**.
- **Fitness tests** that fail CI when a future route skips tenancy or authentication, commits outside a
  service, or hides behind a mount. Each check is proved to fail by a meta-test.
- Also: `Cache-Control: no-store` on every `/api` response, `building_id`/`user_id` in log lines, tenant test
  helpers (`as_user`, `assert_cross_building_404`, …).

The decisions that matter most: the auth allowlist holds only routes that exist (D1), and the fitness checks
also close the ways a route could slip past the dependency walk (D2, tightened by review round 1).

## 2. Decisions

### D1. The auth allowlist names only routes that exist; a stale entry fails

- **Problem or constraint:** the ticket lists future open routes (password reset, invitations, join-code
  lookup, signup) for the allowlist. Listing paths that don't exist pre-approves whatever a later ticket
  puts there.
- **Chosen:** `backend/app/auth/allowlist.py::AUTH_ALLOWLIST` holds `(method, path)` pairs for the five open
  routes that exist (health, ready, version, login, logout).
  `backend/tests/test_architecture.py::stale_allowlist_entries` fails on an entry with no route.
- **Alternatives rejected:** the ticket's full list, by path only: pre-approval, and a path-only match would
  open every method on that path.
- **Tradeoffs and accepted limitations:** P4-02, P4-04 and P4-05 must each add their entries; the fitness
  test tells them.
- **Basis:** autonomous, stricter than the ticket (Frame notes D1).
- **Source:** recorded (PR #59 D1).

### D2. The fitness checks close the ways a route could escape the dependency walk

- **Problem or constraint:** the walk over `route.dependant` only sees FastAPI `APIRoute`s. A route outside
  the prefix that depends on `get_tenant_context` gets `building_id` as a **query** parameter, silently.
- **Chosen:**
  - (a) under `/api/buildings/` the path must start with `/api/buildings/{building_id}` (exact parameter
    name) and have a tenant guard in its tree;
  - (b) no route outside that prefix depends on a tenant guard;
  - (c) every route of the app is an `APIRoute`, except FastAPI's docs routes
    (`backend/tests/test_architecture.py::opaque_routes`).
- **Alternatives rejected:** only the ticket's prefix check, which misses all three escapes. For (c), the
  first version reported only non-`APIRoute`s whose own path was under `/api`; review round 1 showed a
  sub-app mounted at `/` escaped it (§6).
- **Tradeoffs and accepted limitations:** a future non-tenant `/api/buildings/...` route (a platform admin
  list) would need the check changed (ADR-0004 "Revisit when"). Checks 1 and 2 still walk only `/api`
  routes (review round 2 L1, moved to P2-07).
- **Basis:** ticket + autonomous; review finding (round 1, Medium).
- **Source:** recorded (PR D2, review log).

### D3. `get_own_membership` refuses inactive buildings

- **Problem or constraint:** the ticket says "any non-deactivated status" and doesn't mention inactive
  buildings.
- **Chosen:** 404 `building_not_found`, the same body, as `get_tenant_context` gives.
- **Alternatives rejected:** allowing it: a pending applicant could keep onboarding into a closed building,
  and it would be inconsistent with P2-02 D1 (`/me` leaves inactive buildings out).
- **Tradeoffs and accepted limitations:** a pending user of a building that closes sees a 404, not "closed".
- **Basis:** autonomous (consistency with P2-02 D1).
- **Source:** recorded (PR D3).

### D5. `Cache-Control: no-store` in one ASGI middleware

- **Problem or constraint:** P2-02 review L1: nothing set `Cache-Control`, so a browser or proxy could keep
  `/me` or building data after logout. Caddy sets cache headers for the SPA only.
- **Chosen:** `backend/app/middleware/cache_control.py::NoStoreMiddleware`, added last in `create_app` so it
  runs first, `setdefault`s `no-store` on every `/api` and `/api/...` response start. It doesn't touch
  non-API paths.
- **Alternatives rejected:** on the building router only (misses `/api/auth/*` and the 401/404 bodies); per
  route (easy to forget).
- **Tradeoffs and accepted limitations:** health and version get it too (harmless). The 500 that Starlette's
  outermost `ServerErrorMiddleware` writes is outside it and has no header.
- **Basis:** carried from P2-02. **Source:** recorded (PR D5).

### D6. Building and user in logs: `request.state` plus context variables, cleared per request

- **Problem or constraint:** the ticket wants the ids "on `request.state` and in the logging context". The
  `request_completed` line is written by `RequestLoggingMiddleware`, a `BaseHTTPMiddleware` whose
  `call_next` runs the endpoint in another task, so a context variable set in a dependency is invisible to
  it.
- **Chosen:**
  - `get_tenant_context` sets `request.state.user_id` before the membership check and
    `request.state.building_id` after it; the middleware copies both into its log line.
  - It also sets `user_id_ctx` and `building_id_ctx`, which `JsonFormatter` adds to every other line of the
    request.
  - The middleware sets both variables to `None` at the start of each request and resets them in `finally`.
- **Alternatives rejected:**
  - Context variables alone: the request line wouldn't carry the ids.
  - No reset: during implementation `test_building_request_logs_carry_building_and_user` failed because a
    value set by an earlier test's direct call reached a later `/api/auth/me` line. Production with one task
    per request was likely safe, but the code shouldn't depend on that.
- **Tradeoffs and accepted limitations:** a direct call outside any request (a script) sets them in its own
  context.
- **Basis:** ticket; test result. **Source:** recorded (PR D6). Logging `user_id` on refusals was a
  deviation from the plan, recorded in the PR: the stack run showed a 404 line that didn't say who tried.

### D7. One query, with `ARRAY(SELECT …)` subqueries

- **Problem or constraint:** ARCHITECTURE §7: membership, roles and enabled features in one query.
- **Chosen:** correlated `ARRAY(SELECT role::text …)` and `ARRAY(SELECT feature::text … enabled IS true)` in
  the membership/building query (§3), parsed into the enums in Python. An empty array, not NULL, when
  nothing matches.
- **Alternatives rejected:** `array_agg` with `GROUP BY` (NULL for no rows, and the joins multiply roles by
  features); three queries.
- **Tradeoffs and accepted limitations:** none known.
- **Basis:** ARCHITECTURE §7. **Source:** recorded (PR D7).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D4. `my_roles`, `features` sorted by value | database order | `/me` sorts roles by value | convention | PR D4 |
| An active membership with **no roles** still gets a context (`my_roles: []`) | 404 | ADR-0004 keys access on an active membership; every `require_roles` route still 403s | ADR-0004 | PR smaller decisions; review round 1 L2 |
| `require_roles()` with no roles raises `ValueError` at declaration | always-403 route | a mistake would lock a route silently | autonomous | PR |
| A feature with no `building_features` row is disabled | enabled by default | "enabled features" are rows in the table | ADR-0004 | PR |
| Non-UUID `building_id` → 422 | 404 | FastAPI path typing; reveals nothing | convention | PR |
| `as_user` opens a new client per user | switching cookies on one client | a test can hold several users | autonomous | PR |
| P1-05 L5, L6 taken; per-run `condo_test` and `mypy tests/` → P2-07 | take all | `mypy tests/` has 123 errors today | autonomous | PR, Frame notes |

**Framing changes:** criteria 1–6 sharpened (exact bodies; criterion 2 extended to denied, deactivated,
`no_membership` and an inactive building, with "identical" meaning identical except `request_id`), and
criteria 2b, 8, 9, 10 and 11 added, plus the extra fitness checks of D2. Nothing loosened (ticket Frame
notes, commit `649d228`).

**Plan versus final code:** compared with the PR's Plan. Two deliberate deviations, both listed in the PR
below the Plan:
- `user_id` is logged on refused requests too (D6).
- `request_failed` lines also carry the ids (not separately tested).

Review rounds widened `opaque_routes` to the whole app (round 1, Medium) and the commit grep (round 1, L4).
Nothing contradicts a recorded decision.

## 3. How it is implemented

### Overview

- `backend/app/tenancy/router.py::building_router` returns an `APIRouter` with the building prefix and the
  router-level dependency `get_tenant_context`. Feature routers are built from it and included without a
  prefix (`backend/app/main.py::create_app`).
- `backend/app/tenancy/deps.py::get_tenant_context` depends on `get_current_user` (the session), runs one
  query and returns `TenantContext` or raises `BuildingNotFound`.
- `require_roles`/`require_feature` are factories returning dependencies that take the context. FastAPI
  caches a dependency per request, so the router guard and each guard share one context and one query.
- `NoStoreMiddleware` and `RequestLoggingMiddleware` wrap every request; the latter clears and reads the log
  context.
- `backend/tests/test_architecture.py` inspects `app.routes` and the source tree.

### Walkthrough (variant A): `GET /api/buildings/{building_id}` as `a_council`

1. **HTTP:** the request goes through the middlewares outermost first: `NoStoreMiddleware`,
   `RequestLoggingMiddleware` (clears `building_id_ctx`/`user_id_ctx`), `CSRFMiddleware` (GET is safe), then
   the route `backend/app/buildings/router.py::get`.
2. **Dependencies:** FastAPI solves the router-level `get_tenant_context`. That solves
   `get_current_user` → `get_current_session` first: it resolves the cookie and refreshes activity, which may
   commit (`backend/app/auth/deps.py::get_current_session`). A non-UUID `building_id` is a 422; no cookie is
   a 401 `not_authenticated`.
3. **Tenant query:** `get_tenant_context` records `request.state.user_id`, then runs (captured at
   `9951896`):

   ```sql
   SELECT building_memberships.id,
     array((SELECT CAST(membership_roles.role AS TEXT) AS role FROM membership_roles
            WHERE membership_roles.membership_id = building_memberships.id)) AS roles,
     array((SELECT CAST(building_features.feature AS TEXT) AS feature FROM building_features
            WHERE building_features.building_id = buildings.id
              AND building_features.enabled IS true)) AS features
   FROM building_memberships JOIN buildings ON buildings.id = building_memberships.building_id
   WHERE building_memberships.building_id = $1::UUID AND building_memberships.user_id = $2::UUID
     AND building_memberships.status = $3 AND buildings.is_active
   -- ($1 = maple's id, $2 = a_council's user id, $3 = 'active')
   ```

   No row means 404 `building_not_found`. A row gives the context; `request.state.building_id` and
   `building_id_ctx` are set.
4. **Route:** the route's own `Depends(get_tenant_context)` gets the cached context, and
   `backend/app/buildings/service.py::get_building` runs
   `SELECT … FROM buildings WHERE buildings.id = $1`, filtered by `ctx.building_id`. It is read-only (no
   commit).
5. **Response:** `backend/app/buildings/schemas.py::BuildingOut` with `my_roles: ["council", "resident"]`
   and `features: ["maintenance", "notices", "packages"]`. `NoStoreMiddleware` adds
   `Cache-Control: no-store`, and the request log line carries `building_id` and `user_id`.

The whole request ran two statements before the tenant query (a savepoint in tests, and the session/user
lookup), then the tenant query and the building read.

### Data model changes

None. The query uses the existing primary keys of `membership_roles` and `building_features` and the unique
`(building_id, user_id)` on `building_memberships`.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/tenancy/deps.py` | guards: tenant context, roles, feature, own membership | +148 |
| `backend/app/tenancy/context.py`, `router.py` | `TenantContext`; `building_router` | +29, +15 |
| `backend/app/buildings/{router,schemas,service}.py` | `GET /api/buildings/{building_id}` | +23, +17, +24 |
| `backend/app/auth/allowlist.py` | `AUTH_ALLOWLIST` | +17 |
| `backend/app/middleware/cache_control.py` | `NoStoreMiddleware` | +24 |
| `backend/app/main.py`, `backend/app/logging_config.py`, `backend/app/middleware/request_logging.py` | wiring; log context | +7/−1, +11, +11/−1 |
| `backend/tests/test_architecture.py` | fitness tests and meta-tests | +343 |
| `backend/tests/tenancy/test_context.py`, `test_cache_control.py` | behaviour tests | +569, +52 |
| `backend/tests/helpers/tenancy.py`, `backend/tests/conftest.py`, `backend/tests/helpers/db.py` | tenant helpers, `as_user`, `app_client(prefix=)`, P1-05 L5/L6 | +55, +36/−5, +9/−3 |
| `backend/tests/README.md`, `docs/ARCHITECTURE.md`, `CLAUDE.md` | 10-case pattern; §7 fitness list; markers | docs |
| `Makefile` | `ruff --no-cache` | +2/−2 |
| `frontend/src/api/schema.d.ts`, `client.test.ts` | regenerated types; exact path set | +98, +6/−1 |

`backend/app/tenancy/deps.py::get_tenant_context`

```python
async def get_tenant_context(
    request: Request, building_id: UUID, user: CurrentUser, db: DbSession
) -> TenantContext:
    # ...
    request.state.user_id = user.id
    user_id_ctx.set(str(user.id))
    row = (
        await db.execute(
            select(
                BuildingMembership.id,
                _text_array(
                    MembershipRole.role, MembershipRole.membership_id == BuildingMembership.id
                ).label("roles"),
                _text_array(
                    BuildingFeature.feature,
                    BuildingFeature.building_id == Building.id,
                    BuildingFeature.enabled.is_(True),
                ).label("features"),
            )
            .join(Building, Building.id == BuildingMembership.building_id)
            .where(
                BuildingMembership.building_id == building_id,
                BuildingMembership.user_id == user.id,
                BuildingMembership.status == MembershipStatus.ACTIVE,
                Building.is_active,
            )
        )
    ).one_or_none()
    if row is None:
        raise _not_found()
    request.state.building_id = building_id
    building_id_ctx.set(str(building_id))
    return TenantContext(
        user_id=user.id,
        building_id=building_id,
        membership_id=row.id,
        roles=frozenset(Role(r) for r in row.roles),
        features=frozenset(Feature(f) for f in row.features),
    )
```

- One query decides "may this user act in this building now". Every refusal goes through `_not_found()`, so
  the body can't differ between cases (D7, ADR-0004).
- Each `WHERE` line is load-bearing. The PR's mutations:
  - dropping `user_id` → 22 tests failed;
  - dropping `status == ACTIVE` → 2 failed;
  - dropping `is_active` → 1 failed;
  - dropping the `enabled` filter → 3 failed;
  - dropping the feature correlation → 5 failed (round 1 added `test_features_are_the_url_buildings_own`);
  - review round 2 dropped the `building_id` filter on a scratch copy → 8 failed.
- Nothing is cached between requests, so a role, status or feature change applies to the next request.

`backend/app/tenancy/deps.py::require_roles`

```python
def require_roles(*roles: Role) -> Callable[[TenantContext], Awaitable[TenantContext]]:
    if not roles:
        raise ValueError("require_roles needs at least one role")

    async def has_role(ctx: Ctx) -> TenantContext:
        if not ctx.has_any(*roles):
            raise ForbiddenRole(detail="Your role in this building does not allow this.")
        return ctx

    return has_role
```

- It depends on the context, so tenancy runs first: another building's manager gets the 404, not a 403
  (`test_another_buildings_manager_gets_404_not_403_on_a_role_route`). `require_feature` has the same shape.

`backend/app/tenancy/router.py::building_router`

```python
def building_router(*, tags: list[str | Enum]) -> APIRouter:
    return APIRouter(prefix=BUILDING_PREFIX, tags=tags, dependencies=[Depends(get_tenant_context)])
```

- The router-level dependency protects a route even if it never asks for the context. The first mutation
  run showed no test proved that, because every route also took `ctx` as a parameter; hence
  `test_building_router_guards_a_route_that_never_asks_for_the_context`.

`backend/tests/test_architecture.py::dependency_calls` and `unguarded_building_routes`

```python
def dependency_calls(dependant: Dependant) -> Iterator[Callable[..., Any]]:
    for sub in dependant.dependencies:
        if sub.call is not None:
            yield sub.call
        yield from dependency_calls(sub)

def unguarded_building_routes(application: FastAPI) -> list[str]:
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
```

- `route.dependant.dependencies` holds router-level, decorator-level and parameter dependencies, each with
  its own sub-dependencies, so the recursion finds `get_tenant_context` under `require_roles` or a custom
  dependency (`test_meta_guard_deep_in_the_tree_counts`).
- Every check returns violations rather than asserting, so the meta-tests run it on a test app with a bad
  route and assert the exact message.

`backend/app/middleware/cache_control.py::NoStoreMiddleware`

```python
        async def send_no_store(message: Message) -> None:
            if message["type"] == "http.response.start":
                headers = MutableHeaders(scope=message)
                headers.setdefault("Cache-Control", "no-store")
            await send(message)
```

- It edits the response-start message, so it covers every response our app sends, including the CSRF 403
  and the problem bodies; `setdefault` keeps a route's own header (D5).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A member of B reads A | 404 `building_not_found` | `test_every_caller_without_an_active_membership_gets_the_same_404`; `test_another_buildings_member_gets_404_on_every_building_route[...]` |
| Pending, suspended, denied, deactivated, no membership, random id → different answers | One body except `request_id` | `test_every_caller_without_an_active_membership_gets_the_same_404` (compares 7 bodies) |
| Inactive building | 404, the same body | `test_inactive_building_is_a_404_even_for_its_manager` |
| No session | 401 before any tenancy check | `test_building_route_without_a_session_is_401`, `test_every_building_route_without_a_session_is_401[...]` |
| Non-UUID id | 422 | `test_building_id_that_is_not_a_uuid_is_422` |
| Wrong role / other building's manager | 403 / 404 | `test_wrong_role_gets_403_forbidden_role`, `test_another_buildings_manager_gets_404_not_403_on_a_role_route` |
| Feature disabled, or no row | 403 `feature_disabled` | `test_disabled_feature_gets_403_feature_disabled`, `test_feature_without_a_row_is_disabled` |
| Another building's features leak in | correlated on `buildings.id` | `test_features_are_the_url_buildings_own` |
| Role removed, suspended, feature disabled mid-session | applies next request | `test_role_removed_between_requests_…`, `test_membership_suspended_between_requests_…`, `test_feature_disabled_between_requests_…` |
| `multi` gets the wrong membership's roles | per-URL membership | `test_multi_building_user_gets_each_buildings_own_roles` |
| Onboarding dependency too wide or too narrow | any status but deactivated; inactive building 404 | `test_own_membership_allows_every_status_but_deactivated[...]`, `test_own_membership_refuses_deactivated_non_members_and_inactive_buildings`, `test_own_membership_without_a_session_is_401` |
| Guards multiply queries | one tenant statement per request | `test_tenant_context_is_one_query_even_with_role_and_feature_guards` |
| Log context leaks between requests | reset per request | `test_building_request_logs_carry_building_and_user` (stale values set first), `test_refused_building_request_logs_the_user_but_not_the_building` |
| Cached API response | `no-store` on 200/401/403/404/422 | `test_api_responses_are_no_store`, `test_csrf_rejection_and_validation_error_are_no_store`, `test_a_route_that_sets_its_own_cache_control_keeps_it`, `test_non_api_paths_are_left_alone` |
| Unguarded route, unauthenticated route, mount, stale allowlist entry, commit in a router | fitness checks report it | the `test_meta_*` tests in `backend/tests/test_architecture.py` |
| `request_failed` lines carry the ids | copied from `request.state` | **No test** (§7) |

Acceptance criteria → tests:
1. `test_active_member_gets_their_building_with_roles_and_features[…]`
2. `test_every_caller_without_an_active_membership_gets_the_same_404`,
   `test_inactive_building_is_a_404_even_for_its_manager`
3. `test_wrong_role_gets_403_forbidden_role`
4. `test_disabled_feature_gets_403_feature_disabled`
5. `test_role_removed_between_requests_applies_to_the_next_request`
6. `test_multi_building_user_gets_each_buildings_own_roles`
7. `backend/tests/test_architecture.py`: the five checks on the real app, fitness test 3, and the meta-tests
8. the `test_own_membership_*` tests
9. `test_tenant_context_is_one_query_even_with_role_and_feature_guards`
10. the two logging tests
11. `backend/tests/test_cache_control.py`

The stack journey (worktree server, seeded scratch DB) is in the PR.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Claude Sonnet 5.5, fresh, with security pass | `8f0a1a1` | MERGE | Medium: root mount escapes the checks; Lows: L2 roleless membership, L3 `get_own_membership` not confined, L4 narrow commit grep, L5 `/api`-only walk, L6 log-test cleanup | Medium fixed `5e3e612`; L4, L6 fixed `9951896`; L2 → P4-06, L3 → P4-05, L5 no change |
| 1 | Codex `gpt-6-astra` medium | `8f0a1a1` | MERGE | Medium: root mount escapes the checks (proof test) | fixed `5e3e612` |
| 2 | Claude Sonnet 5.5, new, with security pass | `9951896` | MERGE | Lows: L1 checks 1–2 walk only `/api`, L2 commit grep misses lower-case SQL and `AUTOCOMMIT`, L3 `request_failed` untested | L1, L2 → P2-07; L3 accepted |
| 2 | Codex `gpt-6-astra` medium, new run | `9951896` | MERGE | none | — |

**Round 1, Medium (the change that shaped D2).** `application.mount("/", legacy)`, where `legacy` serves
`/api/buildings/{building_id}/private-records` with no guard: an anonymous request got 200, and all four
checks reported nothing, because `opaque_api_routes` (as it was named then) skipped non-`APIRoute`s whose own
path was outside `/api`, and a root mount's path is empty.
- **Fix:** `opaque_routes` reports every non-`APIRoute` in the app except the docs routes.
- **Evidence:** Codex's proof failed before and passed after. `test_meta_root_mount_is_reported` (root mount,
  `/static` mount, `Host`, `WebSocketRoute`) failed before the fix and passes after it.

**Round 1, L4.** An alias (`save = db.commit`), raw `COMMIT` and `async with db.begin():` in a router went
unreported.
- **Fix:** `_COMMIT` matches `\.commit\b|\bCOMMIT\b|\.begin\(` (not `COMMITTED`, not `begin_nested`).
- **Evidence:** `test_meta_commit_outside_a_service_is_reported` gained the three cases: it failed, then
  passed.

**Round 1, residuals added as tests:** `test_features_are_the_url_buildings_own`,
`test_csrf_rejection_and_validation_error_are_no_store`, and the `stale_log_context` fixture.

## 7. Not verified, accepted risks and follow-ups

- **Fitness checks 1 and 2 walk only `/api` routes.** An `APIRoute` at `/admin/export` would pass them. It is
  unreachable from outside today, because Caddy and the Vite proxy forward only `/api` (review round 2 L1).
  Tracked in P2-07.
- **The commit grep is a static regex.** It misses lower-case SQL `commit`, `getattr(db, "commit")()` and
  `AUTOCOMMIT` (round 2 L2). P2-07.
- **`/api/docs` and `/api/openapi.json` are open**, exempt from the checks as docs routes, if production
  serves them (pre-existing). P2-07.
- **`request_failed` carrying `building_id`/`user_id` has no test** (round 2 L3, accepted).
- **The 500 from Starlette's outermost error middleware has no `Cache-Control`** (D5; it carries no user
  data). Tracked only here.
- **An active membership with zero roles can read its building** (round 1 L2). P4-06 decides whether such
  memberships may exist.
- **`get_own_membership` isn't confined to onboarding routes by a test** (round 1 L3). P4-05 adds an
  onboarding-route list to fitness test 1.
- **Authorization is read once per request** under READ COMMITTED. A membership suspended mid-request doesn't
  stop that request's write; this is the same window as the session check. Accepted; tracked only here.
- **Fitness test 3 exercises only real routes**, today one `GET`. Unsafe methods (body `{}`) are untested
  until a building `POST` exists.
- **Timing:** no measurement shows that "not a member" and "no such building" take the same time. It is one
  statement either way (code reading only).
- **Allowlist entries:** P4-02, P4-04 and P4-05 must add their open routes to `backend/app/auth/allowlist.py` (D1).
  To be noted in those tickets in the bookkeeping commit.
- **P2-07 (new):** per-run `condo_test` name, `mypy tests/`, and the three items above.

## 8. How to change this safely

- **New building feature:** `router = building_router(tags=["packages"])` in `backend/app/<feature>/router.py`, add
  `app.include_router(router)` in `create_app` (no prefix), and take `Annotated[TenantContext,
  Depends(get_tenant_context)]` where the service needs it. Add `dependencies=[Depends(require_roles(...)),
  Depends(require_feature(...))]` as the ticket says. Fitness test 3 automatically adds the route to the
  cross-building 404 and the 401 runs. Write the route's own 10-case tests with `backend/tests/helpers/tenancy.py`
  (`backend/tests/README.md`).
- **An open route** (no session): add its `(method, path)` to `AUTH_ALLOWLIST`, or
  `test_every_api_route_requires_a_session_unless_allowlisted` fails.
- **An onboarding route:** use `get_own_membership` on a plain router with the building prefix, not
  `building_router()` (that would demand an active membership).
- **Changing `get_tenant_context`:** run `backend/tests/tenancy` and `backend/tests/test_architecture.py`. The mutation list
  in §4 says which tests guard which line.

## 9. Must explain, then quiz

**1. Why is the building ID in the URL safe, even though "never trust the client" is a rule?**
The client only *selects* a building; the server *authorizes* it on every request. `get_tenant_context`
ignores everything about the id except as a lookup key, and admits the caller only if the database holds an
active membership of *this session's user* in *that* building, which is active
(`backend/app/tenancy/deps.py::get_tenant_context`). A forged or guessed id gives the same 404 as a
nonexistent one. Services then filter every query by `ctx.building_id`, a value the server confirmed
(CLAUDE.md rule 1, ADR-0004).

**2. Why does a pending member get 404 on operational routes, and how do onboarding routes still work?**
The tenant query requires `status = 'active'`, so pending, suspended and denied members are refused exactly
like strangers: one 404, no hint that they are known. Onboarding routes use
`backend/app/tenancy/deps.py::get_own_membership` instead. It allows every status but deactivated, returns
the membership row (not a `TenantContext`), and so grants nothing operational. The fitness test accepts
either guard under the prefix; nothing yet stops an operational route from using the onboarding one (§7).

**3. How does fitness test #1 walk FastAPI's dependency tree? What would make it miss a route?**
FastAPI compiles each `APIRoute` into `route.dependant`: a tree whose `dependencies` include router-level,
decorator-level and parameter dependencies, each with its own sub-tree.
`backend/tests/test_architecture.py::dependency_calls` yields every `call` recursively, and the check looks
for `get_tenant_context` or `get_own_membership`. It would miss:
- routes it doesn't iterate: anything not an `APIRoute` (closed by `opaque_routes`), and `APIRoute`s outside
  `/api` (open, P2-07);
- a guard invoked by hand inside the endpoint rather than declared with `Depends`;
- a guard identity swapped at runtime, e.g. through `app.dependency_overrides`, which the walk doesn't
  consult.

**4. Why does a role change apply on the next request, with no logout needed?**
Nothing about the membership lives in the session: the session row holds only the user. Every request
re-runs the tenant query, which reads the roles, status and features as they are now
(`test_role_removed_between_requests_applies_to_the_next_request` deletes the role between two requests on
one cookie: 200, then 403).

**Quiz**

1. A route under `building_router()` takes no `ctx` parameter. Is it guarded? Which test says so?
2. Why does another building's manager get 404 rather than 403 on a `require_roles(property_management)`
   route?
3. What would break if `RequestLoggingMiddleware` stopped setting `building_id_ctx` to `None` at the start
   of each request?
4. What would break if `opaque_routes` went back to checking only routes whose path is under `/api`?
5. How would you add a council-only "building settings" endpoint gated on a new feature?

<details><summary>Answers</summary>

1. Yes: the router-level dependency runs for every route on the router.
   `test_building_router_guards_a_route_that_never_asks_for_the_context` proves it (the mutation run showed
   nothing else did).
2. `require_roles`' dependency depends on `get_tenant_context`, which runs first and raises 404 for a
   non-member, so the role check never runs. Covered by
   `test_another_buildings_manager_gets_404_not_403_on_a_role_route`.
3. A value left in the context by an earlier call (a direct call, a script, or a task model that reuses
   contexts) would appear on later, unrelated requests' log lines. `test_building_request_logs_carry_building_and_user`
   sets stale values first and fails without the reset (PR mutation: 2 failed).
4. A sub-app mounted at `/` (path empty) could serve unguarded `/api/buildings/...` routes that every check
   accepts: review round 1's Medium. `test_meta_root_mount_is_reported` would fail.
5. Add the feature value to `Feature` (a migration for the enum), then on a `building_router(tags=["buildings"])`
   route add `dependencies=[Depends(require_roles(Role.COUNCIL)), Depends(require_feature(Feature.NEW))]`, and
   test rows 1–4 and 6 with `as_user` and the tenancy helpers. Fitness test 3 picks the route up
   automatically.

</details>
