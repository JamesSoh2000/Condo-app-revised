# Explanation — P0-06 Runtime and CI upgrades: Python 3.14, Postgres 18, SQLAlchemy 2.1, Actions v7

> Code at the head of PR #35 (2026-10-15), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md));
> no human reviewed it. The branch is rebased onto the latest `main` (`git merge-base --is-ancestor origin/main HEAD`).
> Snapshot: if the code changes later, write a new explanation; lasting decisions live in ADRs. Form: full
> (Tier 2). Walkthrough variant: C (one upgrade moving dev, the Docker image and CI together).

## Findings for the implementer (read first)

The code matches the PR's plan and decisions. These are open bookkeeping items and one known gap the PR
already lists as a follow-up:

1. **The inbox is not updated.** Six decisions are marked autonomous (below), but
   [HUMAN_INBOX](../HUMAN_INBOX.md) is not in the diff, and its PRE-7 row is still `open`, with the
   recommendation of a version-range ignore that this PR replaced with `update-types` (see §2). The merge gate
   box "inbox updated" is unticked, so this may still be planned.
2. **The ticket index still says `in progress`** (`docs/tickets/README.md`); the gate box is unticked.
3. **Round 3 L2 is a live trap, not just a note.** The `docker` Dependabot entry groups minor and patch
   updates and has no ignore for `ghcr.io/astral-sh/uv`. The first uv release Dependabot proposes there will
   fail `scripts/check-version-pins.py`, because CI's setup-uv `version` input is not something Dependabot
   updates. Since updates are grouped, that red check blocks the whole grouped docker PR.

## 1. What was built and why

The backend now runs on Python 3.14.8, Postgres 18 and SQLAlchemy 2.1 in dev, in the Docker image and in CI,
and CI uses the v7 GitHub Actions. Dependabot's separate PRs (#17–#33) would have moved these one file at a
time and left, for example, CI on Postgres 16. The PR moves them together, adds a CI check that fails when the
pins disagree, and tells Dependabot to stop proposing the upgrades that need this kind of coordinated change.

## 2. Decisions

| Decision | Alternative rejected | Why | Basis |
|---|---|---|---|
| Upgrade Python, Postgres, SQLAlchemy and Actions now; keep Tailwind 3 and framer-motion 11 | Merge Dependabot's PRs one by one, or wait | P1 starts the schema; upgrading while the backend is mostly infrastructure is cheap | James (inbox PRE-7) |
| Exact 3.14.8 in `.python-version`, `.tool-versions` and CI; minor-only `python:3.14-slim` in the Dockerfile | 3.14.5, the newest Python uv 0.11.17 can download | 3.14.8 is the newest patch both setup-python and the Docker image offer. A dev whose uv is too old uses pyenv or `uvx uv@0.13.1` (README) | James (3.14) + **autonomous** (patch) |
| A new volume `postgres18_data`, old one left alone | `pg_upgrade` in a helper container; dump and restore | Dev data is only migrations (`make seed` is a stub until P1-06), so `make migrate` rebuilds it. Both alternatives add a one-off script. Leaving the old volume makes the change reversible | **autonomous** |
| Mount the volume at `/var/lib/postgresql` | Keep `/var/lib/postgresql/data` and override `PGDATA` | The 18 image's documented layout puts data in `/var/lib/postgresql/18/docker`; one level up leaves room for a future `pg_upgrade --link` beside it | image docs |
| `SQLAlchemy[asyncio]>=2.1.0` | Plain `SQLAlchemy>=2.1` plus a separate `greenlet` pin | 2.1 stopped installing greenlet by default; the extra is SQLAlchemy's own way to ask for it, and moves with it | ticket |
| Stdlib `uuid.uuid7`, drop `uuid6` | Keep `uuid6` | One dependency less; the old comment in `mixins.py` said it was only there for 3.12 | **autonomous** |
| Include setup-uv 8.3.2 → 10.3.0 | Leave Dependabot #20 open | Same file, same kind of bump; the inputs the workflow uses (`version`, `enable-cache: true`) are set explicitly, so the changed defaults don't apply | **autonomous** |
| Add `scripts/check-version-pins.py` to the docs job and `make check` | Rely on review | The [P0-04b explanation](./P0-04b-github-workflow.md) flagged this drift and no gate caught it. Adding a check only tightens | **autonomous** (CLAUDE.md: agents may add checks) |
| Dependabot ignores Python `semver-major` + `semver-minor`, Postgres `semver-major` | A version range (`>=3.15`), as the inbox recommended | `update-types` is relative to the current pin, so the config needn't be edited at every upgrade | **autonomous** |
| `make up` passes `--renew-anon-volumes` | Tell devs to `docker compose down` once | Without it the first `make up` keeps the old 3.12 venv volume and the app crashes (review round 2, M1) | review |
| Accept ruff's `UP037`/`UP043` autofixes | Ignore the rules | They are the normal lint for the new target | ruff config |

The **anonymous volume** is compose's unnamed `- /app/.venv` volume: Docker fills it from the image on first
start and reuses it whenever the container is recreated.

**What an interviewer would ask:** why a Postgres major can't reuse the data directory; why 3.14 → 3.15 is a
*minor* to Dependabot; how to stop a one-file bump splitting dev and CI; what `--renew-anon-volumes` costs.

**Framing changes:** added AC6 (18 must not open the 16 volume), AC9 (stdlib `uuid7` with a test) and AC10
(the pin check). Loosened: none.

## 3. How it is implemented

### Overview

- **Pins:** `.python-version`, `.tool-versions`, `backend/pyproject.toml`, `backend/Dockerfile::FROM python:3.14-slim`,
  both CI `setup-python` steps, `make s3-smoke` and the `scripts/s3-smoke.py` header.
- **Postgres 18:** `docker-compose.yml::postgres18_data` and `.github/workflows/ci.yml::image: postgres:18`.
- **SQLAlchemy 2.1:** `backend/pyproject.toml::SQLAlchemy[asyncio]`, relocked (2.1.4, greenlet, no `uuid6`).
- **The guard:** `scripts/check-version-pins.py::main`, in `.github/workflows/ci.yml::Check version pins` and `make check`.
- **Dependabot:** `.github/dependabot.yml` groups minor/patch per ecosystem and ignores the coordinated bumps.

### Walkthrough (Variant C: one upgrade from push to a running stack)

1. **Trigger.** A push runs `.github/workflows/ci.yml` on the PR; a dev runs `make up` on a machine with the
   3.12 app container and the Postgres 16 volume.
2. **CI backend job.** `actions/setup-python@v7` installs 3.14.8, `astral-sh/setup-uv@v10.3.0` installs uv
   0.11.17, and `uv sync --locked` installs from `backend/uv.lock` (whose `requires-python` is `==3.14.*`).
   Ruff (`py314`) and mypy (`3.14`) run, then `alembic upgrade head`, `alembic check` and pytest, against
   the `postgres:18` service container.
3. **CI docs job.** `Check version pins` reads `.python-version` (3.14.8) as the truth and checks every other
   pin against it, and compose's Postgres major against CI's (excerpt 3). It prints
   `Python 3.14.8, Postgres 18 and uv 0.11.17 agree in every pin`.
4. **Dev `make up`.** `docker compose up -d --build --wait --remove-orphans --renew-anon-volumes`
   rebuilds the image on `python:3.14-slim`; `--renew-anon-volumes` gives `app` a fresh `/app/.venv` copied
   from the new image. `db` starts `postgres:18` on the new, empty `postgres18_data` volume; Postgres
   initialises `/var/lib/postgresql/18/docker`. The old `building-website-local_postgres_data` volume is
   not mounted.
5. **Dev `make migrate`.** Rebuilds the schema on the empty 18 database.
6. **End state.** CI's three checks pass under their old names (green on the PR head). Locally:
   `Python 3.14.8`, `PostgreSQL 18.6`, `/api/health` and `/api/ready` 200 (PR evidence, AC5).
7. **Where it fails and what you see.**
   - Pins drift: `check-version-pins: .github/workflows/ci.yml: postgres major is '18', expected '17'`, then
     `bump every pin together`, exit 1. A vanished pin: `no match for … update this script`; an extra one:
     `3 match(es) … expected 2 (one per step)`.
   - Without `--renew-anon-volumes`: app restarts with `ModuleNotFoundError: No module named 'uvicorn'`.
   - Postgres 18 pointed at the 16 data: it refuses to start ("…upgrading the Docker image without upgrading
     the underlying database using pg_upgrade…").
   - Missing greenlet: `ImportError: The SQLAlchemy asyncio module requires that the Python 'greenlet'
     library is installed.` on the first async session.
8. **Recover.** Everything is reversible: the old volume still holds the 16 data. To reclaim it,
   `docker volume rm building-website-local_postgres_data` (`README.md::Database upgrades`). Dangling venv
   copies left by `--renew-anon-volumes` go with `docker volume prune`.

### Data model changes

None. No migration; the dev database volume is renamed `postgres_data` → `postgres18_data`.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `scripts/check-version-pins.py` | New pin check | +134 |
| `.github/dependabot.yml` | Groups and ignores | +34 |
| `.github/workflows/ci.yml` | Postgres 18, Python 3.14.8, Actions v7, setup-uv 10.3.0, pin-check step | +17 / −11 |
| `backend/uv.lock` | Relock (SQLAlchemy 2.1.4, greenlet, no uuid6) | +420 / −294 |
| `backend/pyproject.toml` | 3.14 targets, `SQLAlchemy[asyncio]`, drop `uuid6` | +5 / −5 |
| `backend/tests/test_models_mixins.py` | New: uuid7 version and ordering | +43 |
| `docker-compose.yml` | `postgres:18`, new volume, mount point | +7 / −3 |
| `Makefile` | `--renew-anon-volumes`, pin check in `check`, s3-smoke 3.14 | +5 / −2 |
| `backend/app/models/mixins.py` | Stdlib `uuid7` | +1 / −5 |
| `backend/Dockerfile`, `.python-version`, `.tool-versions`, `scripts/s3-smoke.py`; `backend/app/core/config.py`, `backend/app/core/dependencies.py` (ruff autofixes) | Version bump | +1 / −1 each |
| `README.md` | Versions, "Database upgrades", how to get 3.14.8 | +17 / −4 |
| `CLAUDE.md`, `docs/ARCHITECTURE.md`, `docs/ENGINEERING_PRACTICES.md`, ADR-0002/0008, D-02, D-05, P1-08, P6-P7 backlog; the ticket and its index row | Version mentions; ticket (+128) | ±1–2 each |

**Key excerpts**

`docker-compose.yml::postgres18_data`

```yaml
  db:
    # Bump together with the CI service in .github/workflows/ci.yml. A new major can't open an older
    # major's data directory, so a major bump also gets a new volume name (README "Database upgrades").
    image: postgres:18
    # ...
    volumes:
      # Postgres 18+ images keep the data in a versioned subdirectory (/var/lib/postgresql/18/docker), so
      # the volume is mounted one level up.
      - postgres18_data:/var/lib/postgresql
# ...
volumes:
  postgres18_data:
```

- A new volume name means 18 never sees the 16 data directory; Postgres initialises an empty one.
- Why: §2 "new volume". If the name had been kept, 18 would find a 16 `PG_VERSION` and refuse to start.
- If the mount stayed at `/var/lib/postgresql/data`, the 18 image's entrypoint would refuse to start: it
  treats any mount there as an old-layout "unused mount/volume" (checked here in the image's
  `docker-entrypoint.sh`). And the image declares `/var/lib/postgresql` as a volume, so without a named
  mount there the data would sit in an anonymous volume.

`backend/pyproject.toml::SQLAlchemy[asyncio]` and `backend/app/models/mixins.py::UUIDPrimaryKeyMixin`

```toml
    # The asyncio extra brings greenlet, which SQLAlchemy 2.1 no longer installs by default.
    "SQLAlchemy[asyncio]>=2.1.0,<3.0.0",
```

```python
from uuid import UUID, uuid7
# ...
class UUIDPrimaryKeyMixin:
    id: Mapped[UUID] = mapped_column(
        Uuid(as_uuid=True),
        primary_key=True,
        default=uuid7,
    )
```

- The extra pulls greenlet, which SQLAlchemy's async layer uses to run its sync core inside `await`.
- Removing `[asyncio]` makes the lock drop greenlet and every async session raise `ImportError` (PR probe).
- `uuid7` now comes from the standard library (3.14+); on 3.12 this import would fail.

`scripts/check-version-pins.py::main`

```python
# A YAML/TOML scalar, quoted or not: `key: 3.14.8`, `key: "3.14.8"`, `key = '3.14'`.
VALUE = r"""["']?([^"'\s#]+)["']?"""
# `image: postgres:18`, quoted or with a registry prefix; captures the major.
POSTGRES_IMAGE = r"""^\s*image:\s*["']?(?:docker\.io/)?(?:library/)?postgres:(\d+)"""


def find_all(path: str, pattern: str, count: int | None = None) -> list[str]:
    """Every match of `pattern` in `path`; exactly `count` of them when given."""
    found = re.findall(pattern, read(path), flags=re.MULTILINE)
    if not found:
        sys.exit(f"check-version-pins: no match for {pattern!r} in {path}; update this script")
    if count is not None and len(found) != count:
        sys.exit(
            f"check-version-pins: {len(found)} match(es) for {pattern!r} in {path},"
            f" expected {count} (one per step); update this script or the file"
        )
    return found
# ...
def main() -> int:
    exact = read(".python-version").strip()
    # ...
    major, minor, _ = exact.split(".")
    want_minor = f"{major}.{minor}"
    next_minor = f"{major}.{int(minor) + 1}"

    # (file, what, found, expected)
    checks = [
        (".tool-versions", "python", find_all(".tool-versions", r"^python (\S+)$"), exact),
        (
            CI,
            "python-version",
            find_all(CI, rf"^\s*python-version:\s*{VALUE}", count_uses("actions/setup-python")),
            exact,
        ),
        # ... Dockerfile minor, requires-python, ruff, mypy, Makefile s3-smoke, s3-smoke.py header
    ]

    docker_uv = find_all("backend/Dockerfile", r"ghcr\.io/astral-sh/uv:(\S+)")
    ci_uv = find_all(CI, rf"^\s*version:\s*{VALUE}", count_uses("astral-sh/setup-uv"))
    checks.append((CI, "setup-uv version", ci_uv, docker_uv[0]))
    checks.append(("backend/Dockerfile", "uv image", docker_uv, docker_uv[0]))

    compose_pg = find_all("docker-compose.yml", POSTGRES_IMAGE)
    ci_pg = find_all(CI, POSTGRES_IMAGE)
    checks.append((CI, "postgres major", ci_pg, compose_pg[0]))
    # ...
```

- `.python-version` is the single source for Python; compose is the source for Postgres; the Dockerfile is
  the source for uv. Every other pin is compared to it.
- `count_uses` makes the number of `python-version:` values equal the number of `setup-python` steps, so a
  step that switches to `python-version-file` (no pin) fails instead of being skipped (round 1, L1).
- "No match" exits non-zero on purpose: a renamed key must not silently stop being checked.
- Without the script, a Dependabot compose bump to `postgres:19` would merge green with CI still on 18.

`.github/dependabot.yml::dependency-name: python`

```yaml
  - package-ecosystem: docker
    directory: /backend
    # ...
    groups:
      docker-minor-and-patch:
        update-types: [minor, patch]
    ignore:
      - dependency-name: python
        update-types: ["version-update:semver-major", "version-update:semver-minor"]

  - package-ecosystem: docker-compose
    # ...
    ignore:
      # Newer LocalStack images need an account token; 4.14.0 is pinned on purpose (ADR-0007).
      - dependency-name: localstack/localstack
      - dependency-name: postgres
        update-types: ["version-update:semver-major"]
```

- Python's "major" is 3 forever; a new Python is a *minor* to Dependabot, so both are ignored.
- Removing the minor ignore brings back a `python:3.15-slim` PR that the pin check would fail.

`Makefile::--renew-anon-volumes`

```make
# --renew-anon-volumes: the app's /app/.venv volume is a copy of the image's venv. Without it, a recreated
# container keeps the old copy (stale packages after a uv.lock change; after a Python bump, no packages at all).
up: ## Start api, db, mailpit and the S3 emulator; waits until all are healthy
	$(COMPOSE) up -d --build --wait --remove-orphans --renew-anon-volumes
```

- Without the flag the first `make up` after this PR runs the 3.14 image over the 3.12 venv copy and crashes
  (round 2, M1). The db is a named volume, so it is unaffected.

`backend/tests/test_models_mixins.py::test_primary_key_default_is_a_standard_library_uuid7`

```python
def test_primary_key_default_is_a_standard_library_uuid7() -> None:
    value = _new_primary_key()

    # Exactly uuid.UUID: a subclass (uuid6.UUID) would mean the third-party package is still in use.
    assert type(value) is uuid.UUID
    assert value.version == 7
    assert value.variant == uuid.RFC_4122


def test_primary_keys_sort_in_creation_order() -> None:
    values = [_new_primary_key() for _ in range(1000)]

    assert values == sorted(values)
    assert len(set(values)) == len(values)
```

- Calls the column's default on a probe model with its own metadata, so no table reaches the migrations.
- Red on `main` (`uuid6.UUID` is a subclass), green here. The ordering test is why uuid7 was chosen: index
  inserts in time order.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| CI Python patch drifts from `.python-version` (quoted or not) | Pin check fails | No automated test; PR mutations (11) and a re-run here (unquoted `3.14.7`) exit 1 |
| Compose Postgres bumped, CI service not | Pin check compares majors | No automated test; mutation re-run here exits 1 |
| A `setup-python` step loses or gains a pin | `count_uses` mismatch exits | No automated test; mutation re-run here exits 1 |
| Dockerfile uv and setup-uv `version` drift | Pin check | PR mutations only |
| Postgres 18 on the 16 volume | Never mounted (new name) | Manual (PR AC6 probe); no test |
| Stale 3.12 venv in the anonymous volume | `--renew-anon-volumes` | Manual reproduction in a scratch project (round 2); no test |
| SQLAlchemy 2.1 changes session/transaction behaviour | Sessions keep `autoflush=False` (`backend/app/core/database.py::autoflush=False`) | `backend/tests/test_db_isolation.py` (all P0-05 isolation tests), on PG 18 in CI |
| greenlet missing | Pulled by the `asyncio` extra | Indirect: every async DB test would fail; no dedicated test |
| PK is not a stdlib v7 UUID, or not ordered | stdlib `uuid7` | `test_primary_key_default_is_a_standard_library_uuid7`, `test_primary_keys_sort_in_creation_order` |

The pin check has **no test file**; its mutations were run by hand. That is a (small) finding: a regex
change could weaken it without anything failing.

**Acceptance criteria → evidence**

- AC1: the pin check is clean; `git grep` finds 3.12 only in history notes, done tickets and the inbox.
- AC2–3: CI `Backend tests` green on PG 18 / SA 2.1 (ruff, format, mypy, `alembic upgrade`/`check`, pytest
  incl. `backend/tests/test_db_isolation.py`); PR: `42 passed` with deprecation warnings as errors.
- AC4: lock `sqlalchemy 2.1.4`, `greenlet 3.5.1` via `extra: asyncio` (PR `uv tree`).
- AC5–6: manual (PR). `test_ready_checks_database_when_enabled` mocks the DB, so it doesn't prove PG 18.
- AC7: the three checks are green under their old names on the PR head.
- AC8: diff only; GitHub validates after merge.
- AC9: the two uuid7 tests above. AC10: manual mutations (PR and re-run here).

## 6. Review log

| Round | Reviewer | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|
| 1 | Fresh Claude reviewer | MERGE | L1: unquoted/single-quoted `python-version` skipped. L2: Makefile s3-smoke and `s3-smoke.py` not checked. L3: docker/compose ecosystems had no group. L4: uv pin could drift | All fixed (`6695c30`, `8204caf`) |
| 2 | New fresh Claude reviewer | MERGE | M1: first `make up` keeps the 3.12 venv, app crashes. L1: README uv claim unverified | Both fixed (`c6f5575`) |
| 3 | New fresh Claude reviewer (last round) | MERGE | L1: `--renew-anon-volumes` recreates containers every `make up` and leaves dangling volumes. L2: Dependabot docker uv bumps will fail the pin check | Not fixed; listed as follow-ups |

## 7. Not verified

- **Dependabot config** is validated only once on `main`; nobody has seen it parse, group or ignore (that it
  reads `3.14-slim` → `3.15-slim` as `semver-minor` is from its docs). Round 3 L2: see Finding 3.
- **Round 3 L1:** every `make up` now recreates containers and leaves an orphaned ~64 MB venv volume (and a
  LocalStack one). LocalStack state is in memory, so S3 emulator objects are lost on each `make up`, not only
  on `make down`; I did not run this to confirm (the instructions ruled out stopping containers).
- **The Docker image's patch version** is not pinned: `python:3.14-slim` picks up the newest 3.14.x on each
  build, so the image can run a newer patch than CI. The pin check only compares the minor there.
- **AC5 and AC6** are manual PR evidence, not re-run here or tested in CI. **Not covered by the pin check:**
  the `postgres:18.x` text in D-02, D-05, P1-08 and P6-P7, and future files like `compose.prodlike.yml`.
- The stdlib `uuid7` ordering test is in one process; ordering across processes relies on clock order.

## 8. How to change this safely

- **Next Python (3.15):** change `.python-version` first, then everything `scripts/check-version-pins.py`
  names (run it; it lists each mismatch), relock, and fix what ruff/mypy report. Dependabot won't propose it.
- **Next Postgres major:** change compose and `.github/workflows/ci.yml::image: postgres:18` together, give
  the volume a new name, and add the old one to `README.md::Database upgrades`. The pin check fails if you miss
  CI.
- **uv:** change `backend/Dockerfile::ghcr.io/astral-sh/uv:0.11.17` and the setup-uv `version` together.
  After any SQLAlchemy bump, `backend/tests/test_db_isolation.py` tells you sessions still behave.
- **A new pinned file** (for example `compose.prodlike.yml`): add a `find_all` line to
  `scripts/check-version-pins.py::main`, then mutate it once to see exit 1.

## 9. Must explain, then quiz

**1. Why can't Postgres 18 start on the old volume, and how could data be carried across?** A major version
changes the on-disk format, so the server checks `PG_VERSION` and refuses a directory written by another
major. The ways across are `pg_upgrade` (rewrites the catalog, optionally hard-linking data files; needs both
versions' binaries), dump and restore (`pg_dump` from 16, `psql`/`pg_restore` into 18), or logical
replication. This ticket uses none because dev data is only migrations: `make migrate` recreates it, and a new
volume (`docker-compose.yml::postgres18_data`) avoids a one-off script.

**2. Why does SQLAlchemy 2.1 need the `asyncio` extra?** The async API runs SQLAlchemy's synchronous core
inside a greenlet so it can `await` the asyncpg driver. 2.1 no longer depends on greenlet by default, so
without `backend/pyproject.toml::SQLAlchemy[asyncio]` the lock omits it and the first async session raises
`ImportError: The SQLAlchemy asyncio module requires that the Python 'greenlet' library is installed.`.

**3. Why does Python need a minor rule when "ignore majors" is enough for Postgres?** Dependabot reads Docker
tags as semver. Postgres tags are `18`, `19`: a new release is a major. Python tags are `3.14`, `3.15`: the
major is always 3, so a new Python is a *minor*. `.github/dependabot.yml::dependency-name: python` therefore
ignores `semver-minor` too, while patches (inside the tag) are irrelevant.

**4. What keeps CI, the image and dev on the same versions, and what doesn't?** `scripts/check-version-pins.py`
in the docs job and `make check`, plus comments at each pin. It does not cover: the image's Python patch
(`3.14-slim` floats), Postgres minors (both use `18`, so each pulls the newest 18.x independently), docs that
mention versions, Node, and files the script doesn't list.

**Quiz**

1. A Dependabot PR bumps `postgres:18` to `postgres:19` in `docker-compose.yml` only. What happens, and why
   did Dependabot open it at all?
2. Why is the volume mounted at `/var/lib/postgresql` and not `/var/lib/postgresql/data` on 18?
3. Why does the uuid7 test assert `type(value) is uuid.UUID` rather than `isinstance`?
4. What would break if we removed `--renew-anon-volumes` from `make up`?
5. How would you extend the pin check to cover a new `compose.prodlike.yml` with its own `db` image?

<details><summary>Answers</summary>

1. It shouldn't open it: the `docker-compose` entry ignores Postgres majors. If one came anyway (or a person
   made the edit), the docs job's `Check version pins` fails with "postgres major is '18', expected '19'" for
   CI, so the PR can't merge until CI's service and the volume name move too.
2. The 18 image keeps data in `/var/lib/postgresql/18/docker` (its `PGDATA`). Its entrypoint refuses to start
   when something is mounted at `.../data` (the pre-18 layout), and the real data directory would not be in
   that mount anyway. One level up puts `18/docker` in the named volume and leaves room for a `19/docker`
   directory beside it for `pg_upgrade --link`.
3. `uuid6.UUID` subclasses `uuid.UUID`, so `isinstance` passes with the old package. Exact type is the only
   way the test goes red on `main` and proves the stdlib is used.
4. On the first `make up` after a Python bump, `app` keeps its old anonymous `/app/.venv` (3.12 packages) and
   restarts with `ModuleNotFoundError: No module named 'uvicorn'`. After any `uv.lock` change, it silently
   runs stale packages.
5. Add `checks.append(("compose.prodlike.yml", "postgres major", find_all("compose.prodlike.yml",
   POSTGRES_IMAGE), compose_pg[0]))` in `main`, run the script clean, then change that image to another major
   and confirm exit 1. Then check whether Dependabot's `docker-compose` entry reads that file; if it does, the
   Postgres-major ignore already applies.

</details>
