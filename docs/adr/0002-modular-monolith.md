# ADR-0002: Modular monolith (FastAPI + PostgreSQL), package-by-feature

- Status: Accepted
- Date: 2026-10-13

## Context

There are two developers, one pilot building, and a planning workload of about 100 concurrent users. The
domain has many small features (packages, notices, maintenance, …) that share identity, tenancy, files,
notifications and audit.

## Decision

- **One deployable backend:** Python 3.12, FastAPI, SQLAlchemy 2 async + asyncpg, Alembic, PostgreSQL 16.
- **A separate worker process** runs from the same codebase and image (`python -m app.worker`).
- **Code is organised by feature** (`app/packages/`, `app/notices/`, …). Each feature has `models.py`,
  `schemas.py`, `service.py` and `router.py`. Shared kernels live in `core/`, `tenancy/`, `audit/`, `jobs/`,
  `files/` and `notifications/`.
- **No repository layer:** SQLAlchemy is the data-access layer.
- **Services own transactions:** one commit per write use-case.

## Consequences

- One transaction can cover business rows, audit, notifications and jobs. Atomicity comes for free.
- Simple local development, one CI pipeline, and one image.
- Feature boundaries are conventions. They are enforced by review and by fitness tests (for example "only
  services commit"), not by the network.
- **Scaling path:** add API processes behind Caddy; move the worker to its own host; add read replicas.
  Splitting a service out is possible later along feature boundaries.

## Alternatives considered

- **Microservices:** network calls, distributed transactions and N deployments, with no benefit at this scale.
- **Django:** batteries included, but the team has already invested in FastAPI. Both are fine choices.
- **Layered architecture (controllers/services/repositories across the whole app):** scatters each feature
  over many folders and makes slices harder to own.

## Revisit when

A feature needs independent scaling or deployment cadence, or the team grows beyond about 6 engineers.
