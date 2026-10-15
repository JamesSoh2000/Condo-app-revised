# Explanation — P0-04a Local stack and Makefile

> Code at the head of PR #9 (2026-10-15), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. The branch is rebased onto the latest `main`. Snapshot: if the code changes later, write a new explanation; lasting decisions live in ADRs. Form: full (Tier 2). Walkthrough variant: C (process: a developer runs `make up`, `make migrate`, `make s3-smoke`, `make check`).

## 1. What was built and why

`make up` now starts the whole local stack: the API, Postgres, Mailpit (a fake mail server with a web inbox) and LocalStack (an S3 emulator) that enforces the upload rules of [ADR-0007](../adr/0007-private-s3-presigned-uploads.md). A root `Makefile` wraps the everyday commands, Redis is removed, and settings gain the SMTP and S3-endpoint values later tickets (P3-02 email, P3-04 uploads) need.

## 2. Decisions

| Decision | Alternative rejected | Why | Basis |
|---|---|---|---|
| S3 emulator: `localstack/localstack:4.14.0` with `SERVICES=s3`, port 4566 | MinIO; moto; SeaweedFS; RustFS | Measured: MinIO images can no longer be pulled; moto accepts a 2 KiB upload against a 1 KiB policy and a wrong `Content-Type`, so it cannot test ADR-0007; SeaweedFS failed the presigned POST; RustFS passes but returns 400 `InvalidPolicyDocument` where AWS returns 403 `AccessDenied`. Recorded in ADR-0007 "Local emulator" | autonomous (measured) |
| Pin 4.14.0 | Track the latest LocalStack | Newer images need an account token; 4.14.0 runs without one. Dev-only, bound to 127.0.0.1 | autonomous |
| Keep `S3_BUCKET_NAME=condo-app-dev-files` | The ticket's new `S3_BUCKET=condo-dev-files` | A second bucket setting would sit beside the one the prod validator already checks | code is the truth for what exists |
| Prod rejects `S3_ENDPOINT_URL` / `S3_PUBLIC_ENDPOINT_URL` (`backend/app/core/config.py::validate_production_settings`) | Allow them | An emulator endpoint must never reach production | ticket AC4 (added in framing) |
| Two S3 endpoints: `http://s3:4566` (API, inside Docker) and `http://localhost:4566` (presigned URLs for the browser) | One endpoint | The hostname `s3` only resolves on the compose network; `localhost:4566` only works from the host. See §9 Q2 | ticket |
| `migrate`, `revision` and `alembic check` run on the host with `uv`, against the published db port | `docker compose exec app alembic …` | Files written through the bind mount would belong to the container user, and the ruff post-write hooks are dev dependencies the image lacks | default |
| `DB_PORT` (default 5432) sets db's host port; `db-guard` is a prerequisite of `migrate`, `revision`, `check` | Hard-coded 5432 | While building, another Postgres held 127.0.0.1:5432, Docker published nothing, and `make migrate` migrated the wrong server without an error. The guard turns that into a loud failure | autonomous |
| s3 healthcheck fails if any init script is in state `ERROR` | Trust LocalStack's `"completed": true` | LocalStack reports completed even when the script failed, so the stack would be "healthy" without a bucket. Found in review round 1 (M1) | autonomous (review fix) |
| `make e2e` stub exits 1; `seed` and `gen-api` stubs exit 0 | All stubs exit 0 | A test stub must never count as a pass; `seed` and `gen-api` have nothing to do yet, so success is honest | ticket AC5 + autonomous |
| `make s3-smoke` runs `uv run --python 3.12` | Plain `uv run` | At the repo root uv demands the exact `.python-version` (3.12.13), which a host may not have | default |
| `scripts/s3-smoke.py` is a PEP 723 script (dependencies declared inline) | Add boto3/httpx to the backend project | The smoke test is a dev tool; boto3 would otherwise become a backend dependency before P3-04 needs it | autonomous |
| CORS allows `:5173` and `:8080` | `:5173` only | P3-06 says P0-04 and P1-08 set the origins; `:8080` (the prod-like stack) costs one line | autonomous |

**What an interviewer would ask:** why the healthcheck must look at the init script and not only at the emulator's port; why a host-port clash is dangerous for Postgres but not for Mailpit (a Docker publish clash on Mailpit makes `make up` fail; for db it silently pointed `uv` at another server); why the smoke script needs a negative run against a weaker emulator to be trusted.

**Framing changes:** P0-04 was split into P0-04a (this) and P0-04b (GitHub settings). AC2 sharpened (wrong `Content-Type`, versioning, CORS allow/deny, non-zero exit). AC4 added (settings load, prod rejects emulator endpoints). AC5 added (`make check` fails on any failure; a stub can't pass for `e2e`). Loosened: none.

## 3. How it is implemented

### Overview

- `docker-compose.yml::mailpit:` and `docker-compose.yml::s3:` replace `redis`; `app` waits for `db`, `mailpit` and `s3` to be healthy.
- `docker/s3-init/create-bucket.sh` runs inside LocalStack once it is ready and creates the bucket: versioned, public access blocked, CORS for the two app origins.
- `backend/app/core/config.py::Settings` loads `smtp_host`, `smtp_port`, `s3_endpoint_url`, `s3_public_endpoint_url`; the prod validator rejects the S3 ones.
- `Makefile` wraps compose, Alembic, the linters and tests; `Makefile::db-guard:` proves the database it is about to touch is compose's.
- `scripts/s3-smoke.py` checks, from the host, that the emulator enforces what ADR-0007 relies on.

### Walkthrough (Variant C)

1. **Trigger:** `make up DB_PORT=55432` (or plain `make up`). `Makefile::export DB_PORT` puts the port in the environment, so compose's `${DB_PORT:-5432}` sees the same value as the Makefile's `DEV_DATABASE_URL`.
2. **Compose:** `docker compose up -d --build --wait --remove-orphans` (`Makefile::up:`). `--remove-orphans` deletes the old `redis` container; `--wait` blocks until every healthcheck passes, so a broken service makes `make up` fail.
3. **Mailpit** turns healthy when `/mailpit readyz` succeeds; SMTP is 1025 and the inbox UI 8025, both on 127.0.0.1 only.
4. **LocalStack** starts with only S3. When it is ready it runs the mounted bucket script (`docker/s3-init/create-bucket.sh`) (`set -eu`, so any failing `awslocal` call fails the script). The healthcheck polls `/_localstack/init/ready` and passes only when `"completed": true` and no script has `"state": "ERROR"`. State is in memory: the bucket is recreated on each start and uploads vanish on `make down`.
5. **App** starts last and reads `backend/.env.dev` (now with a "committed, never secrets" header), which sets `S3_ENDPOINT_URL=http://s3:4566`, `S3_PUBLIC_ENDPOINT_URL=http://localhost:4566`, `SMTP_HOST=mailpit`. Nothing in the app uses them yet.
6. **`make migrate`:** `db-guard` runs `docker compose port db 5432` and requires exactly `127.0.0.1:$(DB_PORT)`; otherwise it prints how to fix it and exits 1. Then `alembic upgrade head` runs on the host with `DATABASE_URL=…@127.0.0.1:$(DB_PORT)/condo_dev`.
7. **`make s3-smoke`:** the script builds a presigned POST (1 to 1024 bytes, `Content-Type` exactly `image/png`), posts 2 KiB, a wrong type and 512 B, reads the `VersionId`, the versioning status, and sends two CORS preflights. Each prints `ok` or `FAIL`; any `FAIL` exits 1.
8. **`make check`:** `lint` (ruff, format check, eslint, the ESLint fence self-test), `typecheck` (mypy, tsc), `test` (pytest), `db-guard`, then `alembic check`, the Base44 count and `npm run build`. Make stops at the first non-zero command, so the target fails if any step fails.
9. **Failures you would see:** `db-guard: compose's db is not published on 127.0.0.1:5432…` (wrong port or stack down); `make up` timing out on `s3` (init script error; `docker compose logs s3` shows the `awslocal` failure); `FAIL  2 KiB upload rejected…` from the smoke script (emulator stopped enforcing the policy). Recovery: `make down && make up` is safe; the Postgres volume survives, the S3 state does not.

### Data model changes

None. No migration.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `Makefile` | New: everyday targets, `db-guard`, stubs | +79 / −0 |
| `docker-compose.yml` | Redis out; `mailpit`, `s3` in; `DB_PORT`; app depends on all | +38 / −9 |
| `docker/s3-init/create-bucket.sh` | New: bucket with versioning, public access block, CORS | +25 / −0 |
| `scripts/s3-smoke.py` | New: the AC2 checks | +105 / −0 |
| `backend/app/core/config.py` | `redis_url` out; SMTP and S3 endpoints in; prod rejection | +15 / −5 |
| `backend/tests/test_config.py` | AC4 tests | +51 / −0 |
| `backend/.env.dev`, `backend/.env.example` | New vars, Redis out, header comment (`.env.dev` only) | +17 / −4 |
| `README.md` | Quickstart; old Docker Alembic notes removed | +17 / −48 |
| `CLAUDE.md` | Commands paragraph, `make s3-smoke` | +4 / −2 |
| `docs/adr/0007-private-s3-presigned-uploads.md` | "Local emulator" section with the measurement table | +23 / −1 |
| `docs/tickets/P0-04*.md`, `docs/tickets/README.md` | Split into 04a / 04b; frame notes | +185 / −17 |

**Key excerpts**

`docker-compose.yml::s3:`

```yaml
  s3:
    image: localstack/localstack:4.14.0
    environment:
      SERVICES: s3
      AWS_DEFAULT_REGION: ca-central-1
    ports:
      - "127.0.0.1:4566:4566"
    volumes:
      - ./docker/s3-init/create-bucket.sh:/etc/localstack/init/ready.d/create-bucket.sh:ro
    healthcheck:
      # Healthy only after the init script has run without an error. LocalStack reports "completed" even
      # when a script fails, so a script in state ERROR must fail the check too.
      test:
        - CMD-SHELL
        - >-
          r=$$(curl -fsS http://localhost:4566/_localstack/init/ready)
          && echo "$$r" | grep -q '"completed": true'
          && ! echo "$$r" | grep -q '"state": "ERROR"'
      # ...
```

- Runs only the S3 part of LocalStack and mounts the bucket script into its "ready" hook.
- `$$` escapes compose's own `$` interpolation; `>-` folds the three lines into one shell command.
- Remove the `! … ERROR` line and a failed bucket creation still reports healthy (review M1): `make up` succeeds, and the first upload fails with `NoSuchBucket`.

`docker/s3-init/create-bucket.sh` (CORS part)

```sh
awslocal s3api put-bucket-cors --bucket "$BUCKET" --cors-configuration '{
  "CORSRules": [{
    "AllowedOrigins": ["http://localhost:5173", "http://localhost:8080"],
    "AllowedMethods": ["GET", "HEAD", "POST"],
    "AllowedHeaders": ["*"],
    "ExposeHeaders": ["ETag"],
    "MaxAgeSeconds": 3000
  }]
}'
```

- The browser uploads straight to S3 (ADR-0007), so S3 itself must allow the app's origin; listing origins (not `*`) is what makes the "evil origin refused" check meaningful.
- Without CORS, the browser blocks every direct upload even though the presigned POST is valid.

`backend/app/core/config.py::validate_production_settings`

```python
            if self.s3_endpoint_url is not None or self.s3_public_endpoint_url is not None:
                raise ValueError(
                    "S3_ENDPOINT_URL and S3_PUBLIC_ENDPOINT_URL must not be set in production"
                )
```

- With `APP_ENV=prod`, any endpoint override stops the app from starting. `None` means "use real AWS S3".
- Note that an empty string (`S3_ENDPOINT_URL=`) is also rejected, because pydantic keeps `""` rather than turning it into `None`. That is the safe direction.
- Without it, a copied `.env.dev` in production would send uploads to an emulator URL.

`Makefile::db-guard:` and `Makefile::check:`

```make
export DB_PORT ?= 5432
DEV_DATABASE_URL := postgresql+asyncpg://postgres:devpassword@127.0.0.1:$(DB_PORT)/condo_dev
# ...
db-guard:
	@$(COMPOSE) port db 5432 2>/dev/null | grep -qx "127.0.0.1:$(DB_PORT)" || { \
	  echo "db-guard: compose's db is not published on 127.0.0.1:$(DB_PORT). Run \`make up\` first, or, if"; \
	  echo "another server holds the port, use a free one on every target: make up DB_PORT=55432"; exit 1; }

migrate: db-guard ## alembic upgrade head on the dev database
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic upgrade head
# ...
check: lint typecheck test db-guard ## Everything CI checks, plus alembic check (needs `make up`)
	$(BACKEND) DATABASE_URL=$(DEV_DATABASE_URL) uv run alembic check
	bash scripts/base44-count.sh
	$(FRONTEND) npm run build
# ...
e2e: ## Playwright journeys (stub until P4-09; fails so a stub never counts as a pass)
	@echo "make e2e: no Playwright suite yet; P4-09 adds it"; exit 1
```

- `export` sends `DB_PORT` to compose, so the published port and the URL always agree.
- The guard asks Docker where compose's db is published; a different server on the same port can't pass because Docker then publishes nothing for db.
- The URL uses `127.0.0.1`, not `localhost`, so it is the exact address the guard checked (review L1; `localhost` can resolve to `::1`).

`scripts/s3-smoke.py::presigned_post`

```python
def presigned_post(key: str, size: int, content_type: str = "image/png") -> httpx.Response:
    """Uploads `size` bytes with a policy of at most MAX_BYTES and Content-Type image/png."""
    post = s3.generate_presigned_post(
        BUCKET,
        key,
        Fields={"Content-Type": "image/png"},
        Conditions=[["content-length-range", 1, MAX_BYTES], {"Content-Type": "image/png"}],
        ExpiresIn=300,
    )
    fields = {**post["fields"], "Content-Type": content_type}
    return httpx.post(post["url"], data=fields, files={"file": ("f.png", b"x" * size)})
```

- The same shape of policy P3-04 will issue: a signed size range and an exact type. Overwriting `Content-Type` after signing simulates a client lying about the type.
- The client uses `S3_PUBLIC_ENDPOINT_URL`, so it tests the URL a browser would get.

`backend/tests/test_config.py::test_prod_rejects_s3_emulator_endpoints`

```python
@pytest.mark.parametrize("field", ["s3_endpoint_url", "s3_public_endpoint_url"])
def test_prod_rejects_s3_emulator_endpoints(field):
    with pytest.raises(ValidationError, match="must not be set in production"):
        Settings(
            _env_file=None,
            app_env="prod",
            allowed_origins=["https://condo.example.org"],
            secret_key="not-the-default-secret",  # noqa: S106 (test fixture, not a real secret)
            s3_bucket_name="condo-app-prod-files",
            ses_from_email="noreply@example.org",
            **{field: "http://localhost:4566"},
        )
```

- Every other prod check is satisfied, so the only reason to fail is the endpoint; each field is tested alone.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Upload bigger than the policy | Emulator returns 400 `EntityTooLarge` | `make s3-smoke` check 1; negative run against moto fails it (PR transcript) |
| `Content-Type` differs from the policy | 403 `AccessDenied` | `make s3-smoke` check 2 (asserts only `>= 400`, not the reason) |
| Object has no version | `head_object` must return a non-`null` `VersionId` | `make s3-smoke` checks 4–5 |
| Upload from an unknown origin | Preflight refused, no `Access-Control-Allow-Origin` | `make s3-smoke` checks 6–7 |
| Bucket script fails, stack still "healthy" | Healthcheck fails on `"state": "ERROR"` | Manual reproduction in review rounds 1–2 (PR); no automated test |
| Another Postgres on the db port | `db-guard` exits 1 before Alembic runs | Manual run (`make db-guard DB_PORT=5432` here → exit 2 with the message); no automated test |
| Emulator endpoint in production | Validator raises | `backend/tests/test_config.py::test_prod_rejects_s3_emulator_endpoints` |
| Prod without endpoints wrongly rejected | Validator passes | `backend/tests/test_config.py::test_prod_accepts_settings_without_s3_endpoints` |
| `make e2e` treated as a pass | Exits 1 | Manual run in the PR |
| Bucket name changed in `.env.dev` | **Not handled:** the s3 container gets no `S3_BUCKET_NAME`, so the script always uses its default (see §7) | None |

Acceptance criteria → evidence:
- AC1: PR transcript (`make up`, `make migrate`, all four healthy, Mailpit 200). Rechecked while writing this: `docker compose ps` shows all four healthy.
- AC2: `make s3-smoke` (rechecked: all 7 `ok`), plus the PR's failing run against moto 5.1.4.
- AC3: `git grep -il redis -- backend docker-compose.yml` returns nothing (rechecked).
- AC4: `backend/tests/test_config.py::test_local_service_endpoints_load_from_env`, `::test_s3_endpoints_default_to_real_aws`, `::test_prod_rejects_s3_emulator_endpoints`, `::test_prod_accepts_settings_without_s3_endpoints` (rechecked: 9 passed in the file).
- AC5: PR transcript (`make check` exit 0; a ruff failure and `DB_PORT=1` exit 2; `make e2e` exit 2).

## 6. Review log

| Round | Reviewer | Verdict | Findings | Outcome |
|---|---|---|---|---|
| 1 | Fresh Claude subagent | MERGE | M1: s3 healthy when the init script fails | Fixed in e257048 (`ERROR` state fails the check) |
| 1 | | | L1: `DEV_DATABASE_URL` used `localhost`, guard checks `127.0.0.1` | Fixed in e878bb4 |
| 1 | | | L2: Mailpit/S3 host ports have no override or guard | Deferred: a clash fails `make up` loudly; follow-up in the PR and inbox |
| 1 | | | L3: P0-04b lost the named stale branches | Fixed in bd77038 |
| 2 | New fresh subagent | MERGE | M1 verified for `ERROR`, still-`RUNNING`, live stack; L1, L3 verified. New Low: review section and L2 follow-up unrecorded | Recorded in the PR body and inbox |

## 7. Not verified

- **The bucket name is not shared with the emulator.** `docker/s3-init/create-bucket.sh` reads `S3_BUCKET_NAME`, but the `s3` service has no `env_file` or that variable (checked: `env` in the container has no bucket variable), so it always creates `condo-app-dev-files`. Changing `S3_BUCKET_NAME` in `backend/.env` would point the API at a bucket that does not exist. Harmless today (nothing uploads yet); P3-04 should fix it.
- The smoke checks for size and type pass on any status `>= 400`; they do not check the error code, so an unrelated failure (for example a signature error) would also count as "rejected". The moto negative run shows they can fail, but not that they fail for the right reason.
- The public access block is created but no check asserts it.
- No automated test covers `db-guard`, the s3 healthcheck's `ERROR` branch, or the stub exit codes; all evidence is manual transcripts in the PR.
- CI does not run any of this: no CI job starts the compose stack or `make s3-smoke`. A future LocalStack or Mailpit change is only caught locally.
- LocalStack's emulation is not AWS: AWS behaviour (exact error codes, CORS on presigned POST to the real regional endpoint) is unverified until milestone D.
- Mailpit is up but nothing sends mail yet (P3-02); SMTP settings are loaded but unused.
- `CLAUDE.md`'s commands block still says `make up` starts a "worker" and `make test` uses "real Postgres"; neither is true yet (the lines predate this ticket, but the block was edited here).
- L2 open: no override for host ports 1025, 8025, 4566.

## 8. How to change this safely

- **New compose service:** add it with a healthcheck, add it to `app`'s `depends_on` if the API needs it, and bind ports to `127.0.0.1`. `make up` (it uses `--wait`) tells you if the healthcheck never passes.
- **New S3 setting or emulator change:** update `docker/s3-init/create-bucket.sh`, ADR-0007's "Local emulator" section, and run `make s3-smoke`; if you swap emulators, rerun the smoke script against the old one too, to show it still distinguishes.
- **New prod-only rule:** add it to `backend/app/core/config.py::validate_production_settings` with a test like `test_prod_rejects_s3_emulator_endpoints` that satisfies every other prod check.
- **New database target in the Makefile:** depend on `db-guard` and use `$(DEV_DATABASE_URL)`, never a hard-coded port.
- **New stub target:** exit non-zero if it stands in for a test run.

## 9. Must explain, then quiz

**1. Why emulate S3 and SMTP locally instead of using real AWS credentials in development?** Real credentials on every laptop and agent session are a secret that can leak, and a dev bug could write to or email real people. An emulator costs nothing, works offline, resets on `make down`, and needs no credentials (`scripts/s3-smoke.py` uses `test`/`test`). Mailpit catches every email in a local inbox (`docker-compose.yml::mailpit:`). The catch is that emulators can differ from AWS, which is why the emulator was chosen by measuring it against the ADR-0007 policy rather than by reputation.

**2. Why does the S3 emulator need two endpoint URLs?** The API runs in a container and reaches LocalStack by its compose service name, `http://s3:4566`; that name means nothing to a browser. A presigned URL is used by the browser, so it must contain an address the browser can reach, `http://localhost:4566` (the published port). In AWS there is one public endpoint, so both settings are `None` and `backend/app/core/config.py::validate_production_settings` forbids setting them.

**3. What does `content-length-range` enforce, and why can't a presigned PUT do the same?** A presigned POST carries a signed policy document: a list of conditions S3 checks against the form upload, including a minimum and maximum body size and an exact `Content-Type` (`scripts/s3-smoke.py::presigned_post`). A presigned PUT is just a signed request; it can sign headers such as an exact `Content-Length`, but it has no way to express a range, so either the client's size must be known and fixed in advance or there is no size limit at all.

**Quiz**

1. `make migrate` printed nothing alarming and succeeded, but your tables are missing from `make psql`. What happened before this ticket, and what stops it now?
2. Why does `make s3-smoke` sign the policy with `image/png` and then send `text/html` instead of signing `text/html` directly?
3. LocalStack's init script fails on `put-bucket-cors`. Without the `"state": "ERROR"` line in the healthcheck, what would a developer see, and when?
4. What would break if we removed `export` from `export DB_PORT ?= 5432` in the `Makefile`?
5. How would you extend the stack so `make s3-smoke` runs in CI on every PR?

<details><summary>Answers</summary>

1. Another Postgres held 127.0.0.1:5432, Docker could not publish db there, and the host `uv run alembic` connected to the other server. `Makefile::db-guard:` now asks Docker where db is published and fails unless it is `127.0.0.1:$(DB_PORT)`.
2. The test is that the emulator rejects a client who lies about the type after getting a signed policy; signing `text/html` would just be a valid policy for HTML and would be accepted.
3. `make up` would succeed with all services healthy; the bucket might exist without CORS (or not at all), and the failure would only appear later, as a browser CORS error or a smoke-test `FAIL`, far from its cause.
4. Compose would not see the Makefile's value, so `make up DB_PORT=55432` would publish db on 5432 while `DEV_DATABASE_URL` and `db-guard` use 55432; the guard would then fail every database target (or, with the default, hide nothing but give no override).
5. Add a CI job that runs `make up` (with a free `DB_PORT`) and `make s3-smoke`, pre-pulling the pinned images, and make it a required check; also pass `S3_BUCKET_NAME` to the `s3` service so CI and the API agree on the bucket.

</details>
