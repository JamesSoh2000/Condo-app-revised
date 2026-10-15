# D-03 — CI/CD: build, push and deploy to staging

| Field | Value |
|---|---|
| Phase / lane | D / B |
| Risk tier | 1 |
| Depends on | D-02, P1-08 (image build, smoke script) |
| Replaces old | M14-T07, M14-T09 (demo subset), M14-T10, M14-T13 |
| Status | todo |

> **Milestone D ([ADR-0013](../adr/0013-local-first-deployment-milestone.md)).** This was P1-10, moved out of
> the local weeks. It stays detailed, but re-frame it before starting: the code it builds on will have
> changed by then.

## Goal

Every merge to `main` that passes CI is automatically built once, deployed to staging, migrated,
health-checked and smoke-tested. Rolling back means redeploying a previous SHA.

## Why

This turns the local walking skeleton (P1-08) into continuous deployment. From now on every merge ships to
a real HTTPS URL, so "it works on my machine" is caught within minutes.

## Scope

- In:
  - **`.github/workflows/deploy.yml`**, triggered on push to `main` after the CI workflow succeeds
    (`workflow_run`, or one workflow with `needs`), plus `workflow_dispatch` with an input `sha` for
    redeploys and rollbacks.
    - `concurrency: deploy-staging` (one at a time)
    - `environment: staging`
    - `permissions: id-token: write, contents: read`
  - **Jobs:**
    - `image`: OIDC role, buildx with cache, tag `${{ github.sha }}`, push to ECR. Never use `latest`. Use
      the same Dockerfile and build args the `prodlike` CI job has built on every PR since week 2.
    - `frontend`: `npm ci`, `npm run build` with `VITE_RELEASE=<sha>`, tar `dist/`, upload to
      `s3://<artifacts>/frontend/<sha>.tgz`.
    - `deploy`: `aws ssm send-command` (AWS-RunShellScript) targeting `tag:env=staging`, running
      `/srv/app/bin/deploy.sh <sha>`; wait for completion and print the output.
    - `smoke`: `scripts/smoke.sh https://<domain> <sha>` (P1-08): `/api/version` reports the SHA, `GET /`
      returns 200 HTML, and the headers are present.
  - **`deploy/deploy.sh <sha>`**, idempotent, with `set -euo pipefail`. In order:
    1. `flock -n /srv/app/deploy.lock` or exit, to serialize deploys.
    2. Render `/srv/app/.env` from SSM `/condo/staging/*` (`umask 077`), plus `GIT_SHA=<sha>` and
       `API_IMAGE=<ecr>/condo-api:<sha>`.
    3. Log in to ECR, `docker compose pull api worker`.
    4. Download and extract the frontend to `frontend/releases/<sha>/`. `cp -n` its `assets/*` into the shared
       `frontend/assets/`, so old tabs keep working.
    5. `docker compose run --rm api alembic upgrade head`. **On failure, exit non-zero before touching the
       running containers.**
    6. `docker compose up -d api worker`. The worker finishes its current job on SIGTERM (P3-01).
    7. Poll `http://127.0.0.1:8000/api/ready` and `/api/version` for 60 s until the version equals the SHA,
       else exit non-zero.
    8. Atomically switch `frontend/current → releases/<sha>` (`ln -sfn` + `mv -T`).
    9. Keep the last 5 releases, and prune shared assets older than 30 days.
    10. Log one line per phase.
  - **`docs/runbooks/deploy.md`:** how to redeploy or roll back (`workflow_dispatch` with the previous SHA),
    and the expand/contract rule that makes rollback safe.
- Out:
  - maintenance page and pre-deploy backup check (pilot)

## Interfaces

GitHub environment `staging` with variables `AWS_ROLE_ARN`, `AWS_REGION`, `ECR_REPO`, `ARTIFACTS_BUCKET` and
`DOMAIN`. These are not secrets.

## Acceptance criteria

1. **Given** a merged PR, **then** staging serves the new SHA within ≤ 10 minutes with no manual step.
   `/api/version` returns it.
2. **Given** a deliberately failing migration (on a throwaway SHA via `workflow_dispatch`), **when** deploying,
   **then** the job fails at step 5, and the previous version still serves traffic.
3. **Given** two quick merges, **then** deploys run sequentially (concurrency group and `flock`).
4. **Given** `workflow_dispatch` with the previous SHA, **then** staging rolls back and `/api/version` shows
   it.
5. **Given** a browser tab opened before a deploy, **when** it lazy-loads a chunk after the deploy, **then**
   the old hashed asset is still served (no 404).
6. **Given** the repository settings, **then** no AWS keys are stored. The role is assumed via OIDC.

## Test plan

Run every criterion once on staging and paste the evidence (workflow run links, curl output) into the PR. Run
`shellcheck deploy/deploy.sh` in CI.

## Likely files

`.github/workflows/deploy.yml`, `deploy/deploy.sh`, `deploy/compose.staging.yml`, `docs/runbooks/deploy.md`,
`infra/host/cloud-init.yaml` (installs the script).

## Must explain (learning checkpoint)

1. Why build the image once and deploy by immutable SHA, instead of building on the server or using `latest`?
2. Why run migrations *before* recreating the API container, and why must they be backward compatible?
3. How does keeping old hashed assets protect users with open tabs?
4. What does `flock` protect against, and why also use a GitHub concurrency group?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
