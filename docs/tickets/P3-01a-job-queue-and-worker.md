# P3-01a — Job queue and worker (split from P3-01)

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 1 |
| Depends on | P1-04, P0-05 |
| Replaces old | M5-T07, M5-T09 (part of [P3-01](./P3-01-job-queue-and-worker.md)) |
| Status | in progress |

## Goal

Code can `enqueue()` background jobs inside a business transaction. A separate worker process claims and
runs them reliably: retries with backoff, recovery from crashes, dead-lettering and deduplication. The
scheduler, the recurring cleanup jobs and the operator CLI are [P3-01b](./P3-01b-scheduler-cleanup-and-cli.md).

## Why

This solves the dual-write problem for email and powers all background work without Redis or Celery
([ADR-0006](../adr/0006-postgres-job-queue.md)).

## Scope

- In:
  - **`jobs` table** (`app/jobs/models.py`), as in P3-01:
    - `kind` String(64), `payload` JSONB
    - `status` enum (queued, running, succeeded, dead)
    - `run_at` default now
    - `attempts` default 0, `max_attempts` default 8
    - `locked_by` String(64), `locked_until`
    - `last_error` Text (≤ 2,000 chars, redacted)
    - `dedupe_key` String(200), unique, nullable
    - `created_at`, `finished_at`
    - partial index `(run_at) WHERE status IN ('queued','running')`
    - check constraints: `attempts >= 0`, `max_attempts >= 1`
  - **`enqueue(db, kind, payload, *, run_at=None, dedupe_key=None, max_attempts=None)`**
    (`app/jobs/service.py`): `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`. Returns the new job's id, or
    `None` when the dedupe key already exists. Never commits.
  - **Handler registry** (`app/jobs/registry.py`): `@job_handler("kind", sensitive_keys=("link",))`.
    Handlers are `async def (payload, ctx) -> None`; `ctx` holds the job's session, id, kind and attempt.
    They raise `PermanentJobError` for non-retryable failures and any other exception for retryable ones.
    Registering a kind twice is an error.
  - **Worker** (`app/jobs/worker.py`, entrypoint `python -m app.worker`):
    - `run_once(batch=10)` claims jobs with the `FOR UPDATE SKIP LOCKED` statement from
      [02 §9](../ARCHITECTURE.md#9-background-jobs-and-email-adr-0006), including expired leases.
    - It processes each job in its own transaction; the handler's writes commit with the job's status.
    - **Success:** `succeeded`, `finished_at`, and the `sensitive_keys` removed from the payload.
    - **Retryable failure:** `queued`, with `run_at = now + min(2^attempts × 10 s, 1 h) × jitter(0.8–1.2)`.
    - **Permanent failure, or attempts exhausted:** `dead`.
    - `run_forever()` loops: claim; sleep 1 s when idle; on SIGTERM/SIGINT finish the current job and exit
      (exit code 0).
    - It logs `worker_heartbeat` every 30 s, with counts processed.
  - **Compose:** a `worker` service in `docker-compose.yml` and `compose.prodlike.yml` (P1-08), using the same
    image with `command: python -m app.worker`, and a healthcheck that fits a process without HTTP.
  - **Carried from P2-07:** `enqueue` in fitness test 4's `NON_COMMITTING_HELPERS`; the
    `test_the_session_database_is_this_runs_own` stem fix.
- Out:
  - the scheduler loop, `jobs.cleanup`, `rate_limits.cleanup`, the session cleanup and the CLI (P3-01b)
  - email (P3-02), notification fan-out (P3-03)
  - the staging compose and `deploy.sh` (D-02, D-03)

## Interfaces

`enqueue()`, `@job_handler`, `PermanentJobError`, `JobContext`, `python -m app.worker`.

## Acceptance criteria

Original P3-01 numbers 1–8 keep their numbers; 10–17 are added while framing.

1. **Given** `enqueue` inside a transaction that rolls back, **then** no job exists. If it commits, the job is
   `queued` with `attempts=0`, `run_at` = the clock's now (or the given `run_at`), and `max_attempts` 8 (or
   the given value). `enqueue` never commits: fitness test 4 lists it in `NON_COMMITTING_HELPERS`.
2. **Given** a `test.echo` job, **when** `run_once()` runs, **then** the job is `succeeded` with `attempts=1`,
   `finished_at` set, `locked_by`/`locked_until` cleared, and the handler ran once with the job's payload.
3. **Given** a handler failing twice and then succeeding, **then** `attempts=3`, `status=succeeded`, and each
   retry's `run_at` grew (frozen clock). Each retry's `run_at` is within `[0.8, 1.2] × min(2^attempts × 10 s,
   1 h)` of the failure time, the cap holds at high attempt counts, and `run_once` before a retry's `run_at`
   claims nothing.
4. **Given** a handler always failing with `max_attempts=3`, **then** after the third run `status=dead`,
   `finished_at` set, and `last_error` holds the exception type and message, at most 2,000 characters, with
   no value of the handler's `sensitive_keys` from the payload in it (no secrets). A `PermanentJobError` is
   `dead` after one attempt.
5. **Given** 20 jobs and two workers calling `run_once` concurrently (separate sessions, real commits),
   **then** every job runs exactly once.
6. **Given** a job `running` with an expired `locked_until`, **when** `run_once` runs, **then** it is reclaimed
   and processed. A `running` job whose lease has not expired is not claimed.
7. **Given** the same `dedupe_key` enqueued twice, **then** one row exists and the second `enqueue` returns
   `None`. Jobs without a dedupe key never collide.
8. **Given** `sensitive_keys=("link",)`, **after** success, **then** the payload has no `link` and keeps its
   other keys. After a retryable failure the payload is unchanged (the retry needs it).
10. **Given** a job whose kind has no registered handler, **then** `run_once` marks it `dead` with a
    `last_error` naming the unknown kind, and goes on with the rest of the batch.
11. **Given** a handler that writes to the database and then fails, **then** its writes are rolled back and
    the job's retry is still recorded; when it succeeds, its writes are committed with the job's status.
12. **Given** a reclaimed job whose attempts are already exhausted (the worker died during its last
    attempt), **then** it becomes `dead` without the handler running again.
13. **Given** a worker that lost its lease (another worker reclaimed the job), **then** its finishing update
    changes nothing: the row keeps the other worker's state.
14. **Given** a handler that runs longer than the handler timeout (below the 60 s lease), **then** it is
    cancelled and the job is retried like any retryable failure, so a slow handler isn't run twice at once.
15. **Given** `python -m app.worker` running a slow job, **when** it receives SIGTERM (or SIGINT), **then** the
    job finishes as `succeeded`, jobs claimed in the same batch but not started go back to `queued` with
    their attempt count unchanged, and the process exits with code 0.
16. **Given** a running worker, **then** it logs `worker_heartbeat` every 30 s with the counts processed
    (succeeded, retried, dead) since the last heartbeat, and no payload values.
17. **Given** `make up` and `make prodlike`, **then** the `worker` service starts and becomes healthy; on the
    prod-like stack it publishes no port and mounts no source (`scripts/prodlike-checks.sh`); `docker compose
    kill -s SIGTERM worker` stops it with exit code 0.

The tenant 10-case table does not apply: no endpoint is added.

## Test plan

- `tests/jobs/test_queue.py` (AC1, AC7) and `tests/jobs/test_worker.py` (the rest), using the test-only
  handlers `test.echo`, `test.fail`, `test.flaky`, registered by a fixture.
- AC5 and AC15 use real commits on the per-run database (`engine`), and clean up after themselves.
- Commands: `make test`; on the stack, `make up`/`make prodlike`, then `docker compose kill -s SIGTERM worker`.

## Likely files

`backend/app/jobs/{models,service,registry,worker}.py`, `backend/app/worker.py`,
`backend/app/logging_config.py`, `backend/app/models/registry.py`, `docker-compose.yml`,
`compose.prodlike.yml`, `scripts/prodlike-checks.sh`, `backend/migrations/versions/<new>.py`,
`backend/tests/jobs/*`, `backend/tests/test_architecture.py`, `backend/tests/test_db_isolation.py`.

## Must explain (learning checkpoint)

1. Walk through two workers running the claim query at the same instant. Why does each get different rows?
2. What happens if the worker crashes after the handler ran but before the status update? Why is that
   acceptable?
3. Why jitter in the backoff?
4. Why does each job run in its own transaction rather than one per batch?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - AC1–AC8 are P3-01's criteria 1–8, each sharpened: exact column values (AC1, AC2), the backoff bounds,
    the cap and "not claimed early" (AC3), what `last_error` holds and `PermanentJobError` (AC4), real
    commits for the concurrency test (AC5), the unexpired-lease negative (AC6), the `None` return and null
    keys (AC7), the payload kept on retry (AC8).
  - AC10–AC17 are new. Missed cases: an unknown kind (AC10), the handler's writes in the job's transaction
    (AC11), a reclaim after the final attempt (AC12), a lost lease (AC13), a handler slower than the lease
    (AC14). AC15–AC17 turn the ticket's shutdown, heartbeat and compose scope lines into criteria.
- Criteria loosened: none. P3-01's criterion 9 (the scheduler) moved to P3-01b with its scope.
- Decisions taken (basis):
  - **Split** (autonomous; playbook step 1.4): see the parent ticket.
  - **The worker's time is `clock.now()`**, bound into the claim and backoff statements, not the database's
    `now()`, so the frozen clock drives the tests (AC3) and `enqueue`'s default `run_at` matches what the
    claim compares it with. One host runs the API, worker and database, so clock skew doesn't arise.
    (autonomous; existing convention `app/core/clock.py`)
  - **The handler gets the job's session in `ctx`** and must not commit; the worker commits once per job.
    (autonomous; CLAUDE.md rule 5; needed by P3-01b's cleanup jobs)
  - **Finishing updates are guarded by `locked_by`** (AC13), and **handlers get a timeout below the lease**
    (AC14), so the at-least-once window is a crash, not a slow handler. (autonomous)
  - **A reclaimed job past `max_attempts` goes `dead` unrun** (AC12): otherwise a job that kills the worker
    would be retried forever. (autonomous)
  - **Shutdown releases the batch's unstarted jobs** (AC15) instead of leaving them leased for 60 s and
    charged an attempt. (autonomous)
  - **The worker's healthcheck** reads a heartbeat file the loop touches; the image's own HTTP healthcheck
    would mark the worker unhealthy and fail `make up --wait`. (autonomous)
  - Recorded in full in the PR's "Decisions and alternatives".
- Split: first part of P3-01; see the parent ticket.
