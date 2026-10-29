# P6-03e — Maintenance cancel and the emergency phone

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03b |
| Replaces old | M8-T01 (resident cancel), M8-T04 (emergency part) |
| Status | in progress |

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
   *Sharpened in framing:*
   - 1a. The answer is 200 with the cancelled request (`MaintenanceRequestOut`: `status = cancelled`,
     `cancelled_at` equal to the row's); `cancelled_at = clock_timestamp()` taken by the `UPDATE` (after any lock
     wait), so `submitted_at ≤ cancelled_at ≤` the test's next `clock_timestamp()`;
     `cancelled_by_membership_id = ctx.membership_id`; the audit row is exactly
     `(maintenance.cancelled, maintenance_request, <id>, actor ctx.user_id, {"from_status": "submitted"})`.
     A request body is ignored (none is defined): `{"cancelled_by_membership_id": …}` changes nothing.
   - 1b. Ownership is answered before the status: the co-occupant gets 403 `not_requester` on a request that is
     no longer `submitted` too (they could never cancel it).
   - 1c. *(Missed case.)* The requester need not live in the unit any more: `a_former` cancels their own 101
     request filed before T1 (200), while `a_resident1`, who lives in 101 now but not when it was filed, gets
     404 `maintenance_request_not_found` on it (the occupancy window, CLAUDE.md rule 3). `a_council` (council +
     resident) cancels their own request; a common-area request is cancelled by its requester.
   - 1d. The race test proves the cancel was **blocked by the start's lock** (`act_blocked_on_lock`,
     `tests/helpers/lock_wait.py`), not merely slow; it gets 409 `invalid_transition`, the row stays
     `in_progress` and no `maintenance.cancelled` row is written. The same with the start rolled back instead:
     the cancel then wins (200).
2. **Emergency** (P6-03b criterion 7). **Given** `category = emergency`, **then** the 201 and every read of that
   request include the building's `emergency_phone`, in the list too, and the cancel's answer; no other category
   does; a building with no phone, or a `config` value that isn't a non-blank string of at most 32 characters,
   gives `emergency_phone: null`; another building's phone is never shown. The seed sets Maple's;
   `bootstrap-building --emergency-phone` sets a new building's (refused, naming the option, without the
   `maintenance` feature; printable, stripped, at most 32 characters). The app never claims to have alerted
   anyone (stub: "never rely on the app").
   *Sharpened in framing:*
   - 2a. "Every read" is: the create's 201, its idempotent replay (201, `Idempotent-Replayed: true`), `GET` one
     and the list, for the requester, `a_manager` and `a_security`, and the cancel's 200. The value returned is
     the stored one stripped of surrounding whitespace, read at answer time (a phone changed in `config` shows
     on the next read). A list mixing categories carries the phone on the emergency items only.
   - 2b. The null cases, each tested: no `emergency_phone` key, JSON `null`, `""`, whitespace only, a number,
     a list, 33 characters; a feature row whose whole `config` is not an object (a JSON string or array) also
     gives null, never a 500.
   - 2c. "Never claims to have alerted anyone": the OpenAPI description of `emergency_phone` and the create
     route say the app alerts no one (call the number); no field or message says anyone was notified by phone.
   - 2d. *(Missed case.)* The bootstrap plan (`--dry-run`) and summary print `emergency phone: <value>` when
     one is given, so the operator sees what will be stored before writing; without one, no such line. A phone
     with a control character (newline, tab), blank, or over 32 characters after the strip is refused naming
     `--emergency-phone`, before any database session.
3. **The tenant table on cancel** (P6-03b rows 1, 2, 3, 4, 5, 6, 7, 8, 10 for this route): the requester
   cancels their own; signed out 401; `b_manager`, `a_pending`, `a_suspended` 404 `building_not_found`;
   `a_manager` and `a_security` 403 `forbidden_role`; `a_resident2` on `a_resident1`'s request and a B request
   on A's URL 404 `maintenance_request_not_found`, the same body as a random id; a request that isn't
   `submitted` 409 `invalid_transition`; two cancels at once give one 200 and one 409, with one audit row.
   *Sharpened in framing:* row 8 covers each non-`submitted` status (`in_progress`, `on_hold`, `resolved`,
   `cancelled`), each 409 with nothing written; rows 3–7 write nothing (row counts unchanged). Row 7 (an ID
   from the body) has no body here: the B request's id on A's URL is its form. Row 9 (idempotency) is n/a: a
   second cancel is the 409 of row 8.
4. **Feature off** and **atomicity**: cancel gives 403 `feature_disabled` with `maintenance` off; a forced
   failure after the `UPDATE` leaves the request `submitted` and no audit row.
   *Sharpened in framing:* "after the `UPDATE`" is a failure raised by `record_audit` (after the `UPDATE`, before
   the commit): the request keeps `status = submitted`, `cancelled_at` and `cancelled_by_membership_id` null.

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

Framed on `origin/main` at `ceec5c4` (P6-03b merged as #138, WF-02b's `act_blocked_on_lock` merged as #145).
`p6-03e-start` branched from P6-03a's merge, before P6-03b's review fixes and the record fence (ADR-0021 on
`main`): only its cancel and phone parts are ported; its other differences from `main` are older P6-03b code
and are not taken.

- Criteria added or sharpened: 1a (the answer's shape, the clock, the exact audit row, a body is ignored); 1b
  (ownership before status); 1c (missed case: a requester who moved out still cancels their own, and the unit's
  current occupant can't see it; `a_council`; common area); 1d (the race proven with `act_blocked_on_lock`, and
  its rolled-back variant); 2a ("every read" listed, including the idempotent replay; stripped; read at answer
  time; mixed list); 2b (each null case, including a non-object `config`); 2c (what "never claims" means,
  testably); 2d (missed case: the bootstrap plan and summary show the phone; the refusals listed); 3 (row 8 per
  status, nothing written on refusals, rows 7 and 9 explained); 4 (where the forced failure is).
- Criteria loosened: none.
- Tenant table (ENGINEERING_PRACTICES §7) on `POST …/{id}/cancel`: rows 1–8 and 10 as criterion 3; row 9 n/a
  (an action on an existing row: a repeat is row 8's 409). The emergency phone adds no route; its row 5
  (another building's phone) is in criterion 2.
- Decisions taken:
  - **D1** (P6-03b D1, confirmed): the phone is the `maintenance` feature row's `config["emergency_phone"]`.
    The ADR drafted as 0021 on `p6-03e-start` is written as **ADR-0022** (`main` took 0021 for the record
    fence), and its inbox line comes in step 6.
  - **D3** (P6-03b D3, confirmed): the requester only; 403 `not_requester` for a co-occupant who sees it; 404
    for anyone who doesn't.
  - **E1** (new, rule 3): the cancel follows `app/packages/service.py::_transition` (an unlocked early check
    for the answer, then the conditional `UPDATE` decides), as the ticket's race wording ("the cancel waits")
    describes, rather than notices' lock-first `_locked`. The audit's `from_status` is taken from the state
    machine (the only source of `cancelled`, `submitted`), not from the value read before the `UPDATE`'s lock
    wait (the CLAUDE.md lesson on values read before a wait).
    *Changed during implementation (PR "Decisions and alternatives" E1):* a criterion 1a test showed that
    an `UPDATE` waiting on a lock released without a change keeps the `clock_timestamp()` it computed
    before the wait, so the cancel now locks the row first (`SELECT … FOR UPDATE`, as notices'
    `_locked`); the `UPDATE` keeps the requester and status in its `WHERE`, and `from_status` is read
    under the lock. No criterion changed.
  - **E2** (new, rule 3): the bootstrap plan and summary print the phone (2d); the bootstrap audit metadata is
    unchanged (it records no feature settings today).
- Estimate: ~180 non-test lines (`p6-03e-start` measured ~170, plus 2d's line and the non-object `config`
  guard). No split.
- Split: none.
