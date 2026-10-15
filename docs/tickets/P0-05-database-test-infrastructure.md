# P0-05 — Database test infrastructure

| Field | Value |
|---|---|
| Phase / lane | P0 / A |
| Risk tier | 2 |
| Depends on | P0-02 (shares the CI workflow file) |
| Replaces old | M2-T07 (infrastructure part), M1-T05 (migration checks) |
| Status | in progress |

## Goal

Tests run against a real PostgreSQL test database built by Alembic. Each test is isolated by a rolled-back
transaction, even when code under test calls `commit()`. CI verifies migrations.

## Why

Every critical property here lives in the database: constraints, composite FKs, atomic transitions, the
outbox. Mocks cannot prove them. See [02 §14](../ARCHITECTURE.md#14-testing-architecture).

## Scope

- In:
  - **Settings:** `TEST_DATABASE_URL` (default `postgresql+asyncpg://postgres:devpassword@localhost:5432/condo_test`).
    A compose init script, or the session fixture, creates `condo_test` if it is missing.
  - **Session-scoped fixture:** drop and recreate the `public` schema in the test DB, then run
    `alembic upgrade head` programmatically against it.
  - **Function-scoped `db` fixture:**
    ```python
    async with engine.connect() as conn:
        trans = await conn.begin()
        session = AsyncSession(bind=conn, join_transaction_mode="create_savepoint", expire_on_commit=False)
        yield session
        await session.close()
        await trans.rollback()
    ```
  - The `client` fixture overrides `get_db_session` (`app/core/dependencies.py`) to yield that session.
  - **Async test runner:**
    - Keep the existing anyio plugin, with a session-scoped `anyio_backend`.
    - If session-scoped async fixtures conflict with the event loop, switch to pytest-asyncio (`asyncio_mode = "auto"`, session loop scope).
    - Record which you chose in the explanation.
  - **CI `backend` job:**
    - a `services: postgres:16` container with a health check
    - steps: `alembic upgrade head`, `alembic check` (fails on model/migration drift), and a single-head check
      (`test "$(uv run alembic heads | wc -l)" -eq 1`)
    - then pytest against `TEST_DATABASE_URL`
  - Remove `READINESS_CHECK_DATABASE: "false"` from CI where it is no longer needed.
- Out:
  - domain factories and world fixtures (P1-05)

## Interfaces

Fixtures `engine` (session), `db` (function), `client` (function, using `db`). Env `TEST_DATABASE_URL`.

## Acceptance criteria

1. **Given** test 1 creates table `_probe`, inserts a row and calls `await db.commit()`, **when** test 2
   runs, **then** `_probe` does not exist. This shows both commit-inside-savepoint and transactional DDL.
   *(sharpened)* Test 1 also proves, after its `commit()`, that (a) its own session still sees the row and
   (b) a **separate** connection does not see `_probe` (the outer transaction is still open). Test 2 checks
   with `to_regclass('public._probe') IS NULL`.
2. **Given** a model change without a migration, **when** CI runs, **then** `alembic check` fails.
   Evidence: a demo commit on the PR branch (a probe model imported by `env.py`), its failing run URL and
   the log line, then the revert.
3. **Given** two migration heads, **when** CI runs, **then** the single-head step fails. The single-head
   step runs **before** `alembic upgrade head` (which would otherwise fail first with "Multiple head
   revisions"). Evidence as in AC2.
4. **Given** the dev database `condo_dev` has data, **when** the backend tests run, **then** `condo_dev` is
   untouched. *(changed)* `make test` arrives in P0-04, so the evidence is `cd backend && uv run pytest`:
   a marker table and row in `condo_dev` survive a full test run (transcript).
5. **Given** CI, **then** the backend job runs against Postgres and passes.
6. *(added)* **Given** `TEST_DATABASE_URL` points at a database whose name does not end in `_test`, or at
   the same database as `DATABASE_URL`, **when** the test session starts, **then** it aborts before
   dropping anything (unit test of the guard).
7. *(added)* **Given** `condo_test` does not exist, **when** the test session starts, **then** it is created
   and migrated (CI starts with only `condo_dev`, so CI proves it).
8. *(added)* **Given** the `client` fixture, **then** a request handled through `get_db_session` uses the
   test's `db` session (a test reads, through a probe dependency, data the test inserted but never
   committed outside the savepoint).

## Test plan

- `tests/test_db_isolation.py` with the two-test probe.
- Demonstrate criteria 2 and 3 once on a throwaway branch.
- Commands: `make test`; `cd backend && uv run alembic check`.

## Likely files

`backend/tests/conftest.py`, `backend/tests/test_db_isolation.py`, `backend/app/core/config.py`,
`backend/migrations/env.py` (accept a URL override), `backend/pyproject.toml` (pytest config),
`.github/workflows/<ci>.yml`, `docker-compose.yml` (optional init script).

## Must explain (learning checkpoint)

1. How does `join_transaction_mode="create_savepoint"` let a service call `commit()` while the test still rolls
   everything back?
2. Why does `CREATE TABLE` roll back in PostgreSQL, and would it in MySQL?
3. Why is building the test schema with `alembic upgrade head`, not `Base.metadata.create_all()`, a better
   test of reality?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC1 (also proves the commit stayed inside the outer transaction, from a
  second connection), AC2/AC3 (evidence named; single-head check ordered before `upgrade`), AC6 (guard
  against dropping a non-test database), AC7 (test DB auto-created), AC8 (`client` really uses `db`).
- Criteria loosened (with reason; also listed in the inbox): AC4's command changes from `make test` to
  `cd backend && uv run pytest`, because the Makefile is added in P0-04 (P0-04 depends on this ticket's
  sibling, not the reverse). Same property, same evidence.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - `migrations/env.py` takes the URL from `config.attributes["database_url"]` when a caller sets it, else
    `settings.database_url` (ticket: "accept a URL override"; `alembic.ini`'s `sqlalchemy.url` holds a
    placeholder, so it can't be the override).
  - The schema reset and `alembic upgrade head` run in a **sync** session fixture (`asyncio.run` /
    Alembic's own `asyncio.run` in `env.py` cannot run inside the test event loop); the async `engine`
    fixture is session-scoped with a session-scoped `anyio_backend` (ticket: keep anyio if it works).
  - The fixture creates `condo_test` through the `postgres` maintenance database; no compose init script
    (compose is a hot file, and the fixture covers CI and local alike).
  - The guard (AC6) is a plain function in `tests/conftest.py`, unit-tested.
  - CI service DB is `condo_dev` (as in compose); `DATABASE_URL` points at it for `alembic upgrade/check`.
- Split: none (estimate ~60 non-test lines: settings, env.py, CI; the fixtures are test code).
