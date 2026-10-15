# Everyday commands (P0-04a). `make help` lists them. The stack runs in Docker; backend tools run on the
# host with uv, frontend tools with npm (see README.md for the toolchain).

COMPOSE := docker compose
# The dev database as seen from the host. docker-compose.yml publishes db on 127.0.0.1:$(DB_PORT); if
# something else already listens on 5432, run every target with the same free port: `make up DB_PORT=55432`.
export DB_PORT ?= 5432
DEV_DATABASE_URL := postgresql+asyncpg://postgres:devpassword@localhost:$(DB_PORT)/condo_dev
BACKEND := cd backend &&
FRONTEND := cd frontend &&

.DEFAULT_GOAL := help
.PHONY: help up down logs ps migrate revision seed test lint fmt typecheck check gen-api e2e psql s3-smoke db-guard

help: ## List the targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-10s %s\n", $$1, $$2}'

up: ## Start api, db, mailpit and the S3 emulator; waits until all are healthy
	$(COMPOSE) up -d --build --wait --remove-orphans

down: ## Stop the stack (the database volume is kept)
	$(COMPOSE) down

logs: ## Follow the stack's logs
	$(COMPOSE) logs -f --tail=100

ps: ## Show the stack's services and health
	$(COMPOSE) ps

# Fails unless compose's db is the server on 127.0.0.1:$(DB_PORT). Without it, another local Postgres on
# that port would be migrated or checked instead, silently.
db-guard:
	@$(COMPOSE) port db 5432 2>/dev/null | grep -qx "127.0.0.1:$(DB_PORT)" || { \
	  echo "db-guard: compose's db is not published on 127.0.0.1:$(DB_PORT). Run \`make up\` first, or, if"; \
	  echo "another server holds the port, use a free one on every target: make up DB_PORT=55432"; exit 1; }

migrate: db-guard ## alembic upgrade head on the dev database
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic upgrade head

revision: db-guard ## Autogenerate a migration: make revision m="add packages" (then READ and edit it)
	@test -n "$(m)" || { echo 'usage: make revision m="what changed"'; exit 2; }
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic revision --autogenerate -m "$(m)"

seed: ## Demo data (stub until P1-06)
	@echo "make seed: nothing to seed yet; P1-06 adds the demo data"

test: ## Backend tests
	$(BACKEND) uv run pytest

lint: ## ruff, the format check, eslint and the Base44 import fence self-test
	$(BACKEND) uv run ruff check .
	$(BACKEND) uv run ruff format --check .
	$(FRONTEND) npm run lint
	bash scripts/check-eslint-fence.sh

fmt: ## Format and auto-fix the backend
	$(BACKEND) uv run ruff format .
	$(BACKEND) uv run ruff check --fix .

typecheck: ## mypy and tsc
	$(BACKEND) uv run mypy app
	$(FRONTEND) npm run typecheck

check: lint typecheck test db-guard ## Everything CI checks, plus alembic check (needs `make up`)
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic check
	bash scripts/base44-count.sh
	$(FRONTEND) npm run build

gen-api: ## Regenerate the frontend API types (stub until P1-07)
	@echo "make gen-api: no typed API client yet; P1-07 adds it"

e2e: ## Playwright journeys (stub until P4-09; fails so a stub never counts as a pass)
	@echo "make e2e: no Playwright suite yet; P4-09 adds it"; exit 1

s3-smoke: ## Check that the S3 emulator enforces the upload policy, versioning and CORS (needs `make up`)
	uv run --python 3.12 scripts/s3-smoke.py

psql: ## psql shell on the dev database
	$(COMPOSE) exec db psql -U postgres -d condo_dev
