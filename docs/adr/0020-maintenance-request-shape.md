# ADR-0020: A maintenance request row holds its current state; common areas are free text

- Status: Accepted
- Date: 2026-10-26
- Deciders: agent (autonomous) in P6-03a

## Context

P6-03a creates `maintenance_requests`, the table P6-03b–d and P6-04 build on. Its framing had to fix two shapes
that later tickets can't change cheaply:

- **Where a common-area request is.** A unit request names a unit (composite FK, ADR-0005). A common-area one
  could name a row of a per-building areas table, a value of a fixed enum, or carry free text.
- **What the row says about history.** The state machine repeats statuses: a held request is resumed
  (`on_hold → in_progress`) and may be held again, and a resolved one may be reopened within 14 days
  (`resolved → in_progress`). P6-04c shows a timeline of status changes, to residents too, so the audit log
  (staff and operators only) can't be its source.

## Decision

- **Common area: free text**, `common_area varchar(120)`, not blank, present iff `location = 'common_area'`
  (a check constraint, with `unit_id` present iff `location = 'unit'`). A common-area request is seen by its
  requester and staff only: `occupancy_window_clause` is false without a unit.
- **The row is the current state.** Each status has its own columns and no other status's: `started_*` (the
  first start, kept through hold, resolve and reopen), `on_hold_*` while on hold, `resolved_*` while resolved,
  `cancelled_*` when cancelled. Resume clears `on_hold_*`; reopen clears `resolved_*`. The check constraints
  enforce it per status.
- **History lives in a status-event table**, `maintenance_status_events`, added by P6-03c with the actions that
  write it (start, hold, resolve, reopen). Submit and cancel happen at most once, so `submitted_at` and
  `cancelled_*` on the row are their events.

## Alternatives

- A table of the building's areas: an admin surface and a migration nobody asked for yet, and over P6-03a's
  budget. A fixed enum: buildings' areas differ (a gameroom, a speakeasy). Either can be added later and the
  text kept as a label.
- Keeping every `*_at` once set: a second hold overwrites the first anyway, and every state check would depend
  on the order of earlier moves.

## Consequences

- P6-03c owns the event table and must write an event in the same transaction as each conditional `UPDATE`.
- P6-03c's reopen window reads `resolved_at`, which is on the row exactly while the request is `resolved`.
- Free text means no per-area reporting; a later areas table would be an expand-only migration.
