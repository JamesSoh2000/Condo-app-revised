# P1-06 — Seed data and operator CLI skeleton

| Field | Value |
|---|---|
| Phase / lane | P1 / A |
| Risk tier | 3 |
| Depends on | P1-03 |
| Replaces old | M2-T11 |
| Status | done |

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

1. **Given** an empty migrated DB, **when** `seed` runs twice, **then** the row count of every domain table
   (`buildings`, `building_features`, `units`, `users`, `building_memberships`, `membership_roles`,
   `unit_occupancies`) after the second run equals the count after the first, and no row's id changes.
2. **Given** `APP_ENV=prod`, **when** `seed` runs (with or without `--reset`), **then** it exits non-zero
   with a message naming `APP_ENV=prod`, and writes nothing: the refusal happens before a database session
   is opened.
3. **Given** `APP_ENV=staging`, **then** `seed` works, and `seed --reset` exits non-zero before opening a
   session. `--reset` runs only when `APP_ENV=dev` (also refused under `test`).
4. **Given** the seeded DB, **then**:
   - `maple` ("Maple Tower", `America/Toronto`, join code `MAPLE-2026`) has 40 units, labels `101`–`104`
     through `1001`–`1004` on floors 1–10, and features `packages`, `notices`, `maintenance` enabled
   - `maple` has 6 active `resident` memberships (`resident1`–`resident6`), each with exactly one current
     occupancy, and the 6 together use all 3 relationships (`owner`, `tenant`, `household`)
   - `maple` has exactly 1 `pending` membership (role `resident`, no occupancy)
   - `maple` staff: `manager` (`property_management`), `security` (`security`), `council` (`council`), all
     active, none with an occupancy
   - `birch` ("Birch Court") has 8 units, `birch.manager` (`property_management`) and `birch.resident`
     (`resident`, one current occupancy)
   - every seeded user's email ends in `@example.test` and has a null `password_hash`
5. `python -m app.cli --help` lists `seed`, `bootstrap-building`, `audit`, `jobs-status` and `email-test`.
   Each placeholder exits non-zero with a message naming the ticket that implements it.
6. *(added in framing)* **Given** a dev DB holding rows the seed didn't create (another building, user and
   membership), **when** `seed` runs, **then** those rows are untouched; **when** `seed --reset` runs
   (dev), **then** they are gone and the counts equal a fresh seed's.
7. *(added in framing)* **Given** a seeded DB where seeded data drifted (a seeded resident's occupancy was
   ended, a seeded building renamed), **when** `seed` runs, **then** the seeded values are restored (the
   resident has a current occupancy of their seeded unit again, the name is back) without adding rows
   beyond the restored occupancy.
8. *(added in framing)* `seed` itself never commits; the CLI runner commits once, at the end of the
   command, and on an error commits nothing.
9. *(added in framing)* `Settings(app_env="staging")` is accepted, and rejects a loopback or `*` trusted
   origin, the dev bucket name, and the local-dev `SECRET_KEY`; `prod` keeps all its existing checks.

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
  - 1: "row counts" made concrete (every domain table) and stable ids added: an upsert that deletes and
    re-inserts would keep the counts but break every reference to a seeded row.
  - 2: "writes nothing" made testable: the guard runs before a session is opened, also for `--reset`.
  - 3: `--reset` is dev-only, so it is refused under `test` as well as `staging` and `prod`.
  - 4: the "documented staff" spelled out; "6 residents with current occupancies" pinned to one current
    occupancy each, covering all 3 relationships. `council` holds only the `council` role, so that the
    resident count stays 6 (the test world's `a_council` is also a resident; the seed isn't the world).
  - 5: the placeholders listed by name, and made to fail loudly so a script can't mistake a stub for
    success (the same rule as `make e2e`).
  - 6–8: added. 6 covers the reset path and the case the ticket missed (seed must not touch data it
    didn't create); 7 makes "idempotent upsert" mean converging to the documented state, not only
    "no duplicates"; 8 is the ticket's commit rule as a test.
  - 9: the ticket's "lighter validator for staging", plus the `SECRET_KEY` check (stricter than the
    ticket: staging will sign real sessions from P2-01, so the public dev key is as unsafe there as in
    prod).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - "Check why CI accepts `APP_ENV: test`": the code already has `AppEnv = Literal["dev", "test", "prod"]`
    and `tests/test_config.py::test_test_app_env_is_accepted` (added before this ticket); the ticket's
    Interfaces note was written against older code. Code is the truth; `staging` is added. (code)
  - `make seed` runs `docker compose exec app …`: the compose service is `app`, not `api` as the ticket
    says. (code)
  - The 10-case tenant table doesn't apply: no endpoint. (ticket scope)
  - Seed occupancies start at `now()` on first seed; re-seeds leave an existing current occupancy of the
    seeded unit alone. (autonomous, simplest; recorded in the PR)
- Split: none. Estimate ~320 non-test lines (cli ~70, seed ~170, config ~25, Makefile/README ~50).
