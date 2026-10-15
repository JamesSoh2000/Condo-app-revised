# Explanation — P0-05 Database test infrastructure

> Code at the head of PR #4 (2026-10-15), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md));
> no human reviewed it. The branch is rebased onto the latest `main`. Snapshot: if the code changes later,
> write a new explanation; lasting decisions live in ADRs.
> Form: full (Tier 2). Walkthrough variant: C (process: one `make test` run, from schema rebuild to the
> per-test rollback).

**Findings for the implementer (code vs PR):**

1. The PR's **Plan** still says the `client` fixture "overrides `get_db_session` with `db`", and the
   ticket's **Interfaces** say "`client` (function, using `db`)". The code does neither: `client` depends on
   a new `db_connection` fixture and gives each request its own session (B-1 option A). The PR's Decisions
   table and the ticket's Frame notes are correct; the Plan bullet and the Interfaces line are stale, and
   `db_connection` is not listed as an interface.
2. The PR says **"Round 4: pending"**, but the head commit is `docs(tests): client fixture harness rules
   (review round 4, L1-L3)`. Round 4's verdict and findings are not recorded in the PR, the ticket or the
   inbox, so §6 below cannot state them. The merge gate needs that round written up.
3. The commit SHAs quoted in the PR body (`87591ec`, `dd9932f`, `edb96fe`, `a677290`, `30a2fa8`,
   `27256a1`, `a3f0e0f`) predate the rebase; the branch now has different SHAs for the same commits
   (for example the AC2 demo is `9e121dc`, its revert `5e2bc6b`). The CI run links still hold.

## 1. What was built and why

Backend tests now run against a real PostgreSQL database, `condo_test`, whose schema is built by the real
Alembic migrations. Each test runs inside one transaction that is always rolled back, even when the code
under test calls `commit()`. CI starts Postgres 16 and checks the migrations (one head, upgrade, no drift).

## 2. Decisions

| Decision | Alternative rejected | Why | Basis |
|---|---|---|---|
| Keep the anyio pytest plugin, with a session-scoped `anyio_backend` and a session-scoped async `engine` | pytest-asyncio with `asyncio_mode = "auto"` | anyio worked with a session-scoped engine; no new dependency. **This is the runner choice the ticket asked to record.** | ticket ("keep anyio if it works") |
| Schema reset and `alembic upgrade head` in a **sync** session fixture (`backend/tests/conftest.py::migrated_test_database`) | An async fixture calling Alembic | `backend/migrations/env.py::run_migrations_online` calls `asyncio.run()`, which cannot run inside an already running event loop | autonomous |
| `env.py` reads an override from `config.attributes["database_url"]` | `config.set_main_option("sqlalchemy.url", …)` | `alembic.ini` ships a placeholder URL, so "is it set?" can't tell an override from the placeholder | ticket ("accept a URL override") |
| `config.attributes["configure_logger"] = False` skips `fileConfig` | `fileConfig(..., disable_existing_loggers=False)` | `fileConfig` disabled every existing logger and broke the P0-02 logging test; the softer flag still replaces root handlers and sets level `WARN` | autonomous (Alembic cookbook pattern) |
| Guard `backend/tests/conftest.py::assert_safe_test_database_url`: name ends in `_test`, differs by **name** from `DATABASE_URL`'s, no `database/dbname/host/port/dsn` query params; plus a `current_database()` check before `DROP` | Trust the env var; compare host+port too | The fixture runs `DROP SCHEMA public CASCADE`. Round 1 showed `?database=` redirected asyncpg; round 2 showed `localhost` vs `127.0.0.1` defeated a host comparison | autonomous (added AC6) |
| The fixture creates `condo_test` via the `postgres` maintenance DB | Compose init script | Compose is a hot file and only covers local runs; the fixture covers CI and local | ticket (either allowed) |
| CI's service DB is `condo_dev`; `alembic upgrade/check` run against it | A separate `condo_ci` DB | Mirrors compose; tests use `condo_test` separately | autonomous |
| Each request gets its **own** session on the test's connection, closed in `finally` (`backend/tests/conftest.py::override_get_db_session`) | (a) share `db` untouched (the ticket's sketch); (b) share `db` and roll it back after each request | (a) a handler that forgets `commit()` passed tests (round 2 M1). (b) skipped the rollback on error paths and expired the test's ORM objects (round 3 H1, M1) | **James, B-1 option A** |
| Test and request sessions come from the app's `AsyncSessionLocal(bind=conn, …)` | The ticket's `AsyncSession(bind=conn, expire_on_commit=False)` | The plain `AsyncSession` had `autoflush=True`, production has `False` (round 1 M1) | autonomous (review fix) |
| Single-head check **before** `alembic upgrade head` in CI | After it, as the ticket listed | With two heads, `upgrade` fails first ("Multiple head revisions") and hides the real cause | autonomous (sharpened AC3) |
| `make test` depends on `db-guard` and exports both URLs for `127.0.0.1:$DB_PORT` | Plain `uv run pytest` | Without the guard a stray Postgres on 5432 would be tested (and its `condo_test` dropped) silently | autonomous |

**Framing changes:** AC1 sharpened (a second connection proves the outer transaction stayed open); AC2/AC3
sharpened (evidence named, step order); AC6 (guard), AC7 (auto-create), AC8 (`client` uses the test's
data) added. AC4 briefly used `cd backend && uv run pytest`; it is back to `make test`. Nothing loosened.

**What an interviewer would ask:** why not `create_all()` (§9 Q3); why per-request sessions instead of
sharing one (the B-1 row); what stops this from wiping a real database (the guard row); why the schema
setup is sync.

## 3. How it is implemented

### Overview

- **Guard + rebuild (once per run):** `backend/tests/conftest.py::migrated_test_database` checks the URL,
  creates `condo_test` if missing, drops and recreates `public`, then runs `command.upgrade(cfg, "head")`.
- **Engine (once per run):** `backend/tests/conftest.py::engine`, an async engine on `condo_test`.
- **Per test:** `backend/tests/conftest.py::db_connection` opens one connection and an outer transaction;
  `backend/tests/conftest.py::db` is a session on that connection; both end in rollback.
- **Per request:** `backend/tests/conftest.py::client` swaps `backend/app/core/dependencies.py::get_db_session`
  for a function that opens a fresh session on the same connection and closes it in `finally`.
- **CI:** `.github/workflows/ci.yml::services:` adds Postgres 16; three steps check migrations before pytest.

A **savepoint** is a named marker inside a transaction: `ROLLBACK TO SAVEPOINT x` undoes work after the
marker, `RELEASE SAVEPOINT x` keeps it, and neither ends the outer transaction.

### Walkthrough (variant C: one `make test DB_PORT=55432` run)

1. **Trigger.** `Makefile::test:` runs `db-guard` (fails if the compose db isn't the server on `DB_PORT`),
   then `uv run pytest` with `DATABASE_URL=…/condo_dev` and `TEST_DATABASE_URL=…/condo_test`.
2. **Settings.** `backend/app/core/config.py::test_database_url` reads `TEST_DATABASE_URL`.
3. **Guard.** The first test that needs the DB pulls in `migrated_test_database`, which calls
   `assert_safe_test_database_url` and raises `UnsafeTestDatabaseError` before any connection on a bad URL.
4. **Rebuild.** `backend/tests/conftest.py::_recreate_test_schema` runs (captured from the engine log):
   ```sql
   SELECT 1 FROM pg_database WHERE datname = $1        -- on "postgres", AUTOCOMMIT
   -- CREATE DATABASE "condo_test" only when missing
   SELECT current_database()                           -- must equal condo_test
   DROP SCHEMA IF EXISTS public CASCADE
   CREATE SCHEMA public
   COMMIT
   ```
5. **Migrate.** Alembic runs `backend/migrations/env.py` with `attributes["database_url"]`; it ends with
   `INSERT INTO alembic_version (version_num) VALUES ('989e5bd83064')`.
6. **One test.** Captured SQL for `test_request_work_committed_before_an_error_is_kept`:
   ```sql
   BEGIN                                    -- db_connection: outer transaction
   SAVEPOINT sa_savepoint_1                 -- db (test session) joins
   CREATE TABLE _request_probe (note text UNIQUE)
   SAVEPOINT sa_savepoint_2                 -- request session joins
   INSERT INTO _request_probe ... 'committed'
   RELEASE SAVEPOINT sa_savepoint_2         -- the handler's commit()
   SAVEPOINT sa_savepoint_3                 -- the session starts a new one after commit
   INSERT INTO _request_probe ... 'uncommitted'
   ROLLBACK TO SAVEPOINT sa_savepoint_3     -- HTTPException -> finally: session.close()
   SELECT note FROM _request_probe          -- test sees only 'committed'
   ROLLBACK TO SAVEPOINT sa_savepoint_1     -- db closes
   ROLLBACK                                 -- db_connection: everything gone
   ```
7. **End state.** `condo_test` holds only the migrated schema and `alembic_version`; `condo_dev` is never
   connected to by the tests.
8. **Failures you would see.** Bad URL: `UnsafeTestDatabaseError` at the first DB test. No Postgres: a
   connection error in `migrated_test_database` (every DB test errors). In CI: the step "Single migration
   head" (two heads), "Alembic check" (`FAILED: New upgrade operations detected`), or pytest.
9. **Re-run.** Safe: each run drops and rebuilds `public` in `condo_test`. Two runs at once on the same
   `condo_test` are **not** safe (see §7).

### Data model changes

None. The tests create throwaway tables (`_probe`, `_request_probe`, `_orm_probe`, …) inside the rolled-back
transaction; `_OrmProbe` uses its own `_ProbeBase` so Alembic autogenerate never sees it.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/tests/conftest.py` | Guard, schema rebuild, `engine`/`db_connection`/`db`/`client` fixtures | +163/−10 |
| `backend/tests/test_db_isolation.py` | 19 test functions (26 collected with the guard parameters): isolation probes, guard cases, request-session error paths | +421/−0 |
| `.github/workflows/ci.yml` | Postgres 16 service, URLs, single-head/upgrade/check steps; drop `READINESS_CHECK_DATABASE` | +33/−1 |
| `backend/migrations/env.py` | URL override and `configure_logger` switch | +9/−3 |
| `Makefile` | `test` behind `db-guard` with both URLs; `check` relies on it | +5/−3 |
| `backend/app/core/config.py` | `test_database_url` setting | +2/−0 |
| `backend/.env.example` | `TEST_DATABASE_URL` | +2/−0 |
| `CLAUDE.md`, `docs/AGENT_MISTAKES_LOG.md` | Promoted "claim before evidence" lesson | +3/−0 |
| `docs/tickets/P0-05-database-test-infrastructure.md` | Frame notes, B-1 answer | +42/−7 |

`backend/tests/conftest.py::assert_safe_test_database_url`

```python
def assert_safe_test_database_url(test_url: str, dev_url: str) -> None:
    """Refuse any test database that isn't clearly a separate, disposable `*_test` database."""
    test_db = make_url(test_url)
    dev_db = make_url(dev_url)
    overrides = _CONNECTION_OVERRIDE_PARAMS.intersection(test_db.query)
    if overrides:
        raise UnsafeTestDatabaseError(...)
    if not test_db.database or not test_db.database.endswith("_test"):
        raise UnsafeTestDatabaseError(...)
    # Compared by name only: host aliases (localhost, 127.0.0.1, ::1) and default ports would make a
    # host/port comparison miss the same database.
    if test_db.database == dev_db.database:
        raise UnsafeTestDatabaseError("TEST_DATABASE_URL must not name the DATABASE_URL database")
```

- Refuses any URL that could make the next `DROP SCHEMA public CASCADE` hit data that matters.
- The query-param check exists because asyncpg applies `?database=` over the parsed URL (round 1 M2).
- Without it, `TEST_DATABASE_URL=…/condo_dev` would wipe the dev database on the first test run.

`backend/tests/conftest.py::migrated_test_database`

```python
@pytest.fixture(scope="session")
def migrated_test_database() -> str:
    test_url = settings.test_database_url
    assert_safe_test_database_url(test_url, settings.database_url)
    asyncio.run(_recreate_test_schema(test_url))

    alembic_cfg = Config(str(BACKEND_DIR / "alembic.ini"))
    alembic_cfg.set_main_option("script_location", str(BACKEND_DIR / "migrations"))
    alembic_cfg.attributes["database_url"] = test_url
    alembic_cfg.attributes["configure_logger"] = False
    command.upgrade(alembic_cfg, "head")
    return test_url
```

- Sync, so `asyncio.run` (here and inside `env.py`) never meets the test loop (§2).
- Removing `attributes["database_url"]` would migrate `DATABASE_URL` (dev) and leave `condo_test` empty;
  removing `configure_logger` breaks the P0-02 log test.

`backend/tests/conftest.py::db_connection` and `::db`

```python
@pytest.fixture
async def db_connection(engine: AsyncEngine) -> AsyncIterator[AsyncConnection]:
    """One connection per test, inside an outer transaction that is always rolled back."""
    async with engine.connect() as conn:
        trans = await conn.begin()
        try:
            yield conn
        finally:
            await trans.rollback()


@pytest.fixture
async def db(db_connection: AsyncConnection) -> AsyncIterator[AsyncSession]:
    # The app's own session factory, so flush/expire behaviour matches production code.
    session = AsyncSessionLocal(bind=db_connection, join_transaction_mode="create_savepoint")
    try:
        yield session
    finally:
        await session.close()
```

- The outer `trans` is owned by the fixture, not the session, so nothing the session does can end it.
- `create_savepoint` makes the session's `commit()` a `RELEASE SAVEPOINT` and `rollback()` a
  `ROLLBACK TO SAVEPOINT`. With `conditional_savepoint` or `rollback_only`, the rollback-probe test fails
  (round 1 mutation check).

`backend/tests/conftest.py::override_get_db_session`

```python
    async def override_get_db_session() -> AsyncIterator[AsyncSession]:
        session = AsyncSessionLocal(bind=db_connection, join_transaction_mode="create_savepoint")
        try:
            yield session
        finally:
            # Like production's `async with AsyncSessionLocal()`: closing rolls back to the
            # request's savepoint, discarding uncommitted work, even when the endpoint raised.
            await session.close()

    app.dependency_overrides[get_db_session] = override_get_db_session
```

- Mirrors `backend/app/core/dependencies.py::get_db_session`, which closes its session on every path.
- FastAPI throws the endpoint's exception into the dependency at `yield`; only `finally` runs then. Without
  it, writes before an `HTTPException` would survive in tests but not in production (round 3 H1; 4 tests
  fail without the `finally`, per the PR).

`.github/workflows/ci.yml::Single migration head`

```yaml
      - name: Single migration head
        run: |
          uv run alembic heads
          test "$(uv run alembic heads | wc -l)" -eq 1

      - name: Apply migrations
        run: uv run alembic upgrade head

      - name: Alembic check (model/migration drift)
        run: uv run alembic check
```

- `alembic check` compares models with the migrated DB and fails on any difference (AC2).

## 5. Edge cases and tests

All tests are in `backend/tests/test_db_isolation.py`.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Code under test commits DDL and rows | Commit is a savepoint release; outer rollback removes both | `test_commit_inside_test_transaction_is_visible_to_the_test_only` + `test_previous_test_ddl_and_rows_were_rolled_back` |
| Service catches `IntegrityError` and calls `rollback()` | Rolls back to the savepoint only | `test_service_rollback_after_an_error_keeps_the_test_transaction` + `test_previous_test_rollback_probe_was_rolled_back` |
| Test session behaves unlike production (autoflush) | Built from `AsyncSessionLocal` | `test_db_session_is_configured_like_the_app_session` |
| Unsafe test URL (name, same DB, alias, query params) | Guard raises | `test_guard_refuses_unsafe_test_database_urls` (8 cases), `test_guard_accepts_a_separate_test_database` |
| Handler forgets `commit()` | Request session closed → discarded | `test_request_writes_without_commit_are_discarded_like_in_production` |
| Handler writes then raises `HTTPException` / an unhandled error | `finally` closes → discarded | `test_request_writes_are_discarded_when_the_handler_raises_http_exception`, `..._an_unhandled_error` |
| Commit then error | Committed part kept | `test_request_work_committed_before_an_error_is_kept` |
| Caught or uncaught DB error, then another request | Aborted savepoint is the request's own; next request works | `test_next_request_works_after_a_request_caught_a_db_error`, `..._failed_on_an_uncaught_db_error` |
| Request expires the test's ORM objects | Separate session; test's untouched | `test_orm_objects_loaded_by_the_test_stay_usable_after_a_request`, `test_test_setup_flushed_but_not_committed_survives_a_request` |
| Guard function exists but the fixture stops calling it | Nothing | **No test.** Only the `current_database()` name check would still stop a non-`_test` drop |
| Two test runs share `condo_test` | Nothing | **No test** (deferred; §7) |
| `condo_test` missing → created | `CREATE DATABASE` via `postgres` | **No automated test**; local transcript and CI (starts with only `condo_dev`) |

**Acceptance criteria → evidence**

1. AC1: the two `_probe` tests above.
2. AC2: demo commit `9e121dc` → CI run 38668824330 failed at "Alembic check"; reverted in `5e2bc6b`.
3. AC3: demo commit `36d9b52` → CI run 38668945831 failed at "Single migration head"; reverted in `5f3aaf1`.
4. AC4: PR transcript (marker row in `condo_dev` survives) + `test_tests_run_against_the_test_database_not_the_dev_database`.
5. AC5: CI run 38669057929 (Postgres 16 service, all steps green). Today: `make test DB_PORT=55432` → `40 passed`.
6. AC6: `test_guard_refuses_unsafe_test_database_urls`, `test_guard_accepts_a_separate_test_database`.
7. AC7: PR transcript (`condo_test exists: 0` → `1` after the run) and every CI run.
8. AC8: `test_client_requests_use_the_test_session`.

## 6. Review log

| Round | Reviewer | Verdict | Findings | Outcome |
|---|---|---|---|---|
| 1 | Fresh Claude, Tier 2 | MERGE | M1 `db` had `autoflush=True`; M2 guard bypass via `?database=` (proven); M3 rollback path unpinned; L3 `DROP SCHEMA` without `IF EXISTS`; L1 app `engine` still on `DATABASE_URL`; L2 parallel runs share `condo_test` | M1–M3, L3 fixed (`b3bfac3` red, `ecc4690` fix); L1, L2 deferred |
| 2 | Fresh Claude | MERGE | M1 handler missing `commit()` passed tests; L1 literal revision in schema test; L2 host-alias guard bypass | Fixed (`e9dc722` red, `9a3784b` fix); residuals listed in §7 |
| 3 | Fresh Claude | **BLOCK** | H1 request rollback only on success (proven 5 vs 0 rows); M1 shared-session rollback expires test ORM objects; L1 AC8 relies on uncommitted setup; L2 no concurrent requests | Escalated as B-1; James chose option A: `efcdbb3` (7 tests, red) + `0e2a6ac` (fix, 40 passed); L1 moot; L2 documented |
| 4 | Fresh Claude (per commit message) | **Not recorded** | "L1–L3" per `edea008` | `edea008` adds the harness rules to the `client` docstring. Verdict and finding text missing (see finding 2 at the top) |

## 7. Not verified

- **Round 4's verdict** is not written down anywhere; the merge gate's "final review MERGE" is unproven.
- **Parallel runs** (two agent worktrees running tests at once) share `condo_test` and drop each other's
  schema. No lock, no per-worktree database (round 1 L2, deferred).
- **The app's own `engine`/`AsyncSessionLocal` still point at `DATABASE_URL` in tests.** Code that bypasses
  `get_db_session` (a future worker, `check_database_connection`) would touch `condo_dev` (round 1 L1,
  deferred to P1-05/P3-01).
- **Removing the guard call** from `migrated_test_database` fails no test (round 2 residual).
- Only `public` is reset; a future second schema would survive between runs.
- Probe routes mutate `app.router.routes` directly; once the OpenAPI schema is cached (P1-07), a probe
  route could leak into it.
- One connection per test: concurrent requests inside one test fail ("savepoint does not exist"); real
  concurrency tests (P5) need their own committing connections and explicit cleanup.
- `make check` runs `alembic check` but not the single-head check; that is CI-only.
- The AC2/AC3 failing CI runs and the AC4/AC7 transcripts are from before the rebase; I re-ran only
  `make test DB_PORT=55432` (40 passed) and the SQL trace in §3.

## 8. How to change this safely

- **New model + migration:** nothing here changes; `test_schema_is_built_by_alembic` follows the current
  head, and CI's `alembic check` catches a model without a migration.
- **New router:** use `Annotated[AsyncSession, Depends(get_db_session)]`; tests get a production-like
  session automatically through `client`. Don't `rollback()` the test's `db` after a request (it also undoes
  the request's commits); if the test catches a DB error in `db`, roll `db` back before the next request.
- **Touching the fixtures:** the `_probe` pair, the rollback-probe pair and the seven request-session tests
  are the regression net; keep the file order of the pairs (the second test of each relies on it).
- **Changing the guard:** add a case to `test_guard_refuses_unsafe_test_database_urls` first.

## 9. Must explain, then quiz

**Q1. How does `join_transaction_mode="create_savepoint"` let a service call `commit()` while the test still
rolls everything back?** The test fixture `backend/tests/conftest.py::db_connection` begins the real
transaction and owns it. A session bound to that connection with `create_savepoint` does not take
ownership; it opens `SAVEPOINT sa_savepoint_N` instead. The service's `commit()` becomes `RELEASE
SAVEPOINT` (and the session opens a new one), `rollback()` becomes `ROLLBACK TO SAVEPOINT`. The outer
transaction never commits, so the fixture's final `ROLLBACK` discards everything (see the trace in §3).

**Q2. Why does `CREATE TABLE` roll back in PostgreSQL, and would it in MySQL?** PostgreSQL's DDL is
transactional: catalog changes are ordinary rows written under the same transaction, so `ROLLBACK` undoes
them (`test_previous_test_ddl_and_rows_were_rolled_back`). MySQL (InnoDB) issues an implicit commit before
and after most DDL, so `CREATE TABLE` would end the test transaction and survive; this harness would not
work there.

**Q3. Why build the schema with `alembic upgrade head`, not `Base.metadata.create_all()`?** Production gets
its schema from migrations. `create_all()` builds from the models and would hide a missing or wrong
migration, hand-written SQL in a migration (triggers, partial indexes, data fixes), or a constraint present
in the model but not in the migration. `backend/tests/conftest.py::migrated_test_database` runs the same
migration chain production runs, and `test_schema_is_built_by_alembic` checks it reached the head.

**Quiz**

1. A handler inserts a row, forgets `commit()`, and returns 200. What does the test see, and why?
2. Why can't `migrated_test_database` be an `async def` fixture?
3. A test calls `await db.rollback()` after a successful `client.post` whose handler committed. What
   happens to the request's row?
4. What would break if we removed the `try/finally` in `override_get_db_session`?
5. How would you extend this so two worktrees can run `make test` at the same time?

<details><summary>Answers</summary>

1. Zero rows. The request's own session is closed without commit, which rolls back to its savepoint, as
   production's `async with AsyncSessionLocal()` does (`test_request_writes_without_commit_are_discarded_like_in_production`).
2. Alembic's `env.py` calls `asyncio.run()`, and so does the schema reset; `asyncio.run` raises if an event
   loop is already running in the thread, which it is inside an async fixture.
3. It is undone too. The request's savepoint was nested inside the test session's open savepoint;
   rolling back the outer one discards everything after it (the harness rule in the `client` docstring).
4. On an `HTTPException` or any error, FastAPI throws into the dependency at `yield`; without `finally` the
   session is never closed, so writes before the error stay visible to the test (production drops them),
   and an aborted savepoint breaks the next request. Four of the B-1 tests fail.
5. Give each worktree its own database: e.g. `TEST_DATABASE_URL=…/condo_<worktree>_test` exported from the
   Makefile (the guard already accepts any `*_test` name), or take `pg_advisory_lock` in
   `migrated_test_database` and hold it for the session so runs queue instead of dropping each other's schema.

</details>
