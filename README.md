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
| Python | 3.12.13 | Backend runtime. Pinned in `.python-version` and `.tool-versions`. |
| Node.js | 24.16.0 | Frontend runtime. Pinned in `.nvmrc`, `.node-version`, and `.tool-versions`. |
| npm | 11.x | Use npm, not yarn/pnpm, because `frontend/package-lock.json` is the lockfile. |
| Backend framework | FastAPI | Version range lives in `backend/pyproject.toml`. |
| Frontend framework | React 18 + Vite 6 | Version ranges live in `frontend/package.json`. |
| Database, when added | PostgreSQL 16 | Added later through the database milestone. |
| Redis, when added | Redis 7 | Future live chat only; not needed for MVP notifications. |
| Containers, when added | Docker Desktop with WSL integration | Docker files are added by infra tickets. |

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
Python 3.12.13
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
Use Python 3.12.13.

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

## Running Alembic migration
From the project root:

Start PostgreSQL:

```bash
docker compose up -d db
```

Rebuild app image so it has current dependencies:

```bash
docker compose build app
```

Check Alembic exists inside the app container:

```bash
docker compose run --rm app alembic --version
```

Run Alembic migrations inside Docker(not from your localhost):

```bash
docker compose run --rm app alembic upgrade head
```

Check current Alembic revision:

```bash
docker compose run --rm app alembic current
```

Verify directly in PostgreSQL:

```bash
docker compose exec db psql -U postgres -d condo_dev -c "select * from alembic_version;"
```

Inside Docker Compose, keep `.env` as:

```bash
DATABASE_URL=postgresql+asyncpg://postgres:devpassword@db:5432/condo_dev
```