# Condo Management App

This is the clean starter repo for the condo management web app.

The app is organized as a small monorepo:

```text
.
├── backend/   # FastAPI starter backend
├── frontend/  # Current Base44-exported frontend V1
├── docs/      # Plan: scope, architecture, ADRs, tickets, process (start at docs/README.md)
├── scripts/   # Repo tooling (docs checks)
├── CLAUDE.md  # Agent context: layout, commands, non-negotiable rules
└── .claude/   # Claude Code slash commands for the ticket loop
```

## Quickstart

Needs Docker (with WSL integration), [uv](https://docs.astral.sh/uv/) and Node 24 (versions below).

```bash
make up                     # api :8000, Postgres, Mailpit (UI :8025), S3 emulator :4566; waits until healthy
make migrate                # alembic upgrade head
make seed                   # demo buildings and accounts (below); `make seed reset=1` wipes first
cd frontend && npm ci && npm run dev   # http://localhost:5173, /api proxied to :8000
```

`make help` lists every target; `make check` runs what CI runs (with the stack up). Port 5432 already taken?
Pass the same free port to every target: `make up DB_PORT=55432`, `make migrate DB_PORT=55432`.
More: [docs/README.md](docs/README.md), [ADR-0007](docs/adr/0007-private-s3-presigned-uploads.md) (the S3 emulator).

`make prodlike` (after `make down`) runs what staging will run instead: the API image tagged with this commit
and the built SPA behind `deploy/Caddyfile` on http://localhost:8080 ([P1-08](docs/tickets/P1-08-production-like-local-stack.md)).
Use it to check the built artifacts (SPA routes, caching, headers, migrations in the image); `make prodlike-smoke`
tests it and `make prodlike-down` stops it. Keep `make up` for everyday work: it reloads code and runs the tests.

### Seeded accounts

`make seed` (`python -m app.cli seed`, [P1-06](docs/tickets/P1-06-seed-and-cli.md)) creates two buildings and
the accounts below, and puts back any seeded value you changed; it leaves other rows alone. It refuses to run
with `APP_ENV=prod`. `make seed reset=1` first deletes every domain row, and runs only with `APP_ENV=dev`.
Every account's password is `DevPassword!2026` in dev and test (`make seed` also puts it back if you changed
it). Login arrives in [P2-01b](docs/tickets/P2-01b-sessions-login-logout.md). Staging uses the secret
`SEED_PASSWORD` instead, and `seed` refuses to run there without a valid one.

| Email (`@example.test`) | Building | Membership | Roles | Unit (relationship) |
|---|---|---|---|---|
| `manager` | Maple Tower (`maple`) | active | property_management | — |
| `security` | `maple` | active | security | — |
| `council` | `maple` | active | council | — |
| `resident1` | `maple` | active | resident | 101 (owner) |
| `resident2`, `resident3` | `maple` | active | resident | 102 (tenant, household) |
| `resident4`, `resident6` | `maple` | active | resident | 304 (owner, household) |
| `resident5` | `maple` | active | resident | 503 (tenant) |
| `pending` | `maple` | pending | resident | — |
| `birch.manager` | Birch Court (`birch`) | active | property_management | — |
| `birch.resident` | `birch` | active | resident | 201 (tenant) |

`maple`: 40 units (`101`–`104` … `1001`–`1004`), join code `MAPLE-2026`, features packages, notices and
maintenance. `birch`: 8 units (`101`–`104`, `201`–`204`), join code `BIRCH-2026`, feature packages. Both in
`America/Toronto`. The list lives in `backend/app/seed.py`; change both together.

### Database upgrades

A new Postgres major can't open an older major's data directory, so a major bump gives compose's `db` a
new volume, and `make up` starts with an empty database. Run `make migrate` again (dev data is only
migrations and seed data). The old volume is kept until you remove it. After the 16 → 18 upgrade
(P0-06):

```bash
docker volume rm building-website-local_postgres_data   # the Postgres 16 data, no longer used
```

## Current State

- The project follows the plan adopted on 2026-10-13: [docs/README.md](docs/README.md) is the single source of
  truth, and work is in phase P0 (quality gates and workflow) of the [roadmap](docs/ROADMAP.md).
- `frontend/` contains the current frontend export from Base44.
- `backend/` is a FastAPI app with JSON request logging, health/readiness/version endpoints, SQLAlchemy model
  bases and an empty Alembic baseline. Domain modules are added through the [tickets](docs/tickets/README.md).
- [`CLAUDE.md`](CLAUDE.md) is the agent context, loaded automatically by Claude Code; Codex reads
  [`AGENTS.md`](AGENTS.md).
- The pre-2026-10-13 docs are archived in [docs/archive/2026-10-legacy/](docs/archive/2026-10-legacy/README.md).

## Important Terms

- Use **Council Member** with role slug `council`.
- Treat old `board` references in the Base44 frontend as legacy terminology to migrate later.
- `security` means building security/concierge staff, not cybersecurity.
- Amenities are building-specific and feature-gated. Do not assume every building has gameroom or speakeasy.
- MVP notifications use durable database records and API refetch/polling. WebSockets are reserved for future live chat.

## Project Versions

Both developers should use the same toolchain in WSL2 Ubuntu:

| Tool | Version | Notes |
|---|---:|---|
| WSL distro | Ubuntu 24.04 LTS | Use WSL2. Ubuntu 22.04 is workable only if the versions below match. |
| Python | 3.14.8 | Backend runtime. Pinned in `.python-version` and `.tool-versions`. |
| Node.js | 24.16.0 | Frontend runtime. Pinned in `.nvmrc`, `.node-version`, and `.tool-versions`. |
| npm | 11.x | Use npm, not yarn/pnpm, because `frontend/package-lock.json` is the lockfile. |
| Backend framework | FastAPI | Version range lives in `backend/pyproject.toml`. |
| Frontend framework | React 18 + Vite 6 | Version ranges live in `frontend/package.json`. |
| Database | PostgreSQL 18 | Runs in Docker Compose (`make up`); CI runs the same major. |
| Containers | Docker Desktop with WSL integration | `docker-compose.yml`: api, db, mailpit, s3 (LocalStack). |

Recommended WSL version managers:

- Use `pyenv` for Python.
- Use `nvm` for Node.
- `mise` or `asdf` also work because `.tool-versions` is included, but both devs should avoid mixing managers within the same shell.

Quick version check:

```bash
python --version
node --version
npm --version
```

Expected major outputs:

```text
Python 3.14.8
v24.16.0
11.x
```

## Frontend

The frontend setup lives in `frontend/package.json`.
Use Node.js 24.16.0 with npm 11.x.

```bash
cd frontend
nvm use
npm install
npm run dev
```

Useful frontend commands:

```bash
npm run build
npm run lint
npm run typecheck
```

Notes:

- The frontend still imports Base44 SDK code.
- The frontend still contains legacy `board` naming from the export.
- Frontend migration work happens through tickets in [docs/tickets/](docs/tickets/README.md)
  ([ADR-0011](docs/adr/0011-frontend-strangler-typescript.md)).

## Backend

The backend setup lives in `backend/pyproject.toml`.
Use Python 3.14.8 (`pyenv install 3.14.8`, or `uv python install 3.14.8` with a recent uv: 0.11.17, the
version CI pins, doesn't know 3.14.8, while 0.13.1 does; `uvx uv@0.13.1 python install 3.14.8` works with
either).

```bash
cd backend
uv sync
uv run uvicorn app.main:app --reload
```

Backend URLs:

- API health: `http://127.0.0.1:8000/api/health`
- API readiness: `http://127.0.0.1:8000/api/ready`
- API version: `http://127.0.0.1:8000/api/version`
- OpenAPI docs: `http://127.0.0.1:8000/api/docs`

Run backend tests:

```bash
cd backend
uv run pytest
```

## Docs

Start at [docs/README.md](docs/README.md) (reading order). The main documents:

- [PRODUCT_SCOPE.md](docs/PRODUCT_SCOPE.md): what the demo does, what waits for the pilot, product defaults.
- [ARCHITECTURE.md](docs/ARCHITECTURE.md) and [adr/](docs/adr/README.md): how the system fits together, and why.
- [ROADMAP.md](docs/ROADMAP.md) and [tickets/](docs/tickets/README.md): phases, gates and the tickets.
- [ENGINEERING_PRACTICES.md](docs/ENGINEERING_PRACTICES.md): git, PRs, Definition of Done, testing, CI.
- [AI_AGENT_PLAYBOOK.md](docs/AI_AGENT_PLAYBOOK.md): the autonomous frame → build → review → explain → merge loop.
- [HUMAN_INBOX.md](docs/HUMAN_INBOX.md): what the agents need from you, and what they decided without you.

Check docs links locally with `python3 scripts/check-links.py` (CI runs it in the `docs` job).

## Development Workflow

AI agents build, review and merge tickets on their own
([docs/AI_AGENT_PLAYBOOK.md](docs/AI_AGENT_PLAYBOOK.md), [ADR-0014](docs/adr/0014-autonomous-agent-workflow.md)).
In short, with Claude Code:

1. `/build-next` (or `/loop /build-next` to keep going): picks the next ready ticket and runs `/build-ticket`,
   which frames it, implements it test-first on branch `<id>-<slug>`, gets a fresh-session review (plus
   Codex on Tier 1), writes the explanation in `docs/explanations/`, and squash-merges when every gate passes.
2. You check [docs/HUMAN_INBOX.md](docs/HUMAN_INBOX.md) for blocked items and decisions to audit, and read
   the explanations to learn (`/quiz-me P0-02` if you want to test yourself).

`CLAUDE.md` holds the rules every session follows; [`.claude/README.md`](.claude/README.md) lists all the
commands.
