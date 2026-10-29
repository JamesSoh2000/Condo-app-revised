# P6-03c — Maintenance manager actions: start, hold, resolve, reopen

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03b, P6-03e, P3-03, P3-02 |
| Replaces old | M8-T01 (management actions part), M8-T04 (status-change part) |
| Status | todo |

Split from the P6-03 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); the schema is
[P6-03a](./P6-03a-maintenance-schema-and-visibility.md), submit and read
[P6-03b](./P6-03b-maintenance-submit-and-read-api.md), comments [P6-03d](./P6-03d-maintenance-comments.md).

## Goal

A manager moves a request through `in_progress`, `on_hold` and `resolved`, and reopens a resolved one within
14 days; each change notifies the people framing decides and is audited.

## Why

The manager's half of journey 6 ("the manager moves it through the states"; "the resident sees the status
changes"), on the transition pattern of P5-02b (CLAUDE.md rule 7). Reopen is the first action in the app with a
**time limit**, and the stub carries a process fix for it: the "time check before a later wait" mistake happened
three times (P4-02b, P6-01b R1, P6-01c R1) despite the `CLAUDE.md` lesson, so this ticket adds a reusable test
helper that makes every later wait visible.

## Scope

- In (building router, `require_feature(Feature.MAINTENANCE)`, `require_roles(Role.PROPERTY_MANAGEMENT)` on every
  route; stub default: security reads and comments only):
  - **`POST /maintenance-requests/{id}/start`**, **`/hold`**, **`/resolve`**, **`/reopen`**: each a conditional
    `UPDATE … WHERE status IN (sources(to)) RETURNING` with P6-03a's `*_at` / `*_by_membership_id` columns set
    from the database clock and the caller; → 200 `MaintenanceRequestOut`
  - **reopen** only while `resolved_at` is within 14 days of the database clock, checked in the writing
    `UPDATE`'s `WHERE` and again after the last statement that can wait (see criterion 5)
  - notifications on each status change (stub: "notify on status changes"): the kinds in
    `app/notifications/kinds.py`, and an email template if a kind emails
  - audit `maintenance.started`, `maintenance.held`, `maintenance.resolved`, `maintenance.reopened`
  - **the row-lock test helper** (stub "Step 8", moved from P6-02): `tests/helpers/locks.py`, documented in
    `tests/README.md`
  - `make gen-api`
- Out:
  - comments, including a resolution note (P6-03d; a manager comments, then resolves)
  - assigning a request to a person, scheduling, priority (not in the stub; follow-ups if framing finds a need)
  - an expiry job for the reopen window: the window is a `WHERE` on the database clock, no job (P6-01a D5)
  - the frontend (P6-04)

## Interfaces

Operation ids `maintenance_start`, `maintenance_hold`, `maintenance_resolve`, `maintenance_reopen`.

- No request body (the action is the verb). If framing gives `hold` a reason, it is a `MaintenanceHold(InputModel)`
  with a `max_length` and is shown to whoever sees the request.
- Errors: 404 `maintenance_request_not_found`; 409 `invalid_transition`; 409 or 422 for a reopen past its window
  (code decided in framing, for example 409 `reopen_window_closed`); 403 `forbidden_role`.
- **Test helper** `tests/helpers/locks.py::hold_row_lock(sessions, statement)` (name and shape decided while
  building): an async context manager that, in its own session, takes `FOR UPDATE` on the rows `statement`
  selects (a membership, a file, a request), yields once the lock is held, and on exit rolls back; plus a way to
  assert that the request under test is **waiting** on it (the `before_cursor_execute` event that
  `tests/notices/test_concurrency.py::test_a_notice_expiring_while_its_fan_out_waits_is_not_published` uses by
  hand). That test is rewritten on the helper as its first user, and keeps passing.

## Acceptance criteria

1. **The 10-case table** for each action: `a_manager` succeeds; `a_security`, `a_resident1` (the requester),
   `a_council` and `multi_in_a` get 403 `forbidden_role`; signed out 401; `b_manager`, `a_pending`,
   `a_suspended` 404 `building_not_found`; a building-B request on A's URL is 404
   `maintenance_request_not_found` for `a_manager`, the same body (minus `request_id`) as a random id; each
   disallowed source status gives 409 `invalid_transition` (one parametrized case per pair outside `ALLOWED`);
   `maintenance` disabled gives 403 `feature_disabled`; two concurrent identical actions give one 200 and one 409
   with one audit row and one set of notifications.
2. **Columns.** **Given** each allowed move, **then** the row has exactly P6-03a's columns for the new status,
   set from the database clock (`statement_timestamp()`, as `app/notices/service.py::_NOW`) and
   `ctx.membership_id`, and P6-03a's check constraints never refuse a request the API accepted (no 500).
3. **Races.** **Given** a `submitted` request, **when** the requester cancels (P6-03e) and the manager starts at
   once, **then** exactly one wins and the other gets 409 `invalid_transition`; likewise hold vs resolve, and
   resolve vs reopen. Each loser writes no audit row and no notification.
4. **Reopen window.** **Given** a request resolved 14 days minus one minute ago (by the database clock), **then**
   reopen succeeds and leads to the status framing decides, with `resolved_at` kept or cleared as decided; at
   exactly 14 days and after, it gives the window error and the row is unchanged; a `cancelled` request can't be
   reopened (409 `invalid_transition`) unless framing allows it.
5. **The window is checked after the last wait** (the stub's "Step 8"; `CLAUDE.md` lesson "after the *last*
   statement that can wait"). With `hold_row_lock`, for **every** statement after the window check that can wait
   — at least the request row (a concurrent action holding it), each notification recipient's membership (the
   notifications `INSERT` takes `KEY SHARE`), and the notification dedupe key if the kind has one — a reopen whose
   window closes while it waits gives the window error, and writes no status change, notification, job or audit
   row. The test asserts the request was waiting (not merely slow), and lists each statement it covers; the PR
   lists the statements of the reopen path that can wait and which test covers each.
6. **Notifications.** For each status change, the recipients framing decides get one notification of the decided
   kind, linking to `/maintenance/<id>` (or the path P6-04 will use, decided in framing), with a fixed title and no
   text a recipient couldn't see on the request; the actor is never notified; a resident who can no longer see the
   request (a moved-out co-occupant, if P6-03a's window excludes them) is never notified; an emailing kind queues
   one `email.send` job per recipient with an address, sent by the worker (rule 6), and the email names no
   internal detail.
6a. **Repeated changes still email.** `notify` builds each email job's dedupe key as
   `<kind>:<entity_id>:<user_id>` (`app/notifications/service.py::notify`), and `jobs.dedupe_key` is unique with
   no expiry, so a second change of the same kind on the same request (hold, start, hold again; resolve, reopen,
   resolve) would queue **no** email. **Given** an emailing kind and two such changes, **then** the recipient gets
   two `email.send` jobs; how (a per-event `entity_id`, a kind per status, or a change to `notify` that keeps the
   retry protection the key exists for) is decided in framing, and a change to `notify` keeps every existing
   `tests/notifications` and `tests/notices` test passing.
7. **Atomicity.** A forced failure after the `UPDATE` and before commit leaves the row, the notifications, the
   jobs and the audit as before.
8. **Audit.** One row per action: `maintenance.started` / `held` / `resolved` / `reopened`, metadata
   `from_status` (and `to_status` for reopen), actor `ctx.user_id`, entity `maintenance_request`/id; no text.
9. **The helper can fail.** A mutation probe (`scripts/mutation-probe.sh`) moves reopen's window check before
   the notification `INSERT` only (as P6-01c R1 found in publish) and the criterion-5 test fails; the PR pastes
   both outputs.

## Test plan

- `backend/tests/maintenance/test_transitions.py` (1, 2, 4), `test_concurrency.py` (1 row 10, 3, 5),
  `test_notify.py` (6), `test_atomicity.py` (7), audit assertions in each.
- `backend/tests/helpers/locks.py` with its own test (`tests/test_locks_helper.py`, next to the other
  top-level infrastructure tests: the lock is held while yielded and released on exit, including when the body
  raises); `tests/notices/test_concurrency.py` moved onto
  it, unchanged in what it asserts.
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/maintenance tests/notices tests/helpers -q`;
  `scripts/mutation-probe.sh` for criterion 9; `make gen-api`.

## Likely files

`backend/app/maintenance/{service,router,schemas}.py`, `backend/app/notifications/kinds.py`,
`backend/app/email/templates/en/*` (if a kind emails), `backend/app/audit/actions.py`, `backend/tests/helpers/
locks.py`, `backend/tests/README.md`, `backend/tests/notices/test_concurrency.py`, `frontend/src/api/schema.d.ts`,
`backend/tests/maintenance/*`. Copy from `app/notices/service.py::publish_notice` (the check after the fan-out)
and `app/packages/service.py::_transition`.

Estimate: ~300 non-test lines (service 170, router 60, kinds, template and actions 40, schemas 20, `tests/README`
10). The helper is test code and doesn't count.

## Must explain (learning checkpoint)

1. List every statement of `POST …/reopen` that can wait, and show which one the window is checked after and why
   checking it in the `UPDATE` alone was not enough for publish (P6-01c R1).
2. Which clock does the window use, and why not `now()` or the host's clock?
3. Of a cancel and a start at once, which statement decides the winner, and what does the loser see?
4. How does the helper prove a request was waiting on the lock, rather than just slow?

## Open decisions (resolve while framing)

Carried from P6-03a (PR #137, ADR-0020): the row holds only the current state, so reopen leads to `in_progress`
and clears `resolved_*`, resume clears `on_hold_*`, and `started_*` is kept. This ticket adds
`maintenance_status_events` (building, request, status, at, by membership; composite FKs) and writes one in the
same transaction as each conditional `UPDATE`, for P6-04c's timeline. The reopen window reads `resolved_at`.
`cancelled` is final, so reopen doesn't apply to it.

From the stub ("Decide while framing"):
- **Can security act on maintenance?** Stub default: **no** (read and comment only), so every action here is
  property management only.

From the stub's "Step 8": the helper is required; its name and API are the builder's.

From the stub's P5-05 recipe check:
- what `reopen` leads to (`in_progress`?) and whether it clears `resolved_at` (P6-03a sets the columns; this
  ticket implements the move)
- who is notified for each status change (the requester; the unit's current occupants who can see it; managers
  when another manager acts?) and which kinds send email

Left open by the stub:
- the window error's status and code
- whether `hold` takes a reason (the stub has none; a public comment can carry it)
- whether `reopen` applies to `cancelled`
- whether the 14 days count from `resolved_at` or from the last transition
- how a repeated status change of one kind gets its own email (criterion 6a)

## Carried from P6-03e (PR #149)

- **Lock before you write a time or `from_status`.** P6-03e's cancel locks the request first
  (`backend/app/maintenance/service.py::_for_cancel`, `SELECT … FOR UPDATE OF maintenance_requests`), then runs
  the conditional `UPDATE`. The plan's unlocked version (`app/packages/service.py::_transition`) failed a test:
  an `UPDATE` that waits on a lock released without a change keeps the `clock_timestamp()` it computed before
  the wait. Start, hold, resolve and reopen record times and `from_status`: copy the lock-first shape, and
  prove each wait with `act_blocked_on_lock` (see `tests/maintenance/test_concurrency.py::
  test_a_cancel_blocked_by_a_start_gets_409`). Start-vs-cancel is now serialized by that lock.
- **Decide whether managers are notified when a resident cancels** (P6-03e sends nothing).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
