# ADR-0021: A feature's per-building settings live in `building_features.config`; the emergency phone first

- Status: Accepted
- Date: 2026-10-26
- Deciders: agent (autonomous) in P6-03b

## Context

P6-03b returns the building's emergency phone with every `emergency` maintenance request (stub: "show the
building's emergency phone, and never rely on the app"). The phone has to live somewhere. Two homes exist
already: a column on `buildings` (name, address, timezone, locale) or the JSONB `config` of the building's
`building_features` row for `maintenance`, which every feature row has (default `{}`) and nothing reads yet. No
API edits building settings; operators provision buildings with `bootstrap-building` (P4-03) and the demo with
the seed.

## Decision

- **A setting that only matters while a feature is on lives in that feature's `config`.** The emergency phone is
  `config["emergency_phone"]` on the `maintenance` row: a string, printable, at most 32 characters (as
  `users.phone`).
- The feature's own module reads it (`app.maintenance.service`), and reads defensively: anything other than a
  non-blank string reads as "none" (`emergency_phone: null`), never a 500.
- It is set by `bootstrap-building --emergency-phone` (refused unless `maintenance` is among `--features`) and
  by the seed. No API edits it until a ticket adds building settings.

## Alternatives

- `buildings.emergency_phone`: a typed column, but a migration for a value only maintenance reads, and by
  P6-03b's sizing rule it would have pushed cancel out of the ticket. A building without maintenance would
  still carry the column.
- A new `building_settings` table: a schema and an admin surface nobody asked for yet.

## Consequences

- No database type or length check: the writers (`BootstrapInput`, the seed) validate, and the reader tolerates
  anything else. A hand-edited `config` can't break a request, only hide the phone.
- A later settings API writes the same key; moving it to a column is a backfill from `config`.
- Other features' settings (P6-05's thresholds, say) follow the same rule: their feature's `config`, read and
  validated by their own module.
