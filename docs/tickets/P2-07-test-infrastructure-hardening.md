# P2-07 — Test infrastructure hardening

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 3 |
| Depends on | P2-03 |
| Replaces old | — |
| Status | in progress |

Follow-ups of [P1-05](./P1-05-test-world-and-isolation-helpers.md) (PR #50) and
[P2-03](./P2-03-tenant-context-guards-fitness.md) (PR #59) that P2-03 did not take in scope. Re-frame before
starting.

## Goal

Concurrent test runs can't break each other, test code is type-checked, and the P2-03 fitness checks lose the
blind spots review round 2 found.

## Scope

- In:
  - **Per-run test database.** `condo_test` is one per server: two concurrent full suites (worktrees,
    reviewers) drop each other's schema. Give the session test database a per-run name (Makefile, CI,
    `backend/tests/conftest.py`), keeping the `_test` guard and dropping it afterwards (P1-05 follow-up).
  - **`mypy tests/` in `make check` and CI.** 123 errors in 13 files on 2026-10-17; fix them, then add the
    path (tightens a gate) (P1-05 follow-up).
  - **Fitness walk over every `APIRoute`.** `backend/tests/test_architecture.py` checks 1 and 2 walk only `/api`
    routes; an unguarded `APIRoute` at `/admin/export` passes. Report non-`/api` `APIRoute`s too (docs routes
    excepted) (P2-03 review round 2, L1).
  - **Commit grep.** Also match lower-case SQL `commit` (`re.IGNORECASE` for the SQL form) and `AUTOCOMMIT`
    (P2-03 review round 2, L2).
  - **Docs routes in production.** `/api/docs` and `/api/openapi.json` are served without a session and are
    exempt from the fitness checks. Decide whether staging/production serve them (settings flag) (P2-03 review
    round 2 residual).
- Out: anything that changes app behaviour beyond the docs-route flag.

## Acceptance criteria

1. Two `make test` runs started at the same time on one server both pass. The session database is named per
   run, `<stem>_run_<pid>_<8 hex>_test`, from `TEST_DATABASE_URL`'s name (`condo_test` → stem `condo`); the
   `_test` guard runs on both the configured and the derived name before anything is created; the derived
   name fits Postgres's 63-byte limit; the database is dropped when the session ends, pass or fail. Evidence:
   two concurrent `make test` transcripts, and a `pg_database` listing afterwards with no `_run_` database.
   Tests: the derived name is unique per call, ends in `_test`, is refused when the configured URL is unsafe.
2. `make typecheck` (so `make check`) and CI's Mypy step run `mypy app tests` and pass, with no new
   `[[tool.mypy.overrides]]` and no bare `# type: ignore` (only narrow codes, where a test passes a wrong type
   on purpose).
3. Meta-tests: an `APIRoute` outside `/api` (`/admin/export`) without a session fails fitness check 2; one with
   a tenant guard fails check 1; an allowlist entry for a non-`/api` path counts as a real route. FastAPI's
   docs routes (plain Starlette routes) stay out of checks 1–2.
4. Meta-test: in a non-service file, `text("commit")`, `text('COMMIT;')`, a triple-quoted lower-case
   `commit;` and `isolation_level="AUTOCOMMIT"` / `"autocommit"` fail fitness test 4; `autocommit=False` (a
   keyword, not the isolation level), a comment saying "commits" and `READ COMMITTED` don't. Today's `app/`
   still passes.
5. Docs routes: setting `api_docs_enabled` (env `API_DOCS_ENABLED`), default on in `dev`/`test`, off in
   `staging`/`prod`. Off: `/api/docs` and `/api/openapi.json` answer 404. On: 200. `make gen-api`
   (`app.export_openapi`) still exports the schema with the flag off. Tested.
6. (Carried from P2-04.) Named non-committing helpers in service modules (`record_audit`): fitness test 4
   fails when one of their bodies commits, and fails when a named helper no longer exists (stale name).
7. (Carried from P2-05.) The `committing` fixture in `tests/test_rate_limit.py` deletes the tests' fixed keys
   before each test as well as after.

## Carried from P2-04 (do while framing)

- The commit fitness test (`tests/test_architecture.py::files_that_commit`) allows every `**/service.py`, so
  a helper that lives in a service module (`app/audit/service.py::record_audit`, later `notify`, `enqueue`)
  isn't checked by it. Only `test_record_audit_never_commits` guards `record_audit` (PR #60 mutation M2).
  Consider naming the non-committing helpers and failing on a commit inside them.

## Carried from P2-05 (do while framing)

- `backend/tests/test_rate_limit.py::committing` really commits rate-limit rows to the shared test database and
  deletes the keys it used afterwards. A hard kill mid-test leaves rows, and the next run fails the `== 1`
  assertions. Also delete the tests' fixed keys before each test (PR #61 review round 1, L4).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 names the per-run scheme, the guard on both names, the 63-byte limit, the
  drop on failure and the evidence; 2 forbids loosening the mypy config to get there; 3 adds the tenant-guard
  and allowlist cases next to the unauthenticated one; 4 adds `COMMIT;`, triple-quoted SQL and the
  non-matches that today's code contains (`app/core/database.py` passes `autocommit=False`, comments say
  "commits"); 5 picks the flag and its per-environment default and adds the `gen-api` case; 6 and 7 turn the
  carried notes into criteria. Case the ticket missed: a stale helper name (criterion 6), the export with
  docs off (criterion 5).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Per-run name derived in `conftest.py` from `TEST_DATABASE_URL`, so the Makefile and CI keep one variable
    (comments only change). pid + random hex: pids repeat across containers sharing one server (autonomous;
    matches the P1-05 scratch-database pattern).
  - No sweep of databases left by a hard-killed run: a sweep can't tell a dead run from a live one in another
    PID namespace. Accepted; `tests/README.md` says how to drop leftovers (autonomous).
  - Docs off by default in staging and production; `API_DOCS_ENABLED=true` turns them on (autonomous: the
    simplest reversible default that doesn't publish the API surface on a reachable host; the SPA doesn't
    use them).
  - SQL `commit` matched only as a string literal starting with it (case-insensitive), `AUTOCOMMIT` only as a
    quoted isolation level: a bare case-insensitive word would flag comments (autonomous, from today's code).
  - Tier 3, no tenant endpoint: the 10-case table doesn't apply.
- Split: none. Estimate ~60 non-test lines (config, main, Makefile, CI); the rest is tests.
