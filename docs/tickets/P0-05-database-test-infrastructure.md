# P0-05 — Database test infrastructure

| Field | Value |
|---|---|
| Phase / lane | P0 / A |
| Risk tier | 2 |
| Depends on | P0-02 (shares the CI workflow file) |
| Replaces old | M2-T07 (infrastructure part), M1-T05 (migration checks) |
| Status | todo |

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
2. **Given** a model change without a migration, **when** CI runs, **then** `alembic check` fails.
3. **Given** two migration heads, **when** CI runs, **then** the single-head step fails.
4. **Given** the dev database `condo_dev` has data, **when** `make test` runs, **then** `condo_dev` is
   untouched.
5. **Given** CI, **then** the backend job runs against Postgres and passes.

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

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
