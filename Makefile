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
# Each test run builds and drops its own copy, condo_run_<pid>_<hex>_test, so concurrent runs don't collide
# (backend/tests/conftest.py::per_run_database_url; it refuses any name not ending in _test).
TEST_DATABASE_URL := postgresql+asyncpg://postgres:devpassword@127.0.0.1:$(DB_PORT)/condo_test
# The files tests (P3-04a) use compose's S3 emulator from the host, in a bucket of their own per run;
# only backend/tests/files/conftest.py reads TEST_S3_ENDPOINT_URL, so the settings tests never see an
# endpoint. LocalStack accepts any credentials; these are not secrets.
TEST_S3_ENV := TEST_S3_ENDPOINT_URL=http://127.0.0.1:4566 AWS_ACCESS_KEY_ID=test AWS_SECRET_ACCESS_KEY=test
BACKEND := cd backend &&
FRONTEND := cd frontend &&

.DEFAULT_GOAL := help
.PHONY: help up down logs ps stack-guard migrate revision seed cli test lint fmt typecheck check gen-api e2e e2e-reset psql s3-smoke \
	db-guard prodlike prodlike-smoke prodlike-down

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

# Fails unless app and worker mount this checkout's backend. The stack is shared by every worktree: one
# `make up` elsewhere, or a worktree removed after merge, leaves the API serving other or deleted code.
stack-guard: ## Check the running app and worker serve this worktree's backend (run after `make up`)
	@for s in app worker; do \
	  src=$$(docker inspect $$($(COMPOSE) ps -q $$s) --format '{{range .Mounts}}{{if eq .Destination "/app"}}{{.Source}}{{end}}{{end}}' 2>/dev/null); \
	  [ "$$src" = "$(CURDIR)/backend" ] || { \
	    echo "stack-guard: $$s mounts '$$src', not $(CURDIR)/backend. Run make up DB_PORT=$(DB_PORT) here."; exit 1; }; \
	done

migrate: db-guard ## alembic upgrade head on the dev database
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic upgrade head

revision: db-guard ## Autogenerate a migration: make revision m="add packages" (then READ and edit it)
	@test -n "$(m)" || { echo 'usage: make revision m="what changed"'; exit 2; }
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic revision --autogenerate -m "$(m)"

seed: stack-guard ## Idempotent demo data (needs `make up` and `make migrate`); `make seed reset=1` wipes first (dev only)
	$(COMPOSE) exec app python -m app.cli seed $(if $(reset),--reset)

cli: stack-guard ## Run an operator command in the app container: make cli args="audit --since 1d"
	@test -n "$(args)" || { echo 'usage: make cli args="audit --since 1d" (python -m app.cli --help lists them)'; exit 2; }
	$(COMPOSE) exec app python -m app.cli $(args)

test: db-guard ## Backend tests, on a per-run copy of condo_test on the compose db and a per-run S3 bucket (needs `make up`)
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) TEST_DATABASE_URL=$(TEST_DATABASE_URL) $(TEST_S3_ENV) uv run pytest

lint: ## ruff, the format check, eslint, the Base44 import fence and the ticket-loop helpers self-tests
	$(BACKEND) uv run ruff check --no-cache .
	$(BACKEND) uv run ruff format --no-cache --check .
	$(FRONTEND) npm run lint
	bash scripts/check-eslint-fence.sh
	bash scripts/check-ticket-helpers.sh

fmt: ## Format and auto-fix the backend
	$(BACKEND) uv run ruff format .
	$(BACKEND) uv run ruff check --fix .

typecheck: ## mypy and tsc
	$(BACKEND) uv run mypy app tests
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

s3-smoke: ## Check that the S3 emulator enforces the upload policy, versioning and CORS (needs `make up`)
	uv run --python 3.14 scripts/s3-smoke.py

psql: ## psql shell on the dev database
	$(COMPOSE) exec db psql -U postgres -d condo_dev

# Production-like stack (P1-08): the API image tagged with this commit and the built SPA, behind
# deploy/Caddyfile on http://localhost:8080, in its own compose project. The image tag gets "-dirty" when the
# working tree has uncommitted changes, so /api/version doesn't pass them off as the commit.
PRODLIKE := $(COMPOSE) -f compose.prodlike.yml
GIT_SHA ?= $(shell git rev-parse HEAD)
prodlike prodlike-smoke prodlike-down e2e e2e-reset: export API_IMAGE_TAG ?= $(GIT_SHA)$(if $(shell git status --porcelain),-dirty)

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

# E2E journeys (P4-09, e2e/README.md): one suite, two stacks. E2E_STACK=dev (the default) runs on `make up` and
# the Vite dev server on :5173, which Playwright starts unless one already runs; E2E_STACK=prodlike runs on
# `make prodlike` (:8080), as CI does. The helpers get the stack's compose file and API service from here.
E2E_STACK ?= dev
ifeq ($(E2E_STACK),prodlike)
E2E_COMPOSE_FILE := compose.prodlike.yml
E2E_API_SERVICE := api
E2E_BASE_URL ?= http://localhost:8080
else ifeq ($(E2E_STACK),dev)
E2E_COMPOSE_FILE := docker-compose.yml
E2E_API_SERVICE := app
E2E_BASE_URL ?= http://localhost:5173
else
$(error E2E_STACK must be dev or prodlike, not "$(E2E_STACK)")
endif
E2E_COMPOSE := $(COMPOSE) -f $(E2E_COMPOSE_FILE)

# The API and worker are stopped first: their pooled connections cache the old schema's type OIDs.
e2e-reset: ## Drop and recreate the e2e stack's schema, migrate and seed; refused unless its API has APP_ENV=dev
	@$(E2E_COMPOSE) exec -T $(E2E_API_SERVICE) python -c \
	  "import sys; from app.core.config import settings; sys.exit(settings.app_env != 'dev')" || { \
	  echo "e2e-reset: refused: the $(E2E_STACK) stack's API must be running, with APP_ENV=dev"; exit 1; }
	$(E2E_COMPOSE) stop $(E2E_API_SERVICE) worker
	$(E2E_COMPOSE) exec -T db sh -c \
	  'psql -q -v ON_ERROR_STOP=1 -U postgres -d "$$POSTGRES_DB" -c "DROP SCHEMA public CASCADE; CREATE SCHEMA public;"'
	$(E2E_COMPOSE) run --rm --no-deps $(E2E_API_SERVICE) alembic upgrade head
	$(E2E_COMPOSE) run --rm --no-deps $(E2E_API_SERVICE) python -m app.cli seed
	$(E2E_COMPOSE) up -d --wait $(E2E_API_SERVICE) worker

e2e: ## Playwright journeys: start the stack, reset it, run (E2E_STACK=dev|prodlike; args="--ui" passes options)
	@$(MAKE) --no-print-directory $(if $(filter prodlike,$(E2E_STACK)),prodlike,up)
	@$(MAKE) --no-print-directory e2e-reset
	$(if $(filter dev,$(E2E_STACK)),test -d frontend/node_modules || ($(FRONTEND) npm ci --no-audit --no-fund))
	cd e2e && npm ci --no-audit --no-fund && npx playwright install $(if $(CI),--with-deps) chromium
	cd e2e && E2E_BASE_URL=$(E2E_BASE_URL) E2E_COMPOSE_FILE=$(E2E_COMPOSE_FILE) \
	  E2E_API_SERVICE=$(E2E_API_SERVICE) npx playwright test $(args)
