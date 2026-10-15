# P0-04a — Local stack and Makefile

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 2 |
| Depends on | P0-02, P0-03a, P0-03b |
| Replaces old | M1-T02 (compose follow-ups), M1-T04 (dev docs) |
| Status | in progress |

Split from [P0-04](./P0-04-repo-workflow-and-local-stack.md) (see there why). The GitHub side (branch
protection, PR template, Dependabot, stale branches) is [P0-04b](./P0-04b-github-workflow.md).

## Goal

One command starts the full local stack (API, Postgres, Mailpit, S3 emulator), and one `Makefile` wraps the
everyday commands.

## Scope

- In:
  - **`Makefile` at the repo root**, with targets `up`, `down`, `logs`, `ps`, `migrate`, `revision m=…`,
    `seed` (stub until P1-06), `test`, `lint`, `fmt`, `typecheck`, `check`, `gen-api` (stub until P1-07),
    `e2e` (stub until P4-09), `psql`.
  - **`docker-compose.yml`:** remove the `redis` service and its volume; remove `redis_url` from settings and
    `REDIS_URL` from the env files. Add `mailpit` (pinned `axllent/mailpit` tag; SMTP 1025, UI 8025). Add the
    S3 emulator (evaluated and chosen below) with an init step that creates the bucket with versioning and
    CORS for the app origins. Record the choice in ADR-0007 under a "Local emulator" note.
  - **Settings:** `SMTP_HOST`, `SMTP_PORT`, `S3_ENDPOINT_URL` (container-internal), `S3_PUBLIC_ENDPOINT_URL`
    (browser). The bucket keeps the existing `S3_BUCKET_NAME` setting (see Frame notes).
  - **`backend/.env.dev`:** a header comment saying it is committed, so it must never contain secrets.
  - **`scripts/s3-smoke.py`** for AC2.
  - **`README.md`:** a quickstart in ≤ 15 lines (`make up`, `make migrate`, `make seed`, `npm run dev`),
    linking the docs.
- Out: everything in P0-04b; the worker (P3-01); the production-like stack (P1-08); AWS (milestone D).

## Acceptance criteria

1. (P0-04 AC1) **Given** a clone with nothing running, **when** `make up && make migrate`, **then** `make ps`
   shows `app`, `db`, `mailpit` and `s3` as `healthy`, no `redis` service exists, and
   `curl -fsS http://localhost:8025/` returns the Mailpit UI (HTTP 200).
2. (P0-04 AC2, sharpened) **Given** the stack, **when** `uv run scripts/s3-smoke.py` runs against the
   emulator's bucket, **then**: a presigned POST limited to 1 KiB rejects a 2 KiB upload; the same policy
   accepts 512 B; a `Content-Type` that differs from the policy is rejected; `head_object` on the accepted
   object returns a `VersionId`; bucket versioning is `Enabled`; a CORS preflight from
   `http://localhost:5173` is allowed and one from another origin is not. The script exits non-zero if any
   check fails.
3. (P0-04 AC4) **Given** the repo, **when** `grep -ri redis backend docker-compose.yml`, **then** nothing
   matches (docs excluded).
4. (new) Settings load `SMTP_HOST`, `SMTP_PORT`, `S3_ENDPOINT_URL` and `S3_PUBLIC_ENDPOINT_URL` from the
   environment; with `APP_ENV=prod`, a set `S3_ENDPOINT_URL` or `S3_PUBLIC_ENDPOINT_URL` is rejected (an
   emulator endpoint must never reach production). Unit tests.
5. (new) `make check` runs ruff, the format check, mypy, pytest, `alembic check`, and frontend lint,
   typecheck and build, and exits non-zero when any of them fails. Stubs say which ticket implements them;
   `make e2e` exits non-zero, so a stub can never pass for a test run.

## Test plan

`make up`, `make migrate`, `make ps`, `curl` Mailpit, `uv run scripts/s3-smoke.py`, `make check`,
`make down`; unit tests for AC4; a deliberately failing step to show `make check` fails (AC5).

## Likely files

`Makefile`, `docker-compose.yml`, `docker/s3-init/*.sh`, `backend/app/core/config.py`,
`backend/tests/test_config.py`, `backend/.env.example`, `backend/.env.dev`, `scripts/s3-smoke.py`,
`README.md`, `docs/adr/0007-private-s3-presigned-uploads.md`, `CLAUDE.md` (Commands block).

## Must explain (learning checkpoint)

1. Why emulate S3 and SMTP locally instead of using real AWS credentials in development?
2. Why does the S3 emulator need two endpoint URLs (container-internal and browser)?
3. What does a presigned POST's `content-length-range` enforce, and why can't a presigned PUT do the same?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC2 adds the wrong-`Content-Type`, versioning and CORS checks, which the
  ticket's scope required but no criterion tested. AC4 (missed case): the prod validator rejects emulator
  endpoints. AC5: `make check` must fail on any failure, and a stub must not pass as a test run.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **S3 emulator: LocalStack 4.4.0** (autonomous, measured on 2026-10-15). MinIO images can't be pulled
    any more (Docker Hub "repository does not exist", Quay 401). moto 5.1.4 and moto 5.2.4.dev0 accept a
    2 KiB upload against a 1 KiB policy and a wrong `Content-Type`, so they can't test the ADR-0007 policy.
    SeaweedFS failed the presigned POST entirely. LocalStack 4.4.0 and RustFS passed every AC2 check;
    LocalStack is chosen because its failures match AWS (403 `AccessDenied`, "Invalid according to
    Policy"), where RustFS returns 400 `InvalidPolicyDocument`. Port 4566, not the ticket's example 9000
    ("use the actual port of the chosen emulator").
  - **Bucket variable:** the ticket's `S3_BUCKET=condo-dev-files` would duplicate the existing
    `S3_BUCKET_NAME` setting, which the production validator already checks. The existing name and value
    (`condo-app-dev-files`) stay (code is the truth for what exists).
  - **CORS origins:** `http://localhost:5173` and `http://localhost:8080` (P3-06 says P0-04 and P1-08 set
    them; adding `:8080` now costs one line).
  - Migrations and `revision` run on the host with `uv` against the published `db` port, so new revision
    files are owned by the developer and the ruff post-write hooks (dev dependencies) run.
- Split: part a of [P0-04](./P0-04-repo-workflow-and-local-stack.md).
