# P0-02 — Backend quality gates

| Field | Value |
|---|---|
| Phase / lane | P0 / A |
| Risk tier | 3 |
| Depends on | P0-01 (the loop commands and `CLAUDE.md` come from it) |
| Replaces old | M1-T05 (remaining lint/format part) |
| Status | todo |

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

1. **Given** the current `main`, **when** CI runs, **then** ruff, format and mypy steps run and pass.
2. **Given** a commit adding an unused import, **when** CI runs, **then** the backend job fails at
   `ruff check`. Demonstrate this once on the PR branch, then revert.
3. **Given** the database is down and `READINESS_CHECK_DATABASE=true`, **when** `GET /api/ready` is called,
   **then** it returns 503 without exception text, and the log line contains the error and `request_id`.
4. **Given** `pre-commit install`, **when** committing a badly formatted file, **then** the hook reformats or
   blocks it.

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

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
