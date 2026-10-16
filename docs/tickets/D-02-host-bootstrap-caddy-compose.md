# D-02 — Host bootstrap, Caddy and staging compose

| Field | Value |
|---|---|
| Phase / lane | D / B |
| Risk tier | 1 |
| Depends on | D-01, P1-08 (Dockerfile, Caddyfile), P3-01 (worker) |
| Replaces old | M14-T06, M14-T08, M14-T05 (self-hosted Postgres part) |
| Status | todo |

> **Milestone D ([ADR-0013](../adr/0013-local-first-deployment-milestone.md)).** This was P1-09, moved out of
> the local weeks. It stays detailed, but re-frame it before starting: the code it builds on will have
> changed by then.

## Goal

A freshly created instance configures itself, serves the SPA and `/api` over HTTPS through Caddy, and runs
the API, worker and PostgreSQL containers, with data on the persistent volume.

## Why

This turns the adopted single-host design into a working, rebuildable host. The image, the Caddyfile and the
compose layout already run locally (P1-08), so this ticket is about the host, not the app.

## Scope

- In:
  - **cloud-init user-data** (`infra/host/cloud-init.yaml`, templated by Terraform):
    - install Docker Engine + compose plugin (Docker apt repo), Caddy (official apt repo), awscli v2, jq
    - enable `unattended-upgrades` (security only)
    - create `/srv/app/{bin,frontend/releases,frontend/assets,pgdata}`
    - **mount the data volume by UUID** at `/srv/app/pgdata`: create a filesystem **only if `blkid` shows none**
      (log loudly), add an fstab entry with `nofail`
    - install `deploy.sh` (from D-03; placeholder now), `compose.staging.yml` and the `Caddyfile`
  - **`deploy/compose.staging.yml`**, derived from `compose.prodlike.yml` (P1-08). Keep the differences few
    and listed in a comment at the top of the file:
    - `api`:
      - `image: ${API_IMAGE}`, `env_file: /srv/app/.env`
      - `ports: ["127.0.0.1:8000:8000"]`
      - healthcheck on `/api/ready`, `restart: unless-stopped`
      - the image's gunicorn command from P1-08, with `FORWARDED_ALLOW_IPS=127.0.0.1` (host Caddy)
    - `db`:
      - `postgres:18.x` (pinned minor), bind mount `/srv/app/pgdata`
      - **no published ports**
      - healthcheck `pg_isready`, `restart: unless-stopped`
      - password from `.env`
    - `worker`: the same image with `command: python -m app.worker` and the same `env_file` (P3-01)
  - **`deploy/Caddyfile`** from P1-08, unchanged. Host Caddy runs it with `SITE_ADDRESS=<domain>` (automatic
    HTTPS), `API_UPSTREAM=127.0.0.1:8000` and `S3_PUBLIC_ORIGIN=https://<files bucket host>`, set in the
    Caddy systemd unit's environment. If it needs a change to work on the host, change the shared file so
    the prod-like stack keeps matching staging.
- Out:
  - CI/CD (D-03)
  - the backups timer (D-05)
  - CloudWatch logging driver and the Sentry CSP entry (D-04)
  - the Dockerfile changes (done in P1-08)

## Interfaces

`/srv/app/.env` (rendered by deploy; mode 600). Env `DOMAIN`, `API_IMAGE`. Caddy env `SITE_ADDRESS`,
`API_UPSTREAM`, `S3_PUBLIC_ORIGIN` (the same names as in P1-08).

## Acceptance criteria

1. **Given** a new instance from Terraform, **when** cloud-init finishes, **then** `docker`, `docker compose`
   and `caddy` are active, and the data volume is mounted (`findmnt /srv/app/pgdata`).
2. **Given** a manually pushed image and a manual `docker compose up -d`, **when**
   `curl https://<domain>/api/health` runs, **then** `{"status":"ok"}` comes back with a valid certificate.
   `curl -I https://<domain>/` shows the security headers.
3. **Given** the host, **then** PostgreSQL is not reachable from the internet, and `ss -tlnp` shows no 5432
   listener on the host interfaces.
4. **Given** a row written to the DB, **when** the instance reboots, **then** services (api, worker, db)
   return automatically and the row still exists.
5. **Given** the volume already has a filesystem, **when** cloud-init reruns (instance replaced), **then** it
   is mounted, not reformatted.
6. **Given** a manually copied frontend build in `/srv/app/frontend/current` (and its `assets/`), **when**
   `scripts/smoke.sh https://<domain> <sha>` (P1-08) runs, **then** it passes against the host.

## Test plan

Manual verification on staging, with commands and outputs pasted into the PR. The image itself is already
built and smoke-tested by the `prodlike` CI job (P1-08).

## Likely files

`infra/host/cloud-init.yaml`, `infra/terraform/modules/app_env/ec2.tf` (user_data), `deploy/compose.staging.yml`,
`deploy/caddy.env` (or the systemd unit's environment), `infra/README.md`.

## Must explain (learning checkpoint)

1. What does each Caddy header protect against, and what changes once the site is served over HTTPS?
2. What differs between `compose.staging.yml` and `compose.prodlike.yml`, and why is each difference needed?
3. Why must cloud-init check for an existing filesystem before formatting? What would happen otherwise?
4. Why bind the API to `127.0.0.1` and publish no DB port?

## Carried from P1-06 (decide while framing)

- `Settings.app_env` defaults to `dev`, and `seed --reset` (truncate every domain table) is allowed when
  `APP_ENV=dev`. A deployed env that forgets `APP_ENV` would therefore permit `--reset`, and skip the staging
  settings checks. Set `APP_ENV=staging` explicitly in the staging env, and consider making deployed images
  fail without it (P1-06 review L2).

## Carried from P2-01a

- `make seed` refuses to run in staging unless `SEED_PASSWORD` is set (a secret: 12–128 characters, passes
  the password policy, not the public `DevPassword!2026`). Put it in the staging env (`/srv/app/.env`) with
  the other secrets; D-06 logs in with it. See `backend/app/seed.py::seed_password_for` and PR #56 D2.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
