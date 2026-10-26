# P6-03e — Maintenance cancel and the emergency phone

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03b |
| Replaces old | M8-T01 (resident cancel), M8-T04 (emergency part) |
| Status | todo |

Split from [P6-03b](./P6-03b-maintenance-submit-and-read-api.md) while it was being built (its Frame notes,
"Split"): P6-03b's diff came out at 705 non-test lines with these two parts. The criteria, rows and decisions
below are P6-03b's as framed, moved unchanged. Its code and tests as built (passing, **unreviewed**) are on the
local branch `p6-03e-start` (in the P6-03b worktree's repository): a starting point to rebase onto `main` and
re-check, not a source of truth.

## Goal

A resident cancels their own maintenance request while it is `submitted`; an emergency request shows the
building's emergency phone.

## Scope

- In (building router, `require_feature(Feature.MAINTENANCE)`):
  - **`POST /maintenance-requests/{id}/cancel`** (`require_roles(Role.RESIDENT)`): `submitted → cancelled` by
    the requester only (P6-03b D3), a conditional `UPDATE … WHERE status IN (sources(cancelled)) AND
    requester_membership_id = ctx.membership_id RETURNING`, `cancelled_at = clock_timestamp()`,
    `cancelled_by_membership_id = ctx.membership_id`; operation id `maintenance_cancel`
  - `emergency_phone` on `MaintenanceRequestOut` (create, list, get and cancel answers), from the maintenance
    feature's `building_features.config["emergency_phone"]` (P6-03b D1), read defensively; set by the seed
    (Maple) and `bootstrap-building --emergency-phone`; the ADR for "a feature's settings live in its
    `config`" (drafted as ADR-0021 on `p6-03e-start`) and its inbox line
  - audit `maintenance.cancelled` (`from_status`)
  - `make gen-api`
- Out: an API to edit the phone; P6-03c's start (its race with cancel is criterion 1 below).

## Acceptance criteria

1. **Cancel** (P6-03b criterion 6). **Given** a `submitted` request, **when** its requester cancels, **then** it
   is `cancelled` with its cancel columns set by the database clock and the caller, and one
   `maintenance.cancelled` audit row (`from_status`, actor `ctx.user_id`, no description text); the requester
   check is in the conditional `UPDATE`'s `WHERE`, so a co-occupant who can see the request (`a_former`, in 102
   since T1, on `a_resident2`'s 102 request) gets 403 `not_requester`, never a cancel, and the row and audit log
   are unchanged; a test skips the early check once and shows the `UPDATE` itself refuses. **Given** a request a
   manager started at the same time, **then** exactly one of start (P6-03c) and cancel wins; here, with a raw
   `UPDATE` to `in_progress` in a second session, the cancel waits and gets 409.
2. **Emergency** (P6-03b criterion 7). **Given** `category = emergency`, **then** the 201 and every read of that
   request include the building's `emergency_phone`, in the list too, and the cancel's answer; no other category
   does; a building with no phone, or a `config` value that isn't a non-blank string of at most 32 characters,
   gives `emergency_phone: null`; another building's phone is never shown. The seed sets Maple's;
   `bootstrap-building --emergency-phone` sets a new building's (refused, naming the option, without the
   `maintenance` feature; printable, stripped, at most 32 characters). The app never claims to have alerted
   anyone (stub: "never rely on the app").
3. **The tenant table on cancel** (P6-03b rows 1, 2, 3, 4, 5, 6, 7, 8, 10 for this route): the requester
   cancels their own; signed out 401; `b_manager`, `a_pending`, `a_suspended` 404 `building_not_found`;
   `a_manager` and `a_security` 403 `forbidden_role`; `a_resident2` on `a_resident1`'s request and a B request
   on A's URL 404 `maintenance_request_not_found`, the same body as a random id; a request that isn't
   `submitted` 409 `invalid_transition`; two cancels at once give one 200 and one 409, with one audit row.
4. **Feature off** and **atomicity**: cancel gives 403 `feature_disabled` with `maintenance` off; a forced
   failure after the `UPDATE` leaves the request `submitted` and no audit row.

## Test plan

`backend/tests/maintenance/test_cancel.py` (1, 3), `test_emergency.py` (2), `test_concurrency.py` (1's race,
3's two cancels), `test_atomicity.py`, `tests/cli/test_bootstrap.py` (the option). `make check DB_PORT=55432`.

## Likely files

`backend/app/maintenance/{service,router,schemas}.py`, `backend/app/audit/actions.py`,
`backend/app/buildings/{schemas,service}.py`, `backend/app/cli.py`, `backend/app/seed.py`, `docs/adr/0021-*.md`,
`frontend/src/api/schema.d.ts`. Estimate ~170 non-test lines (`p6-03e-start` measured).

## Must explain (learning checkpoint)

1. Why does cancel put the requester check in the `UPDATE`'s `WHERE` rather than only in Python before it?
2. What does the API do for an emergency request, and what does it deliberately not promise?
3. Why does the phone live in the feature's `config`, and what does reading JSONB "defensively" cost?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: (to frame)
- Criteria loosened: none so far (moved unchanged from P6-03b).
- Decisions taken: P6-03b D1 and D3 (its Frame notes), to confirm in framing.
- Split: none.
