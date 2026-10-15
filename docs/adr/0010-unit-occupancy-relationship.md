# ADR-0010: Dated unit occupancy with an owner / tenant / household relationship

- Status: Accepted
- Date: 2026-10-13

## Context

The old plan linked residents to units through dated `resident_unit_occupancies`. That is good, because it
preserves history and prevents a new occupant from inheriting a previous occupant's private records.

The business-side schema (`Process/initial database Structure/metropolis-data-schema.md`) shows a condo
syndicate where **owners** may own several units and **lease** them to tenants. Contributions are charged to
units and owners, and council members are owners.

Without the relationship type, every owner-only feature (council eligibility, contributions, owner notices)
would later need a schema redesign.

## Decision

- **Table `unit_occupancies`:**
  - `building_id`, `unit_id`, `membership_id`
  - `relationship` enum: `owner`, `tenant`, `household`
  - `started_at` timestamptz (default now), `ended_at` timestamptz null. Timestamps, not dates, so the
    visibility window is exact; a human-facing move-in date can be added later
- **Composite FKs** to `units(building_id, id)` and `building_memberships(building_id, id)`.
- **Default cardinality:** one *current* occupancy per membership, via a partial unique index on
  `membership_id WHERE ended_at IS NULL`. Many current occupancies per unit.
- **Operations** (service functions, all audited):
  - `start_occupancy`
  - `transfer` (close + open)
  - `end_occupancy` (move-out; also deactivates the membership unless another occupancy remains)
- **Domain records reference the person** (`recipient_membership_id`, `requested_by_membership_id`), plus the
  unit for addressing.
- **Visibility rule for unit-addressed records:** a resident sees a record only if they are its person-owner,
  or if it is addressed to their unit and was created inside their occupancy period.
- **Not modelled yet:**
  - non-resident owners holding several units (needs the partial unique index relaxed for `owner`)
  - ownership percentages
  - leases as documents

## Consequences

- Owner-only features become a filter, not a migration.
- Unit turnover privacy is a query rule with tests (`former occupant` fixture in P1-05).
- Investors with several units need a later, additive change. Drop or relax the partial index for
  `relationship='owner'`.

## Alternatives considered

- **A `unit_id` column on the membership:** loses history, and causes the turnover privacy bug.
- **Separate `unit_ownerships` and `unit_residencies` tables:** more precise, but more joins and UI work now.
  Revisit if financials need ownership shares.

## Revisit when

Financials or contributions are selected, a pilot building has non-resident owners using the app, or there are
council-election features.
