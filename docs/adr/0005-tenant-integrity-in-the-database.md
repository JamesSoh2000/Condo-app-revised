# ADR-0005: Tenant integrity enforced by composite foreign keys; RLS deferred

- Status: Accepted
- Date: 2026-10-13

## Context

Application-level filtering (ADR-0004) prevents most tenant leaks, but one forgotten check on a *related* ID
would let a building-A package point at a building-B unit or file. That is a silent integrity bug, and
potentially a privacy leak.

PostgreSQL Row-Level Security (RLS) is another layer. It needs a per-connection tenant setting, care with the
table owner and BYPASSRLS, and its own test suite.

## Decision

- Every tenant-owned table has `building_id NOT NULL` with an FK to `buildings`.
- Every tenant-owned table that other tables reference declares `UNIQUE (building_id, id)`.
- Every reference to another tenant-owned row is a **composite FK** `(building_id, x_id) → x(building_id, id)`.
  The database then rejects cross-building references even if application code forgets.
- Constraint tests (P1-01…P1-03) insert deliberately mismatched rows and assert `IntegrityError`.
- **RLS is explicitly not used in the demo or pilot.** We never claim RLS protection.

## Consequences

- Cross-building references are impossible at the storage layer, which makes them cheap to guarantee.
- There is a slightly wider FK declaration and one extra unique index per referenced table, which is
  negligible.
- **Reads** are still protected only by application filters, the fitness tests and the 10-case test table.
  RLS would add defence in depth for reads.

## Alternatives considered

- **App-level checks only:** one missed check corrupts data.
- **RLS now:** strong, but a significant learning and operations investment before any feature exists.
- **Database per tenant:** strongest isolation, but heavy operations; wrong for many small buildings.

## Revisit when

There are more than about 10 buildings, a third developer, an external security review recommendation, or a
platform-admin feature that reads across tenants. Then evaluate RLS as a second layer.
