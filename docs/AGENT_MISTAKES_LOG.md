# Agent Mistakes Log

Record every implementer mistake that CI, an independent reviewer, the explainer or James caught (step 8 of the
[playbook](./AI_AGENT_PLAYBOOK.md)). When a pattern appears **twice**, the agent turns it into a fitness test
(preferred) or a `CLAUDE.md` rule in its next PR, and links it here. Over time this file becomes the most
project-specific guidance you have, and it shows how well the autonomous gates work.

| Date | Ticket | What the agent did | Caught by (CI / review round + reviewer / explainer / James after merge) | Root cause (missing context? ambiguous ticket? model habit?) | Prevention added |
|---|---|---|---|---|---|
| 2026-__-__ | P_-__ | e.g. queried packages by id without the building_id filter | review round 1 (Claude) | the ticket didn't restate the rule; no test for case #5 | fitness test `test_package_queries_scoped` + CLAUDE.md rule 3 wording |
| 2026-10-14 | fix (PR #3) | Opened "unbreak main" after fixing two of three failures; the backend job still failed on `APP_ENV=test` | review round 1 (Claude) and CI; fixed before the verdict arrived | claimed the outcome before CI had run the whole job on the fix | — (pattern "claim before evidence", 1 of 2) |
| 2026-10-14 | P0-02 | Claimed the modernised `script.py.mako` makes new revisions ruff-clean without generating one; it didn't (unused imports, quotes) | review round 1 (Claude), Low | claimed without running the thing | Alembic post-write hooks (PR #2). Pattern "claim before evidence", 2 of 2: promote next ticket |
| 2026-10-14 | P0-02 | Removed the stub model imports from `migrations/env.py` via `ruff --fix` without noting it (autogenerate needs model imports) | review round 1 (Claude), Low | auto-fix output not read file by file | comment in `env.py` + P1-01 follow-up |

| 2026-10-14 | P0-05 | Built the test `db` session by hand (`autoflush=True`) instead of from the app's `AsyncSessionLocal` (`autoflush=False`) | review round 1 (Claude), Medium | re-typed config instead of reusing the factory | test `test_db_session_is_configured_like_the_app_session` (pattern "test double diverges from production", 1) |
| 2026-10-14 | P0-05 | The destructive test-DB guard checked only the parsed DB name; `?database=` in the URL bypassed it (a scratch DB was dropped in the proof) | review round 1 (Claude), Medium | didn't consider driver-level URL overrides | 4 guard cases + `current_database()` check |
| 2026-10-14 | P0-05 | The rollback-after-error path of the per-test transaction was not pinned by any test | review round 1 (Claude), Medium | tested only the happy path (`commit()`) | test `test_service_rollback_after_an_error_keeps_the_test_transaction` + mutation check |
| 2026-10-14 | P0-05 | The `client` override shared the test's session, so a handler missing `commit()` passed its tests | review round 2 (Claude), Medium | followed the ticket's sketch without asking what production does at request end | rollback after request (pattern "test double diverges from production", 2) |
| 2026-10-14 | P0-05 | That rollback had no `try/finally`, so on every error path tests still diverged from production | review round 3 (Claude), **High**, ticket blocked | fixed the success path only; didn't test the fix on raising endpoints | pending (inbox B-1). Pattern "test double diverges from production", 3: promote in the next ticket PR |

## Promoted to rules / tests

| Pattern | Promoted to | Date |
|---|---|---|
