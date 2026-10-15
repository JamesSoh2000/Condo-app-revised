# P0-02 — Backend quality gates

| Field | Value |
|---|---|
| Phase / lane | P0 / A |
| Risk tier | 3 |
| Depends on | P0-01 (the loop commands and `CLAUDE.md` come from it) |
| Replaces old | M1-T05 (remaining lint/format part) |
| Status | in progress |

## Goal

Backend CI blocks merges on lint, format and type errors, and the existing code passes them.

## Why

CI currently runs only `pytest`. Agents produce more code than humans can read line by line, so cheap
automatic checks must catch the mechanical problems before review.

## Scope

- In:
  - `uv add --dev ruff mypy pre-commit` (plus any `types-*` stubs needed).
  - Configure in `backend/pyproject.toml`:
    - `[tool.ruff]` with `target-version = "py312"` and `line-length = 100`
    - `[tool.ruff.lint]` with `select = ["E","F","I","B","UP","S","ASYNC","SIM","RUF"]`; ignore `S101` in
      tests
    - `[tool.mypy]` with `strict = true` for `app/`; relaxed overrides for `migrations/` and `tests/`
  - Add `.pre-commit-config.yaml` at the repo root: ruff, ruff-format, end-of-file-fixer,
    trailing-whitespace, check-merge-conflict, detect-private-key.
  - Fix all violations in the current code:
    - delete the commented-out "Older version" blocks and unused imports in `app/buildings/models.py` and
      `app/units/models.py`
    - leave the stub classes; P1-01 replaces them
  - `/api/ready`: log the exception with the request ID, and return a generic `{"status":"not_ready"}` body
    (no `str(exc)`).
  - `settings.aws_region` default becomes `ca-central-1`, matching `.env.example`.
  - CI `backend` job: add `uv run ruff check .`, `uv run ruff format --check .` and `uv run mypy app` before
    pytest.
- Out:
  - Makefile (P0-04)
  - database tests (P0-05)
  - frontend (P0-03)

## Interfaces

No API changes. The `/api/ready` 503 body becomes `{"status": "not_ready", "checks": {...}}` with no error
text.

## Acceptance criteria

1. **Given** the PR head, **when** CI runs, **then** the backend job runs `uv run ruff check .`,
   `uv run ruff format --check .` and `uv run mypy app` as separate steps **before** `uv run pytest`, and all
   pass. `mypy app` runs with `strict = true` and no `# type: ignore` added to `app/`.
2. **Given** a commit adding an unused import, **when** CI runs, **then** the backend job fails at
   `ruff check`. Demonstrate this once on the PR branch, then revert. Evidence: the failing run's URL and
   the `F401` line from its log.
3. **Given** the database is down and `READINESS_CHECK_DATABASE=true`, **when** `GET /api/ready` is called,
   **then** it returns 503 with exactly `{"status": "not_ready", "checks": {"app": "ok", "database":
   "error"}}` at the top level (not wrapped in `detail`), the body contains no exception text, and one
   `ERROR` log record from the readiness check carries the exception (type and message) and the same
   `request_id` as the response's `X-Request-ID` header.
4. **Given** `pre-commit install`, **when** committing a badly formatted file, **then** the hook reformats or
   blocks it. Evidence: transcript of a scratch commit in the PR.
5. *(added)* **Given** the database is up and `READINESS_CHECK_DATABASE=true`, **then** `/api/ready` still
   returns 200 `{"status": "ready", "checks": {"app": "ok", "database": "ok"}}` (existing test kept), and
   with the check disabled, 200 with `"database": "skipped"` (existing test kept).
6. *(added)* **Given** no `AWS_REGION` in the environment, **then** `Settings(_env_file=None).aws_region ==
   "ca-central-1"`.
7. *(added)* **Given** the merged migration `989e5bd83064`, **then** this PR does not change it (rule 11);
   ruff excludes that one file by name, and new migrations are still linted and format-checked.
8. *(added)* `pre-commit run --all-files` passes on the PR head, so the hooks don't fail on untouched files
   the first time someone commits.

## Test plan

- Update `tests/test_health.py` for the new 503 body (monkeypatch `check_database_connection` to raise).
- Commands: `cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy app && uv run pytest -q`.

## Likely files

`backend/pyproject.toml`, `backend/uv.lock`, `.pre-commit-config.yaml`, `.github/workflows/<ci>.yml`,
`backend/app/routers/health.py`, `backend/app/core/config.py`, `backend/app/buildings/models.py`,
`backend/app/units/models.py`, `backend/tests/test_health.py`.

## Must explain (learning checkpoint)

1. What does each tool catch (ruff lint, ruff format, mypy) that the others can't?
2. Why is returning `str(exc)` in an HTTP response a security problem?
3. What does `S` (bandit) in the ruff rules look for? Give one example from this codebase.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC1 names the CI steps and their order and forbids new `type: ignore` in
  `app/`; AC2 names the evidence; AC3 pins the exact 503 body (top level, as the Interfaces section says,
  rather than inside FastAPI's `detail` wrapper) and how the log line is checked; AC4 names the evidence.
  Added AC5 (the healthy and skipped paths don't regress), AC6 (the region default, which had no
  criterion), AC7 (the merged migration stays untouched) and AC8 (pre-commit is green on the whole repo).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - The 503 is a `JSONResponse`, not an `HTTPException` (ticket Interfaces: the body *is*
    `{"status": "not_ready", "checks": …}`).
  - `ruff format` would rewrite the merged baseline migration `989e5bd83064`. Rule 11 forbids editing a
    merged migration, so ruff excludes that one file by path (autonomous, ticket-local; basis CLAUDE.md
    rule 11). `migrations/script.py.mako` is updated so new migrations come out ruff-clean.
  - The intentional local-dev `secret_key` default trips bandit `S105`; it gets an inline `noqa` with the
    reason (production rejects it in `validate_production_settings`). Same for the one test fixture
    password (`S106`). No rule is ignored repo-wide beyond the ticket's `S101` in tests.
  - mypy uses the `pydantic.mypy` plugin, so settings and future schemas type-check precisely (default:
    pydantic's documented setup).
  - Pre-commit is not added to CI here: CI already runs ruff and ruff-format directly. The generic hooks
    (whitespace, EOF) run locally only. Follow-up candidate for P0-04.
- Split: none (estimate ~150 non-test lines, most of it deleted comment blocks and formatting).
