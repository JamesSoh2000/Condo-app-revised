# Explanation — P0-07 App venv outside the bind mount; Dependabot leaves uv alone

> Code at the head of PR #42 (`56d3a1a`, 2026-10-15), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. The branch contains the latest `origin/main`. Snapshot: if the code changes later, write a new explanation. Form: short (Tier 3). Walkthrough variant: C (`make up` builds and starts the stack).

**1. What changed and why.** The app image's virtualenv (venv: the folder holding the installed Python packages) moves from `/app/.venv` to `/opt/venv`, outside the `./backend:/app` bind mount (a host folder shown inside the container). It no longer needs an anonymous volume to survive the mount, so `make up` drops `--renew-anon-volumes`, which restarted all four containers on every run. Dependabot stops proposing uv image bumps that `scripts/check-version-pins.py` would fail.

**2. Decisions** (*autonomous* = no written rule; these are in the inbox)
- venv in `/opt/venv` via `UV_PROJECT_ENVIRONMENT` (uv's setting for where the project venv lives, so `uv sync` and `uv run` agree). Rejected: keeping the flag (a full restart on every `make up`); a named volume (it goes stale exactly like the anonymous one). *Autonomous* (P0-06 review round 3, L1).
- `export BUILDX_NO_DEFAULT_ATTESTATIONS := 1` in the Makefile. Docker Desktop attaches a timestamped provenance attestation (build metadata) to every build, so the image ID changed even with every step cached and compose recreated `app` anyway. Rejected: compose's `build.provenance: false`, which was tried and didn't change the ID on compose 2.40.3. *Autonomous*, found while proving AC1.
- Dependabot ignores `ghcr.io/astral-sh/uv` for all update types. Rejected: teaching the pin check to accept a lone bump (CI's setup-uv `version` must move too, and Dependabot can't do that); leaving it (the grouped docker PR stays red). *Autonomous* (round 3, L2).
- `--reload-dir app` on uvicorn. Without the old volume over `/app/.venv`, the reloader watched the host's `backend/.venv`, `tests/` and `migrations/`. Basis: review round 1, L1.
- **Framing changes:** AC1 measured by `State.StartedAt` and the dangling-volume count; AC2 (a rebuilt image's packages win without the flag), AC4 (upgrade from the P0-06 stack) and AC5 (production image) added. Nothing loosened.

**3. Files changed.** `backend/Dockerfile::UV_PROJECT_ENVIRONMENT=/opt/venv` (and `PATH`) · `docker-compose.yml::--reload-dir app` (the `- /app/.venv` volume removed) · `Makefile::BUILDX_NO_DEFAULT_ATTESTATIONS` (and `up:` without the flag) · `.github/dependabot.yml::dependency-name: ghcr.io/astral-sh/uv` · `docs/HUMAN_INBOX.md` (the P0-06 row now says superseded) · the ticket and `docs/tickets/README.md`.

**Walkthrough (C).** `make up` runs `docker compose up -d --build --wait --remove-orphans` with the attestation variable exported. The build is fully cached, so the image ID is the same and compose prints `Running` for all four services, touching nothing. After a `uv.lock` change the image ID changes, compose recreates `app`, and the new container sees the new image's `/opt/venv` directly: there is no volume holding an old copy. A bare `docker compose up --build` (without `make`) still gets a new ID on Docker Desktop and recreates `app`, but that is only a restart; nothing goes stale.

**4. The code.** `backend/Dockerfile::UV_PROJECT_ENVIRONMENT=/opt/venv`

```dockerfile
    UV_LINK_MODE=copy \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    PATH="/opt/venv/bin:$PATH"
```

Without `UV_PROJECT_ENVIRONMENT`, `uv sync --locked --no-install-project` would build `/app/.venv` again and the dev bind mount would hide it (the container would fall back to the host's `backend/.venv`, whose symlinks point outside the container). Without the `PATH` line, `python`, `uvicorn` and `gunicorn` would resolve to the system Python with no packages.

**5. How to verify it.** Run `make up` twice and compare `docker inspect -f '{{.State.StartedAt}}'` for the four containers and `docker volume ls -q -f dangling=true | wc -l`: both unchanged (the PR shows 30/30/30 and identical `StartedAt` values; on `main` all four changed and dangling went 27 → 29). `docker compose exec app which python uvicorn` → `/opt/venv/bin/...`. Touching `backend/app/main.py` logs `Reloading...`; touching `backend/tests/` does not. CI on the head: backend, frontend and docs jobs pass. All of this is transcript evidence; no automated test covers AC1–AC5. These commands were not re-run for this explanation (containers left as they were).

**6. Review.** Round 1 (fresh Claude reviewer): `MERGE`, one Low fixed (`--reload-dir app`, commit `56d3a1a`; measured 78 spurious reload lines in 30 s before, 0 after). Round 2 (new fresh reviewer, whole diff): `MERGE`, no findings; it re-proved AC1 and the reload probes. **Not verified:** GitHub's Dependabot config check (AC6) does not appear in the PR's check list, so "config valid" rests on the diff; whether Dependabot actually stops proposing uv shows only on its next run. The attestation fix is specific to Docker Desktop's containerd image store and compose 2.40.3; on other setups it was not tried. Pre-existing gunicorn `Permission denied: '/nonexistent'` log is left for P1-08.

**7. How to change it safely.** Bump uv in one ticket that changes the Dockerfile image tag and CI's setup-uv `version` together; `make check` runs the pin check. If a later compose honours `build.provenance: false`, move the setting there and re-prove AC1 with `StartedAt`.

**Must explain.**
1. A bind mount replaces everything under `/app` with the host folder, so a venv the image built at `/app/.venv` is hidden. The old compose file mounted an anonymous volume at `/app/.venv` to keep it visible: Docker fills an empty volume from the image *once*, and compose carries that volume over to every recreated container. So after a rebuild the container still saw the old copy (3.12 packages after the Python bump, so it crashed).
2. `--renew-anon-volumes` made compose recreate every container on every `make up`: db restarted, the S3 emulator lost its in-memory objects, and each run left two dangling volumes. Moving the venv (`backend/Dockerfile::UV_PROJECT_ENVIRONMENT=/opt/venv`) removes the volume, so there is nothing to renew and nothing to restart.
3. `scripts/check-version-pins.py` requires the Dockerfile's uv image tag and CI's setup-uv `version` to be the same release; Dependabot's docker ecosystem only edits the Dockerfile. Relaxing the check would let dev and CI drift onto different uv releases, which is the bug the check exists to stop; ignoring the image keeps the rule and moves bumps into tickets.

**Quiz.** 1. Why would a *named* volume at `/app/.venv` not have fixed the staleness? 2. Why did `app` keep being recreated after the venv moved, even with every build step cached? 3. What breaks if we remove `--reload-dir app`? 4. What breaks if we remove the `PATH` line but keep `UV_PROJECT_ENVIRONMENT`? 5. How would you extend this so a bare `docker compose up --build` is also a no-op?

<details><summary>Answers</summary>

1. A named volume is also filled from the image only when it is empty, and it survives recreation, so it keeps the old packages just like the anonymous one. 2. Docker Desktop's image store adds a provenance attestation with a timestamp to each build, giving a new image ID; compose recreates a container whose image ID changed. 3. uvicorn watches all of `/app`, including the host's `backend/.venv` (broken symlinks logging ~150 change lines a minute) and `tests/`; a host `uv sync` or test edit restarts the server. 4. The dev `command:` and the production `CMD` call `uvicorn`/`gunicorn` by name, and the system Python has no such packages, so the container fails to start. 5. The variable must be in the environment of the process that runs the build, so export it from the shell profile (or a tool like direnv), or turn off Docker Desktop's containerd image store; compose's `.env` file only feeds `${...}` interpolation, so it may not work there. Either way, re-prove AC1 with `StartedAt` without `make`.
</details>
