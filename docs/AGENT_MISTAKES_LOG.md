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

| 2026-10-14 | P0-03a | Base44 fence missed `.js` extensions, the `entities`/`integrations` barrels, `import()`, `require()`; TS files had no `rules-of-hooks` | review round 1 (Claude), Medium ×2 | tested only the ticket's literal example | regex fence + `scripts/check-eslint-fence.sh` in CI |
| 2026-10-14 | P0-03a | A broken esquery selector crashed ESLint only on files that don't exist yet, so `eslint .` passed with a broken fence | the implementer, while fixing round 1 | a gate that only runs on empty folders passes vacuously | fence self-test in CI |
| 2026-10-14 | P0-03a | The round-1 baseline fix (`^[0-9]+$`) still let `08`/`0999` disable the ratchet (octal); the self-test ignored severity, so `warn` passed | review round 2 (Claude), Medium ×2 | fixed the reported input only, not its neighbours (pattern "fix not tested on adjacent cases", 2 with P0-05 round 3: promote in the next ticket PR) | `^(0\|[1-9][0-9]*)$`, `"severity":2` |

| 2026-10-15 | P0-03b | Hid the out-of-scope pages from routes and navigation, but the Dashboard still rendered Financials inline (`?role=financials`, the "Finance" role switch, a saved view) and its cards linked to hidden pages | review round 1, Codex (M1, M2) and Claude (H1), **High** | checked only the routes the ticket listed, not other ways to reach the same page | `isDemoViewRole`, `InScope`, journey link sweep for 4 roles and 4 board views |
| 2026-10-15 | P0-03b | The journey's `/Financials` "hidden" check passed vacuously (`/Financials` was never a route); round 2 found the resident link check also ran on the `/ResidentSetup` redirect | review round 1 (Claude) and round 2 (Claude, Low) | asserted on a page without first asserting the page was the one under test. Pattern "check passes vacuously", 3 with P0-03a: promote in the next ticket PR | the journey asserts the URL before checking content |
| 2026-10-15 | P0-03b | The AC6 table missed that the shipped Base44 SDK posts every API request and response to `window.parent` (`'*'`) when framed, and the `app-params` URL overrides | review round 1 (Claude), Medium | surveyed `src/` only, not the dependency code that ships | table corrected; P1-08 `frame-ancestors` follow-up |
| 2026-10-15 | P0-03b | Proxy key `/api` also matched `/apifoo`; `VITE_API_PROXY_TARGET` was ignored in `.env`; a hidden `mainPage` gave a blank `/`; `/Contacts` was routed unconditionally | review round 1 (Claude), Low ×4 | prefix match and `process.env` assumed, not tried | key `^/api(/\|\?\|$)`, `loadEnv`, fallbacks; journey boundary cases |
| 2026-10-15 | P0-03b | The round-1 fix looked `?role=`/localStorage values up in an object literal, so `constructor` or `__proto__` crashed the app for board users | review round 2 (Claude), Medium | fixed the reported value, not malformed input: pattern "fix not tested on adjacent cases" again, **after** its `CLAUDE.md` lesson landed in this PR | `Map` lookup + 30 journey checks. The lesson alone did not stop it: consider a lint rule against indexing object literals with untrusted strings |

| 2026-10-15 | P0-04a | Wrote an s3 healthcheck ("healthy only after the bucket exists") from LocalStack's `"completed": true` without trying a failing init script; LocalStack reports completed on ERROR too | review round 1 (Claude), Medium | trusted a health signal's name instead of proving its failure case | the check also fails on `"state": "ERROR"`, proven on a failing script (e257048) |
| 2026-10-15 | P0-04a | The Makefile's DB URL used `localhost` while its own `db-guard` checked `127.0.0.1`, so an IPv6-only stray server could still be migrated | review round 1 (Claude), Low | guard and guarded value written separately | one address in both (e878bb4) |
| 2026-10-15 | P0-04a | Split P0-04 and dropped the named stale branches from P0-04b's scope while the split note said nothing was dropped | review round 1 (Claude), Low | summarised scope while splitting | restored (bd77038) |

| 2026-10-15 | P0-05 | The shared-session `client` design also expired the test's ORM objects after any request (round 3 M1); the first regression test for it passed vacuously (flush-only setup gets expunged, not expired) | implementer, before the fix (mutation of the test against the old fixture) | wrote the reproduction from the finding's summary instead of its exact state | test rewritten to load the object by query and to flush a change; both red on the old fixture |

## Promoted to rules / tests

| Pattern | Promoted to | Date |
|---|---|---|
| Fix not tested on adjacent cases (P0-05 round 3, P0-03a round 2) | `CLAUDE.md` lesson "When fixing a review finding, also test the fix on its neighbours" (P0-03b) | 2026-10-14 |
| Claim before evidence (fix PR #3, P0-02) | `CLAUDE.md` lesson "Don't claim an effect … until you have run the thing" (P0-05) | 2026-10-14 |
