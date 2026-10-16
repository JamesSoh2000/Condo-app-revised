# P1-05 — Test world fixtures and tenant-isolation helpers

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 1 |
| Depends on | P1-03, P0-05 |
| Replaces old | M2-T07 |
| Status | in progress |

## Goal

A single `world` fixture creates two realistic buildings with every role and occupancy situation the 10-case
test table needs, plus factories and database-level isolation assertions.

## Why

Tenant tests only get written if they are cheap. With one fixture and a few helpers, each case in the
10-case table ([04 §7](../ENGINEERING_PRACTICES.md#7-testing-standards)) is one or two lines.

## Scope

- In:
  - **`tests/factories.py`:** async factory functions with sensible defaults and overrides:
    - `make_building`, `make_unit`, `make_user`
    - `make_membership(user, building, roles=..., status=...)`
    - `make_occupancy(membership, unit, relationship=..., started_at=..., ended_at=...)`

    Plain functions, no factory library.
  - **`tests/world.py`:** a `World` dataclass. The `world` fixture builds:
    - **Building A** ("maple", units 101, 102, 201):
      - `a_manager` (property_management)
      - `a_security`
      - `a_resident1` (tenant in 101, current)
      - `a_resident2` (owner in 102)
      - `a_council` (roles council + resident; owner in 201)
      - `a_pending` (pending, no occupancy)
      - `a_suspended` (resident, suspended)
      - `a_former` (active resident; lived in 101 until T1, then transferred to 102 as tenant; `a_resident1`
        moved into 101 after T1)
    - **Building B** ("birch", unit 101): `b_manager`, `b_resident1` (tenant in 101)
    - **`multi`:** resident in A 201 (household) and security in B
    - `no_membership` (a user with no memberships)
    - features `packages`, `notices` and `maintenance` enabled in both buildings
  - **`tests/helpers/db.py`:** `assert_integrity_error(db, coro)`, which runs the insert in a nested savepoint
    so the outer test transaction survives.
  - **Docs:** a section in `tests/README.md` showing how to write the 10 cases with the world. The HTTP
    helpers (`as_user`, `assert_cross_building_404`, …) arrive with auth in P2-01 and P2-03; leave TODO
    links.
- Out:
  - HTTP client helpers (they need sessions and tenancy)

## Interfaces

`world` fixture (function scope, built inside the test transaction). The `World` attributes listed above
(users, memberships, units, buildings).

## Acceptance criteria

1. **Given** the `world` fixture, **then** building A has exactly 3 units, building B has 1, and every listed
   persona exists with the stated roles and status.
2. **Given** `a_former` and `a_resident1`, **then** both have occupancies of A-101. The former's `ended_at`
   (T1) is earlier than the resident's `started_at`, and `a_former` has a current occupancy of 102
   starting at T1.
3. **Given** `assert_integrity_error`, **when** used for a cross-building occupancy insert, **then** the test
   passes, and the test can keep using `db` afterwards.
4. **Given** two tests using `world`, **then** no data leaks between them (row counts are identical at the
   start of each).
5. Building the world takes < 300 ms locally (print the timing once; not a hard assertion).

## Test plan

- `tests/test_world.py` covering criteria 1–4.
- Commands: `make test`

## Likely files

`backend/tests/factories.py`, `backend/tests/world.py`, `backend/tests/helpers/db.py`,
`backend/tests/conftest.py`, `backend/tests/README.md`.

## Must explain (learning checkpoint)

1. Why does the world include a *former* occupant, a *pending* member and a *multi-building* user? Name the
   bug each one catches.
2. Why do we need a nested savepoint to assert an `IntegrityError` inside a transactional test?
3. Why "same building, other resident" tests in addition to cross-building tests?

## Carried from P1-02 (decide while framing)

Open ORM and schema follow-ups from the P1-02 reviews (PR #44). They belong with this ticket's test
infrastructure; take them in scope, or move each to a named ticket:
- A fitness test: every one-to-many `relationship()` whose child FK is part of the child's primary key has
  `cascade` including `delete-orphan` (P1-02 round 2 crashed without it).
- Tests that pin `BuildingMembership.roles`'s `passive_deletes=True` (deleting a membership with unloaded
  roles issues no `SELECT` on `membership_roles`) and the `user` relationship on its own (review L-B).
- No relationship to `Building` from `BuildingMembership`, `MembershipRole` or `Unit`: deleting a building
  and its children in one ORM flush deletes the building first (review L-A). Buildings aren't deleted by
  design; add the relationship if anything ever does.
- No index on `membership_roles.building_id` or `building_memberships.status_changed_by_user_id`; only rare
  building and user deletes scan for them (review L3).

## Carried from P1-03 (decide while framing)

From the P1-03 reviews (PR #45). The migration round-trip tests in `tests/test_schema_buildings_units.py`,
`tests/test_schema_identity.py` and `tests/test_schema_occupancy.py` all use the fixed scratch database
`condo_migrations_test`, so two test runs at once (parallel worktrees or reviewers) can collide. Give it a
per-run name (e.g. with the process id), keeping the `_test` suffix that `assert_safe_test_database_url`
requires, and drop it afterwards. Agents also use `make_occupancy` here: build occupancies with the helpers
in `app/memberships/occupancy.py` (explicit past `at`), not raw inserts, so the world can't hold overlapping
history (ADR-0016).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - **1 sharpened.** Building A is slug `maple` with exactly units `101`, `102`, `201` (tower NULL); B is
    `birch` with exactly `101`. Every user is active with `password_hash` NULL (P2-01 adds passwords). Each
    persona's membership has exactly this status and role set, and exactly these occupancies (T0 < T1 < T2,
    fixed instants in the past, exposed on the world so tests can stamp records inside a window):

    | Persona | Building | Status | Roles | Occupancies |
    |---|---|---|---|---|
    | `a_manager` | A | active | property_management | none |
    | `a_security` | A | active | security | none |
    | `a_resident1` | A | active | resident | 101 tenant, from T2, current |
    | `a_resident2` | A | active | resident | 102 owner, from T0, current |
    | `a_council` | A | active | council, resident | 201 owner, from T0, current |
    | `a_pending` | A | pending | resident | none |
    | `a_suspended` | A | suspended | resident | 201 household, from T0, current |
    | `a_former` | A | active | resident | 101 tenant T0–T1; 102 tenant from T1, current |
    | `b_manager` | B | active | property_management | none |
    | `b_resident1` | B | active | resident | B-101 tenant, from T0, current |
    | `multi` | A and B | active, active | A: resident; B: security | A-201 household, from T0, current |
    | `no_membership` | none | — | — | — |

    `a_pending` holds the resident role and `a_suspended` lives in 201, so a 404 for either proves the
    status check, not a missing role or unit. Features `packages`, `notices`, `maintenance` enabled in both
    buildings, and no other feature rows.
  - **2 sharpened.** `ended_at` of a_former's 101 row is T1, strictly before a_resident1's `started_at` (T2);
    a_former's 102 row starts at T1 exactly (a transfer) and is current.
  - **3 sharpened.** `assert_integrity_error(db, awaitable, constraint=...)` takes the expected constraint
    name and checks it exactly; the test keeps using `db` (a query and a new flush) afterwards, and rows
    flushed before the call survive.
  - **4 sharpened.** A test without the world sees every table in `Base.metadata` empty; two tests with the
    world see identical, exact row counts per table (2 buildings, 4 units, 12 users, 12 memberships,
    13 roles, 8 occupancies, 6 features).
  - **6 added (proves the helper can fail).** `assert_integrity_error` fails the test when the awaitable
    raises nothing, or an `IntegrityError` on another constraint; any other exception propagates.
  - **7 added.** Factories write occupancies through `app.memberships.occupancy` (ADR-0016): a second
    current occupancy raises `IntegrityError`, and a start inside an earlier occupancy raises
    `OccupancyTimeError`.
  - **8 added (case the ticket missed).** The world supports the visibility window
    (`occupancy_window_clause`): a record in A-101 at T0 + 1 day is visible to `a_former` only; one at
    `now()` to `a_resident1` only; neither to `a_resident2` (same building, other resident: case 5).
  - **9 added (carried from P1-02, taken in scope).** A fitness test: every one-to-many `relationship()` whose
    child FK columns are part of the child's primary key cascades `delete-orphan`; shown failing on a
    synthetic violating mapper, and shown non-vacuous (it finds `BuildingMembership.roles`). Tests pin
    `roles`'s `passive_deletes=True` (deleting a membership with unloaded roles issues no `SELECT` on
    `membership_roles`, and the database cascade removes them) and the `user` relationship on its own (a
    new user and its membership, set only through `user`, flush together).
  - **10 added (carried from P1-03, taken in scope).** The migration round-trip tests use a per-process
    scratch database (`condo_migrations_<pid>_test`) and drop it afterwards.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - 10-case table: no endpoints in this ticket, so no rows apply directly; the world provides a persona for
    each of cases 1, 3, 4, 5, 6 and 7, and `tests/README.md` maps them (ticket).
  - Personas are `Member(user, membership)` pairs; `multi` exposes `multi_in_a` / `multi_in_b` (autonomous,
    reversible; test-only).
  - P1-02 L-A (no `building` relationship) and L3 (two missing indexes): closed with no change. Nothing deletes
    buildings or users (they are deactivated, P1-01/P1-02 RESTRICT FKs), so there is no ticket to move them
    to; whichever ticket first deletes either must revisit them (autonomous; inbox "Decisions to audit").
  - The session test database `condo_test` is also fixed per server, so two concurrent `make test` runs on one
    server still collide. Out of scope (the carried item names only the scratch database); concurrent runs
    pass their own `TEST_DATABASE_URL=..._test` meanwhile; follow-up in the PR (autonomous).
- Split: no. Estimate ~350 lines, almost all under `backend/tests/`.
