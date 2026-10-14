# P0-04 — Repo workflow and local stack

| Field | Value |
|---|---|
| Phase / lane | P0 / B |
| Risk tier | 2 |
| Depends on | P0-02, P0-03 (Makefile wraps their commands) |
| Replaces old | M1-T02 (compose follow-ups), M1-T04 (dev docs), M0-T07 (workflow) |
| Status | todo |

## Goal

One command starts the full local stack (API, Postgres, Mailpit, S3 emulator), the GitHub repo enforces the
PR workflow, and the stale branches are gone.

## Why

Agents and humans need identical, fast feedback loops. Branch protection turns the practices in
[ENGINEERING_PRACTICES.md](../ENGINEERING_PRACTICES.md) from advice into rules.

## Scope

- In:
  - **GitHub:**
    - Branch protection on `main`: PR required, 1 approval, required checks `backend` + `frontend`, linear
      history, no force push.
    - `.github/CODEOWNERS` (`* @JamesSoh2000 @KhoiTienNguyen`; confirm the handles).
    - `.github/pull_request_template.md` (from the template).
    - `.github/dependabot.yml` (pip/uv, npm, github-actions, docker; weekly).
  - **Branches:**
    - List `git branch -r --no-merged origin/main` and decide each case with the team.
    - Delete merged or stale remote branches, including `develop`, `staging`, `starting` and
      `starting-james`, after confirming nothing unmerged matters.
    - Finish the in-progress `M2-T03_Core-Tenant-Schema_James` work under P1-01 instead.
  - **`Makefile` at the repo root**, with targets:
    - `up`, `down`, `logs`, `ps`
    - `migrate`, `revision m=…`
    - `seed` (stub until P1-06)
    - `test`, `lint`, `fmt`, `typecheck`, `check`
    - `gen-api` (stub until P1-07), `e2e` (stub until P4-09)
    - `psql`
  - **`docker-compose.yml`:**
    - Remove the `redis` service and its volume. Remove `redis_url` from settings and `REDIS_URL` from
      `.env.example`.
    - Add `mailpit` (pinned `axllent/mailpit` tag; SMTP 1025, UI 8025).
    - Add an **S3 emulator.** Evaluate a pinned MinIO image vs `motoserver/moto` for presigned **POST** with
      `content-length-range`, versioning and browser CORS, then choose one. Add an init step creating
      the bucket with versioning and CORS for `http://localhost:5173`. Record the choice in
      `docs/adr/0007-…` under a "Local emulator" note.
  - **`backend/.env.dev`:** add a header comment saying it is committed, so it must never contain secrets.
  - **`README.md`:** a quickstart in ≤ 15 lines (`make up`, `make migrate`, `make seed`, `npm run dev`), linking
    the docs.
- Out:
  - the worker service (P3-01)
  - the production-like stack (P1-08) and anything on AWS (milestone D)

## Interfaces

New env vars in `.env.example`:
- `SMTP_HOST=mailpit`, `SMTP_PORT=1025`
- `S3_ENDPOINT_URL=http://s3:9000` (container-internal)
- `S3_PUBLIC_ENDPOINT_URL=http://localhost:9000` (browser)
- `S3_BUCKET=condo-dev-files`

Use the actual port of the chosen emulator.

## Acceptance criteria

1. **Given** a fresh clone, **when** `make up && make migrate`, **then** api, db, mailpit and s3 are healthy
   (`make ps`), and `http://localhost:8025` shows the Mailpit UI.
2. **Given** the stack, **when** `scripts/s3-smoke.py` creates a presigned POST for 1 KiB max and uploads
   2 KiB, **then** the emulator rejects it. A 512 B upload succeeds, and `head_object` returns a `VersionId`.
3. **Given** GitHub, **when** someone pushes directly to `main`, **then** it is rejected. A PR shows the
   template, and the required checks are listed.
4. **Given** the repo, **when** `grep -ri redis backend docker-compose.yml`, **then** nothing matches (docs
   excluded).
5. **Given** `git branch -r`, **then** only `main` and active ticket branches remain.

## Test plan

- `make up`, `make ps`, `make down`
- `uv run python scripts/s3-smoke.py`
- An attempted direct push (expected to fail)
- `make check` runs ruff, mypy, pytest, eslint and tsc

## Likely files

`Makefile`, `docker-compose.yml`, `backend/app/core/config.py`, `backend/.env.example`, `backend/.env.dev`,
`.github/CODEOWNERS`, `.github/pull_request_template.md`, `.github/dependabot.yml`, `scripts/s3-smoke.py`,
`README.md`, `docs/adr/0007-private-s3-presigned-uploads.md`.

## Must explain (learning checkpoint)

1. Why is a long-lived `develop` branch harmful for a two-person team that releases from `main`?
2. What do CODEOWNERS and required status checks enforce?
3. Why emulate S3 and SMTP locally instead of using real AWS credentials in development?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
