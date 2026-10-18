# P5-01 — Package schema and state machine

| Field | Value |
|---|---|
| Phase / lane | P5 / A |
| Risk tier | 1 |
| Depends on | P1-03, P3-04 |
| Replaces old | M7-T01 |
| Status | todo |

## Goal

The `packages` table, the legal state transitions and a `visible_packages(ctx)` query exist. The query
encodes who may see which package, including correct behaviour across unit turnover.

## Why

Packages are the **reference slice**. The visibility helper written here is the pattern every later domain
copies, so it must be exactly right and thoroughly tested.

## Scope

- In:
  - **`packages` table:**
    - `building_id`, `unit_id` (composite FK to units)
    - `recipient_membership_id` (nullable, composite FK to memberships)
    - `carrier` String(50), `description` String(200), `tracking_last4` String(4) nullable
    - `photo_file_id` (nullable, composite FK to files)
    - `status` enum (`received`, `picked_up`, `returned`)
    - `received_at` (default now), `received_by_membership_id` (composite FK)
    - `picked_up_at`, `picked_up_by_name` String(120), `picked_up_by_membership_id` (nullable, composite FK),
      `handed_out_by_membership_id` (nullable, composite FK)
    - `returned_at`, `return_reason` String(300)
    - `idempotency_key` String(80), `request_hash` String(64)
    - `UniqueConstraint(building_id, idempotency_key)`
    - **checks:** `status='picked_up' ⇒ picked_up_at IS NOT NULL AND handed_out_by_membership_id IS NOT NULL`;
      `status='received' ⇒ picked_up_at IS NULL AND returned_at IS NULL`;
      `status='returned' ⇒ returned_at IS NOT NULL`
    - indexes `(building_id, status, received_at DESC)`, `(building_id, unit_id, received_at DESC)`,
      `(recipient_membership_id)`
  - **`app/packages/state.py`:** `ALLOWED = {received: {picked_up, returned}}` and
    `assert_transition(from, to)`. This is pure logic, unit-tested.
  - **`visible_packages(ctx) -> Select`:**
    - `security` / `property_management`: every package in `ctx.building_id`
    - `council` (without a resident role): none (aggregates only, later)
    - `resident`: packages in the building where `recipient_membership_id = ctx.membership_id`, **or**
      `occupancy_window_clause(ctx.membership_id, Package.unit_id, Package.received_at)` (P1-03)
    - multi-role: the union of the role grants
  - Register `can_view` for file purpose `package_photo`: the file is attached to a package that is visible to
    the caller.
    Follow-up from P3-04b: call `app.files.purposes.register_can_view(FilePurpose.PACKAGE_PHOTO, …)` from a
    module `app/main.py` imports (until then attached package photos are visible to nobody), and attach photos
    with `app.files.service.claim_file` inside the write use case, before its single commit.
  - **Seed:** about 15 packages for Maple across units and states.
- Out:
  - endpoints (P5-02a, P5-02b)
  - retention (pilot or P7)

## Interfaces

Model `Package`, enum `PackageStatus`, `visible_packages(ctx)`, `assert_transition()`.

## Acceptance criteria

1. **Given** a package for an A unit with a B photo file or a B recipient membership, **then** `IntegrityError`.
2. **Given** `status='picked_up'` with a null `picked_up_at`, **then** a check-constraint error.
3. **Given** `assert_transition(picked_up, received)`, **then** `InvalidTransition`.
4. **Given** the world, with packages:
   - P0: unit 101, received before T1 (during `a_former`'s 101 occupancy)
   - P1: unit 101, received after `a_resident1` moved in
   - P2: unit 102, received before T1 (before `a_former` moved to 102)

   **then:**
   - `a_resident1` sees P1 only
   - `a_former` sees P0 only (history follows the person, not the unit)
   - `a_resident2` (owner of 102 throughout) sees P2 only
   - `a_security` and `a_manager` see all three
   - `a_council` (council + resident of 201) sees none of these
   - `b_resident1` sees none
5. **Given** a package addressed to unit 101 with `recipient_membership_id = a_resident1`, **then**
   `a_resident1` sees it, even if received before their occupancy started (named recipient).
6. **Given** `can_view` on a package photo, **then** it follows the same visibility as the package.

## Test plan

- `tests/packages/test_schema.py`, `tests/packages/test_state.py`, `tests/packages/test_visibility.py`
  (a table-driven test over the world personas).
- Commands: `make test`.

## Likely files

`backend/app/packages/{models,enums,state,queries}.py`, `backend/app/files/purposes.py`,
`backend/app/seed.py`, `backend/migrations/versions/<new>.py`, `backend/tests/packages/*`.

## Must explain (learning checkpoint)

1. Walk through why `a_resident1` cannot see P0, using the actual SQL that `visible_packages` produces.
2. Why put the transition rules both in Python (`ALLOWED`) and in check constraints?
3. Why is visibility a reusable `Select` rather than a filter applied in each endpoint?

## Carried from P1-03 (decide while framing)

From the P1-03 reviews (PR #45, ADR-0016). `occupancy_window_clause` calls the database function
`public.occupancy_window(membership, unit, at)`:
- **`received_at` must be `timestamptz`** (`DateTime(timezone=True)`). A naive `timestamp` record column is
  cast with the session's time zone, which moves the window (P1-03 review round 5, L2: with
  `America/Toronto`, a new occupant saw the former occupant's record). Add a test that pins the column type.
- **`visible_packages` selects from `packages` itself**, with the building filter, and passes
  `ctx.membership_id` (never a client value) as the membership. Pin both with a test.
- Test `visible_packages` against the argument shapes the P1-03 reviews used (outer aliases, an outer join
  to `unit_occupancies`), as `tests/test_occupancy_helpers.py` does for the clause.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
