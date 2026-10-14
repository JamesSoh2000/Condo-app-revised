# Condo Management App

This is the clean starter repo for the condo management web app.

The app is organized as a small monorepo:

```text
.
├── backend/   # FastAPI starter backend
├── frontend/  # Current Base44-exported frontend V1
└── docs/      # Product, architecture, tickets, and AI-agent context
```

## Current State

- `frontend/` contains the current frontend export from Base44.
- `backend/` is intentionally minimal: FastAPI app startup, JSON request logging, and health/version endpoints.
- Database, auth, Alembic, Docker, deployment, S3, notifications, and feature modules will be added through the milestone tickets instead of living in the repo as half-built scaffolding.
- `docs/AI_PROJECT_CONTEXT.md` is the standard context file to attach to AI coding sessions.
- `docs/AI_AGENT_WORKFLOW.md` explains how two developers should work with AI agents on this project.

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
- Frontend migration work should happen through tickets in `docs/MILESTONES_AND_TICKETS.md`.

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

- `docs/backend_requirements.md`: backend/product requirements.
- `docs/BACKEND_INFRA.md`: target backend and infrastructure guide.
- `docs/MILESTONES_AND_TICKETS.md`: canonical milestone and ticket breakdown.
- `docs/AI_PROJECT_CONTEXT.md`: attach this to AI coding sessions.
- `docs/AI_AGENT_WORKFLOW.md`: team workflow for two developers using agentic AI coding.

## Development Workflow

1. Pick a ticket from `docs/MILESTONES_AND_TICKETS.md`.
2. Attach `docs/AI_PROJECT_CONTEXT.md` to the AI coding session.
3. Follow `docs/AI_AGENT_WORKFLOW.md` for prompt shape, branch naming, PR checklist, and handoff format.
4. Keep each PR scoped to one ticket.
5. Add database, auth, Docker, and infra only when the relevant ticket calls for it.

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