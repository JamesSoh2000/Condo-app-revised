# ADR-0016: Occupancy windows are half-open on the database clock; writes serialize per membership

- Status: Accepted
- Date: 2026-10-15
- Deciders: agent (autonomous) in P1-03

## Context

ADR-0010 links residents to units through dated `unit_occupancies` rows, and makes "a unit-addressed record
is visible only if it was created during the viewer's occupancy" the rule against the unit-turnover privacy
bug. It leaves open what exactly "during" means at the edges, which clock stamps the edges, and what keeps
one person's history consistent when two writers act on it at once. Every visibility helper from P5-01 on
builds on the answers (`occupancy_window_clause` in `app/memberships/occupancy.py`).

## Decision

- **Half-open windows.** An occupancy covers `started_at <= T < ended_at`, or from `started_at` on while
  `ended_at` is NULL. A transfer ends the old row and starts the new one at the same instant, so a record
  stamped exactly then belongs to the new occupant only: never to both, never to neither.
- **One clock.** When a helper isn't given `at`, it uses the database's `now()` (the start of the current
  transaction), not the app server's clock. Records default to `now()` too, so both sides of the comparison
  come from Postgres, and an end and a start in one transaction share the same instant.
- **No overlapping history per membership.** `start_occupancy` refuses an `at` earlier than the end of one of
  the membership's earlier occupancies, and `end_occupancy` refuses an `at` before the current row's start
  (`OccupancyTimeError`). This is a check in Python, not a database exclusion constraint. The partial unique
  index `(membership_id) WHERE ended_at IS NULL` still guarantees one current row in the database.
- **Writes serialize per membership.** `start_occupancy`, `end_occupancy` and `transfer_occupancy` first take
  `SELECT … FOR NO KEY UPDATE` on the membership's row. A concurrent write for the same membership waits,
  then (READ COMMITTED: a fresh snapshot per statement) sees what the first committed. Two concurrent
  transfers therefore apply one after the other, and a move-out racing a transfer ends the new row.
- **Helpers flush, never commit**, and take `building_id` so every statement is scoped to one building.

## Consequences

- Positive: a record's visibility at a turnover instant is decided by one comparison on one clock; tests pin
  the edges. Concurrent writers can't leave two current rows or a missed move-out.
- Negative: the overlap rule lives in Python, so raw SQL (seeds, a manual fix) can still write overlapping
  rows for one membership; only "one current row" is enforced by the database.
- Negative: `now()` is the transaction's start. A helper call in a transaction that began before a concurrent
  writer committed can find that writer's row starting after its own `now()`, and gets `OccupancyTimeError`
  rather than a silent overlap; the caller retries.
- The membership row lock is held to the end of the transaction. Services that also lock the building row
  (P4-06's last-manager rule) take the building first, then the membership.

## Alternatives considered

- **Closed windows (`T <= ended_at`):** a record at the transfer instant would be visible to both the
  former and the new occupant.
- **The app server's clock (`datetime.now(UTC)`):** records are stamped by Postgres; two clocks drift.
- **An exclusion constraint** `EXCLUDE USING gist (membership_id WITH =, tstzrange(started_at, ended_at)
  WITH &&)`: enforces non-overlap in the database, but needs the `btree_gist` extension, new database
  infrastructure that CLAUDE.md rule 13 reserves for an ADR of its own.
- **No lock; rely on the conditional `UPDATE` and the unique index:** two concurrent transfers end with one
  `IntegrityError`, but a move-out racing a transfer misses the row the transfer inserted (its `UPDATE` never
  saw it) and silently leaves the person with a current occupancy.

## Revisit when

Occupancies are written outside these helpers (imports, admin SQL), a pilot needs backdated move-ins, or a
second database feature needs `btree_gist` anyway (then add the exclusion constraint).
