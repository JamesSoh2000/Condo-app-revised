# Explanation — P0-02 Backend quality gates

> Code at the head of PR #2 (`c4ffa15`, 2026-10-14), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. Snapshot: if the code changes later, write a new explanation. Form: short (Tier 3). Walkthrough variant: C (process: a push in CI, a local commit).

**1. What changed and why.** Backend CI used to run only `pytest`. It now runs ruff lint, ruff format check and strict mypy first, and the existing code was fixed to pass them. A pre-commit config catches the same problems before a commit. Two small fixes ride along: `/api/ready` no longer returns exception text in its 503 body, and `aws_region` defaults to `ca-central-1`.

**2. Decisions** (*autonomous* = no written rule; these are in the inbox)
- 503 is a `JSONResponse` with a top-level body, not `HTTPException` (which nests it under `detail`). Basis: ticket Interfaces.
- The merged migration `989e5bd83064` is excluded from ruff and pre-commit by name instead of reformatted. Basis: CLAUDE.md rule 11.
- Alembic post-write hooks run `ruff check --fix` and `ruff format` on every new revision; the template was modernised too. Rejected: template only (still left unused imports). *Autonomous.*
- Inline `noqa: S105` / `S106` for the dev secret and one test password, not a per-file or global ignore. *Autonomous.*
- Pre-commit EOF and whitespace hooks are scoped to `backend/` (merge-conflict and private-key stay repo-wide). A repo-wide run would rewrite ~90 frontend files and protected scripts. *Autonomous.* Note: AC8 ("green on all files") passes because of this narrowing, not because the frontend is clean.
- Stub model imports removed from `backend/migrations/env.py` (they crash Alembic on `main`); a comment says P1-01 must re-import real model modules. *Autonomous.*
- Pre-commit does not run in CI; CI runs ruff directly. Basis: ticket scope. mypy uses the `pydantic.mypy` plugin (pydantic's documented default).

**3. Files changed.** `.github/workflows/ci.yml::Ruff lint` (+ format, mypy steps) · `.pre-commit-config.yaml` (new) · `backend/pyproject.toml::[tool.ruff.lint]` and `[tool.mypy]` · `backend/alembic.ini::hooks = ruff_fix, ruff_format` · `backend/migrations/script.py.mako`, `backend/migrations/env.py` · `backend/app/routers/health.py::ready` · `backend/app/core/config.py::LOCAL_DEV_SECRET_KEY` · mechanical fixes in `backend/app/main.py::lifespan`, `backend/app/middleware/request_logging.py::dispatch`, the "Older version" blocks deleted from `backend/app/buildings/models.py` and `backend/app/units/models.py` (stubs kept), and whitespace and import order elsewhere · tests in `backend/tests/test_health.py` and `backend/tests/test_config.py` · `backend/uv.lock`.

**Walkthrough (C).** *On a push or PR:* job `backend-tests` checks out, installs uv 0.11.17, runs `uv sync --locked`, then `Ruff lint` → `Ruff format check` → `Mypy` (`mypy app` only) → `Run backend tests`. The first failing step fails the job and later steps are skipped. The AC2 demo run failed at `Ruff lint` with `F401 ... os imported but unused` and skipped the rest. *On a local commit* (after `cd backend && uv run pre-commit install`): the git hook runs `ruff-check --fix` and `ruff-format` on staged `backend/` files. If either one changes a file, the commit aborts with exit 1; you review the change, `git add` it and commit again. *On `uv run alembic revision`:* the post-write hooks lint and format the new file, so it passes CI. To fix a failure: `uv run ruff check --fix . && uv run ruff format . && uv run mypy app`.

**4. The code.** `backend/app/routers/health.py::ready`, the failure branch:

```python
        except Exception as exc:
            # The error details go to the log only; clients get a generic body.
            logger.exception(
                "readiness_check_failed",
                extra={"request_id": request_id_ctx.get(), "error_type": type(exc).__name__},
            )
            return JSONResponse(
                status_code=503,
                content={
                    "status": "not_ready",
                    "checks": {**checks, "database": "error"},
                },
            )
```

`logger.exception` logs at ERROR with the traceback attached; `backend/app/logging_config.py::JsonFormatter` writes it as `exception` and picks up `request_id` and `error_type`. The request ID comes from the context variable that `backend/app/middleware/request_logging.py::RequestLoggingMiddleware` sets. Without this branch, the 503 body would again carry text like a hostname and port. The route has `response_model=None` because it returns either a dict or a `JSONResponse`.

**5. How to verify it.** `cd backend && uv run ruff check . && uv run ruff format --check . && uv run mypy app && APP_ENV=test uv run pytest -q`. Re-run for this explanation: `All checks passed!`, `24 files already formatted`, `Success: no issues found in 19 source files`, `9 passed`. AC3 is proven by `backend/tests/test_health.py::test_ready_returns_503_without_exception_text_when_database_check_fails` (exact body, no secret text, a single ERROR record with the request ID and `RuntimeError`). AC6 is proven by `backend/tests/test_config.py::test_aws_region_defaults_to_ca_central_1`. AC2, AC4 and AC8 have only CI-run or transcript evidence in the PR; no test covers them.

**6. Review.** Round 1 (fresh Claude, head `ceb3b55`): MERGE. Low: the `env.py` imports were removed without mention (fixed in `c4ffa15` with a comment). Low: the template alone wasn't ruff-clean (fixed with the post-write hooks). Round 2 (fresh Claude, `c4ffa15`): MERGE. Low, **not fixed**: for a hand-written empty revision, the `--fix` hook strips the unused `op`/`sa` imports. **Not verified:** nothing ran against a live Postgres; the 200 schema of `/api/ready` is missing from OpenAPI (`response_model=None`); mypy does not check `tests/` or `migrations/` in CI (the relaxed overrides are only used if someone runs mypy on them); the ruff pin `v0.17.0` in pre-commit is kept equal to `uv.lock` by hand; pre-commit runs only on machines where someone ran `install`.

**7. How to change it safely.** To add a rule, add it to `select` in `backend/pyproject.toml` and run `uv run ruff check .` before pushing. When you bump ruff, change `uv.lock` and the `rev:` in `.pre-commit-config.yaml` together. Never add a merged migration to the formatter's reach; exclude it by name.

**Must explain.** (1) *Ruff lint* finds code problems such as unused imports, likely bugs (B) and insecure patterns (S). *Ruff format* only rewrites layout and never judges meaning. *mypy* checks that types agree across calls, like `lifespan` returning `AsyncIterator[None]`, which neither ruff tool can see. (2) `str(exc)` can expose hostnames, ports, SQL or file paths to anyone who calls the endpoint, and `/api/ready` is unauthenticated, so it gives attackers a map. The full error goes to the log, where only operators read it. (3) `S` is flake8-bandit, which looks for security smells: hard-coded passwords, `assert` used as a guard, `subprocess` with a shell, and so on. The example here is `S105` on `backend/app/core/config.py::LOCAL_DEV_SECRET_KEY`.

**Quiz.** 1. Why does `test_ready_returns_503_...` put `secret-host` in the fake error? 2. Why exclude one migration by name rather than all of `migrations/versions/`? 3. If ruff-format modifies a file during a commit, is the commit created? 4. What breaks if we remove the top-level `exclude:` from `.pre-commit-config.yaml`? 5. How would you extend these gates to `frontend/`?

<details><summary>Answers</summary>

1. To prove that no part of the exception message, including the hostname, reaches the body; the test asserts it is absent from `response.text`. 2. New migrations should still be linted and formatted; only the merged one is frozen (rule 11). 3. No. The hook exits 1 and the reformatted file is left unstaged, so you re-add it and commit again. 4. A commit touching the baseline migration would reformat it, which is an edit to a merged migration and breaks rule 11 (ruff's own `extend-exclude` still protects it in CI). 5. Widen the `files:` patterns or add frontend hooks (eslint, prettier, tsc) in `.pre-commit-config.yaml`, add matching CI steps in the frontend job, and clean up the ~90 whitespace files first; P0-03 owns this.
</details>
