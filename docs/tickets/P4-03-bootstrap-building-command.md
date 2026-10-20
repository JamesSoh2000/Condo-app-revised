# P4-03 — Bootstrap-building operator command

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-02, P4-01, P1-06 |
| Replaces old | M3-T12 (bootstrap part), M4-T09 (pilot data preparation part) |
| Status | in progress |

## Goal

An operator can provision a new building (settings, features, units, and an invitation for the first
manager) with one audited, dry-runnable command that also works in production.

## Why

There is a chicken-and-egg problem: someone has to create the first building and manager. Doing it with ad
hoc SQL is error-prone and unaudited. This command is also the demo's journey 1.

## Scope

- In:
  - **CLI `bootstrap-building`**, options:
    - `--slug`, `--name`, `--address`, `--timezone`
    - `--locale en`
    - `--features packages,notices,maintenance`
    - `--units-csv PATH` (optional)
    - `--manager-email`, `--manager-name`
    - `--reason "…"` (required)
    - `--dry-run`
  - **Validation:**
    - slug format and uniqueness
    - IANA timezone
    - a valid email
    - the CSV, using P4-01's import logic, which is reused rather than duplicated
  - **Effects, in one transaction:**
    - the building with a generated `join_code`
    - the features
    - the units
    - an invitation for the manager with roles `[property_management]`, plus the queued email
    - audit `building.bootstrapped` with `actor_user_id=null` and metadata `{operator: $OPERATOR or $USER,
      reason}`
  - **Output:** a summary, plus the **accept URL printed once to stdout** (so the operator can deliver it if
    email fails). Never log the URL.
  - **Dry run:** prints the plan (counts, features, invitation target) and writes nothing.
  - Works with `APP_ENV=prod` (unlike `seed`).
  - **`docs/runbooks/bootstrap-building.md`:** run locally with
    `docker compose exec api python -m app.cli bootstrap-building …`. D-06 adds the staging variant (the same
    command through SSM Session Manager).
- Out:
  - a building-settings UI (later)
  - a platform-admin UI (later)

## Interfaces

CLI `bootstrap-building`. Audit action `building.bootstrapped`.

## Acceptance criteria

Sharpened while framing (see Frame notes); the original six are kept, numbered as before.

1. **Given** `--dry-run` with valid input, **then** the row counts of `buildings`, `building_features`,
   `units`, `invitations`, `jobs` and `audit_events` are identical before and after, the exit code is 0, and
   stdout shows the plan: slug, name, timezone, locale, the features, the unit count, the invitation target
   (email, role `property_management`) and `dry run: nothing was written`. No accept URL is printed.
2. **Given** a real run with a 40-unit CSV and `--features packages,notices,maintenance`, **then** exactly 1
   building (with a non-null `join_code`), 3 enabled features, 40 units, 1 pending invitation (roles
   `[property_management]`, no unit, `created_by_user_id` NULL), 1 `email.send` job (template `invitation`,
   to the manager) and 1 audit event (`building.bootstrapped`, `actor_user_id` NULL, `building_id` and
   `entity_id` the new building, metadata `{operator, reason, invitation_id, units}`) are created, and stdout
   ends with the accept URL `<APP_BASE_URL>/invite/<token>` exactly once.
3. **Given** the same slug again, **then** it exits non-zero with `slug already exists` on stderr, and nothing
   is written (also with `--dry-run`).
4. **Given** `--timezone Mars/Base`, a malformed CSV row (any row `parse_units_csv` reports invalid), an
   unreadable, non-UTF-8 or malformed CSV file, a bad slug (outside `^[a-z0-9-]{1,63}$`), an invalid
   `--manager-email`, an unknown or repeated feature, an unsupported locale, a blank `--reason`, or neither
   `OPERATOR` nor `USER` set, **then** it exits non-zero with an error naming the option, before any database
   session is opened.
5. **Given** the printed URL, **when** the manager accepts it (P4-02b), **then** they have an active
   membership in the new building with exactly the role `property_management`, and can create a staff
   invitation there (P4-02a, 201).
6. **Given** the logs captured during a real run and the accept, and the audit event's metadata, **then**
   neither contains the token or the URL.
7. *(added)* **Given** `APP_ENV=prod`, **then** the command runs (unlike `seed`).
8. *(added)* **Given** a real run, **then** the command commits once, and an error raised after the first
   write (e.g. the email can't be queued) leaves no building, feature, unit, invitation, job or audit row.
9. *(added)* **Given** an existing building, **then** a bootstrap of another slug changes none of its rows
   (row counts of the world's buildings, units and invitations are unchanged).

## Test plan

- `tests/cli/test_bootstrap.py`, calling the command function with the test session.
- Manual run on the prod-like stack (paste the command and output, with the URL redacted).

## Likely files

`backend/app/cli.py`, `backend/app/buildings/service.py`, `backend/app/units/service.py`,
`docs/runbooks/bootstrap-building.md`, `backend/tests/cli/test_bootstrap.py`.

## Must explain (learning checkpoint)

1. Why an audited CLI instead of an admin web page for this?
2. Why print the URL to stdout but never log it?
3. What would go wrong if bootstrap were not a single transaction?

## Carried from P1-06 (do while framing)

- The compose service is `app`, not `api`: use `docker compose exec app python -m app.cli …` (as `make seed`
  does).

## Carried from P4-01b (do while framing)

- Call `app.units.service.parse_units_csv` (it refuses text over 1 MiB itself) and
  `import_units(db, building_id, parsed, dry_run=False)` inside the command's one transaction; it flushes,
  never commits (`test_import_flushes_but_never_commits`).
- `import_units` writes with Core upserts, so a `Unit` loaded in the same session before the call keeps its
  old floor (review round 3, Low, accepted in PR #85). Don't reuse units loaded before the import, or call
  `db.expire_all()` after it.
- Invalid rows are skipped and reported, not fatal (P4-01 D3): decide while framing whether bootstrap should
  refuse a file with any invalid row (e.g. dry-run first, then fail if `report.invalid`).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - All six criteria made precise (exact tables, columns and outputs) above; AC4 lists every input refused
    before a session; AC3 also applies to a dry run (the slug check is a read).
  - Added AC7 (prod), AC8 (one transaction, rollback on a late failure), AC9 (other buildings untouched:
    the tenant table's "related records of another building" row, the only one that applies to a CLI with
    no request or role).
  - Not applicable from the 10-case table (no HTTP route, no role, no tenant context): rows 1-6, 8-10.
    The accept and invite of AC5 run through P4-02's routes, which their own tests cover.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - F1 `invitations.created_by_user_id` becomes nullable (new expand migration; NULL = created by an
    operator command). The ticket needs an invitation with no inviting user, and the column is NOT NULL.
    The accept already copies it into `status_changed_by_user_id`, which is nullable. Lasting (table shape):
    inbox. Basis: autonomous (rule 3), expand-only (CLAUDE.md rule 11).
  - F2 A CSV with any invalid row refuses the whole run (the P4-01b carry's open question). Basis: AC4.
  - F3 `import_units` takes `audit=False` for bootstrap, so its rows get no `unit.created` events and AC2's
    "1 audit event" holds; the bootstrap event records the unit count. Basis: AC2 + "reuse, don't
    duplicate" (ticket).
  - F4 The invitation is written by the same helper as `create_invitation` (token, hash, 7-day expiry,
    email in the building's locale), with no `invitation.created` event (AC2). Basis: ticket (reuse).
  - F5 `join_code` is generated: 10 characters from an unambiguous upper-case alphabet in two groups,
    `XXXXX-XXXXX` (11 of the column's 16), from `secrets`. Basis: autonomous; the seed's `MAPLE-2026` is
    the same shape.
  - F6 `--features` defaults to `packages,notices,maintenance`; an empty value means none; unknown or
    repeated names are refused. `--locale` defaults to `en` and must be an email locale (`en`, `fr`).
    Basis: ticket's option list; `SUPPORTED_LOCALES`.
  - F7 `--manager-name` is optional and only shown in the plan and summary: invitations store no name and
    the accept form asks for it (P4-02b). Storing it to prefill the form is a follow-up. Basis: code.
  - F8 Operator = `$OPERATOR`, else `$USER`, 1-64 printable characters; neither set is refused (inside
    `docker compose exec` `USER` is usually unset, so the runbook passes `-e OPERATOR`). `--reason` is
    1-500 printable characters. Both are written to the audit metadata as the ticket says; they are the
    operator's own words, not secrets. Basis: ticket.
  - F9 A concurrent bootstrap of the same slug: the building insert is `ON CONFLICT (slug) DO NOTHING`, so
    the loser gets `slug already exists`, not an IntegrityError. Basis: autonomous.
- Split: no. Estimate ~330 non-test lines (CLI ~100, service ~130, schema ~50, invitations and units
  changes ~20, migration ~25), plus the runbook.
