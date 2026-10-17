# Everyday commands (P0-04a). `make help` lists them. The stack runs in Docker; backend tools run on the
# host with uv, frontend tools with npm (see README.md for the toolchain).

COMPOSE := docker compose
# Docker Desktop's image store adds a provenance attestation, with a timestamp, to every build. Each
# `make up` (--build) would then get a new image ID and recreate app even when nothing changed (P0-07).
# compose's `build.provenance: false` doesn't stop it (compose 2.40); this does.
export BUILDX_NO_DEFAULT_ATTESTATIONS := 1
# The dev database as seen from the host. docker-compose.yml publishes db on 127.0.0.1:$(DB_PORT); if
# something else already listens on 5432, run every target with the same free port: `make up DB_PORT=55432`.
export DB_PORT ?= 5432
DEV_DATABASE_URL := postgresql+asyncpg://postgres:devpassword@127.0.0.1:$(DB_PORT)/condo_dev
# Dropped and rebuilt by every test run (backend/tests/conftest.py refuses any name not ending in _test).
TEST_DATABASE_URL := postgresql+asyncpg://postgres:devpassword@127.0.0.1:$(DB_PORT)/condo_test
BACKEND := cd backend &&
FRONTEND := cd frontend &&

.DEFAULT_GOAL := help
.PHONY: help up down logs ps migrate revision seed cli test lint fmt typecheck check gen-api e2e psql s3-smoke db-guard \
	prodlike prodlike-smoke prodlike-down

help: ## List the targets
	@grep -E '^[a-z0-9-]+:.*## ' $(MAKEFILE_LIST) | awk -F':.*## ' '{printf "  %-14s %s\n", $$1, $$2}'

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

seed: ## Idempotent demo data (needs `make up` and `make migrate`); `make seed reset=1` wipes first (dev only)
	$(COMPOSE) exec app python -m app.cli seed $(if $(reset),--reset)

cli: ## Run an operator command in the app container: make cli args="audit --since 1d"
	@test -n "$(args)" || { echo 'usage: make cli args="audit --since 1d" (python -m app.cli --help lists them)'; exit 2; }
	$(COMPOSE) exec app python -m app.cli $(args)

test: db-guard ## Backend tests, against condo_test on the compose db (needs `make up`)
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) TEST_DATABASE_URL=$(TEST_DATABASE_URL) uv run pytest

lint: ## ruff, the format check, eslint and the Base44 import fence self-test
	$(BACKEND) uv run ruff check --no-cache .
	$(BACKEND) uv run ruff format --no-cache --check .
	$(FRONTEND) npm run lint
	bash scripts/check-eslint-fence.sh

fmt: ## Format and auto-fix the backend
	$(BACKEND) uv run ruff format .
	$(BACKEND) uv run ruff check --fix .

typecheck: ## mypy and tsc
	$(BACKEND) uv run mypy app
	$(FRONTEND) npm run typecheck

check: lint typecheck test ## Everything CI checks: lint, types, tests, alembic check, API type drift (needs `make up`)
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic check
	bash scripts/base44-count.sh
	python3 scripts/check-version-pins.py
	$(FRONTEND) npm run test
	@$(MAKE) --no-print-directory gen-api >/dev/null
	@test -z "$$(git status --porcelain -- frontend/src/api/schema.d.ts)" || { \
	  echo "check: frontend/src/api/schema.d.ts was stale and has been regenerated; commit it"; exit 1; }
	$(FRONTEND) npm run build

# openapi.json (repo root, gitignored) is an intermediate; only schema.d.ts is committed. CI runs the same two
# steps and fails if schema.d.ts changes.
gen-api: ## Regenerate frontend/src/api/schema.d.ts from the backend's OpenAPI (no server or database needed)
	$(BACKEND) uv run python -m app.export_openapi > ../openapi.json
	$(FRONTEND) npm run --silent gen:api

e2e: ## Playwright journeys (stub until P4-09; fails so a stub never counts as a pass)
	@echo "make e2e: no Playwright suite yet; P4-09 adds it"; exit 1

s3-smoke: ## Check that the S3 emulator enforces the upload policy, versioning and CORS (needs `make up`)
	uv run --python 3.14 scripts/s3-smoke.py

psql: ## psql shell on the dev database
	$(COMPOSE) exec db psql -U postgres -d condo_dev

# Production-like stack (P1-08): the API image tagged with this commit and the built SPA, behind
# deploy/Caddyfile on http://localhost:8080, in its own compose project. The image tag gets "-dirty" when the
# working tree has uncommitted changes, so /api/version doesn't pass them off as the commit.
PRODLIKE := $(COMPOSE) -f compose.prodlike.yml
GIT_SHA ?= $(shell git rev-parse HEAD)
prodlike prodlike-smoke prodlike-down: export API_IMAGE_TAG ?= $(GIT_SHA)$(if $(shell git status --porcelain),-dirty)

prodlike: ## Build the image and SPA, migrate, start the prod-like stack on :8080 (run `make down` first)
	docker build -t condo-api:$(API_IMAGE_TAG) --build-arg GIT_SHA=$(GIT_SHA) \
	  --build-arg IMAGE_TAG=$(API_IMAGE_TAG) --build-arg BUILD_TIME=$$(date -u +%Y-%m-%dT%H:%M:%SZ) backend
	$(FRONTEND) npm ci --no-audit --no-fund && VITE_RELEASE=$(GIT_SHA) npm run build
	# The order deploy.sh will use (D-03): migrate from the new image, then start it.
	$(PRODLIKE) run --rm api alembic upgrade head
	# --force-recreate caddy: the build replaced frontend/dist/assets, and a running container's bind mount
	# still points at the deleted directory. The API and the rest are recreated only when they changed.
	$(PRODLIKE) up -d --wait --remove-orphans
	$(PRODLIKE) up -d --wait --no-deps --force-recreate caddy

prodlike-smoke: ## Smoke-test the prod-like stack (scripts/smoke.sh) and check its wiring
	@# A later `npm run build` (make check does one) replaces frontend/dist/assets under the running Caddy.
	bash scripts/smoke.sh http://localhost:8080 $(GIT_SHA) || { \
	  echo "prodlike-smoke: was frontend/dist rebuilt after make prodlike? Then re-run make prodlike"; exit 1; }
	bash scripts/prodlike-checks.sh http://localhost:8080

prodlike-down: ## Stop the prod-like stack (its database volume is kept)
	$(PRODLIKE) down
