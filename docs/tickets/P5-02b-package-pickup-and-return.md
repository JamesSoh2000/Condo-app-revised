# P5-02b — Package pickup and return

| Field | Value |
|---|---|
| Phase / lane | P5 / A |
| Risk tier | 1 |
| Depends on | P5-02a |
| Replaces old | M7-T02 (transition part) |
| Status | done |

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

Added or sharpened while framing (see Frame notes):

7. **Pickup happy path:** security and property_management each get 200 `PackageOut` with
   `status: picked_up` and `picked_up_at` set; the row has `handed_out_by_membership_id` = the caller's
   membership, the pickup person as sent, and `picked_up_at >= received_at`. Same for return
   (`status: returned`, `returned_at`, `return_reason` stored stripped). One `package.picked_up` /
   `package.returned` audit row whose metadata holds IDs and field names only (never the typed name or
   reason).
8. **Who may collect** (PRODUCT_SCOPE "Package pickup", the P1-03 carry): `picked_up_by_membership_id`
   must be an **active** membership of this building that is the package's named recipient or has a
   current occupancy of the package's unit. Otherwise one 422 `invalid_pickup_member` with no change,
   for: an occupant of another unit (criterion 4), a building-B membership, an unknown id, `a_pending`,
   a suspended current occupant (`a_suspended` of 201), and a former occupant of the unit (`a_former`
   for 101). The named recipient may collect even after moving to another unit of the building.
9. **Body shape:** exactly one of `picked_up_by_membership_id` and `picked_up_by_name` (neither or both:
   422). `picked_up_by_name` (≤ 120) and `reason` (≤ 300) are stripped; blank, whitespace-only, too long
   or containing control characters → 422 (the P5-01 carry). Unknown fields → 422.
10. **Order of answers:** a package that is not `received` gives 409 `invalid_transition` whatever the
    pickup person (state before body checks that need the package); another building's or an unknown
    package id gives 404 `package_not_found` (the same body for both).
11. **Notification:** pickup notifies, in-app only (no `email.send` job), the named recipient if their
    membership is active, else the unit's current active occupants (none if the recipient is inactive);
    return notifies nobody. A second (losing) pickup writes no notification or audit row.
12. **Sequential repeats:** a second pickup after a pickup, a return after a pickup and a pickup after a
    return each give 409 `invalid_transition` and change nothing (tenant row 8).
13. **Concurrent pickup and a membership change:** a pickup naming a member waits for a concurrent
    deactivation of that member to finish and then refuses with 422 (reads the committed status), so a
    pickup never records a member deactivated before it committed.
14. **Carried from P5-02a:** after a pickup, a create replay with the original key and body answers 201,
    `Idempotent-Replayed: true`, and `status: picked_up`.
15. Council (resident + council) and residents get 403 `forbidden_role`; unauthenticated 401.

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

## Carried from P5-01 (do while framing)

From PR #109: the state checks accept an empty `picked_up_by_name` or `return_reason` (`''` is NOT NULL).
Refuse blank values in the request schemas (`min_length`, stripped), with a test. Use
`app.packages.state.assert_transition` and the same from-states in the conditional UPDATE.

## Carried from P5-02a

From PR #114: a create replay renders the package as it is now (decision D3), so after a pickup a retried
create shows `picked_up`; test that the replay still answers 201 with the new status. The pickup form's
member list is `GET /units/{id}/occupants` (active current occupants only, the P1-03 carry).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 7–15 above. 1 is unchanged; 8 makes the ticket's "current occupant of the
  unit or the recipient" precise with PRODUCT_SCOPE's "active resident" and the P1-03 carry (active
  memberships only), and fixes the building-B case of 1 to 422 (one answer for every refused member, as
  P5-02a's `invalid_recipient`). 9 resolves "one required" as exactly one. 13 is the case the ticket missed.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Flow: read the package through `visible_packages` (404), `assert_transition` on what was read (409),
    validate the pickup member against the package's unit and recipient (422), then the conditional
    `UPDATE … WHERE id AND building_id AND status IN (from-states of the target) RETURNING`; zero rows →
    re-read and `assert_transition` on the current status (409), or 404. The member must be checked
    before the UPDATE: an unchecked building-B id would fail the composite FK at the UPDATE (a 500).
    The UPDATE alone decides the race (basis: ticket, CLAUDE.md rule 7; autonomous for the pre-read).
  - From-states come from `app.packages.state.ALLOWED` (a `sources(to)` helper), not a second list
    (basis: the P5-01 carry).
  - The member check takes FOR SHARE on the membership row first, then reads status and occupancy in a
    new statement: membership status and occupancy writes take FOR NO KEY UPDATE on that row
    (`app.memberships`), so the check waits for them and reads what they committed (basis: existing
    lock pattern in `app.memberships.occupancy`; autonomous).
  - `picked_up_at` / `returned_at` = `clock_timestamp()` in the UPDATE, not the transaction's `now()`
    nor the app clock: `received_at` is the create transaction's `now()`, and a pickup transaction that
    began before that create committed would otherwise write a time before it (the check constraint →
    500) (basis: CLAUDE.md lesson "fresh clock in the writing statement"; autonomous).
  - `package.picked_up` becomes in-app only (`email_template=None`): P3-03 registered it with the
    generic `notification` email, the ticket says in-app only. `test_only_the_in_app_kinds_have_no_email`
    gains it, as its comment asks for a new in-app kind (basis: ticket).
  - New 422 code `invalid_pickup_member`; 404 stays `package_not_found` (basis: P5-02a pattern).
  - `PackageOut` is unchanged (status and the times show the transition); who collected it and the
    return reason aren't returned yet. P5-03's desk page decides what it shows (follow-up there).
  - Return notifies nobody and has no member field (ticket scope).
- Split: no. Estimate ~230 non-test lines (service ~140 with the error and race paths, router ~45,
  schemas ~35, state/kinds/actions ~10).
