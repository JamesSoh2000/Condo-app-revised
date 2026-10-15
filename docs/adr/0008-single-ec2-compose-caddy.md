# ADR-0008: Single EC2 host with Docker Compose and host Caddy, in ca-central-1

- Status: Accepted. Records the project owner's 2026-10-12 decision
  (Plan/EC2-single-instance-deployment-plan.md (outside repo)) and
  stages its implementation.
- Date: 2026-10-13
- Amended by [ADR-0013](./0013-local-first-deployment-milestone.md): staging is built in milestone D, after
  the local week-8 demo. The topology below is unchanged.

## Context

The owner chose one EC2 instance with host Caddy (TLS, SPA, `/api` proxy), one API container, one worker
container and PostgreSQL 18 (16 until P0-06) on separate encrypted EBS. The aim is the lowest cost and a
deployment the team fully understands. The original plan implemented every release-safety and recovery mechanism before the first
feature.

## Decision

**Keep the topology, and stage its operational depth.**

| Capability | Staging (milestone D) | Pilot ([07](../PILOT_READINESS.md)) |
|---|---|---|
| Provisioning | Terraform/OpenTofu: EC2 `t3a.small` (Ubuntu 24.04), separate encrypted gp3 data volume, EIP, security group (80/443 only), IAM instance role, ECR repo, S3 buckets (files, backups), SSM parameters | Same code, separate production workspace/state |
| Host setup | cloud-init: Docker Engine + compose plugin, Caddy (systemd), data volume mounted by UUID at `/srv/app/pgdata` | + unattended-upgrades, CloudWatch agent for disk/memory |
| Access | SSM Session Manager only; no inbound SSH | Same |
| Images | GitHub Actions builds once; tag = git SHA; push to ECR via OIDC role | Same + Trivy gate |
| Deploy | SSM Run Command → `deploy.sh <sha>`: render `.env` from SSM → pull → `alembic upgrade head` → `up -d api worker` → wait for `/api/ready` and version = SHA → switch frontend symlink → smoke | + deploy lock, maintenance page during migrations, pre-deploy backup check, rehearsed rollback |
| Environments | One "staging" (hosts the demo once milestone D is done; until then the demo runs locally) | + separate production |
| Region | **ca-central-1 (Montreal)** for data residency (likely Quebec pilot) | Same |

- One API process. Gunicorn with `WEB_CONCURRENCY=1` and uvicorn workers, or plain uvicorn. The current
  Dockerfile default of 2 is changed to 1 in P1-08, so the local prod-like stack already runs what staging
  will run.
- **Migrations are expand/contract**, so the previous release still works against the new schema. Rollback
  then means "deploy the previous SHA".

## Consequences

- About $25–40/month for staging. Simple to reason about. Every piece is visible.
- A single point of failure, with a brief interruption during deploys. Acceptable for demo and a pilot, and
  stated to the building.
- The team owns OS and Postgres patching (pilot checklist).

## Alternatives considered

Recorded in the owner's plan: blue/green on two hosts, ECS/Fargate + ALB, RDS. RDS is re-evaluated at
pilot ([ADR-0009](./0009-backups-staged.md)).

## Revisit when

Uptime requirements exceed what a single host offers, there are more than about 5 buildings, or recurring
operational toil exceeds about 2 h/week.
