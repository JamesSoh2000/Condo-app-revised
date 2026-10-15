# P0-07 — App venv outside the bind mount; Dependabot leaves uv alone

| Field | Value |
|---|---|
| Phase / lane | P0 / A |
| Risk tier | 3 |
| Depends on | P0-06 |
| Replaces old | — |
| Status | in progress |

The two follow-ups of [P0-06](./P0-06-runtime-and-ci-upgrades.md) (PR #35, review round 3 L1 and L2),
started by James in session on 2026-10-15.

## Goal

`make up` on an unchanged stack leaves the running containers alone and creates no volumes, and the app
container still always runs the packages of its own image. Dependabot stops proposing uv image bumps that
the version-pin check would fail.

## Why

The app image keeps its virtualenv in `/app/.venv`, inside the `./backend:/app` bind mount, so compose
shadows it with an anonymous volume. That volume outlives the image: after the Python bump it held the 3.12
packages and the app crashed, and P0-06 fixed it with `make up --renew-anon-volumes`. That flag recreates
every container on every `make up`: db restarts, the S3 emulator loses its in-memory objects, and each run
leaves two dangling volumes (measured on 2026-10-15: start times of all four containers changed, dangling
volumes 27 → 29). Moving the venv out of the bind-mounted path removes the need for the volume and the
flag.

Dependabot's docker ecosystem updates `ghcr.io/astral-sh/uv` in the Dockerfile but not setup-uv's
`version` input in CI, so `scripts/check-version-pins.py` fails every such PR, and with grouping it blocks
the whole grouped docker PR.

## Scope

- In:
  - `backend/Dockerfile`: the venv lives in `/opt/venv` (`UV_PROJECT_ENVIRONMENT`, `PATH`).
  - `docker-compose.yml`: drop the `- /app/.venv` anonymous volume.
  - `Makefile`: drop `--renew-anon-volumes` and its comment.
  - `.github/dependabot.yml`: ignore `ghcr.io/astral-sh/uv` in the docker ecosystem; a uv bump is a
    ticket that moves the Dockerfile and CI together (like Python and Postgres).
  - The inbox decision row for P0-06's `--renew-anon-volumes` gets a pointer to this ticket.
- Out: bumping uv; the production-like stack (P1-08); the open Dependabot PRs.

## Interfaces

None. Inside the app image the venv path changes from `/app/.venv` to `/opt/venv`; nothing in the repo
refers to the old path except the files above.

## Acceptance criteria

1. **Given** the stack is up, **when** `make up` runs again with nothing changed, **then** no container is
   recreated or restarted (each `State.StartedAt` is unchanged) and the number of dangling volumes is
   unchanged.
2. **Given** a change to the image (a `uv.lock` or Python change, simulated by rebuilding with a changed
   `pyproject.toml`/`uv.lock`), **when** `make up` runs, **then** the recreated app runs the new image's
   packages: no venv copy survives the recreation. Shown with a package added only in the new image.
3. **Given** the app container, **then** `python` and `uvicorn` come from `/opt/venv`, the app has no
   anonymous volume, `/api/health` and `/api/ready` answer 200, and `--reload` still picks up a change to
   `backend/app/` (the bind mount still works), while changes elsewhere under `backend/` (the host's
   `.venv`, `tests/`, `migrations/`) don't restart the server (review round 1, Low 1).
4. **Given** a machine still running the P0-06 stack (app with the `/app/.venv` volume), **when** it pulls
   this change and runs `make up`, **then** the app is recreated and healthy.
5. **Given** the production image (`docker build backend`), **then** `docker run` of it serves
   `/api/health` with gunicorn from `/opt/venv`, as user `app`.
6. **Given** `.github/dependabot.yml`, **then** the docker ecosystem ignores `ghcr.io/astral-sh/uv`, and
   GitHub's Dependabot config check passes.
7. `make check DB_PORT=55432` passes, and CI is green.

## Test plan

- AC1: `State.StartedAt` of the four containers and `docker volume ls -q -f dangling=true | wc -l`, before
  and after a second `make up`; the same commands on `main` show the failure (baseline above).
- AC2: in a scratch compose project, build the app, then rebuild with a package added to the lock, and
  import it in the recreated container. The same steps on `main` without `-V` show the stale copy.
- AC3/AC4: `docker inspect` mounts, `which python uvicorn`, curl, a touched file in `backend/app/`
  reloading (log line).
- AC5: `docker build` + `docker run` + curl, `whoami`.
- AC6/AC7: diff, CI, the Dependabot config check on the PR.

## Likely files

`backend/Dockerfile`, `docker-compose.yml`, `Makefile`, `.github/dependabot.yml`, `docs/HUMAN_INBOX.md`.

## Must explain (learning checkpoint)

1. Why does a bind mount over `/app` force an anonymous volume for a venv inside `/app`, and why does that
   volume survive an image rebuild?
2. What exactly did `--renew-anon-volumes` cost, and why is moving the venv better than keeping the flag?
3. Why does the version-pin check fail a Dependabot uv bump, and why ignore it rather than relax the check?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC1 measured by `StartedAt` and the dangling-volume count (the round-3
  probe's evidence); AC2 (the reason the flag existed must still hold without it); AC4 (upgrade from the
  P0-06 state); AC5 (the production image, not only compose).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - `/opt/venv` via `UV_PROJECT_ENVIRONMENT` (autonomous): uv's documented way to put the project venv
    elsewhere; the image's `uv sync` and any `uv` command in the container agree on it.
  - Ignore uv in Dependabot instead of teaching the pin check about it (autonomous): a uv bump must move
    CI's `version` too, which Dependabot can't do.
  - Found while proving AC1: with the venv moved, `app` was still recreated on every `make up`, because
    Docker Desktop's containerd image store wraps each build in an index with a provenance attestation
    that carries a timestamp, so the image ID changed even with every step cached. compose's
    `build.provenance: false` / `sbom: false` didn't change that (compose 2.40.3); exporting
    `BUILDX_NO_DEFAULT_ATTESTATIONS=1` from the Makefile does (autonomous; the dev image is never pushed,
    so it loses nothing).
- Split: none.
