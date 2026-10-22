# P5-01 — Package schema and state machine

| Field | Value |
|---|---|
| Phase / lane | P5 / A |
| Risk tier | 1 |
| Depends on | P1-03, P3-04 |
| Replaces old | M7-T01 |
| Status | in progress |

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

1. **Given** a package in building A whose unit, photo file, recipient, `received_by`, `picked_up_by` or
   `handed_out_by` membership belongs to building B, **then** `IntegrityError` naming that column's composite
   FK (`fk_packages_building_id_<column>`), one case per column.
2. **Given** `status='picked_up'` with a null `picked_up_at`, **then** a check-constraint error. Sharpened: each
   state check rejects every column that breaks it, by constraint name:
   - `picked_up`: `picked_up_at` and `handed_out_by_membership_id` set, `picked_up_by_membership_id` or
     `picked_up_by_name` set, `returned_at` and `return_reason` null
   - `received`: `picked_up_at`, `returned_at` and every pickup/return column null
   - `returned`: `returned_at` and `return_reason` set, `picked_up_at` and every pickup column null
   - `picked_up_at` and `returned_at`, when set, are not before `received_at`
3. **Given** `assert_transition(picked_up, received)`, **then** `InvalidTransition` (409, code
   `invalid_transition`). Table-driven over every pair: only `received → picked_up` and
   `received → returned` pass; every other pair (including staying put) raises.
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
6. **Given** `can_view` on a package photo, **then** it follows the same visibility as the package. Sharpened:
   the hook is the one registered by importing `app.main` alone (fresh interpreter), it grants exactly the
   personas of criterion 4 for a photo of P0–P2, and it refuses a `package_photo` file whose `attached_type`
   isn't `package` or whose package doesn't name it as `photo_file_id`. One download through
   `GET /api/buildings/{id}/files/{file_id}/download-url` returns 200 to a viewer of the package and the same 404
   as a random id to a non-viewer.
7. **(added: tenant row 3)** `multi` sees, with its A membership (resident of A-201), only A-201 packages
   received during its occupancy, and with its B membership (security) every B package and no A package. Every
   persona's result is limited to its own building.
8. **(added: window edges, half-open)** A unit-101 package received exactly at T1 is invisible to `a_former`
   (101 ended at T1) and to `a_resident1` (starts at T2); one received exactly at T2 is visible to
   `a_resident1` and not to `a_former`.
9. **(added: carried from P1-03)** `received_at`, `picked_up_at` and `returned_at` are `timestamptz`; with the
   session `TimeZone` set to `America/Toronto`, criterion 4's results are unchanged. `visible_packages(ctx)`
   selects from `packages` with `building_id = ctx.building_id`, passes `ctx.membership_id` to
   `occupancy_window`, and returns the same rows when composed into a query with an aliased `packages` and an
   outer join to `unit_occupancies`.
10. **(added)** Two packages with one `idempotency_key` in one building violate
    `uq_packages_building_id_idempotency_key`; the same key in two buildings is allowed. `idempotency_key` and
    `request_hash` are NOT NULL (P5-02a requires the header).
11. **(added)** A context with no granting role (council only, or no roles) sees no package; a resident who is
    also security sees everything (union).
12. **(added: seed)** `make seed` creates about 15 Maple packages across at least 4 units and all three states,
    every one passes the checks, a second run adds none, and at least one seeded resident sees a package
    through the occupancy window and one through being the named recipient.

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
  - 1: every composite FK, not only the photo and recipient, each by constraint name.
  - 2: the full set of state checks: the ticket's three, plus the pickup person (P5-02b criterion 5 requires
    one), the return reason (P5-02b's `{reason}`), columns belonging to the other terminal state, and time
    order. They make the columns of a state exclusive to it, so the checks enforce what `ALLOWED` says.
  - 3: the error's status and code (`invalid_transition`, as in `app/units/service.py::InvalidTransition`), and
    every pair of states.
  - 6: what "follows the visibility" means for the hook (registered from `app.main`, keyed on `attached_type`
    and `photo_file_id`), and one end-to-end download.
  - 7–12 added. Tenant table (ENGINEERING_PRACTICES §7): no endpoint in this ticket, so rows apply to the query:
    row 3 (other building, `multi`) → 7; row 5 (another resident, `a_former` after T1) → 4 and 8; row 7 (related
    id from another building) → 1. Rows 1, 2, 4, 6 (role gates, auth, pending/suspended) are the endpoints'
    and `get_tenant_context`'s job, in P5-02a/b; rows 8–10 (transitions, retry, concurrency) are P5-02a/b's,
    with 3 and 10 here at the schema level. Missed cases: the window's edges (8), the time zone and the
    composed query shapes carried from P1-03 (9), roles that grant nothing and the union (11), and the seed (12).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - `attach photos with claim_file inside the write use case` moves to P5-02a, whose `POST /packages` is the
    first write use case (its scope already lists `claim_file(..., purpose=package_photo)`). This ticket defines
    the `attached_type` value (`package`) that P5-02a passes. Basis: ticket scope (endpoints are out).
  - The `can_view` hook lives in `app/packages/photos.py`, registered when the module is imported; `app/main.py`
    imports it at module level. Basis: ticket (P3-04b follow-up).
  - `idempotency_key` and `request_hash` NOT NULL; `description` nullable (optional in P5-02a's body). Basis:
    P5-02a's scope; autonomous where it is silent.
  - Staff here means `security` or `property_management`, not `STAFF_ROLES` (which includes `council`). Basis:
    ticket.
  - Seeded packages: found by `(building, idempotency_key)` and left as they are once created (their times are
    relative to the first run, so "set back" has no fixed value). Basis: autonomous.
- Split: none. Estimate ~360 non-test lines (model 90, migration 90, seed 70, queries and hook 75, state and
  enums 35).
