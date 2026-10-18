# Explanation — P3-01a Job queue and worker

> **PR:** #69 · **Source revision:** `2e46dd7`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the last review session (the flaky-test diagnosis, Codex gpt-6-astra medium)
> reviewed `84aedb3`. `2e46dd7` is the fix of that session's two findings, which no reviewer saw. Round 3
> was skipped on James's instruction (PR "Independent review").
> **Merge commit:** not known when written; after the merge, `gh pr view 69 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `2e46dd7`: `git diff origin/main...HEAD`; `backend/app/jobs/worker.py`
> (whole file), `models.py`, `service.py`, `registry.py`, `backend/app/worker.py`, the migration, both
> compose files; the assertions of the cited tests in `backend/tests/jobs/`; the PR #69 description with its
> three review records. Rendered the claim's SQL from `_claim`. Ran `uv run pytest -q tests/jobs
> tests/test_world.py tests/test_architecture.py tests/test_db_isolation.py tests/test_cli_seed.py`: 180
> passed; `make check DB_PORT=55432`: exit 0 (887 backend tests passed). Differences from the plan: yes, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: C (a job becoming due and the worker running it).

## 1. What was built and why

Business code can now call `enqueue(db, kind, payload)` inside its own transaction. The job row exists only
if that transaction commits, which is the outbox pattern of [ADR-0006](../adr/0006-postgres-job-queue.md).
A separate process, `python -m app.worker`, claims due jobs one at a time with `FOR UPDATE SKIP LOCKED` and
runs each handler in its own transaction. It retries failures with jittered exponential backoff, reclaims
jobs from crashed workers when their 60 s lease expires, and dead-letters permanent or exhausted failures.
`last_error` never stores a secret it can recognise. On SIGTERM the worker finishes the current job and
exits 0. Both compose stacks run it.

P3-01 was split while framing. This part holds the queue and the worker. The scheduler, the cleanup jobs and
the `jobs-status`/`jobs-retry` CLI are [P3-01b](../tickets/P3-01b-scheduler-cleanup-and-cli.md). Two decisions
matter most:
- **one claim per job** (D9). Three review sessions found the batch claim of the first version
  unsafe in three different ways.
- **a guarded finish**: every final update checks that this worker still holds the lease (D4).

## 2. Decisions

All are recorded in PR #69's "Decisions and alternatives" (D1–D9 there). D1 (the split) is in the
parent ticket [P3-01](../tickets/P3-01-job-queue-and-worker.md) "Why split".

### D9. One claim per job, written as `id = (SELECT … LIMIT 1 FOR UPDATE SKIP LOCKED)`

- **Problem or constraint:** the first version claimed up to 10 jobs under one lease and ran them in turn.
  Each review round broke it differently:
  - Round 1: jobs waiting in the batch outlived the lease, and a second worker ran them too.
  - Round 2, after round 1 added a per-job renewal: a waiting job whose lease lapsed was reclaimed,
    charged an attempt and dead-lettered without ever running.
  - The flaky-test diagnosis: even `id IN (SELECT … LIMIT 1 …)` could lease several rows. Under stale
    statistics, Postgres ran it as a semi-join that re-ran the subquery for each row.
- **Chosen:** `backend/app/jobs/worker.py::run_once` loops up to `batch` times. Each pass claims exactly
  one job (`_claim`, `.limit(1)`, compared with `=` to a scalar subquery), runs it, and goes on. A job is
  leased only from the moment it starts.
- **Alternatives rejected:**
  - Batch claim plus renewal (round 1's fix): round 2 showed it still loses jobs.
  - Renewing every waiting job after each one: only narrows the window.
  - `IN` over a `MATERIALIZED` CTE: correct too, but `=` states "exactly one" in the SQL itself.
- **Tradeoffs and accepted limitations:** one claim round trip per job. `batch` now caps the jobs per
  `run_once` call, not the rows one claim takes.
- **Basis:** review findings (round 1 High 1, round 2 High 2, diagnosis High 1).
- **Source:** recorded (PR D9, "Independent review").

### D4. Finishing updates apply only while this worker holds the lease; handlers time out at 50 s

- **Problem or constraint:** a handler slower than the 60 s lease would be reclaimed. Two workers would
  then run it, and the slower one's update would overwrite the other's.
- **Chosen:** `_finish` updates `WHERE id AND status='running' AND locked_by=:me AND attempts=:claimed`.
  If no row matches, it logs `job_lease_lost`, commits nothing, and the handler's writes roll back.
  `_process` runs the handler under `asyncio.timeout(HANDLER_TIMEOUT)`, which is 50 s, below `LEASE`.
- **Alternatives rejected:**
  - A background task renewing the lease while the handler runs: more moving parts, and a stuck handler
    would hold its job forever.
  - No guard: AC13 shows that is wrong.
- **Tradeoffs and accepted limitations:** a handler must finish in 50 s.
- **Basis:** autonomous. **Source:** recorded (PR D4).

### D8. What `last_error` holds

- **Problem or constraint:** AC4 requires at most 2,000 characters, redacted, no secrets.
- **Chosen:** `describe_error` stores `"<Type>: <message>"` with every value under the handler's
  `sensitive_keys` replaced with `[redacted]`.
  - The values come from all those keys together, searched recursively through dicts and lists, and are
    replaced in one regex pass, longest first.
  - Redaction happens before the cut to 2,000 characters.
  - Any SQLAlchemy or asyncpg error keeps only its types and SQLSTATE: `"… database error (…); message
    withheld"`.
  - The handler receives a deep copy of the payload.
  - The log line `job_failed` has the type only.
- **Alternatives rejected:**
  - Storing a traceback: longer, and frames can show locals.
  - Truncating before redacting: a cut secret would leak its prefix.
  - Redacting the cut-off prefixes of database parameters: we can't predict SQLAlchemy's cut points.
  - `hide_parameters=True` on the engine: it would change the API's logging, outside this ticket.
- **Tradeoffs and accepted limitations:**
  - A secret outside `sensitive_keys`, or in another form (URL-encoded, partial), is not caught.
  - A database `last_error` names no constraint, only the SQLSTATE.
  - A handler that re-raises a database error's message inside another exception type bypasses the
    database branch.
- **Basis:** ticket, then review findings (round 1 Highs 2–3, round 2 High 1, diagnosis Medium).
  **Source:** recorded (PR D8).

### D2. The worker's time is `clock.now()` bound into SQL, not the database's `now()`

- **Problem or constraint:** the tests freeze time, and inside a transaction `now()` is the time the
  transaction started.
- **Chosen:** `enqueue` defaults `run_at` to `clock.now()`. `_claim` compares against it and sets
  `locked_until = now + LEASE`. The backoff adds to it.
- **Alternatives rejected:** the database's `now()` as in ARCHITECTURE §9: a frozen clock would not reach
  the claim.
- **Tradeoffs and accepted limitations:** API, worker and database must agree on wall-clock time. They do
  on one host. Several worker hosts would need this revisited.
- **Basis:** existing convention `backend/app/core/clock.py::now`. **Source:** recorded (PR D2).

### D3. A handler runs in the job's own transaction (`ctx.db`) and never commits

- **Problem or constraint:** "each job in its own transaction". CLAUDE.md rule 5 forbids helpers that
  commit.
- **Chosen:** `backend/app/jobs/registry.py::JobContext` carries the job's session. The worker commits the
  handler's writes together with `succeeded`. On failure it rolls them back and records the retry in a
  fresh transaction.
- **Alternatives rejected:** no session in `ctx`: the handler's writes and the job's status could disagree.
- **Tradeoffs and accepted limitations:** an external side effect (SMTP) can't roll back. This is the
  at-least-once window ADR-0006 accepts.
- **Basis:** ticket, CLAUDE.md rule 5. **Source:** recorded (PR D3).

### D5–D7 and smaller decisions

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| A reclaimed job with `attempts > max_attempts` goes `dead` unrun (D5) | filter such jobs out of the claim | they would stay `running`, invisible, forever | autonomous | PR D5 |
| On SIGTERM: finish the current job; with one claim per job nothing else is held (D6); `stop_grace_period: 60s` | release a claimed batch (first version) | removed with D9 | review round 2 | PR D6 |
| Worker healthcheck = heartbeat file under 120 s old (D7) | `healthcheck: disable` / an HTTP endpoint | a hung loop would go unnoticed / a server in a worker | autonomous | PR D7 |
| `enqueue` returns the id, or `None` on a duplicate key | return nothing | callers can tell whether a job was added | autonomous | PR table |
| Unknown kind → `dead` | leave queued | retried forever, silently | autonomous | PR table |
| `worker_loop_error` logs the type, waits ≥ 5 s, continues | crash and let compose restart | the worker starts before `make migrate` on a fresh stack | autonomous | PR table |
| `HANDLER_MODULES` lists the modules to import | auto-discovery | explicit; P3-01b and P3-02 add one line each | autonomous | PR table |
| `worker_heartbeat` logged by a timer task | log between batches | review round 1 Medium: held back ~500 s by slow jobs | review | PR table |
| Dead jobs keep their sensitive keys | scrub on death too | `jobs-retry` (P3-01b) needs the payload | ticket | PR table |

**Framing changes:** P3-01 was split into P3-01a and P3-01b. Criteria 1–8 were sharpened (exact values,
backoff bounds and cap, the `None` return, real commits for concurrency, and others). New criteria 10–17
cover an unknown kind, the handler's writes, a reclaim after the last attempt, a lost lease, the handler
timeout, SIGTERM/SIGINT, the heartbeat and compose. Nothing was loosened (ticket Frame notes).

**Plan versus final code:**
- **The claim** is one row per pass, `id = (scalar subquery)` (D9). The plan had one batch claim with
  `IN (… LIMIT :batch …)`.
- **`release(ids)`** was planned, written, then removed by D9.
- **`redact_error`** is called `describe_error`.
- **Finishing updates** also check `attempts`.
- **The heartbeat file** is touched per job too.
- **The heartbeat log** runs on its own timer.
- **`backend/tests/test_world.py::EXPECTED_ROW_COUNTS`** gained `"jobs": 0`.

All are noted in the PR below the Plan.

## 3. How it is implemented

### Overview

- `jobs` table (`backend/app/jobs/models.py::Job`): one row per job, its status, lease and error.
- `backend/app/jobs/service.py::enqueue`: one `INSERT … ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`
  in the caller's transaction.
- `backend/app/jobs/registry.py::job_handler`: maps a kind to `HandlerSpec(handler, sensitive_keys)`.
- `backend/app/jobs/worker.py::Worker`: `run_once` (claim one, process, repeat up to `batch`),
  `run_forever` (loop and heartbeat timer), `_finish` (the guarded final update).
- `backend/app/worker.py::run`: the `python -m app.worker` entry point. `main` installs the signal handlers.
- Compose `worker` service: same image, heartbeat-file healthcheck, 60 s stop grace.

### Walkthrough (variant C: a job becomes due and is run)

1. **Trigger.** Business code calls `enqueue(db, "email.send", {...}, dedupe_key=...)` and commits (P3-02 will
   be the first). The row is `queued`, `attempts=0`, `run_at=clock.now()`. If the transaction rolls back, there
   is no row (`test_enqueue_rolled_back_leaves_no_job`).
2. **Loop.** `_loop` in the worker calls `run_once(10, stop)`. It touches the heartbeat file every pass and
   sleeps 1 s when nothing ran (5 s after a `worker_loop_error`).
3. **Claim** (`_claim`, its own committed transaction). The SQL, rendered from the code:
   ```sql
   UPDATE jobs SET status='running', attempts=attempts + 1, locked_by=:worker,
                   locked_until=:now + 60 s
   WHERE jobs.id = (SELECT jobs.id FROM jobs
                    WHERE status = 'queued' AND run_at <= :now
                       OR status = 'running' AND locked_until < :now
                    ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)
   RETURNING id, kind, payload, attempts, max_attempts
   ```
4. **Process** (`_process`):
   - `attempts > max_attempts` → `dead` with "the lease expired during the last attempt".
   - No handler → `dead` with "no handler registered for job kind '…'".
   - Otherwise the handler runs with a deep copy of the payload and `ctx.db`, under the 50 s timeout.
5. **Finish.**
   - Success: `_finish` sets `succeeded`, `finished_at`, the payload without its sensitive keys, and clears
     the lease, in the handler's transaction.
   - Failure: the session closes (rollback). `_fail` then writes, in a new transaction, either `queued`
     with `run_at = now + backoff(attempts, jitter)`, or `dead` (`PermanentJobError`, or `attempts >=
     max_attempts`), with `describe_error`'s text.
   - Both finishing paths go through `_finish`'s guard.
6. **End state:** `succeeded`, `queued` (later `run_at`) or `dead`. The heartbeat counts it, and
   `worker_heartbeat` logs the counts every 30 s.
7. **Where it fails and what you see:**
   - `job_failed` (with `error_type`) and `job_lease_lost` are WARNING logs.
   - `worker_loop_error` is an ERROR log (database down, table missing).
   - In SQL, `SELECT status, count(*) FROM jobs GROUP BY 1`.
8. **Recover:**
   - A crashed worker's job is reclaimed after 60 s.
   - A dead job can be re-queued by hand today (`UPDATE … SET status='queued', attempts=0`), and by
     `jobs-retry` once P3-01b ships.
   - A restart is safe at any point: delivery is at-least-once.

### Data model changes

`jobs` (migration `6155f8860fc1`):

| Column | Type | Note |
|---|---|---|
| `id` | uuid7 PK | |
| `kind` | varchar(64) | |
| `payload` | jsonb | |
| `status` | varchar | `ck_jobs_job_status` limits it to queued/running/succeeded/dead (a string enum, the repo's `database_enum`) |
| `run_at` | timestamptz | default `now()` |
| `attempts` | int | default 0; `ck_jobs_attempts_not_negative` |
| `max_attempts` | int | default 8; `ck_jobs_max_attempts_positive` (a 0 would dead-letter unrun) |
| `locked_by` | varchar(64) | |
| `locked_until` | timestamptz | |
| `last_error` | text | |
| `dedupe_key` | varchar(200) | `uq_jobs_dedupe_key`; NULLs never collide |
| `created_at` | timestamptz | |
| `finished_at` | timestamptz | |

`ix_jobs_run_at_due` is a partial index on `run_at WHERE status IN ('queued','running')`, the claim's scan.
Autogenerate rendered the status check twice. The duplicate was removed by hand, as in migration
`2b2e5bcaf6b4`.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/jobs/worker.py` | the worker | +310/−0 |
| `backend/app/jobs/models.py` | `Job`, `JobStatus` | +50/−0 |
| `backend/app/jobs/registry.py` | `job_handler`, `JobContext`, `PermanentJobError` | +50/−0 |
| `backend/app/jobs/service.py` | `enqueue` | +43/−0 |
| `backend/app/worker.py` | entry point | +15/−0 |
| `backend/app/logging_config.py` | job log fields | +8/−0 |
| `backend/app/models/registry.py`, `backend/app/cli.py` | register the model; placeholder names P3-01b | +2/−1 |
| `backend/migrations/versions/6155f8860fc1_jobs_queue_p3_01a.py` | `jobs` table | +86/−0 |
| `docker-compose.yml`, `compose.prodlike.yml`, `scripts/prodlike-checks.sh` | `worker` service and its wiring check | +67/−2 |
| `backend/tests/jobs/*` | 47 tests, test handlers, the subprocess runner | +1008/−0 |
| `backend/tests/test_architecture.py`, `test_db_isolation.py`, `test_world.py`, `test_cli_seed.py` | carries and the new table | +13/−5 |
| `docs/tickets/*` | framing and split | +271/−18 |

**Key excerpts**

`backend/app/jobs/worker.py::run_once` and `_claim` (trimmed):

```python
    async def run_once(self, batch: int = 10, stop: asyncio.Event | None = None) -> int:
        ran = 0
        while ran < batch and not (stop is not None and stop.is_set()):
            job = await self._claim()
            if job is None:
                break
            # Per job too: a run of slow jobs is not a hung worker.
            HEARTBEAT_FILE.touch()
            await self._process(job)
            ran += 1
        return ran
    # ...
    async def _claim(self) -> ClaimedJob | None:
        now = clock.now()
        due = (
            select(Job.id)
            .where(
                or_(
                    and_(Job.status == JobStatus.QUEUED, Job.run_at <= now),
                    and_(Job.status == JobStatus.RUNNING, Job.locked_until < now),
                )
            )
            .order_by(Job.run_at)
            .limit(1)
            .with_for_update(skip_locked=True)
        )
        claim = (
            update(Job)
            # `=` a scalar subquery, not `IN`: Postgres may run `IN (… LIMIT 1 …)` as a semi-join
            # that re-runs the subquery per row and leases several jobs (flaky-test diagnosis).
            .where(Job.id == due.scalar_subquery())
            .values(
                status=JobStatus.RUNNING,
                attempts=Job.attempts + 1,
                locked_by=self.worker_id,
                locked_until=now + LEASE,
            )
            # ...
        )
        async with self._sessions() as db:
            row = (await db.execute(claim)).one_or_none()
            await db.commit()
        return None if row is None else ClaimedJob(*row)
```

- What it does: leases the oldest due job (or one whose lease expired) to this worker, and runs it before
  claiming the next. The claim commits before the handler starts, so other workers see the lease at once.
- Why this way: D9 and D2.
- What breaks without it:
  - Without `skip_locked=True`, the second worker waits for the first (mutation M1b′ fails
    `test_a_claim_does_not_wait_for_another_workers_open_claim`).
  - Without `with_for_update`, two workers claim the same rows (M1′: 25 claims for 20 jobs).
  - With `IN` instead of `=`, one claim can lease several jobs (M13).

`backend/app/jobs/worker.py::_finish`:

```python
    async def _finish(self, db: AsyncSession, job: ClaimedJob, **values: Any) -> bool:
        """Apply `values` and clear the lease, only while this worker still holds it."""
        result = await db.execute(
            update(Job)
            .where(
                Job.id == job.id,
                Job.status == JobStatus.RUNNING,
                Job.locked_by == self.worker_id,
                Job.attempts == job.attempts,
            )
            .values(locked_by=None, locked_until=None, **values)
            .returning(Job.id)
            .execution_options(synchronize_session=False)
        )
        if result.first() is None:
            # Another worker reclaimed it (our lease ran out): its outcome wins.
            logger.warning("job_lease_lost", extra={"job_id": str(job.id), "job_kind": job.kind})
            return False
        return True
```

- What it does: the only way a job leaves `running`, both for success (`_process`) and failure (`_fail`).
- Why this way: D4. A worker that lost its lease must not overwrite the new owner's state.
- What breaks without the guard: `test_finish_after_lost_lease_changes_nothing[False|True]` (mutation M2).

`backend/app/jobs/worker.py::describe_error` (trimmed):

```python
    if isinstance(exc, SQLAlchemyError) or type(exc).__module__.startswith("asyncpg"):
        orig = getattr(exc, "orig", None) or exc
        code = getattr(orig, "sqlstate", None) or getattr(orig, "pgcode", None)
        detail = type(orig).__name__ + (f", SQLSTATE {code}" if code else "")
        return f"{type(exc).__name__}: database error ({detail}); message withheld"
    text = f"{type(exc).__name__}: {exc}" if str(exc) else type(exc).__name__
    secrets_ = {s for key in sensitive_keys for s in _strings(payload.get(key))}
    if secrets_:
        # One pass, longest first: replacing a shorter value (a URL prefix) first would break a
        # longer one that contains it and leave its token behind.
        pattern = "|".join(re.escape(s) for s in sorted(secrets_, key=len, reverse=True))
        text = re.sub(pattern, "[redacted]", text)
    return text[:MAX_ERROR_LENGTH]
```

- Why this way: D8. Each branch answers a confirmed finding.
- What breaks without it:
  - The database branch: `test_database_error_keeps_no_parameters_in_last_error`, M12.
  - Longest first: `test_overlapping_sensitive_values_are_all_redacted`, M14.
  - Redaction itself: M7.

`backend/tests/jobs/test_worker.py::test_one_claim_leases_exactly_one_job_whatever_the_statistics`, the
test behind the intermittent failure:

```python
    async with sessions() as db:
        await enqueue(db, "test.old", {})
        await db.execute(text("ANALYZE jobs"))
        await db.rollback()
    assert await db_connection.scalar(text("SELECT count(*) FROM jobs")) == 0
    async with sessions() as db:
        for n in range(3):
            await enqueue(db, "test.echo", {"n": n}, max_attempts=1)
        await db.commit()

    claimed = await worker(sessions)._claim()

    assert claimed is not None
    async with sessions() as db:
        statuses = sorted(job.status for job in (await db.scalars(select(Job))).all())
    assert statuses == sorted([JobStatus.RUNNING, JobStatus.QUEUED, JobStatus.QUEUED])
```

- What it proves: `ANALYZE` records statistics for a row that is then rolled back. With those stale
  statistics, one claim leases exactly one of three due jobs. With `IN`, it leased all three (failed
  before the fix; M13).

<details><summary>Deeper: the concurrency test (AC5)</summary>

`backend/tests/jobs/test_worker.py::test_two_workers_run_each_of_20_jobs_exactly_once` gives both workers
sessions whose `commit` waits 50 ms first. Each worker's claim therefore holds its row lock while the other
claims. The test asserts the two transactions overlapped (`overlap["max"] == 2`), that both workers claimed
jobs, that each of the 20 handlers ran once, and that every job is `succeeded` with `attempts == 1`. The
first version of this test passed even without `FOR UPDATE SKIP LOCKED`: the claims hardly overlapped in
time, so it was vacuous. The forced overlap was added after that mutation probe (PR, M1).

</details>

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| The business transaction rolls back | no job | `backend/tests/jobs/test_queue.py::test_enqueue_rolled_back_leaves_no_job` |
| Same dedupe key twice | one row; second call returns `None` | `backend/tests/jobs/test_queue.py::test_same_dedupe_key_keeps_one_row` |
| Handler fails twice, then succeeds | `queued` with growing jittered backoff, then `succeeded`, `attempts=3` | `test_flaky_job_succeeds_on_third_attempt_with_growing_backoff`, `test_backoff_is_jittered_and_capped` |
| Retry claimed early | not before its `run_at` | `test_retry_is_not_claimed_before_its_run_at` |
| Always fails | `dead` after `max_attempts`, secret redacted, ≤ 2,000 chars | `test_always_failing_job_is_dead_after_max_attempts_without_secrets`, `test_last_error_is_truncated` |
| Two workers at once | each job once; neither waits | `test_two_workers_run_each_of_20_jobs_exactly_once`, `test_a_claim_does_not_wait_for_another_workers_open_claim` |
| Stale statistics | one claim, one job | `test_one_claim_leases_exactly_one_job_whatever_the_statistics` |
| Worker crashed mid-job | reclaimed after the lease; dead unrun if it was the last attempt | `test_expired_lease_is_reclaimed`, `test_reclaimed_job_past_max_attempts_is_dead_unrun` |
| Lease lost while running | final update changes nothing, handler writes roll back | `test_finish_after_lost_lease_changes_nothing[False|True]` |
| Slow handler | cancelled at the timeout, retried | `test_handler_past_timeout_is_cancelled_and_retried` |
| Jobs waiting while one runs | stay `queued`, free for others, never charged | `test_while_a_job_runs_the_other_due_jobs_stay_queued`, `test_waiting_job_is_not_dead_lettered_without_ever_running` |
| Database error carrying a secret | message withheld | `test_database_error_keeps_no_parameters_in_last_error[65|64]`, `test_pending_rollback_error_keeps_no_parameters_in_last_error`, `test_every_database_error_has_its_message_withheld` |
| Handler mutates nested payload | redaction and scrub use the original | `test_nested_handler_mutation_does_not_remove_redaction_source[dict|list]` |
| SIGTERM / SIGINT mid-job | job finishes, others stay `queued` with 0 attempts, exit 0 | `test_sigterm_finishes_current_job_releases_the_rest_and_exits_0[SIGTERM|SIGINT]` (a real subprocess; the name predates D9, nothing is "released" now) |
| Heartbeat during a long run | logged on its timer | `test_heartbeat_is_logged_while_a_batch_runs` |

**Acceptance criteria → tests:**
- AC1: `test_enqueue_*` (3 tests), plus fitness test 4 listing `enqueue`.
- AC2: `test_echo_job_succeeds_and_runs_once`.
- AC3: the flaky, backoff and not-early tests.
- AC4: always-failing, truncated and permanent tests.
- AC5: the two concurrency tests.
- AC6: the expired and unexpired lease tests.
- AC7: the two dedupe tests.
- AC8: `test_sensitive_keys_removed_on_success`, `test_payload_kept_on_retry`.
- AC10: `test_unknown_kind_is_dead_and_batch_continues`.
- AC11: `test_handler_writes_commit_with_success`, `test_handler_writes_roll_back_on_failure`.
- AC12: `test_reclaimed_job_past_max_attempts_is_dead_unrun`.
- AC13: `test_finish_after_lost_lease_changes_nothing`.
- AC14: `test_handler_past_timeout_is_cancelled_and_retried`.
- AC15: `test_sigterm_…[SIGTERM|SIGINT]`.
- AC16: the three heartbeat tests.
- AC17: `test_heartbeat_file_is_touched_per_loop_and_per_job`, plus the PR's stack transcripts (both stacks
  healthy, `prodlike-checks` "worker publishes no port and mounts no source", SIGTERM → `exit=0`).

## 6. Review log

Reviewer for this run, per James's instruction: Codex only. There was no Claude reviewer, which differs
from the playbook's Tier 1 pair.

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol, high | `2d1da45` | BLOCK | High: batch jobs outlive the lease and run twice. High: database error stores a cut token. High: nested mutation hides a secret. Medium: heartbeat delayed by a busy batch | all fixed in `c0b9c96` (renewal later replaced by D9), SIGINT test in `668c6d7` |
| 2 | Codex gpt-6.1-sol, high | `668c6d7` | BLOCK | High: `PendingRollbackError` leaks parameters. High: waiting job dead-lettered unrun | fixed in `84aedb3` (all database errors withheld; one claim per job) |
| Diagnosis | Codex gpt-6-astra, medium | `84aedb3` | BLOCK | High: `IN (… LIMIT 1 …)` semi-join leases several jobs (the flaky-test cause). Medium: overlapping secrets redacted shortest first | fixed in `2e46dd7` |
| 3 | not run | — | — | — | skipped on James's instruction once the cause was fixed and nothing was open |

The failure behind each fix, and its evidence:
- **Round 1, High 1.** Three jobs, the first two 40 s each. Worker B reclaimed the third while A started
  it: `Counter({3: 2, …})`. `test_waiting_batch_job_is_not_run_by_two_live_workers` failed, now passes.
- **Round 1, High 2.** A 600-character link through a failing insert put `usable-private-reset-token`
  into `last_error`. `test_database_error_keeps_no_parameters_in_last_error`.
- **Round 1, High 3.** `last_error == "RuntimeError: failed sending nested-private-token"`.
  `test_nested_handler_mutation_does_not_remove_redaction_source`.
- **Round 1, Medium.** 10 × 49 s jobs gave no heartbeat for about 490 s.
  `test_heartbeat_is_logged_while_a_batch_runs`.
- **Round 2, High 1.** A swallowed flush made the worker's own update raise `PendingRollbackError`
  quoting the cut parameters. `test_pending_rollback_error_keeps_no_parameters_in_last_error`.
- **Round 2, High 2.** `max_attempts=1`, third job `dead` with `attempts=2` and never run.
  `test_waiting_job_is_not_dead_lettered_without_ever_running`.
- **Diagnosis, High.** About 1 in 10 suite runs failed. Codex's instrumented runs showed the claim plan
  updating 2 rows during a failing heartbeat test. After the fix: 40 of 40 runs green.
- **Diagnosis, Medium.** `[redacted]usable-private-reset-token`.
  `test_overlapping_sensitive_values_are_all_redacted`.

Every fix test failed before its fix and passes now. The PR lists the mutation probes M1–M15.

## 7. Not verified, accepted risks and follow-ups

- **No reviewer saw `2e46dd7`.** That is the fix of the diagnosis session's two findings. Round 3 was
  skipped on James's instruction. Its evidence is the failing-then-passing tests, mutations M13/M14 and
  the 40-run stress loop.
- **The playbook's Tier 1 pair was not used.** All reviews were by Codex models, at James's instruction.
- **Multiple worker hosts:** not tested. The design assumes one clock (D2).
- **Real email:** not exercised. There are no app handlers yet (`HANDLER_MODULES = ()`); P3-02 adds the
  first.
- **Healthcheck meaning:** "healthy" means the loop is alive, not that the database is reachable (D7).
  Alerting on `worker_loop_error` and `job_failed` is D-05's job. Tracked only here and in the PR.
- **Dead jobs keep their sensitive payload keys indefinitely.** Their retention, or scrubbing them on
  death, is to be decided in P3-01b (added to that ticket in the bookkeeping commit).
- **Redaction limits** (D8): secrets outside `sensitive_keys`, encoded forms, re-raised database messages.
- **At-least-once:** a crash between the handler and the commit reruns the job (ADR-0006).
- **Size:** 631 non-test lines against the ~400 guideline, recorded in the PR's "Size".
- **Migration downgrade:** no test runs it for this table.
- **Follow-up:** P3-01b (todo, in the index).

## 8. How to change this safely

- **Adding a handler:** decorate an `async def (payload, ctx)` with `@job_handler("<domain>.<verb>",
  sensitive_keys=(...))` in the domain's module, add that module to `HANDLER_MODULES`, and never commit in
  it. Raise `PermanentJobError` for failures retrying can't fix. Keep it under 50 s.
- **Changing the claim:** keep `=` with `LIMIT 1` and `FOR UPDATE SKIP LOCKED`.
  `test_one_claim_leases_exactly_one_job_whatever_the_statistics` and the two concurrency tests will
  catch a regression.
- **Changing what `last_error` holds:** the redaction tests above and
  `test_every_database_error_has_its_message_withheld` guard it.
- **Changing `LEASE` or `HANDLER_TIMEOUT`:** keep the timeout below the lease
  (`test_handler_timeout_is_below_the_lease`), and keep the healthcheck's 120 s above the timeout.

## 9. Must explain, then quiz

**1. Two workers run the claim query at the same instant. Why does each get different rows?**
Each `_claim` runs `UPDATE … WHERE id = (SELECT id … ORDER BY run_at LIMIT 1 FOR UPDATE SKIP LOCKED)`.
- Worker A's subquery locks the oldest due row.
- Worker B's subquery reaches that row and finds it locked. `SKIP LOCKED` makes it skip the row instead
  of waiting, and B locks the next one.
- Each `UPDATE` then sets its own row to `running` and commits.
- Without `SKIP LOCKED`, B would wait for A's commit (M1b′). Without `FOR UPDATE`, both could update the
  same row (M1′).
- The scalar `=` makes sure one statement leases one row (D9).

**2. What happens if the worker crashes after the handler ran but before the status update? Why is that
acceptable?**
- The handler's database writes roll back with its uncommitted transaction (`_process`). The job stays
  `running` with its lease.
- After 60 s, `_claim`'s `locked_until < :now` branch lets any worker reclaim it, and the handler runs
  again. Its external effects (an email) happen twice.
- ADR-0006 accepts this: delivery is at-least-once, handlers are idempotent where possible, and the
  promise is "no lost email", not "exactly once".
- If that was the last attempt, the reclaim marks it `dead` without running it again (D5,
  `test_reclaimed_job_past_max_attempts_is_dead_unrun`).

**3. Why jitter in the backoff?**
Jobs that failed together (an SMTP outage fails every queued email) would otherwise get identical `run_at`
values and retry as one burst, which can knock the recovering service over again. A factor of 0.8–1.2
(`_jitter`) spreads them out. `test_backoff_is_jittered_and_capped` and the flaky test check the bounds.

**4. Why does each job run in its own transaction rather than one per batch?**
- With one transaction per batch, one failing job would roll back the others' successes and their
  handlers' writes, and they would run again.
- The batch would also hold row locks for the whole batch.
- Per job (D3), a success commits at once with its own writes, and a failure rolls back only its own.
- Since D9, the claim is per job too, so nothing waits leased behind another job.

**Quiz**

1. A handler takes 55 s. What happens, and in which function?
2. Why does `_finish` check `attempts` as well as `locked_by`?
3. What would break if `_claim` went back to `Job.id.in_(due)` with `.limit(1)`?
4. What would break if we removed `copy.deepcopy` in `_process`?
5. How would you add a job that must run at most once per user per day?

<details><summary>Answers</summary>

1. `asyncio.timeout(self._handler_timeout)` in `_process` cancels it at 50 s. That `TimeoutError` is a
   retryable failure, so `_fail` re-queues the job with backoff, or marks it `dead` on the last attempt.
   The lease (60 s) has not expired by then, so no other worker started it.
2. What it does: a finish written for one attempt cannot change the row once the job has been claimed
   again, even if the `locked_by` value were the same. Why it was added: rationale not recorded. The PR
   lists it only as "stricter than the plan". No test isolates the `attempts` check from the `locked_by`
   check.
3. Under some plans (stale statistics), one claim could lease several jobs while the worker runs only the
   first. The rest sit `running` until their lease expires, attempts are charged, and with
   `max_attempts=1` they can die unrun. `test_one_claim_leases_exactly_one_job_whatever_the_statistics`
   fails (M13).
4. A handler that pops a nested secret, such as `payload["credentials"]["token"]`, would also remove it
   from `job.payload`. `describe_error` would then not find it and would store it verbatim, and the success
   scrub would work on a changed payload. `test_nested_handler_mutation_does_not_remove_redaction_source`
   fails (M11).
5. Enqueue it with `dedupe_key=f"<kind>:{user_id}:{yyyy-mm-dd}"`. `ON CONFLICT (dedupe_key) DO NOTHING`
   keeps one row per key and returns `None` for the duplicates. The key stays taken while the row exists,
   so the cleanup in P3-01b decides how long "once" lasts.

</details>
