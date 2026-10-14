# P5-02b — Package pickup and return

| Field | Value |
|---|---|
| Phase / lane | P5 / A |
| Risk tier | 1 |
| Depends on | P5-02a |
| Replaces old | M7-T02 (transition part) |
| Status | todo |

Split from the original P5-02 (Package API). Create and read are in
[P5-02a](./P5-02a-package-create-and-read.md).

## Goal

Pickup and return are atomic state transitions with exactly one winner under concurrency, audited and
notified in the same transaction.

## Why

This is the reference implementation of the state-transition rule (CLAUDE.md rule 7): action endpoints with a
conditional `UPDATE … RETURNING`, never `PATCH status`. Notices and maintenance (P6) copy it.

## Scope

- In (building router, `require_feature(packages)`):
  - **`POST /packages/{id}/pickup`** (security, property_management)
    `{picked_up_by_membership_id?, picked_up_by_name?}` (one required):
    - a conditional `UPDATE … WHERE id=:id AND building_id=:b AND status='received' RETURNING *`
    - zero rows: re-read to return 404 if not found (or not in this building), 409 `invalid_transition` if not
      `received`
    - `picked_up_by_membership_id` (if given) must be a current occupant of the unit or the recipient
    - audit `package.picked_up`
    - `notify(package.picked_up)` to the recipient (in-app only)
  - **`POST /packages/{id}/return`** `{reason}` (security, property_management): `received` → `returned`, with
    the same conditional-update pattern and audit `package.returned`.
- Out:
  - undoing a pickup (not planned for the demo; would be a new ADR)
  - reminders and retention (P6/P7 option, pilot)

## Interfaces

`packages_pickup`, `packages_return`.

## Acceptance criteria

1. **The 10-case table** ([04 §7](../ENGINEERING_PRACTICES.md#7-testing-standards)) holds for both
   endpoints:
   - residents get 403
   - building B gets 404
   - `a_pending` gets 404
   - a building-B `picked_up_by_membership_id` gives 404/422 with no change
   - pickup or return of a package that is not `received` gives 409 `invalid_transition`
2. **Given** two concurrent pickup requests (separate sessions via `asyncio.gather`), **then** exactly one
   200, one 409, one `package.picked_up` audit row, and one pickup notification.
3. **Given** a concurrent pickup and return of the same package, **then** exactly one succeeds and the other
   gets 409.
4. **Given** `picked_up_by_membership_id` of an occupant of a *different* unit in the same building, **then**
   422 and the package stays `received`.
5. **Given** neither `picked_up_by_membership_id` nor `picked_up_by_name`, **then** 422.
6. **Given** the `packages` feature is disabled for A, **then** both endpoints return 403 `feature_disabled`.

## Test plan

- `tests/packages/test_transitions.py`, `tests/packages/test_concurrency.py` (real separate connections;
  explicit cleanup).
- Commands: `make test`, `make gen-api`.

## Likely files

`backend/app/packages/{service,router,schemas}.py`, `backend/app/notifications/kinds.py`,
`backend/tests/packages/*`.

## Must explain (learning checkpoint)

1. Explain, with two timelines, why the conditional UPDATE gives exactly one pickup winner under READ
   COMMITTED.
2. Why does `SELECT` then `UPDATE` have a race that `UPDATE … WHERE status='received' RETURNING` does not?
3. After zero rows come back, why re-read the package, and how does the re-read decide between 404 and 409?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
