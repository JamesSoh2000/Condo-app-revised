# P4-03 — Bootstrap-building operator command

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-02, P4-01, P1-06 |
| Replaces old | M3-T12 (bootstrap part), M4-T09 (pilot data preparation part) |
| Status | todo |

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

1. **Given** `--dry-run`, **then** the table row counts before and after are identical, and the plan is
   printed.
2. **Given** a real run with a 40-unit CSV, **then** exactly 1 building, 3 features, 40 units, 1 invitation, 1
   email job and 1 audit event are created.
3. **Given** the same slug again, **then** it exits non-zero with `slug already exists`, and nothing is written.
4. **Given** `--timezone Mars/Base` or a malformed CSV row, **then** it exits non-zero before writing.
5. **Given** the printed URL, **when** the manager accepts, **then** they log in as active
   `property_management` and can invite staff (P4-02).
6. **Given** the logs and the audit metadata, **then** they contain no token or URL.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
