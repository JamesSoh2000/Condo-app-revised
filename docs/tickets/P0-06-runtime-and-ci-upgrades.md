# P0-06 — Runtime and CI upgrades: Python 3.14, Postgres 18, SQLAlchemy 2.1, Actions v7

| Field | Value |
|---|---|
| Phase / lane | P0 / A |
| Risk tier | 2 |
| Depends on | P0-04a, P0-04b, P0-05 |
| Replaces old | — |
| Status | in progress |

Added after the P0 gate, from James's answer to [HUMAN_INBOX](../HUMAN_INBOX.md) PRE-7 (2026-10-15, in
session): do the Python, Postgres, GitHub Actions and SQLAlchemy upgrades that Dependabot proposed in
#17–#33; keep Tailwind 3 and framer-motion 11.

## Goal

The backend runs and is tested on Python 3.14, Postgres 18 and SQLAlchemy 2.1, in dev, in the Docker image
and in CI alike, and CI uses the v7 GitHub Actions.

## Why

P1 starts writing the schema and migrations. Upgrading now, while the backend is mostly infrastructure,
costs far less than after P1-P3. It also stops dev and CI drifting apart: Dependabot's compose bump alone
would have left CI on Postgres 16 ([P0-04b explanation](../explanations/P0-04b-github-workflow.md)).

## Scope

- In:
  - **Python 3.12 → 3.14.8:** `.python-version`, `.tool-versions`, `backend/pyproject.toml`
    (`requires-python`, ruff `target-version`, mypy `python_version`), `backend/Dockerfile`
    (`python:3.14-slim`), CI `python-version`, `Makefile` `s3-smoke`, `scripts/s3-smoke.py`, the lockfile,
    and docs that state the version.
  - **Postgres 16 → 18:** compose `db` and the CI service together. The 18 image keeps its data in
    `/var/lib/postgresql/18/docker` and wants the volume mounted at `/var/lib/postgresql`. A 16 data
    directory can't be opened by 18, so dev gets a new volume, and the docs say how to drop the old one.
  - **SQLAlchemy 2.0 → 2.1:** `sqlalchemy[asyncio]` (2.1 no longer installs greenlet, which the async API
    needs); check sessions, transactions and migrations still behave (the P0-05 suite).
  - **GitHub Actions:** `actions/checkout`, `actions/setup-python` and `actions/setup-node` v6 → v7;
    `astral-sh/setup-uv` 8.3.2 → 10.3.0 (Dependabot #20, same file and same kind of change).
  - **Dependabot config:** stop proposing upgrades James has ruled out or that must move in step: no
    Tailwind or framer-motion majors; no Python minor (3.15) or Postgres major (19) bumps through
    Dependabot, because each needs the coordinated change this ticket makes; group the rest by ecosystem.
  - Close the superseded Dependabot PRs (#17, #19, #20, #21, #22, #24, #27) and the ruled-out ones (#26,
    #29) with a comment that links this PR.
- Out (do **not** do in this ticket): Tailwind 4 and framer-motion 14 (James: keep); the other Dependabot
  PRs (alembic, asyncpg, gunicorn, pytest, three, radix, mailpit): they stay open and are merged on their
  own, unless the 3.14 lock needs one of them; Node upgrades; the uv version pin (0.11.17).

## Interfaces

None. No API, schema or env var changes. Compose's db volume is renamed (`postgres_data` →
`postgres18_data`).

## Acceptance criteria

1. **Given** the repo, **then** every Python pin says 3.14 (3.14.8 where an exact patch is pinned) and no
   tracked config outside `docs/archive/`, `learnings/` and merged history still names 3.12.
2. **Given** `uv sync --locked` on Python 3.14.8, **then** ruff (target `py314`), the format check and
   `mypy --strict` (`python_version = "3.14"`) pass.
3. **Given** the compose stack on Postgres 18 and CI's Postgres 18 service, **then** `alembic upgrade head`,
   `alembic check` and the full pytest suite (including the P0-05 transaction-isolation tests) pass on
   SQLAlchemy 2.1.
4. **Given** `uv.lock`, **then** it resolves SQLAlchemy 2.1.x with greenlet (through the `asyncio` extra),
   and `requires-python` is `>=3.14,<3.15`.
5. **Given** the Docker image, **when** built, **then** it runs Python 3.14 and `/api/health` and
   `/api/ready` answer 200 against the Postgres 18 db (`make up`).
6. **Given** a dev machine that still has the Postgres 16 volume, **when** `make up` runs, **then** db
   starts healthy on a fresh 18 volume (it does not try to open the 16 data), and the README says how to
   remove the old volume.
7. **Given** CI, **then** every `uses:` line is on the new versions (checkout/setup-python/setup-node v7,
   setup-uv v10.3.0), the three required checks keep their names, and all three pass.
8. **Given** `.github/dependabot.yml`, **then** it ignores Tailwind and framer-motion majors, Python
   minor/major image bumps and Postgres majors, groups the remaining updates per ecosystem, and still
   ignores LocalStack (ADR-0007); GitHub reports no config error.
9. (new) **Given** the app's UUID primary keys, **then** they are still version-7 UUIDs: with 3.14 they come
   from the standard library (`uuid.uuid7`), and the `uuid6` package is dropped. A test checks the version
   and the ordering.
10. (new) **Given** a later bump that moves only some pins (Dependabot updates compose but not CI's
    `services:`, the Dockerfile but not `.python-version`), **then** CI fails:
    `scripts/check-version-pins.py` (docs job and `make check`) requires one Python patch/minor, one
    Postgres major and one uv release everywhere, quoted or not, with one pin per `setup-python`/`setup-uv`
    step (review round 1, L1, L2, L4). Shown to fail on purpose (CLAUDE.md lesson).

## Test plan

- `make check DB_PORT=55432` on the 3.14 venv against the compose Postgres 18 (AC2, AC3).
- `backend/tests/test_models_mixins.py` (new): the default PK is a version-7 UUID, and successive ones
  sort in creation order (AC9).
- `docker compose exec app python --version`; curl `/api/health` and `/api/ready` (AC5).
- `docker compose exec db postgres --version`; the old volume is left untouched (AC6).
- CI run on the PR (AC3, AC7); `gh api` Dependabot config check after merge (AC8).
- `git grep` for leftover 3.12 / postgres:16 pins (AC1).
- `scripts/check-version-pins.py` clean, then four mutations (compose Postgres, CI Python patch,
  Dockerfile minor, ruff target), each must exit 1 (AC10).

## Likely files

`.python-version`, `.tool-versions`, `backend/pyproject.toml`, `backend/uv.lock`, `backend/Dockerfile`,
`docker-compose.yml`, `.github/workflows/ci.yml`, `.github/dependabot.yml`, `Makefile`,
`scripts/s3-smoke.py`, `backend/app/models/mixins.py`, `README.md`, `CLAUDE.md`,
`docs/ENGINEERING_PRACTICES.md`, `docs/ARCHITECTURE.md`, ADR-0002/0008, D-02, D-05, P1-08, P6-P7 backlog.

## Must explain (learning checkpoint)

1. Why can't Postgres 18 start on the old dev volume, and what are the ways to carry data across a major
   version (and why this ticket uses none of them)?
2. Why does SQLAlchemy 2.1 need the `asyncio` extra, and what fails without it?
3. Why does Dependabot need a version range or `update-types` rule for Python, when "ignore majors" is
   enough for Postgres?
4. What keeps CI, the Docker image and the dev stack on the same versions, and what still doesn't?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC6 (the old volume must not be opened by 18), AC9 (stdlib `uuid7`, found
  while reading `app/models/mixins.py`, whose comment ties `uuid6` to 3.12), AC10 (a check that the pins
  stay in step: the drift the P0-04b explanation warned about had no gate).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Python 3.14.8, the newest patch that both `actions/setup-python` and the `python:3.14.8-slim` image
    offer (James: upgrade to 3.14). The Dockerfile keeps a minor-only tag (`3.14-slim`), as before.
  - setup-uv 10.3.0 is included (autonomous): the same CI file, explicit inputs (`version`,
    `enable-cache: true`) that v9/v10 didn't change.
  - A new dev volume instead of `pg_upgrade` or dump/restore (autonomous): dev data is only migrations
    (`make seed` is a stub until P1-06), so `make migrate` rebuilds it.
  - Dependabot ignores and groups (autonomous, reversible): the inbox recommendation, adjusted to the new
    versions.
- Split: none.
