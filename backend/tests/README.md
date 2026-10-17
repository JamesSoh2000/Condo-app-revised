# Backend tests

`make test` runs them against real Postgres (`condo_test`, rebuilt with the migrations once per run). Each
test runs inside one transaction that is rolled back at the end; see the docstring of `tests/conftest.py`
for the rules (`commit()` only releases a savepoint, requests must not run concurrently).

The `client` and `app_client` fixtures send `X-Requested-With: fetch` and a trusted `Origin` with every
request, as the SPA does, so unsafe requests pass the CSRF check (`app/core/csrf.py`). To test a request
without them, build it and replace its headers (`tests/test_csrf.py::send`).

## The world

The `world` fixture (`tests/world.py`) builds two buildings inside the test's transaction. Use it instead of
setting up users by hand:

| Persona | Building | Status | Roles | Lives in |
|---|---|---|---|---|
| `a_manager` | A (`maple`) | active | property_management | — |
| `a_security` | A | active | security | — |
| `a_resident1` | A | active | resident | 101, tenant, from `World.T2` |
| `a_resident2` | A | active | resident | 102, owner |
| `a_council` | A | active | council, resident | 201, owner |
| `a_pending` | A | pending | resident | — |
| `a_suspended` | A | suspended | resident | 201, household |
| `a_former` | A | active | resident | 101 until `World.T1`, then 102 (tenant) |
| `b_manager` | B (`birch`) | active | property_management | — |
| `b_resident1` | B | active | resident | B-101, tenant |
| `multi` (user) | A and B | active | A: resident (`multi_in_a`); B: security (`multi_in_b`) | A-201, household |
| `no_membership` (user) | — | — | — | — |

Units: `world.a_101`, `a_102`, `a_201`, `b_101`. Personas are `Member(user, membership)`; `multi` and
`no_membership` are plain users. Occupancies start at `World.T0` unless stated, and are current unless they
end. Stamp a record with `World.T0 + timedelta(days=1)` to put it in `a_former`'s time in A-101, or leave
it at `now()` to put it in `a_resident1`'s.

Why these personas: `a_former` catches a visibility filter that checks "has ever lived in the unit" instead
of "lived there when the record was created"; `a_pending` and `a_suspended` hold the resident role, so a
404 for either proves the status check rather than a missing role; `a_suspended` also lives in 201, so on a
unit-addressed route only its 404 rules out the occupancy filter (`a_pending` has no unit);
`multi` catches code that takes a user's role from the wrong membership.

## The 10 cases with the world

The table is in [docs/ENGINEERING_PRACTICES.md §7](../../docs/ENGINEERING_PRACTICES.md#7-testing-standards).
Apply every row that fits to each tenant endpoint. The helpers:

- `client = await as_user(world.a_manager.user)` (fixture in `tests/conftest.py`): a client of its own,
  logged in, so a test can hold several users. `login_as(db, client, user)` (`tests/helpers/auth.py`)
  switches an existing client, such as an `app_client` with test-only routes, to another user. Neither needs
  a password: they create the session row directly.
- `tests/helpers/tenancy.py`: `assert_cross_building_404`, `assert_forbidden_role`, `assert_not_visible`
  (each sends one request and checks the problem+json), `assert_problem`, and `without_request_id` to
  compare two 404 bodies.
- `frozen_clock` freezes time (`frozen_clock.advance(minutes=5)`); code reads it through
  `app.core.clock.now()`.

| # | Case | Who | Assert |
|---|---|---|---|
| 1 | Happy path per allowed role | `a_manager`, `a_security`, `a_resident1`, … | 2xx and the exact body |
| 2 | Unauthenticated | `client` without logging in | `assert_problem(r, 401, "not_authenticated")` |
| 3 | Member of another building | `b_manager`/`b_resident1` on a building-A route; `multi` with the wrong building's role | `assert_cross_building_404(c, "GET", url)` |
| 4 | Same building, wrong role | `a_security` on a management route, `a_resident1` on a staff route | `assert_forbidden_role(c, "POST", url, json=...)` |
| 5 | Same building, another resident's record | `a_resident2` on `a_resident1`'s record; `a_former` on a record in 101 after `T1` | `assert_not_visible(c, "GET", url, code="package_not_found")`, same body as a random id |
| 6 | Pending / suspended | `a_pending`, `a_suspended` | `assert_cross_building_404` |
| 7 | Related ID from another building | `world.b_101.id` in a building-A body | 404 or 422, then count the rows: none written |
| 8–10 | Invalid transition, retry, concurrency | per endpoint | 409 `invalid_transition`; the original result; one winner |

Rows 2, 3 and 6 also run automatically for every building route in `tests/test_architecture.py` (fitness
test 3), but only as "the guard is there". A route's own test still covers them with its real body.

```python
async def test_resident_cannot_see_other_residents_package(as_user, world, package_of_resident1):
    client = await as_user(world.a_resident2.user)
    url = f"/api/buildings/{world.a.id}/packages/{package_of_resident1.id}"

    hidden = await assert_not_visible(client, "GET", url, code="package_not_found")
    missing = await assert_not_visible(
        client, "GET", f"/api/buildings/{world.a.id}/packages/{uuid.uuid4()}", code="package_not_found"
    )
    assert without_request_id(hidden) == without_request_id(missing)


async def test_security_cannot_create_a_notice(as_user, world):
    client = await as_user(world.a_security.user)
    await assert_forbidden_role(client, "POST", f"/api/buildings/{world.a.id}/notices", json={...})
```

New building routes come from `building_router(tags=[...])` (`app/tenancy/router.py`); add role and feature
checks with `dependencies=[Depends(require_roles(Role.X)), Depends(require_feature(Feature.Y))]`. Test-only
routes under the building prefix go through `app_client(router, prefix="")`, as in
`tests/tenancy/test_context.py`.

## Factories

`tests/factories.py`: `make_building(db, features=...)`, `make_unit(db, building)`, `make_user(db)`,
`make_membership(user, building, roles=..., status=...)` and
`make_occupancy(membership, unit, relationship=..., started_at=..., ended_at=...)`. Every keyword overrides a
default; each factory flushes and never commits. `make_occupancy` goes through `app.memberships.occupancy`,
so it refuses overlapping history and future times (ADR-0016): pass past instants.

## Asserting a constraint

A failed statement aborts the test's whole transaction. Use `tests/helpers/db.py`:

```python
await assert_integrity_error(
    db,
    make_occupancy(world.a_manager.membership, world.b_101),
    constraint="fk_unit_occupancies_building_id_unit_id",
)
# `db` still works here: the insert ran in a savepoint that was rolled back.
```

It fails the test if nothing is raised or another constraint is violated. Create the invalid row inside the
awaitable, not with `db.add()` before the call: rows pending before it are flushed first, outside the
savepoint, so their violation is raised as a plain error.

## Migration tests

Tests that run migrations up and down take the `scratch_database_url` fixture: an empty database named for
the process (`condo_migrations_<pid>_test`), dropped afterwards, so concurrent runs don't collide on it.
`condo_test` itself is still one per server: run concurrent suites with their own
`TEST_DATABASE_URL=..._test`.
