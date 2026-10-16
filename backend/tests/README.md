# Backend tests

`make test` runs them against real Postgres (`condo_test`, rebuilt with the migrations once per run). Each
test runs inside one transaction that is rolled back at the end; see the docstring of `tests/conftest.py`
for the rules (`commit()` only releases a savepoint, requests must not run concurrently).

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
The HTTP helpers arrive with auth: `as_user` in P2-01 and `assert_cross_building_404` and the other tenant
helpers in `tests/helpers/tenancy.py` in P2-03
([P2-03](../../docs/tickets/P2-03-tenant-context-guards-fitness.md)). Until then the persona is the whole
recipe:

| # | Case | Who |
|---|---|---|
| 1 | Happy path per allowed role | `a_manager`, `a_security`, `a_resident1`, … |
| 2 | Unauthenticated | no session (TODO P2-01: the client without `as_user`) |
| 3 | Member of another building | `b_manager` or `b_resident1` on a building-A route; `multi` with the wrong building's role |
| 4 | Same building, wrong role | `a_security` on a management route, `a_resident1` on a staff route |
| 5 | Same building, another resident's record | `a_resident2` on `a_resident1`'s record; `a_former` on a record in 101 after `T1` |
| 6 | Pending / suspended | `a_pending`, `a_suspended` |
| 7 | Related ID from another building | `world.b_101.id` in a building-A body |
| 8–10 | Invalid transition, retry, concurrency | per endpoint |

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
