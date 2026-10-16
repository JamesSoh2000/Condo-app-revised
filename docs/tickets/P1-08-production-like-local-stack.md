# P1-08 — Production-like local stack (local walking skeleton)

| Field | Value |
|---|---|
| Phase / lane | P1 / B |
| Risk tier | 2 |
| Depends on | P0-04 (compose, Makefile, S3 emulator), P0-02, P0-03 (CI jobs) |
| Replaces old | — (new by [ADR-0013](../adr/0013-local-first-deployment-milestone.md); takes the Dockerfile and Caddyfile work from D-02) |
| Status | todo |

## Goal

The artifacts that staging will one day run (the API image and the built SPA) run locally behind Caddy on
one origin with `make prodlike`. CI builds and smoke-tests them on every PR. No AWS account, domain or
server is needed.

## Why

This is the **walking skeleton** without the cloud. `make up` (uvicorn `--reload`, bind mounts, the Vite
proxy) can hide bugs that only appear in the built artifacts:
- missing files in the image
- SPA routing fallbacks
- asset caching
- security headers
- running behind a reverse proxy

Catching these on every PR from week 2 means milestone D only has to deploy artifacts that already work,
instead of debugging them for the first time on a server.

## Scope

- In:
  - **`backend/Dockerfile`:**
    - also `COPY alembic.ini migrations ./`. Today only `app/` is copied, so migrations cannot run from the
      image.
    - default `WEB_CONCURRENCY=1` (ADR-0008: one API process)
    - build args `GIT_SHA`, `IMAGE_TAG` and `BUILD_TIME`, exposed as env vars so the existing `/api/version`
      reports them
    - gunicorn `--forwarded-allow-ips` read from `FORWARDED_ALLOW_IPS`. It is the proxy's address: the
      compose network here, `127.0.0.1` on staging.
  - **`deploy/Caddyfile`**, shared with staging (D-02 reuses it unchanged):
    - site address from `{$SITE_ADDRESS}`: `:8080` locally (plain http), the domain on staging (automatic
      HTTPS)
    - `encode zstd gzip`
    - `handle /api/*` reverse-proxies to `{$API_UPSTREAM}` (`api:8000` here, `127.0.0.1:8000` on staging)
    - `handle /assets/*` serves from `root /srv/app/frontend/assets` with
      `Cache-Control: public, max-age=31536000, immutable`
    - `handle` (everything else): `root /srv/app/frontend/current`, `try_files {path} /index.html`,
      `file_server`, with `Cache-Control: no-cache` for `index.html`
    - headers:
      - HSTS (`max-age=31536000`; browsers ignore it over plain http)
      - `X-Content-Type-Options nosniff`
      - `Referrer-Policy strict-origin-when-cross-origin`
      - `Permissions-Policy` (camera=self for photo capture)
      - a `Content-Security-Policy` allowing `'self'`, `frame-ancestors 'none'`, and the S3 origin for
        img/connect from `{$S3_PUBLIC_ORIGIN}` (the emulator locally, the bucket on staging)
  - **`compose.prodlike.yml`.** It is a standalone file, not an override, so no dev bind mounts or `--reload`
    leak in. Services:
    - `api`: the locally built image (`condo-api:<sha>`), gunicorn, no source mounts, **no published port**
    - `db`: `postgres:18.x` (pinned minor) with its own volume, **no published port**
    - `mailpit`
    - the S3 emulator
    - `caddy`: pinned `caddy:2.x` image with `deploy/Caddyfile`, `frontend/dist` mounted at
      `/srv/app/frontend/current` and `frontend/dist/assets` at `/srv/app/frontend/assets`, published on
      `127.0.0.1:8080`
    - It uses `APP_ENV=dev` values: plain http, a non-`Secure` `session` cookie, local-only secrets. Behaviour
      that needs HTTPS or real AWS is verified in D-06.
    - The worker is added by P3-01.
  - **S3 emulator CORS:** allow `http://localhost:8080` as well as `http://localhost:5173`.
  - **`scripts/smoke.sh <base_url> <sha>`**, reused by D-03 after every deploy. It checks:
    - `/api/version` reports `git_sha == <sha>`
    - `/` returns 200 HTML
    - a deep link (`/packages`) returns `index.html`
    - one hashed asset has the immutable cache header
    - the security headers are present
  - **`Makefile`:**
    - `make prodlike` builds the image with `GIT_SHA=$(git rev-parse HEAD)`, builds the frontend with
      `VITE_RELEASE=<sha>`, runs `docker compose -f compose.prodlike.yml run --rm api alembic upgrade head`
      (the same step `deploy.sh` will run), then `up -d`
    - `make prodlike-smoke` and `make prodlike-down`
    - It is its own compose project. Stop the dev stack first (`make down`), because Mailpit and the emulator
      use the same ports.
  - **CI job `prodlike`:**
    - build the image (tag = SHA, not pushed anywhere) and the frontend
    - `docker compose -f compose.prodlike.yml up`, migrate
    - run `scripts/smoke.sh http://localhost:8080 $GITHUB_SHA`
    - required status check from this ticket on
  - **`README.md`:** two lines on `make prodlike`, and when to use it rather than `make up`.
- Out:
  - TLS, the domain and anything on AWS (milestone D)
  - Sentry, CloudWatch and uptime (D-04)
  - the worker service (P3-01 adds it here and in the dev compose)

## Interfaces

`make prodlike`, `make prodlike-smoke`, `make prodlike-down`, `compose.prodlike.yml`, `deploy/Caddyfile`,
`scripts/smoke.sh`, CI job `prodlike`. Env `SITE_ADDRESS`, `API_UPSTREAM`, `S3_PUBLIC_ORIGIN`,
`FORWARDED_ALLOW_IPS`, build args `GIT_SHA`, `IMAGE_TAG`, `BUILD_TIME`.

## Acceptance criteria

1. **Given** a clean checkout with Docker, **when** `make prodlike`, **then** `http://localhost:8080/` serves
   the built SPA, and `http://localhost:8080/api/version` returns `git_sha` equal to `git rev-parse HEAD`.
2. **Given** the prod-like stack, **when** requesting `/packages`, **then** the response is `index.html`
   with `Cache-Control: no-cache`. A hashed `/assets/*.js` has `public, max-age=31536000, immutable`.
3. **Given** `curl -I http://localhost:8080/`, **then** `X-Content-Type-Options`, `Referrer-Policy`,
   `Permissions-Policy` and a `Content-Security-Policy` with `frame-ancestors 'none'` are present.
4. **Given** `docker compose -f compose.prodlike.yml config`, **then** `api` and `db` publish no host ports
   and mount no source directories. The API runs one gunicorn worker.
5. **Given** the image, **when** `alembic upgrade head` runs from it against an empty prod-like database,
   **then** it succeeds (migrations are in the image).
6. **Given** a PR, **then** the `prodlike` job runs and is required. A PR that removes the migrations
   `COPY`, or breaks the Caddyfile, fails it.

## Test plan

- `make prodlike && make prodlike-smoke`, then `make prodlike-down`
- `shellcheck scripts/smoke.sh`
- `caddy validate --config deploy/Caddyfile` (in the Caddy container)
- Break the Dockerfile on a throwaway branch to check that CI fails (criterion 6)

## Likely files

`backend/Dockerfile`, `compose.prodlike.yml`, `deploy/Caddyfile`, `scripts/smoke.sh`, `Makefile`,
`.github/workflows/ci.yml`, `README.md`, the S3 emulator init script from P0-04.

## Must explain (learning checkpoint)

1. Why build the image once, tag it with the git SHA, and test *that* image, rather than the dev container?
2. Name three differences between `make up` and `make prodlike` that could hide a bug in one but not the
   other.
3. Why do hashed `/assets/*` get a one-year immutable cache while `index.html` gets `no-cache`?
4. Why do `api` and `db` publish no host ports, and why does that make trusting forwarded headers from the
   compose network safe here?
5. What does the prod-like stack still *not* prove about staging? Where is each of those checked (D-06)?

## Carried from P1-04

`TRUSTED_ORIGINS` (renamed from `ALLOWED_ORIGINS` in P1-04; the CSRF check of P2-01 reads it) must include
`http://localhost:8080` for the prod-like stack. Check whether uvicorn/gunicorn logs a second, unstructured
traceback for a 500 next to the `request_failed` line (P1-04 D1, unverified).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
