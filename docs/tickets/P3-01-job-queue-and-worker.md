# P3-01 — Job queue and worker (split)

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 1 |
| Depends on | P1-04, P0-05 |
| Replaces old | M5-T07, M5-T09, M14-T16 (demo subset) |
| Status | split into [P3-01a](./P3-01a-job-queue-and-worker.md), [P3-01b](./P3-01b-scheduler-cleanup-and-cli.md) |


Split while framing (2026-10-18). "P3-01" in other tickets' text means both parts; the
[ticket index](./README.md) lists which part each dependent actually needs (P3-02, P3-03 and D-02 need
P3-01a: `enqueue`, the worker and its compose service).

| Part | Scope | Acceptance criteria (original numbers) |
|---|---|---|
| [P3-01a](./P3-01a-job-queue-and-worker.md) | `jobs` table, `enqueue`, handler registry, worker (`run_once`, `run_forever`, shutdown, heartbeat), compose `worker` service; the P2-07 carries | 1–8 (sharpened), plus new 10–17 |
| [P3-01b](./P3-01b-scheduler-cleanup-and-cli.md) | Scheduler loop, `jobs.cleanup`, `rate_limits.cleanup`, the session cleanup (P2-01b carry), CLI `jobs-status` and `jobs-retry` | 9 |

## Why split

- Size: the estimate for the whole ticket was ~560 non-test lines (model and migration ~100, `enqueue` and
  registry ~70, worker with shutdown, heartbeat and lease guards ~190, entrypoint and logging ~25, compose
  and wiring checks ~40, scheduler and three cleanup jobs ~70, CLI ~65), over ~400.
- Order: the queue and worker are what P3-02 (email) and P3-03 (notifications) build on, so they go first;
  the scheduler, cleanups and CLI only add jobs and read the table.
- No criterion was dropped or loosened: criteria 1–8 are in P3-01a (sharpened), 9 in P3-01b. "Must explain"
  questions 1–4 are answered by P3-01a's explanation; P3-01b has its own.

## Original ticket (for reference)

### Goal

Code can `enqueue()` background jobs inside a business transaction. A separate worker process claims and
runs them reliably: retries with backoff, recovery from crashes, dead-lettering, deduplication and recurring
jobs.

### Why

This solves the dual-write problem for email and powers all background work without Redis or Celery
([ADR-0006](../adr/0006-postgres-job-queue.md)).

### Scope

- In:
  - **`jobs` table** (`app/jobs/models.py`):
    - `kind` String(64), `payload` JSONB
    - `status` enum (queued, running, succeeded, dead)
    - `run_at` default now
    - `attempts` default 0, `max_attempts` default 8
    - `locked_by` String(64), `locked_until`
    - `last_error` Text (≤ 2,000 chars, redacted)
    - `dedupe_key` String(200), unique, nullable
    - `created_at`, `finished_at`
    - partial index `(run_at) WHERE status IN ('queued','running')`
  - **`enqueue(db, kind, payload, *, run_at=None, dedupe_key=None, max_attempts=None)`:**
    `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`. Never commits.
  - **Handler registry:** `@job_handler("kind", sensitive_keys=("link",))`. Handlers are
    `async def (payload, ctx) -> None`. They raise `PermanentJobError` for non-retryable failures and any
    other exception for retryable ones.
  - **Worker** (`app/jobs/worker.py`, entrypoint `python -m app.worker`):
    - `run_once(batch=10)` claims jobs with the `FOR UPDATE SKIP LOCKED` statement from
      [02 §9](../ARCHITECTURE.md#9-background-jobs-and-email-adr-0006), including expired leases.
    - It processes each job in its own transaction.
    - **Success:** `succeeded`, `finished_at`, and the `sensitive_keys` removed from the payload.
    - **Retryable failure:** `queued`, with `run_at = now + min(2^attempts × 10 s, 1 h) × jitter(0.8–1.2)`.
    - **Permanent failure, or attempts exhausted:** `dead`.
    - `run_forever()` loops: claim; sleep 1 s when idle; on SIGTERM/SIGINT finish the current job and exit
      (exit code 0).
    - It logs `worker_heartbeat` every 30 s, with counts processed.
  - **Scheduler loop** (in the worker, every 60 s): enqueue recurring jobs with
    `dedupe_key=f"{kind}:{yyyy-mm-dd}"`:
    - `jobs.cleanup` (delete succeeded jobs older than 14 days)
    - `rate_limits.cleanup` (P2-05)
  - **CLI:**
    - `jobs-status`: counts by status, oldest due age, last 10 dead jobs
    - `jobs-retry <id>`: dead → queued, attempts reset
  - **Compose:** a `worker` service in `docker-compose.yml` and `compose.prodlike.yml` (P1-08), using the same
    image with `command: python -m app.worker`. The staging compose and `deploy.sh` get it in milestone D
    (D-02, D-03).
- Out:
  - email (P3-02)
  - notification fan-out (P3-03)

### Interfaces

`enqueue()`, `@job_handler`, `PermanentJobError`, CLI `jobs-status` and `jobs-retry`.

### Acceptance criteria

1. **Given** `enqueue` inside a transaction that rolls back, **then** no job exists. If it commits, the job is
   `queued`.
2. **Given** a `test.echo` job, **when** `run_once()` runs, **then** the job is `succeeded` and the handler
   ran once.
3. **Given** a handler failing twice and then succeeding, **then** `attempts=3`, `status=succeeded`, and each
   retry's `run_at` grew (frozen clock).
4. **Given** a handler always failing with `max_attempts=3`, **then** `status=dead` with `last_error` set (no
   secrets).
5. **Given** 20 jobs and two workers calling `run_once` concurrently (separate sessions), **then** every job
   runs exactly once.
6. **Given** a job `running` with an expired `locked_until`, **when** `run_once` runs, **then** it is reclaimed
   and processed.
7. **Given** the same `dedupe_key` enqueued twice, **then** one row exists.
8. **Given** `sensitive_keys=("link",)`, **after** success, **then** the payload has no `link`.
9. **Given** the scheduler runs twice on the same day (simulated restart), **then** one `jobs.cleanup` job
   exists for that date.

### Test plan

- `tests/jobs/test_queue.py` and `tests/jobs/test_worker.py`, using the test-only handlers `test.echo`,
  `test.fail` and `test.flaky`.
- Commands: `make test`; manual `docker compose kill -s SIGTERM worker` during a slow test job.

### Likely files

`backend/app/jobs/{models,service,registry,worker,scheduler}.py`, `backend/app/worker.py`,
`backend/app/cli.py`, `docker-compose.yml`, `compose.prodlike.yml`,
`backend/migrations/versions/<new>.py`, `backend/tests/jobs/*`.

### Must explain (learning checkpoint)

1. Walk through two workers running the claim query at the same instant. Why does each get different rows?
2. What happens if the worker crashes after the handler ran but before the status update? Why is that
   acceptable?
3. Why jitter in the backoff?
4. Why does each job run in its own transaction rather than one per batch?

### Carried from P2-01b (do while framing)

- Expired and revoked `sessions` rows are never deleted, and there is no per-user cap on live sessions
  (PR #57 review round 2 L3). Add a periodic job that deletes rows past `expires_at`/`idle_expires_at` or
  revoked for some retention period, and decide on a cap.

### Carried from P2-07 (do while framing)

- Add `enqueue` (in its service module) to `NON_COMMITTING_HELPERS` in `backend/tests/test_architecture.py`, so
  fitness test 4 fails if it ever commits (CLAUDE.md rule 5).
- Review round 3 Low (PR #67): `backend/tests/test_db_isolation.py::test_the_session_database_is_this_runs_own`
  expects the whole stem of `TEST_DATABASE_URL`'s name, so it fails when the stem is longer than about 39
  bytes (the per-run name truncates it). Use `assert_named_per_run` there, as the scratch-name test does.

### Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
