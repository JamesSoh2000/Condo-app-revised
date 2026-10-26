# ADR-0021: The record fence: an occupancy write never moves a window edge behind a record stamped since

- Status: Accepted
- Date: 2026-10-26
- Deciders: agent in P6-03b, from James's answer to inbox B-10 (option A, in session). Extends
  [ADR-0016](./0016-occupancy-windows-and-writes.md); its "one clock" stays.

## Context

ADR-0016 stamps occupancy edges and records with the transaction's `now()`, which is when the transaction
**began**, and refuses a stale writer only against other occupancy rows. P6-03b review round 2 (F1, High,
reproduced) found the gap that leaves. A manager's transfer whose transaction began before a resident's
maintenance create, but took the membership lock after the create committed, ended the resident's occupancy
and started the newcomer's at its own earlier `now()`. The committed request then fell after the requester's
move-out and inside the incoming household's window: the newcomer read the outgoing household's request and
photo, the turnover leak ADR-0010 exists to prevent. The create can't detect a transaction that hasn't locked
yet; only the occupancy write, once it holds the lock, can see the record. Packages (`received_at = now()`)
have the same gap.

## Decision

- **A fence in the occupancy helpers.** Called without `at`, `start_occupancy` checks the unit it starts,
  `end_occupancy` the unit it ended, and `transfer_occupancy` both. If a registered unit-addressed record of
  that unit was stamped after `at`, the helper raises `OccupancyTimeError`, so the caller's transaction rolls
  back. The caller retries in a new transaction, whose `now()` is later than the record.
- **The end side is what closes R2 F1, and it is complete.** A create locks its requester's membership
  `FOR SHARE` until it commits, and ending that membership's occupancy locks the same row first: the fence
  runs after the create committed, and READ COMMITTED shows its row. So a requester's window never ends
  before their own request.
- **The start side is conservative, not required.** A newcomer's start locks the newcomer's membership,
  which the create doesn't hold, so it sees only records already committed. When it misses an uncommitted
  one, the result is the same as the serial order "move in, then the request": the newcomer was a
  co-occupant when the request was filed, and `visible_maintenance` shows a co-occupant's unit requests by
  design (review round 3 raised this case; the serial run gives the same answer). Every outcome is then one
  that some serial order of the same operations gives, which is the property R2 F1 broke.
- **Domains register their records.** `register_unit_record(building_col, unit_col, time_col)` in
  `app/memberships/occupancy.py`, called next to the model (`app/maintenance/models.py`), so every process
  that loads the models has the fence and `memberships` never imports a record domain. Maintenance requests
  are registered now (`submitted_at`); packages can follow (follow-up).
- **An explicit `at` is not fenced.** It is for seeds, tests and backfills (ADR-0016), which set times on
  purpose.
- **Every caller answers 409 `occupancy_changed`.** Memberships already mapped `OccupancyTimeError`;
  onboarding approve (`start_occupancy`) and invitation accept (`transfer_occupancy`, `end_occupancy`) now do
  too, instead of a 500.

## Consequences

- Positive: a record stamped by a transaction that committed before an occupancy write took its lock is never
  left on the wrong side of the edge that write sets. Same-transaction records (stamped `= at`) are unaffected,
  so "a record stamped right after a transfer belongs to the new occupant" still holds.
- Negative: a move-out, transfer, approval or accept that races a resident's create gets a 409 and must be
  retried. That is rare (the windows are milliseconds) and the retry succeeds.
- Negative: the fence is conservative. It refuses on any later record of the unit, including a co-occupant's
  that the edge wouldn't have exposed.
- Negative: one indexed `EXISTS` per registered record type and fenced unit on each occupancy write
  (`ix_maintenance_requests_building_id_unit_id_submitted_at`).
- Negative: a record type that isn't registered keeps the gap. Packages do today.

## Alternatives considered

- **Resolve `at` with `clock_timestamp()` after the lock** (B-10 option B): closes it for every record type,
  but supersedes "one clock" and breaks the same-transaction rule many tests pin.
- **Accept and document** (B-10 option C): leaves a reproduced turnover leak in the visibility rule CLAUDE.md
  rule 3 makes non-negotiable.
- **A check in the record's create:** it can't see a transaction that hasn't locked yet.

## Revisit when

A unit-addressed record type is added (register it), or occupancy writes start failing with 409 often enough to
need an automatic retry.
