# P1-06 — Seed data and operator CLI skeleton

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 3 |
| Depends on | P1-03 |
| Replaces old | M2-T11 |
| Status | todo |

## Goal

`python -m app.cli` exists, and `make seed` idempotently creates a realistic demo dataset for local and
staging use.

## Why

Humans and agents need a believable building to click through, and later operator commands (bootstrap,
audit, jobs) need a home. One CLI is better than many ad-hoc scripts.

## Scope

- In:
  - **`app/cli.py`** using Typer (`uv add typer`), with commands:
    - `seed [--reset]`
    - placeholder commands added by later tickets (`bootstrap-building`, `audit`, `jobs-status`,
      `email-test`)
    - `python -m app.cli --help` lists them
  - A shared async runner helper: a CLI command opens its own session and **commits at the end of the
    command** (CLI commands are "services" for the commit rule).
  - **Seed dataset** (idempotent upserts by natural keys: building slug, unit `(tower,label)`, user email):
    - Building **"Maple Tower"** (`maple`, `America/Toronto`, join code `MAPLE-2026`): 40 units across floors
      1–10 (labels `101`…`1004`), features `packages`, `notices` and `maintenance` enabled
    - Building **"Birch Court"** (`birch`), 8 units, for multi-tenant demos
    - Users (emails `@example.test`):
      - `manager`, `security`, `council`
      - `resident1`…`resident6` with occupancies across 3 relationships
      - one `pending` resident
      - `birch.manager`, `birch.resident`
    - Passwords are added in P2-01. Until then users have a null `password_hash`.
  - **Environment guard:** `seed` refuses when `APP_ENV=prod`, and runs in `dev` and `staging`.
  - **`--reset`** (dev only) truncates the domain tables before seeding.
  - `make seed` calls `docker compose exec api python -m app.cli seed`.
- Out:
  - the bootstrap command for real buildings (P4-03)
  - packages, notices and other domain data (added to seed by each slice)

## Interfaces

CLI: `python -m app.cli seed [--reset]`. `APP_ENV` becomes `Literal["dev","test","staging","prod"]` (it is
currently `Literal["dev","prod"]`, while CI already sets `APP_ENV: test`, so check why CI accepts that). The
production validator applies to `prod`, and a lighter validator to `staging` (no localhost origins, real
bucket).

## Acceptance criteria

1. **Given** an empty migrated DB, **when** `seed` runs twice, **then** the row counts after the second run
   equal those after the first.
2. **Given** `APP_ENV=prod`, **when** `seed` runs, **then** it exits non-zero with a clear message and writes
   nothing.
3. **Given** `APP_ENV=staging`, **then** `seed` works, and `--reset` is refused.
4. **Given** the seeded DB, **then** `maple` has 40 units, 6 residents with current occupancies, 1 pending
   membership, and the documented staff.
5. `python -m app.cli --help` lists `seed`.

## Test plan

- `tests/test_cli_seed.py`: invoke the command function against the test session (call the underlying async
  function, not a subprocess) for criteria 1–4.
- Commands: `make seed && make seed`, then `make psql` to count rows.

## Likely files

`backend/app/cli.py`, `backend/app/seed.py`, `backend/app/core/config.py`, `Makefile`,
`backend/tests/test_cli_seed.py`, `README.md` (the seeded accounts table).

## Must explain (learning checkpoint)

1. What makes a seed script idempotent, and why does that matter for staging?
2. Why is the CLI allowed to commit, while helpers are not?
3. Why must `seed` refuse to run in production?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
