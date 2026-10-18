# Explanation — P2-07 Test infrastructure hardening

> **PR:** #67 · **Source revision:** `df4646174c61b7771b8e8f37803f0a3a816b7634`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3) reviewed this
> commit. **Merge commit:** not known when written; after the merge, `gh pr view 67 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (the non-test files, `backend/tests/conftest.py`,
> `backend/tests/test_architecture.py`, `backend/tests/test_rate_limit.py::committing`) and the assertions of
> the tests cited below at `df46461`; ran `uv run pytest -q tests/test_architecture.py tests/test_db_isolation.py
> tests/test_docs_routes.py tests/test_config.py tests/test_rate_limit.py`: 182 passed. `make check` at
> `df46461`: exit 0, 840 passed. Differences from the plan: two, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: short, with an edge-case table and a review log. Tier: 3. Walkthrough variant: C (a test run).

## 1. What changed and why

Two full test suites on one Postgres used to drop each other's `condo_test` schema. Now each pytest session
builds and drops a database of its own, and so does the migration tests' scratch database. `tests/` is
type-checked in `make check` and CI (126 mypy errors fixed, none silenced by config). The fitness checks got
tighter: checks 1–2 walk every `APIRoute`, not only `/api` ones; the commit grep catches quoted lower-case SQL
`commit` and the quoted `AUTOCOMMIT` isolation level; a named non-committing helper (`record_audit`) may not
commit even though it lives in a `service.py`. `/api/docs` and `/api/openapi.json` are off by default in
staging and production.

## 2. Decisions

- **D1. Per-run database name derived in `conftest.py`** (recorded: PR #67 D1, autonomous).
  `backend/tests/conftest.py::per_run_database_url` turns `TEST_DATABASE_URL`'s `<stem>_test` into
  `<stem>_<kind>_<pid>_<8 hex>_test`. The Makefile and CI keep one variable. Rejected: a Makefile-computed name
  (CI and plain `uv run pytest` would still share one), an advisory lock (serialises runs instead of isolating
  them), pid alone (repeats across containers on one server; review round 1 proved it for the scratch
  database). Accepted: a SIGKILLed run leaves its database; nothing sweeps, since a sweep can't tell a dead
  run from a live one in another PID namespace.
- **D2. Docs routes off by default in staging/prod** (recorded: PR #67 D2, autonomous).
  `api_docs_enabled` defaults per environment in `backend/app/core/config.py::_per_environment_defaults`;
  `API_DOCS_ENABLED=true` turns them on. Rejected: always on (advertises the API surface on a reachable host),
  never in prod (no way to inspect a deployed schema), behind a session (more code than the ticket asks).
  Not secrecy: the frontend bundle still reveals the calls.
- **D3. Commit grep matches quoted forms only** (recorded: PR #67 D3). A bare case-insensitive `commit`
  would flag today's comments (`backend/app/core/security.py` cites "commit 2153…") and `autocommit=False` in
  `backend/app/core/database.py`.
- Smaller (recorded, PR #67 table): helper bodies checked with `ast`; fixed rate-limit keys deleted before each
  test as the ticket asked; mypy fixed in the tests, never by relaxing `[[tool.mypy.overrides]]`.

**Framing changes:** criteria 1–5 sharpened (per-run scheme, 63-byte limit, drop on failure; no new mypy
overrides; guard and allowlist cases outside `/api`; the commit non-matches; the flag's defaults and the export
case). Criteria 6 and 7 added from the notes carried from P2-04 and P2-05. Nothing loosened.

**Plan versus final code:** (1) `per_run_database_url` gained a `kind` argument and also names the scratch
database (review round 1). (2) Helpers are looked up among module-level functions only (review round 2). Two
deliberate deviations are noted under the PR's Plan: the older commit meta-test patches
`NON_COMMITTING_HELPERS` to `{}`, and the mypy fixes in `test_login.py`/`test_health.py`/`test_rate_limit.py`
change how the tests reach the same objects, not what they assert.

## 3. How a test run uses it (variant C)

1. `make test` sets `TEST_DATABASE_URL=…/condo_test`; pytest asks for `engine`, which needs the session fixture
   `backend/tests/conftest.py::migrated_test_database`.
2. It calls `per_run_database_url`: the guard `assert_safe_test_database_url` runs on the configured URL, then on
   the derived one (`condo_run_<pid>_<hex>_test`, cut to 63 bytes before the suffix).
3. Inside a `try`, `_recreate_test_schema` creates it and Alembic upgrades it to head; the session's tests run.
4. The `finally` calls `_drop_database` (`DROP DATABASE … WITH (FORCE)`): after a pass, a failure, or Ctrl-C.
   A SIGKILL skips it; `backend/tests/README.md` ("The session database") has the cleanup query.

## 4. The code

| File | Change |
|---|---|
| `backend/tests/conftest.py::per_run_database_url` | new; used by `migrated_test_database` and `scratch_database_url` |
| `backend/tests/test_architecture.py::files_that_commit` | quoted `commit`/`autocommit`, `NON_COMMITTING_HELPERS`; `_api_routes` walks every `APIRoute` |
| `backend/app/core/config.py::_per_environment_defaults`, `backend/app/main.py::create_app` | the docs flag |
| `Makefile::typecheck:`, `.github/workflows/ci.yml::Mypy` | `mypy app tests` |
| `backend/tests/test_rate_limit.py::COMMITTED_KEYS` | fixed keys deleted before each `committing` test |
| 14 test files | type-only mypy fixes; `backend/tests/README.md`, `backend/.env.example` docs |

`backend/tests/test_architecture.py::_helper_commits`

```python
        # Module level only: a method of the same name is another function (Codex review round 2).
        functions = {
            node.name: node
            for node in ast.parse(source).body
            if isinstance(node, ast.FunctionDef | ast.AsyncFunctionDef)
        }
        for helper in helpers:
            if helper not in functions:
                yield f"{name}::{helper}: no such function"
            elif _COMMIT.search(ast.get_source_segment(source, functions[helper]) or ""):
                yield f"{name}::{helper}"
```

Without it, `record_audit` could commit and pass, because `**/service.py` may commit. A renamed helper fails as
"no such function", so the list can't silently go stale.

## 5. Edge cases and tests

| What could go wrong | Test that proves it |
|---|---|
| Two runs, even with equal pids, share a database | `backend/tests/test_db_isolation.py::test_equal_pids_still_get_distinct_databases`, `::test_per_run_database_is_unique_and_ends_in_test`; PR transcript 1 (two concurrent runs pass) vs 2 (`main` collides) |
| The session isn't really on its own database | `::test_the_session_database_is_this_runs_own`, `::test_the_scratch_database_is_named_per_run` |
| A long or unsafe configured name | `::test_per_run_database_name_fits_postgres_identifier_limit`, `::test_per_run_name_keeps_the_configured_stem`, `::test_per_run_database_refuses_an_unsafe_configured_url` |
| Database left after a failing run or Ctrl-C | No test; PR transcript 3 (probe: 0 left both times) |
| Unguarded route outside `/api` | `backend/tests/test_architecture.py::test_meta_unauthenticated_route_outside_api_fails_check_2`, `::test_meta_tenant_guard_outside_api_fails_check_1`, `::test_meta_allowlist_entry_outside_api_is_a_real_route` |
| Lower-case or quoted SQL commit, AUTOCOMMIT; no false hit on comments | `::test_meta_commit_outside_a_service_is_reported` |
| Helper commits, is shadowed by a method, or was renamed | `::test_meta_commit_inside_a_non_committing_helper_is_reported`, `::test_meta_helper_is_the_module_level_function`, `::test_meta_stale_non_committing_helper_is_reported` |
| Docs served in prod; export breaks with docs off | `backend/tests/test_config.py::test_api_docs_default_follows_the_environment`, `::test_api_docs_flag_loads_from_env`, `backend/tests/test_docs_routes.py::test_docs_routes_follow_the_flag`, `::test_export_works_with_the_docs_routes_off` |
| Leftover rate-limit row breaks `== 1` assertions | No permanent test; PR probe M9 |

Criteria → evidence: 1 the `test_db_isolation.py` tests above plus transcripts 1–3; 2 `make check` output
(`mypy app tests`: no issues in 102 files) and CI's Mypy step; 3, 4, 6 the meta-tests above; 5 the docs tests;
7 probe M9. Each new check was mutation-probed (PR, M1–M12).

## 6. Review

All rounds: Codex `gpt-6.1-sol`, high effort (James asked for it instead of `gpt-6-astra` and for no Claude
reviewer).

| Round | Commit | Verdict | Finding | Outcome |
|---|---|---|---|---|
| 1 | `96dbfc2` | BLOCK | High: scratch DB named by pid only; two sandboxed runs with pid 45 dropped each other's `condo_migrations_45_test` (832/3 and 833/2 failed) | fixed `e972fab`: `kind` argument; `test_equal_pids_still_get_distinct_databases` red then green |
| 2 | `e972fab` | MERGE | Medium: a same-named method shadowed `record_audit` in the `ast.walk` map. Low: scratch-name test hard-coded `condo` | fixed `df46461`: module-level lookup (`test_meta_helper_is_the_module_level_function`); stem from the configured URL |
| 3 | `df46461` | MERGE | Low: `test_the_session_database_is_this_runs_own` expects the whole stem, so a 58-character `TEST_DATABASE_URL` name (correctly truncated) fails it | not fixed: round 3 was the last, and a fix would merge code no reviewer saw; see §7 |

## 7. Not verified, accepted risks and follow-ups

- **Round 3 Low, open:** `backend/tests/test_db_isolation.py::test_the_session_database_is_this_runs_own`
  fails when `TEST_DATABASE_URL`'s stem is longer than about 39 bytes, because the per-run name truncates it.
  Fix: use `assert_named_per_run` there. Reproduced with a 58-`a` name. Will be added to
  [P3-01](../tickets/P3-01-job-queue-and-worker.md) as a carried note in the bookkeeping commit (step 6), with
  adding `enqueue` to `NON_COMMITTING_HELPERS`.
- Drop on failure/Ctrl-C and criterion 7's pre-delete rest on recorded probes, not permanent tests.
- A SIGKILLed run leaves its database (D1); manual cleanup only.
- The commit grep misses lower-case `commit` in the middle of a string and `END`, and would flag a string that
  starts with the word "commit" (D3).
- Not run on staging (no staging yet): the docs-off default is proven by settings and app tests only.

## 8. How to change it safely

Add a helper that must never commit (`notify`, `enqueue`) to `NON_COMMITTING_HELPERS` in
`backend/tests/test_architecture.py`; `test_only_services_and_entry_points_commit` then guards it. Another test
database? Name it with `per_run_database_url(..., kind=...)` and drop it in a `finally`.

## 9. Quiz

1. Why does the per-run name need random bytes when it already has the pid?
2. A test file keeps `condo_test` hard-coded in a raw `create_async_engine` call. What happens with two
   concurrent runs?
3. Why is the SQL `commit` pattern limited to strings that *start* with it?
4. What breaks if `_helper_commits` goes back to `ast.walk`?
5. How would you let staging serve the docs only to logged-in staff?

<details><summary>Answers</summary>

1. Containers sharing one Postgres have separate PID namespaces, so two runs can both be pid 45 (review round 1
   saw exactly that).
2. They share and collide again: only the fixtures use `per_run_database_url`. (The suite uses `engine`, so
   none does today.)
3. A bare case-insensitive word matches comments and `autocommit=False` in today's `app/` (D3).
4. A method with the same name replaces the module function in the map: a committing `record_audit` passes,
   and a missing one is "found" (round 2, M12 probe).
5. Keep `openapi_url=None` and add an `APIRoute` for the schema that depends on `get_current_user` plus a staff
   role check; fitness check 2 would then see it (it walks every `APIRoute`).

</details>
