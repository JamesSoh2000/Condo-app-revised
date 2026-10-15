# Human Inbox

The one page James checks. Agents build and merge on their own
([ADR-0014](./adr/0014-autonomous-agent-workflow.md)) and write here only when they need James, or when they
decided something James may want to overturn. Agents update it through PRs; James edits it directly.

**Run state: running**

<!-- Set to `paused` to stop agents at the next step 0 of the loop (docs/AI_AGENT_PLAYBOOK.md). -->

## Blocked — needs James

The agent stopped on a [stop rule](./AI_AGENT_PLAYBOOK.md#stop-rules). Write your answer under the item.
The next `/build-next` unblocks the ticket and moves the item to "Resolved".

| # | Date | Ticket | What's needed | Options (agent's recommendation first) | Blocks |
|---|---|---|---|---|---|

## Prerequisites coming up

Human-only setup the plan will need soon. Agents add these ahead of time so nothing waits on them.

| # | Needed by | What | Status |
|---|---|---|---|
| PRE-1 | the first autonomous merge (P0-01) | `gh auth login` in the environment where agents run, with a token that can merge PRs and edit branch protection (P0-04). Without it, agents can open PRs but not merge them | done: PRs merge (#1–#11), and the token's admin rights set branch protection on `main` (P0-04b, 2026-10-15) |
| PRE-2 | P0-02 (Tier 1 reviews start at P1-02) | Codex CLI installed and logged in for the `codex-review` skill. Without it, Tier 1 falls back to a second Claude reviewer | done: Codex (`gpt-6-astra`) reviewed P0-03b rounds 1 and 3 |
| PRE-4 | P0-04 (`make up`), P0-05 (DB tests run locally) | Docker reachable from the WSL distro the agents run in (Docker Desktop → Settings → Resources → WSL integration). Today `docker` is "not found in this WSL 2 distro", so agents verify DB behaviour only in CI | done (2026-10-15, James: Docker connection is on) |
| PRE-5 | now (local runs) | A `pgserver` Postgres started by an earlier agent session (P0-05 work, 2026-10-14, from `/tmp/claude-1000/.../f1c4eb4b-…/scratchpad/pgenv`) still listens on 127.0.0.1:5432, so the compose `db` can't publish there. Agents use `make … DB_PORT=55432`, and `db-guard` stops `make migrate` from hitting the stray server. Stop it when convenient (`pkill -f pgserver/pginstall`); nothing in the repo needs it | done (2026-10-15, James: keep using `DB_PORT=55432`; the stray server stays. P0-06 found nothing listening on 5432 that day) |
| PRE-6 | optional, any time | (a) The archived `building-website` repo still has the long-lived `develop`, `staging`, `starting` and `starting-james` branches; P0-04b didn't touch that repo. Delete them if you want. (b) Settings → General → "Automatically delete head branches" is off; agents pass `--delete-branch`, but turning it on makes that automatic | (b) done (2026-10-15, James turned on \"Automatically delete head branches\"); (a) still open, optional |
| PRE-7 | soon (before merging any of them) | Dependabot's first run opened 17 PRs (#17–#33). Agents don't merge them. Some break the pins: Python 3.14 (project pins `>=3.12,<3.13` and `python:3.12-slim`) and Postgres 18 (CI tests 16). Others are majors with breaking changes (Tailwind 4, framer-motion 14, the GitHub Actions v7 bumps) or minors that may break (SQLAlchemy 2.1). **Recommendation:** close the Python, Postgres, Tailwind and framer-motion PRs. Then a small ticket changes `.github/dependabot.yml`: ignore `python` versions `>=3.13` and `postgres` `>=17` (version ranges, because 3.12→3.14 is a *minor* bump that a semver-major ignore wouldn't catch), and group minor/patch updates. See [the P0 recap](./recaps/P0.md) §5 | done (2026-10-15). James: upgrade Python 3.14, Postgres 18, the Actions v7 and SQLAlchemy 2.1; keep Tailwind 3 and framer-motion 11. Done in [P0-06](./tickets/P0-06-runtime-and-ci-upgrades.md) (PR #35); the superseded and ruled-out Dependabot PRs were closed. **Your dev machine:** the old Postgres 16 volume is kept; remove it when you like (README \"Database upgrades\") |
| PRE-3 | milestone D (start ~week 8) | AWS account with MFA and budget alerts, a domain, SES domain verification ([D-01](./tickets/D-01-terraform-base.md)) | not yet |

## Decisions to audit

Made by agents under the [decision rules](./AI_AGENT_PLAYBOOK.md#decision-rules), without you. Skim weekly.
To overturn one, write a superseding ADR or a ticket; agents build it like any other.

| Date | Ticket | Decision | Where recorded | Reversible? |
|---|---|---|---|---|
| 2026-10-14 | fix (PR #3) | `main` was red since the initial commit. Fixed in its own PR: committed the 10 `frontend/src/lib/*` files from the local checkout (a Python `lib/` pattern in `.gitignore` had kept them out of git; reviewed: no secrets), pinned `astral-sh/setup-uv@v8.3.2` (no `v8` tag exists), and added `"test"` to `APP_ENV` (CI sets it; P1-06 widens it further) | PR #3 | yes |
| 2026-10-14 | P0-02 | The merged baseline migration `989e5bd83064` is excluded from ruff and pre-commit by name rather than reformatted (CLAUDE.md rule 11); every new migration is linted | `backend/pyproject.toml`, PR #2 | yes |
| 2026-10-14 | P0-02 | Alembic `post_write_hooks` run `ruff check --fix` and `ruff format` on every new revision. Side effect: an empty hand-written revision loses its unused `op`/`sa` imports | `backend/alembic.ini`, PR #2 | yes |
| 2026-10-14 | P0-02 | Pre-commit formatting hooks cover `backend/` only. Run repo-wide they rewrote ~90 legacy frontend files and the protected `scripts/check-*.py`; P0-03 extends them to `frontend/` | `.pre-commit-config.yaml`, PR #2 | yes |
| 2026-10-14 | P0-03a | P0-03 split into P0-03a (gates), P0-03b (proxy, route scope, Base44 runtime investigation), P0-03c (whitespace-only normalisation). Dependents now point at a/b | `docs/tickets/P0-03-frontend-quality-gates.md`, PR #6 | yes |
| 2026-10-14 | P0-03a | [ADR-0015](./adr/0015-typescript-eslint-for-new-code.md): `typescript-eslint` (recommended rules + `rules-of-hooks`) lints `.ts/.tsx`; the Base44 fence is one regex plus `import()`/`require()` selectors, self-tested in CI by `scripts/check-eslint-fence.sh` (new protected gate) | ADR-0015, PR #6 | yes |
| 2026-10-15 | P0-03b | Demo route scope is an allowlist, `DEMO_PAGES` in `frontend/src/app/routeScope.ts` (the Demo tier of `docs/PRODUCT_SCOPE.md`). Every other Base44 page stays in the repo but is not routed (404) and not in navigation; `pages.config.js` is untouched. A slice restores a page by adding its name | `routeScope.ts`, PR #7 | yes |
| 2026-10-15 | P0-03b | Dashboard views and cards that open hidden pages are hidden through the same allowlist (`isDemoViewRole` drops the Finance view and the `?role=financials`/saved-view routes into it; `InScope` hides cards and buttons), not deleted | `Dashboard.jsx`, `RoleSwitcher.jsx`, `Layout.jsx`, PR #7 | yes |
| 2026-10-15 | P0-03b | The Base44 editor helpers (`VisualEditAgent`, `NavigationTracker`) render only in dev (`import.meta.env.DEV`). Production no longer posts `app_changed_url`/visual-edit messages or page-view logs to Base44. The Base44 SDK itself still ships, and when the app is framed it posts every API request and response to the parent window: P1-08's `frame-ancestors 'none'` is the mitigation | `App.jsx`, PR #7 (AC6 table) | yes |
| 2026-10-15 | P0-03b | Vite proxies only `/api`, `/api/…` and `/api?…` (key `^/api(/\|\?\|$)`) to `VITE_API_PROXY_TARGET` (shell or `frontend/.env*`, default `http://localhost:8000`), so the SPA calls the API same-origin with no CORS | `frontend/vite.config.js`, PR #7 | yes |
| 2026-10-15 | P0-03c | The whitespace hooks now cover all of `frontend/`. Their one run removed trailing spaces inside 7 string/template literals (a Tailwind class list in `Layout.jsx`, HTML email markup in `NotificationHelper.jsx`, the Concierge LLM prompt), judged whitespace-insensitive, so no file was excluded from the hooks | PR #8 (AC4) | yes |
| 2026-10-15 | P0-04a | P0-04 split into P0-04a (local stack, Makefile) and P0-04b (branch protection, PR template, Dependabot, branches). P1-08 and P3-04 depend on 04a; D-01 on both | `docs/tickets/P0-04-repo-workflow-and-local-stack.md`, PR #9 | yes |
| 2026-10-15 | P0-04a | Local S3 emulator is LocalStack 4.14.0 (pinned; newer images need an account token). MinIO images are no longer pullable; moto doesn't enforce presigned-POST size or type; RustFS works but its errors differ from AWS (the fallback) | ADR-0007 "Local emulator", PR #9 | yes |
| 2026-10-15 | P0-04a | Kept `S3_BUCKET_NAME=condo-app-dev-files` instead of the ticket's new `S3_BUCKET=condo-dev-files`; production settings now reject `S3_ENDPOINT_URL`/`S3_PUBLIC_ENDPOINT_URL` | `backend/app/core/config.py`, PR #9 | yes |
| 2026-10-15 | P0-04a | Migrations and `alembic check` run on the host against `127.0.0.1:$DB_PORT` (default 5432), behind a `db-guard` that fails unless compose's db owns that port; `make e2e` (stub) exits 1 | `Makefile`, PR #9 | yes |
| 2026-10-15 | P0-05 | Test convention for every endpoint test from P1 on: `client` gives each request its own session on the test's connection (savepoints); the test's `db` sees the request's committed work and setup needs no commit. Don't `rollback()` `db` after a request, and don't run requests concurrently in one test (docstring of `tests/conftest.py::client`) | `backend/tests/conftest.py`, PR #4 | yes |
| 2026-10-15 | P0-05 | `make test` runs pytest against `condo_test` on the compose db (`127.0.0.1:$DB_PORT`, behind `db-guard`); the test-DB defaults use `127.0.0.1` | `Makefile`, PR #4 | yes |
| 2026-10-15 | P0-04b | Branch protection on `main`: PR required with 0 approvals; required checks `Backend tests`, `Frontend lint, types, ratchet and build`, `Docs links and explanation references` (up to date); linear history; no force push or deletion; **enforced for admins** (agents push with your admin token). Emergency push: turn "Do not allow bypassing" off in Settings → Branches | GitHub settings, PR #11 | yes |
| 2026-10-15 | P0-04b | The PR template moved to `.github/pull_request_template.md` (no copy left in `docs/templates/`); Dependabot runs weekly for uv, npm, actions, docker and compose, ignoring LocalStack (ADR-0007 pin) | PR #11 | yes |
| 2026-10-15 | P0-06 | Postgres 16 → 18 in dev uses a **new volume** (`postgres18_data`, mounted at `/var/lib/postgresql`); dev data is rebuilt with `make migrate`, no `pg_upgrade`/dump. The old `postgres_data` volume is left for you to delete | `docker-compose.yml`, README "Database upgrades", PR #35 | yes |
| 2026-10-15 | P0-06 | Also took setup-uv 8.3.2 → 10.3.0 (Dependabot #20) with the v7 actions; and dropped `uuid6` for the standard library's `uuid.uuid7` (Python 3.14) | `ci.yml`, `app/models/mixins.py`, PR #35 | yes |
| 2026-10-15 | P0-06 | New protected gate `scripts/check-version-pins.py` (docs job and `make check`): one Python patch/minor, one Postgres major and one uv release across `.python-version`, `.tool-versions`, Dockerfile, pyproject, Makefile, `s3-smoke.py`, compose and CI | PR #35 | yes |
| 2026-10-15 | P0-06 | Dependabot: minor/patch grouped per ecosystem; ignores Tailwind and framer-motion majors, Python image minor+major, Postgres majors (by `update-types`, not the version ranges the inbox recommended, so the config needn't change at each upgrade) | `.github/dependabot.yml`, PR #35 | yes |
| 2026-10-15 | P0-06 | `make up` passes `--renew-anon-volumes` so a recreated app container never keeps an old `/app/.venv` copy (it crashed after the Python bump). Side effects: every `make up` recreates the containers, so the S3 emulator's in-memory objects reset on each `make up` (not only `make down`), and the old anonymous volumes are left dangling (`docker volume prune`); follow-up moves the venv to `/opt/venv` | `Makefile`, PR #35 | yes |
| 2026-10-14 | P0-03a | `jsconfig.json` deleted (`tsconfig.json` with `allowJs` serves editors); `typecheck` checks `.ts/.tsx` only (`checkJs: false`, as the ticket says), so legacy JSX gets no type hints | PR #6 | yes |

## Resolved

| # | Ticket | Answer | Date |
|---|---|---|---|
| B-1 | [P0-05](./tickets/P0-05-database-test-infrastructure.md) (PR #4) | James (in session): **option A**: give each request its own session on the test's connection (`join_transaction_mode="create_savepoint"`), add the regression tests (write-then-`HTTPException`, caught DB error then the next request, an ORM object after a GET), then a **fourth** fresh review round. P0-05 is back to `todo`; the answer is also in the ticket's Frame notes on PR #4 | 2026-10-15 |
