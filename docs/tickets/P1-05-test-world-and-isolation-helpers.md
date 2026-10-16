# P1-05 — Test world fixtures and tenant-isolation helpers

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 1 |
| Depends on | P1-03, P0-05 |
| Replaces old | M2-T07 |
| Status | todo |

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
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
