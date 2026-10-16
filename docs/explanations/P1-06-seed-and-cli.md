# Explanation — P1-06 Seed data and operator CLI skeleton

> **PR:** #51 · **Source revision:** `60773c8` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1, a fresh Claude reviewer) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 51 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs. The branch
> is rebased onto `origin/main` (`git merge-base --is-ancestor origin/main HEAD` succeeds).
> This is a snapshot: if the code changes later, write a new explanation; do not update this one. Lasting
> decisions live in ADRs.
> Form: short, plus full-form §2 decision blocks, a walkthrough and an edge-case table (the seed's
> idempotence and its environment guard are the parts a reader needs to see). Tier: 3. Walkthrough
> variant: C (one `make seed` run). There is no HTTP request: the ticket adds no endpoint.

## 1. What changed and why

`python -m app.cli` is a new Typer command-line app (Typer: a library that turns typed Python functions into
CLI commands) and the one home for operator commands. Its only working command, `seed [--reset]`, creates or
restores a demo dataset: buildings `maple` (40 units) and `birch` (8 units) and 12 `@example.test` accounts
with memberships, roles and occupancies. Four placeholder commands (`bootstrap-building`, `audit`,
`jobs-status`, `email-test`) exist so later tickets have a place, and fail loudly until then. `make seed`
runs the command in the compose `app` container. `APP_ENV` gains a `staging` value, and staging now gets the
settings checks that keep dev values out of a deployed environment.

The two decisions that matter most: idempotence means "find each row by its natural key, create it if
missing, then set its seeded fields back" (D1), and the environment guard runs before any database session
is opened (D2). A **natural key** is the business identifier a human would use (a building's slug, a user's
email), as opposed to the generated UUID primary key.

## 2. Decisions

### D1. Idempotence: find by natural key, create if missing, set seeded fields back

- **Problem or constraint:** the ticket asks for "idempotent upserts by natural keys". Staging will be
  reseeded over data people have clicked around in, so a second run must neither duplicate rows nor move
  ids (references to a seeded row would break).
- **Chosen:** `backend/app/seed.py::_upsert` selects the row by its natural key and inserts only if none is
  found; `backend/app/seed.py::_set` then assigns only the seeded fields whose value differs. Keys: building
  `slug`; unit `(building, tower IS NULL, label)`; user `lower(email)`; membership `(building, user)`;
  feature `(building, feature)`. Roles are added if missing, never removed. Occupancies are started if the
  membership has no current one, transferred if the current one is in another unit or relationship, and
  left alone otherwise (`backend/app/seed.py::_occupancy`).
- **Alternatives rejected:** `INSERT … ON CONFLICT DO UPDATE` per table: `users` is unique on the expression
  `lower(email)` and `units` on a `NULLS NOT DISTINCT` triple, which makes the conflict targets awkward, and
  it bypasses the model validators and the occupancy helpers, which ADR-0016 makes the only writers of
  occupancies. Delete-and-reinsert: keeps counts but changes ids (this is why criterion 1 also checks ids).
- **Tradeoffs and accepted limitations:** one SELECT per row (about 70 rows; negligible). Extra roles added
  by hand to a seeded membership survive a re-seed. Two concurrent `seed` runs can both miss a row and then
  hit a unique violation (accepted: reviewer residual, PR "Follow-ups").
- **Basis:** ticket; ADR-0010 / ADR-0016; test results (criteria 1 and 7); the PR's stack run.
- **Source:** recorded (PR decision D1, ticket Frame notes 1 and 7).

### D2. The guard runs before any session, in the CLI and again inside `seed()`

- **Problem or constraint:** criterion 2: in `prod`, `seed` "writes nothing". That should not depend on a
  rollback.
- **Chosen:** `backend/app/seed.py::check_seed_allowed` is called by `backend/app/cli.py::seed_command`
  before `run_in_session`, and again as the first line of `backend/app/seed.py::seed` (defence for other
  callers). It refuses `prod` always, and `--reset` anywhere except `dev` (so also under `test` and
  `staging`).
- **Alternatives rejected:** checking only inside `seed()`: a session and connection would already be open,
  and "writes nothing" would rely on rollback rather than on never starting.
- **Tradeoffs and accepted limitations:** the guard trusts `APP_ENV`, and `Settings.app_env` defaults to
  `dev`; a deployed host that forgets to set `APP_ENV` would allow `seed --reset` (review L2, pre-existing).
- **Basis:** ticket criteria 2–3; test
  `test_cli_seed_in_prod_exits_nonzero_without_opening_a_session` (the session factory is replaced by a
  recorder that must stay empty).
- **Source:** recorded (PR decision D2).

### D3. `--reset` truncates every table in `Base.metadata`

- **Problem or constraint:** "truncates the domain tables", while later slices keep adding tables.
- **Chosen:** `backend/app/seed.py::_truncate_domain_tables` builds `TRUNCATE <every model table> CASCADE`
  from `Base.metadata.sorted_tables`, after importing `app.models.registry` (which an existing fitness test
  keeps complete). `alembic_version` is not a model table, so the migration state survives.
- **Alternatives rejected:** a hand-written table list: goes stale silently when P2/P3 add tables.
- **Tradeoffs and accepted limitations:** future non-domain model tables (sessions in P2-01, jobs in P3-01)
  are wiped too; in dev that is the intended clean slate.
- **Basis:** ticket; autonomous (PR: "simplest, reversible").
- **Source:** recorded (PR decision D3).

### D4. Staging shares the "no dev values" checks with prod

- **Problem or constraint:** the ticket asks a lighter validator for `staging` (no localhost origins, real
  bucket).
- **Chosen:** in `backend/app/core/config.py::validate_production_settings`, `staging` and `prod` both
  reject the dev `SECRET_KEY`, empty or `*` origins, loopback origins and the dev bucket name. The https-only
  origins, the ban on S3 emulator endpoints and the real-SES-sender check stay prod-only.
- **Alternatives rejected:** exactly the ticket's two checks: rejected for `SECRET_KEY`, because staging
  will sign real sessions from P2-01 and the dev key is public.
- **Tradeoffs and accepted limitations:** staging may still use http origins and an S3 emulator endpoint.
- **Basis:** ticket plus an autonomous tightening (stricter than the ticket, not looser).
- **Source:** recorded (PR decision D4, ticket Frame note 9).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `council` holds only the `council` role | council + resident, like the test world's `a_council` | criterion 4 counts exactly 6 residents | ticket | recorded (Frame note 4) |
| Placeholders exit 1 naming their ticket | exit 0 with a note | a script must not mistake a stub for success (same rule as `make e2e`) | convention | recorded (PR table) |
| Birch gets only `packages`, join code `BIRCH-2026` | Maple's three features | lets feature gating be demoed across buildings | autonomous | recorded (PR table) |
| Residents share units 102 and 304 | one resident per unit | shows several current occupants of one unit | autonomous | recorded (PR table) |
| Seed occupancies start at `now()`; re-seeds leave a matching current occupancy alone | backdated starts | no history needed yet; backdating decides visibility (ADR-0016) | default / autonomous | recorded (PR table, Frame notes) |
| `make seed` uses `exec app` | `exec api` (ticket text) | the compose service is named `app` | code | recorded |
| `typer>=0.27.3` as a runtime dependency, with no upper bound | argparse | the ticket names Typer. The missing upper bound differs from the neighbouring pins (`SQLAlchemy>=2.1.0,<3.0.0`): rationale not recorded | ticket | recorded / not recorded |

**Framing changes:** criteria 1–5 sharpened (ids stable; refusal before a session; `--reset` dev-only;
dataset spelled out; placeholders named and failing). Criteria 6 (seed leaves other rows; reset wipes them),
7 (drift is restored), 8 (commit rule) and 9 (staging settings) added. Nothing loosened. The ticket's "check
why CI accepts `APP_ENV: test`": `test` was already in `AppEnv` before this ticket.

## 3. How it is implemented

### Overview

- `backend/app/cli.py::app`: the Typer app; `seed_command` checks the guard, then hands the work to
  `run_in_session`.
- `backend/app/cli.py::run_in_session`: opens one `AsyncSession`, runs the command, commits once, and
  disposes the engine before `asyncio.run` closes the event loop.
- `backend/app/seed.py::seed`: the dataset (`BUILDINGS`, `MEMBERS`) and the upsert logic. It flushes,
  never commits (CLAUDE.md rule 5: only use-cases commit; a CLI command counts as one).
- `backend/app/core/config.py::AppEnv`: gains `staging`.

### Walkthrough (variant C: one `make seed` run)

1. **Trigger:** `make seed DB_PORT=55432` runs `docker compose exec app python -m app.cli seed` (add
   `reset=1` for `--reset`; `Makefile::seed:`).
2. **Guard:** `seed_command` reads `settings.app_env` and calls `check_seed_allowed`. On refusal it prints
   `error: …` to stderr and exits 1; no session has been created.
3. **Session:** `run_in_session` opens `AsyncSessionLocal()` inside a fresh `asyncio.run` loop.
4. **Reset (dev only):** one `TRUNCATE … CASCADE` statement over every model table, then
   `db.expunge_all()` so the session forgets objects whose rows are gone.
5. **Buildings, features, units:** for each `SeedBuilding`, `_building` upserts by slug and sets name,
   address, timezone, join code and `is_active`; each feature row is upserted and set `enabled=True`.
   `_units` upserts labels `{floor}{n:02d}` (`101` … `1004`) and sets `floor` and `is_active`.
6. **People:** for each `SeedMember`, the user is upserted by `lower(email)` and `full_name`/`is_active`
   set; `_membership` upserts by `(building, user)`, sets `status`, and adds missing roles; residents get
   `_occupancy`, which calls the ADR-0016 helpers `start_occupancy` or `transfer_occupancy`.
7. **End state:** `seed` flushes; `run_in_session` commits once and prints `seeded (APP_ENV=dev)`. The PR's
   stack run shows the counts after a fresh seed: 2 buildings, 4 feature rows, 48 units, 12 users, 12
   memberships, 12 roles, 7 occupancies, unchanged after a second run.
8. **Failure:** any exception propagates out of `work`, the commit line is skipped, and the session context
   manager rolls back; the engine is still disposed (`finally`). A non-seed building already holding join
   code `MAPLE-2026` makes `seed` fail this way with an `IntegrityError` (accepted residual).
9. **Recover / re-run:** run `make seed` again (it converges); in dev, `make seed reset=1` gives a clean slate.

### Data model changes

None. No migration.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/seed.py` | dataset, guard, upsert helpers | +267 |
| `backend/app/cli.py` | Typer app, `run_in_session`, `seed`, placeholders | +73 |
| `backend/app/core/config.py` | `staging` in `AppEnv`; split validator | +13 −9 |
| `backend/tests/test_cli_seed.py` | criteria 1–8 | +421 |
| `backend/tests/test_config.py` | staging cases (criterion 9) | +56 −1 |
| `Makefile` | real `seed` target | +2 −2 |
| `README.md` | "Seeded accounts" table | +25 −1 |
| `CLAUDE.md`, `backend/.env.example` | stub note removed; `APP_ENV` values listed | +3 −2 |
| `backend/pyproject.toml`, `backend/uv.lock` | `typer` | +61 |
| `docs/tickets/P1-06-seed-and-cli.md` | framing | +58 −11 |

**Key excerpts**

`backend/app/seed.py::check_seed_allowed`
([permalink](https://github.com/JamesSoh2000/Condo-app-revised/blob/60773c8011c18ceb243384e455f0ef1ca5a8573a/backend/app/seed.py#L117-L126))

```python
def check_seed_allowed(app_env: AppEnv, *, reset: bool) -> None:
    """Raise `SeedRefusedError` unless `seed` may run. Call it before opening a session."""
    if app_env == "prod":
        # Demo accounts with known emails (and, from P2-01, known passwords) never go to production.
        raise SeedRefusedError("seed refuses to run with APP_ENV=prod: demo data never goes there")
    if reset and app_env != "dev":
        raise SeedRefusedError(
            "seed --reset deletes every domain row and runs only with APP_ENV=dev, "
            f"not APP_ENV={app_env}"
        )
```

- It is a deny-list for `seed` (only `prod` refused) and an allow-list for `--reset` (only `dev`). Drives D2.
- Remove the first `if` and a prod operator could fill production with demo accounts; flip the second to
  `app_env == "staging"` and `--reset` would run under `test`.

`backend/app/cli.py::run_in_session` and `seed_command`

```python
def run_in_session(work: Callable[[AsyncSession], Awaitable[None]]) -> None:
    """Run `work` in a new session and commit once after it returns; on an error, commit nothing."""

    async def main() -> None:
        try:
            async with AsyncSessionLocal() as db:
                await work(db)
                await db.commit()
        finally:
            # The engine's pool belongs to this event loop, which asyncio.run closes next.
            await dispose_database_engine()

    asyncio.run(main())
# ...
    app_env = settings.app_env
    try:
        # Before any session: a refused seed must not touch the database at all.
        check_seed_allowed(app_env, reset=reset)
    except SeedRefusedError as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(1) from exc
```

- The commit sits after `work`, so an exception skips it (criterion 8). The CLI is the use-case boundary, so
  it, not `seed()`, commits (CLAUDE.md rule 5).
- Without `dispose_database_engine()` the pooled asyncpg connections would outlive the loop that created
  them (Inferred: this would show up as "event loop is closed" errors if a second command ran in the same
  process, e.g. in tests).

`backend/app/seed.py::_upsert` and `_set`

```python
async def _upsert[T](db: AsyncSession, model: type[T], where: tuple[Any, ...], **key: Any) -> T:
    """The row matching `where`, or a new one built from `key` and flushed."""
    found = (await db.scalars(select(model).where(*where))).one_or_none()
    if found is not None:
        return found
    obj = model(**key)
    db.add(obj)
    await db.flush()
    return obj


def _set(obj: object, **values: Any) -> None:
    # Only assign what differs, so an unchanged row isn't written (and keeps its updated_at).
    for name, value in values.items():
        if getattr(obj, name) != value:
            setattr(obj, name, value)
```

- The core of D1. The flush after `add` gives the new row its id at once, so the next step can use it as a
  foreign key.
- `_set` skipping equal values is why an unchanged re-seed doesn't move `max(updated_at)` (PR stack run).
  Remove the `!=` check and every re-seed would rewrite every row (Inferred: SQLAlchemy usually skips
  no-op assignments of equal scalars anyway, so the check is mostly belt and braces).

`backend/app/seed.py::_occupancy`

```python
    if current is None:
        await start_occupancy(
            db,
            building_id=membership.building_id,
            membership_id=membership.id,
            unit_id=unit.id,
            relationship=relationship,
        )
    elif (current.unit_id, current.relationship) != (unit.id, relationship):
        # History is ended, never rewritten (ADR-0010): move them back with a transfer.
        await transfer_occupancy(
            db,
            building_id=membership.building_id,
            membership_id=membership.id,
            new_unit_id=unit.id,
            relationship=relationship,
        )
```

- Restoring an occupancy adds a row rather than editing the old one, because occupancy history decides
  what a resident may see (ADR-0010, ADR-0016). This is why criterion 7 allows exactly one extra occupancy.
- Remove the `start_occupancy` branch and no resident gets a unit (the PR's mutation run: 14 tests failed).
  The `transfer_occupancy` branch has **no test** (see §5).

`backend/app/core/config.py::validate_production_settings` (excerpt)

```python
        if self.app_env in {"staging", "prod"}:
            where = "in production" if self.is_production else "in staging"
            if self.secret_key == LOCAL_DEV_SECRET_KEY:
                raise ValueError(f"SECRET_KEY must be changed {where}")
            # ... empty or '*' origins, loopback origins
            if self.s3_bucket_name in {"", "condo-app-dev-files"}:
                raise ValueError(f"S3_BUCKET_NAME must be set to a real bucket {where}")

        if self.is_production:
            if any(not origin.startswith("https://") for origin in self.trusted_origins):
                raise ValueError("TRUSTED_ORIGINS must all be https:// in production")
```

- Implements D4. The bucket check moved from the prod-only block to the shared one; its prod message changed
  from "a production bucket" to "a real bucket".

## 5. Edge cases and tests

I ran `uv run pytest tests/test_cli_seed.py tests/test_config.py` at the source revision: 96 passed.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Second run duplicates rows or changes ids | find by natural key, insert only if missing | `test_seed_twice_keeps_row_counts_and_ids` |
| `seed` in prod (with or without `--reset`) | refused before a session | `test_seed_is_refused_in_prod`, `test_cli_seed_in_prod_exits_nonzero_without_opening_a_session`, `test_seed_in_prod_writes_nothing` |
| `--reset` in staging or test | refused before a session | `test_reset_is_refused_outside_dev`, `test_cli_seed_reset_in_staging_exits_nonzero_without_opening_a_session` |
| Seed touches rows it didn't create | only queries its own natural keys | `test_seed_leaves_rows_it_did_not_create` |
| `--reset` leaves stray rows | `TRUNCATE` every model table | `test_reset_removes_other_rows_and_matches_a_fresh_seed` |
| Seeded resident's occupancy ended; building renamed | new occupancy started; name restored | `test_seed_restores_drifted_seed_data` |
| Seeded resident moved to another unit or relationship | `transfer_occupancy` back to the seeded unit | **No test.** The drift test only covers an ended occupancy (the `start_occupancy` branch) |
| Seeded user deactivated, membership status changed, feature disabled | `_set` restores them | No direct test; covered only by the same `_set` path the rename test exercises |
| Extra role added to a seeded membership | kept (roles never removed) | No test; documented tradeoff (D1) |
| `seed()` commits by itself | it only flushes | `test_seed_does_not_commit` |
| Runner commits before the work or on error | commit after `work`, skipped on exception | `test_cli_runner_commits_once_after_the_command`, `test_cli_runner_does_not_commit_when_the_command_fails` |
| Placeholder looks like success | exits 1 naming its ticket | `test_cli_placeholders_exit_nonzero_naming_their_ticket` |
| Staging boots with dev values | validator rejects them | `test_staging_rejects_dev_values`, `test_staging_settings_are_accepted`, `test_staging_allows_what_only_prod_forbids`, `test_prod_still_rejects_the_dev_secret_key` |

Acceptance criteria → tests: 1 `test_seed_twice_keeps_row_counts_and_ids`; 2 the three prod tests above;
3 `test_seed_runs_in_staging` plus the two `--reset` tests; 4 the `test_seeded_*` tests (maple building and
units, six residents, one pending, staff, birch, users); 5 `test_cli_help_lists_every_command` and the
placeholder test; 6 the two "other rows" tests; 7 `test_seed_restores_drifted_seed_data`; 8 the three commit
tests; 9 the four `test_config.py` tests. The CLI's real database path (Typer → `run_in_session` → Postgres)
is not tested in pytest: a command runs its own event loop and can't share the test's connection. The PR's
stack transcript (two seeds, a reset, prod and staging refusals, `--help`) is the only evidence for it.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | fresh Claude reviewer (Sonnet 5.5, high effort) | `60773c8` | MERGE | L1: `seed` (no `--reset`) allowed under `APP_ENV=test` | dismissed: the ticket says "runs in dev and staging", not "only"; `test` is CI/pytest; `--reset` stays dev-only (`test_seed_without_reset_is_allowed_outside_prod`) |
| | | | | L2: `app_env` defaults to `dev`, so a deployed host missing `APP_ENV` would allow `--reset` | pre-existing; deferred to D-02 |
| | | | | L3: staging demo accounts get known passwords once P2-01 adds them | deferred to P2-01 |

No finding changed the code. The reviewer also re-ran the seed and config tests, ruff, mypy and the CLI
against the dev DB, and checked that Typer's rich traceback doesn't print the DB password on a failed
connect.

## 7. Not verified, accepted risks and follow-ups

Not verified:
- The `transfer_occupancy` branch of `backend/app/seed.py::_occupancy` (no test; the mutation runs listed in
  the PR don't cover it).
- The CLI against a real database only in the PR's manual stack run, not in CI.
- Seeding on an actual staging host (no staging host exists yet).
- Concurrent `seed` runs (unique violation possible; accepted residual).

Accepted risks and follow-ups. The PR says L2 was "added to D-02" and L3 "noted in P2-01", but this branch
changes neither ticket, and P2-01 currently says the opposite of L3 ("dev and staging users get the password
`DevPassword!2026`"). So at the source revision:

| Item | Where tracked |
|---|---|
| `APP_ENV` defaults to `dev`; require it explicitly in deployed envs, or host-check `--reset` (L2) | PR #51 only (not in `docs/tickets/D-02-host-bootstrap-caddy-compose.md`) |
| Staging demo accounts must not get a known password (L3) | PR #51 only; `docs/tickets/P2-01-sessions-login-logout-csrf.md` contradicts it |
| P4-03 and P4-09 say `docker compose exec api`; the service is `app` | PR #51 only |
| P2-04's test plan uses `make cli audit …`; no `make cli` target exists | PR #51 only |
| Concurrent seeds; foreign building holding `MAPLE-2026` → `IntegrityError` | accepted; PR #51 only |
| Autonomous decisions (D3, D4 tightening, Birch features, shared units) | not yet in `docs/HUMAN_INBOX.md` (an unticked merge-gate item) |

## 8. How to change it safely

To add a seeded slice (packages, notices): add a `_<thing>` helper in `backend/app/seed.py` that uses
`_upsert` with a natural key and `_set`, call it from `seed()`, extend `DOMAIN_TABLES` in
`backend/tests/test_cli_seed.py` so the idempotence test counts the new table, and update the README table.
New model tables are reset automatically if they are registered in `app.models.registry`. A new CLI command
replaces its `_placeholder(...)` line and runs its work through `run_in_session`.

## 9. Must explain, then quiz

**1. What makes a seed script idempotent, and why does that matter for staging?** Running it twice leaves
the database in the same state as running it once: same rows, same ids, same seeded values. Here each row is
looked up by a natural key and created only if missing (`backend/app/seed.py::_upsert`), and its seeded
fields are set back (`backend/app/seed.py::_set`). Staging is reseeded after deploys over data people have
used; a non-idempotent seed would pile up duplicates or, if it deleted and re-inserted, break every
reference to a seeded row (packages, notices, audit events pointing at a user id).

**2. Why is the CLI allowed to commit, while helpers are not?** CLAUDE.md rule 5: only a use-case commits,
exactly once, so a use-case is all-or-nothing. A CLI command is a use-case invoked from a terminal instead
of HTTP, so `backend/app/cli.py::run_in_session` commits once at the end. `seed()` and the occupancy helpers
only flush; if they committed, a failure halfway would leave half a dataset, and a caller (a test, a later
command composing `seed`) could not roll the whole thing back.

**3. Why must `seed` refuse to run in production?** It creates accounts with publicly known emails (and,
from P2-01, known passwords) and fake buildings; in production that is a back door and polluted tenant data.
`--reset` would delete every real row. The refusal is checked before a session exists
(`backend/app/cli.py::seed_command`), so even a bug later in `seed()` cannot write.

Quiz:

1. A seeded resident was moved by a manager to unit 205 as `owner`. What does `seed` do, and how many
   occupancy rows does that resident have afterwards?
2. Why does `_upsert` flush right after `db.add(obj)`?
3. `seed` runs with `APP_ENV` unset on a freshly provisioned staging host. What happens with
   `seed --reset`, and why?
4. What would break if the `db.expunge_all()` line in `_truncate_domain_tables` were removed?
5. How would you extend the seed to give each Maple resident two packages, keeping it idempotent?

<details><summary>Answers</summary>

1. The current occupancy's `(unit, relationship)` differs from the seeded pair in `MEMBERS`, so `_occupancy` calls `transfer_occupancy`: the 205 row is ended and a new row for the seeded unit starts.
   The resident has one more row than before (the 205 one stays as history). This path is untested.
2. So the new row has its id (and server defaults) before the next step uses it as a foreign key: the
   features, units and memberships need `building.id`, and roles and occupancies need `membership.id`.
3. It runs. `Settings.app_env` defaults to `dev`, so `check_seed_allowed("dev", reset=True)` passes and every
   domain row is truncated. This is review L2, tracked only in the PR.
4. The session's identity map would still hold objects for rows the `TRUNCATE` deleted. A following
   `select` would return nothing, but objects already loaded in the session could be reused or flushed as if
   they still existed (Inferred: in practice the seed queries again after the reset, so the visible risk is
   stale objects, e.g. after a caller had loaded rows earlier in the same session).
5. Give packages a natural key the seed controls (e.g. a fixed tracking number per resident), add a helper
   that `_upsert`s by `(building, tracking number)` and `_set`s the seeded fields, call it after occupancies,
   add `Package` to `DOMAIN_TABLES` in the test, and extend the README. Without a stable natural key each
   run would add two more packages.

</details>
