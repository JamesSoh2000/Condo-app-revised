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
| B-1 | 2026-10-14 | [P0-05](./tickets/P0-05-database-test-infrastructure.md) (PR #4) | Stop rule 4: the third review round left a **High** open. In the test `client` fixture, the "roll back the request's uncommitted work" step added in round 2 only runs when the request succeeds. When the endpoint raises (an `HTTPException` or an error), its uncommitted writes stay visible to the test, while production discards them. So a write-then-raise bug (for example, a failed-login audit event that is never committed) passes its tests. The reviewer proved this and verified two fixes. I need your OK for a 4th review round (or to take another option). Everything else in PR #4 passed review; CI is green. | **A (recommended):** give the request its own session on the test's connection (`AsyncSessionLocal(bind=conn, join_transaction_mode="create_savepoint")` per request). This fixes H1 and the round-3 M1 (expired ORM objects after a GET), and test setup no longer needs to commit first. Add tests for write-then-`HTTPException`, caught-DB-error-then-next-request, and an ORM object after a GET. Then a 4th fresh review. **B:** minimal `try/finally` around the rollback plus the same tests, then a 4th review (leaves M1 open). **C:** revert to the ticket's plain `yield db` and log "missing commit isn't caught by client tests" as a known gap for P1-05. | P1-01 → the whole critical path (P1-02, P1-03, P1-05, P2-*…), and P3-01. P0-03 and P0-04 can continue. |

## Prerequisites coming up

Human-only setup the plan will need soon. Agents add these ahead of time so nothing waits on them.

| # | Needed by | What | Status |
|---|---|---|---|
| PRE-1 | the first autonomous merge (P0-01) | `gh auth login` in the environment where agents run, with a token that can merge PRs and edit branch protection (P0-04). Without it, agents can open PRs but not merge them | partly done: PRs merge (#1–#3); branch-protection permission not yet verified (P0-04). Note: `main` has no branch protection today |
| PRE-2 | P0-02 (Tier 1 reviews start at P1-02) | Codex CLI installed and logged in for the `codex-review` skill. Without it, Tier 1 falls back to a second Claude reviewer | done: Codex (`gpt-6-astra`) reviewed P0-03b rounds 1 and 3 |
| PRE-4 | P0-04 (`make up`), P0-05 (DB tests run locally) | Docker reachable from the WSL distro the agents run in (Docker Desktop → Settings → Resources → WSL integration). Today `docker` is "not found in this WSL 2 distro", so agents verify DB behaviour only in CI | open |
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
| 2026-10-14 | P0-03a | `jsconfig.json` deleted (`tsconfig.json` with `allowJs` serves editors); `typecheck` checks `.ts/.tsx` only (`checkJs: false`, as the ticket says), so legacy JSX gets no type hints | PR #6 | yes |

## Resolved

| # | Ticket | Answer | Date |
|---|---|---|---|
