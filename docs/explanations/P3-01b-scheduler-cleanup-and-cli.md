# Explanation — P3-01b Scheduler, cleanup jobs and jobs CLI

> **PR:** #71 · **Source revision:** `bc90d08`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2, Codex gpt-6.1-sol high) reviewed `82635b5`, which
> the rebase onto `aa90046` (#70) turned into `bc90d08` with no conflict in the ticket's files.
> **Merge commit:** not known when written; after the merge, `gh pr view 71 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `bc90d08`: `git diff origin/main...HEAD` (all app files in full: `backend/app/jobs/worker.py`
> diff and `run_forever`/`schedule`/`_scheduler`/`_schedule_logged`, `backend/app/jobs/service.py`, `backend/app/jobs/report.py`,
> `backend/app/jobs/handlers.py`, `backend/app/auth/jobs.py`, `backend/app/rate_limits/jobs.py`, `backend/app/auth/service.py::delete_ended_sessions`,
> `cli.py`), the assertions of the cited tests in `backend/tests/jobs/`, the carried test changes, the PR #71
> description and both review files. Ran `uv run pytest -q tests/jobs tests/test_world.py
> tests/test_architecture.py tests/test_cli_seed.py`: 195 passed; `make check DB_PORT=55432`: exit 0 (1023
> backend tests passed). Differences from the plan: yes, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: C (a day's recurring jobs, from the scheduler to the cleanup).

## 1. What was built and why

P3-01a gave the app a job queue and a worker, but nothing ran on a schedule and operators had only SQL. Now:

- **The worker schedules three daily jobs.** At start and every 60 s, `Worker.run_forever` enqueues
  `jobs.cleanup`, `rate_limits.cleanup` and `sessions.cleanup`. Each gets the key `"<kind>:<yyyy-mm-dd>"`
  (the UTC date). The key is unique in the table, so a restart, a second worker or the next tick adds
  nothing until the date changes.
- **The cleanups keep three tables bounded.** Successes older than 14 days are deleted. Dead jobs lose their
  secret payload keys after 7 days but stay as a record. Rate-limit windows older than a day are deleted.
  Sessions that ended more than 30 days ago are deleted.
- **Operators get two commands.** `jobs-status` prints counts, the oldest due job's age and the last 10
  dead jobs, never a payload. `jobs-retry <id>` puts a recently dead job back in the queue as if new.

ADR-0006 names both the scheduled cleanup and these two commands. This is the second half of P3-01; the
queue and worker were [P3-01a](./P3-01a-job-queue-and-worker.md).

## 2. Decisions

All recorded in PR #71's "Decisions and alternatives" (D1–D4 and the table), plus the ticket's Frame notes.

### D2. Dead jobs: secrets scrubbed 7 days after death; `jobs-retry` allowed only within those 7 days

- **Problem or constraint:** P3-01a removes sensitive keys only when a job succeeds. A dead email job would
  keep its reset or invitation link forever. But scrubbing at death would make `jobs-retry` useless for
  email, its main use: re-sending after an SMTP outage outlasted the 8 attempts.
- **Chosen:** `jobs.cleanup` removes each registered handler's `sensitive_keys` from `dead` jobs that
  finished more than 7 days ago (`DEAD_RETENTION`). The row, its other keys and `last_error` stay.
  `jobs-retry` refuses any dead job older than that, scrubbed yet or not, so the two never disagree.
- **Alternatives rejected:**
  - Scrub at death: no retry for email.
  - Delete dead jobs after N days: loses the failure record `jobs-status` shows, and AC19 says the cleanup
    deletes only `succeeded` rows.
  - A `scrubbed_at` column: a migration in the hot `migrations/versions/` folder (P3-04a was working there)
    for something the age already tells.
- **Tradeoffs and accepted limitations:** a dead job whose kind has no registered handler is never
  scrubbed, because its keys are unknown. Dead rows are kept forever.
- **Basis:** autonomous. 7 days is the longest token lifetime the plan has (invitations, P4-02; password
  reset is 1 hour, P4-04), so a later retry would send a dead link anyway. **Source:** recorded (PR D2,
  Frame notes).

### D1. Sessions are deleted 30 days after they end; no per-user cap yet

- **Problem or constraint:** P2-01b never deleted ended sessions (PR #57 round 2 L3). A row holds the
  user's IP and user agent, and audit events point at sessions by id.
- **Chosen:** delete rows whose `revoked_at`, `expires_at` or `idle_expires_at` is more than 30 days in the
  past (`SESSION_RETENTION`). A cap on live sessions per user is deferred.
- **Alternatives rejected:**
  - Delete as soon as a session ends: an investigation that starts from an audit event loses the IP and
    user agent.
  - 90 days or more: keeps that personal data longer with no stated need.
  - A cap now: it changes login behaviour (lane A, auth), outside this ticket.
- **Tradeoffs and accepted limitations:** an incident found more than 30 days later has no IP or user
  agent for the session. A user can still have any number of live sessions.
- **Basis:** autonomous. 30 matches `SESSION_ABSOLUTE_DAYS` and the 30-day log retention in staging
  (ARCHITECTURE §16). **Source:** recorded (PR D1).

### D4. The scheduler is a `Worker` parameter that defaults to the three kinds

- **Problem or constraint:** the ticket puts the scheduler in `run_forever`. P3-01a's `run_forever` tests
  count every job the loop runs, and its SIGTERM test runs the real worker in a subprocess.
- **Chosen:** `Worker(recurring=RECURRING_KINDS)`. Production (`main`) gets the default and can't forget it.
  P3-01a's test helper `backend/tests/jobs/test_worker.py::worker` passes `recurring=()`. The committed-session
  fixture now deletes every job afterwards, including the recurring jobs the subprocess worker leaves.
- **Alternatives rejected:** off by default with `main` turning it on (a worker built elsewhere would
  schedule nothing); a module-level flag (global state across tests).
- **Tradeoffs and accepted limitations:** none known.
- **Basis:** autonomous. **Source:** recorded (PR D4).

### Review round 1: `jobs-retry` locks the row before reading the clock

- **Problem or constraint:** the first version computed its cutoff, then ran one conditional `UPDATE`. A
  retry delayed between the two could cross the 7-day boundary while the scrub emptied the payload, and
  then re-queue a job with no link (Codex round 1, Medium).
- **Chosen:** `backend/app/jobs/service.py::retry_dead_job` runs `SELECT status, finished_at … FOR UPDATE`,
  then reads `clock.now()`, then checks, then updates by id.
- **Alternatives rejected:** none recorded beyond Codex's suggested fix, which this is.
- **Tradeoffs and accepted limitations:** correctness relies on one clock for the CLI and the worker (one
  host, as P3-01a D2).
- **Basis:** review finding. **Source:** recorded (PR "Independent review").

### Smaller decisions

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| No index on `finished_at`, so no migration (D3) | a partial index for succeeded rows | a daily scan of a few thousand rows is cheap; the index costs a write per finish and a hot-file migration | autonomous | PR D3 |
| PRODUCT_SCOPE's "Nothing is deleted automatically in the demo" read as domain-record retention | treat it as covering every table (a stop rule) | ADR-0006 and the ticket name these cleanups | ticket, ADR-0006 | PR table, Frame notes |
| `jobs-retry` keeps `last_error` and `max_attempts` | clear `last_error` | the reason it died stays until the next failure overwrites it | autonomous | PR table |
| `jobs-retry` writes no audit event | `record_audit` | `audit_events` is the users' history; the CLI prints the id | autonomous | PR table |
| "Oldest due" uses the claim's predicate | queued only | a job held by a dead worker is due too | autonomous | PR table |
| Recurring jobs run at the first tick after 00:00 UTC | a fixed hour | ARCHITECTURE §9 asks only for a daily key | autonomous | PR table |
| One `jobs.cleanup` job does both the delete and the scrub | two kinds | one daily job about the `jobs` table | autonomous | PR table |

**Framing changes:** criteria 9 and 18–26 replace the ticket's two bullets. AC9 got two `Worker` instances, a
day boundary and concurrent schedulers. New cases were added: control characters in `last_error`, a retry
after the window, a second retry. Nothing was loosened (ticket Frame notes).

**Plan versus final code** (all noted in the PR below the Plan):
- `retry_dead_job`: lock, check, update instead of one conditional update (review round 1).
- `scrub_dead_jobs` takes a `{kind: keys}` mapping, not the registry.
- The text output is in `backend/app/jobs/report.py::render_status`, as `backend/app/audit/report.py` does for
  `audit`.
- Two scheduler tests use real connections, because the timer and the loop run at once.
- The "do first" change to `.claude/commands/build-ticket.md` was dropped in the rebase: #70 had merged the
  same rule first.

## 3. How it is implemented

### Overview

- `backend/app/jobs/worker.py`: `RECURRING_KINDS`, `SCHEDULE_INTERVAL`, `HANDLER_MODULES` (now three
  modules), and `Worker.schedule` / `_scheduler` / `_schedule_logged`, called from `run_forever`.
- `backend/app/jobs/service.py`: `delete_old_succeeded_jobs`, `scrub_dead_jobs`, `job_status`,
  `retry_dead_job`, `JobNotRetryable`. None of them commits.
- Handlers: `backend/app/jobs/handlers.py::cleanup_jobs`, `backend/app/rate_limits/jobs.py::cleanup_rate_limits`,
  `backend/app/auth/jobs.py::cleanup_sessions`. Each calls a helper on `ctx.db` and logs a count.
- `backend/app/auth/service.py::delete_ended_sessions`.
- `backend/app/jobs/report.py::render_status`, and the commands `jobs_status_command` and
  `jobs_retry_command` in `backend/app/cli.py`.

### Walkthrough (variant C: a day's recurring jobs)

1. **Start.** `python -m app.worker` → `app.jobs.worker.main` imports `HANDLER_MODULES`, which registers the
   three handlers, then calls `run_forever`.
2. **First schedule.** `run_forever` awaits `_schedule_logged` before it starts the job loop.
   `schedule` opens one session and calls `enqueue(db, kind, {}, dedupe_key=f"{kind}:{today}")` for each
   kind, where `today` is `clock.now().astimezone(UTC).date()`. Then it commits. `enqueue` is
   `INSERT … ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, so a key that exists returns `None` and adds
   nothing. On the stack, the first start created the three rows with keys `…:2026-10-18`.
3. **Every 60 s.** The `_scheduler` task waits `schedule_interval` (or the stop event) and calls
   `_schedule_logged` again. The same day it adds nothing. The first tick after 00:00 UTC adds the new
   day's three jobs. If `schedule` raises (the database is down), `scheduler_error` is logged at ERROR with
   `error_type` only, and the next tick tries again. The job loop is not affected.
4. **Claim and run.** The jobs are due at once (`run_at = now`) and the normal P3-01a loop claims them. Each
   handler runs in the job's transaction:
   - `jobs.cleanup`: `DELETE FROM jobs WHERE status='succeeded' AND finished_at < now − 14 d`, then, for each
     registered kind with sensitive keys, `UPDATE jobs SET payload = payload - :keys WHERE kind=:kind AND
     status='dead' AND finished_at < now − 7 d AND payload ?| :keys`.
   - `rate_limits.cleanup`: P2-05's `delete_expired_rate_limits` (windows that started more than a day ago).
   - `sessions.cleanup`: `DELETE FROM sessions WHERE revoked_at < cutoff OR expires_at < cutoff OR
     idle_expires_at < cutoff`, with `cutoff = now − 30 d`.
   The worker commits the deletes together with `succeeded`. If the handler fails, they roll back and the job
   is retried (`test_a_failing_cleanup_rolls_its_deletions_back`).
5. **End state:** three `succeeded` rows for the day, and log lines `jobs_cleaned {deleted, scrubbed}`,
   `rate_limits_cleaned {deleted}`, `sessions_cleaned {deleted}`. Fourteen days later `jobs.cleanup` deletes
   that day's rows, which frees their keys. The date is past by then, so nothing re-enqueues them.
6. **Where it fails and what you see:** `scheduler_error` (ERROR), or a cleanup job that is `queued` with a
   later `run_at` or `dead`. `jobs-status` shows both.
7. **Recover:** a dead cleanup job keeps its day's key, so that day gets no other one. The next day gets a
   new one, or the operator runs `jobs-retry <id>` within 7 days.

**The operator side.** `jobs-status` runs `job_status` in one read-only `run_in_session`: a `GROUP BY
status` merged into a dict of all four statuses with zeros, `min(run_at)` over the claim's due predicate, and
the 10 dead jobs with the latest `finished_at` (id, kind, attempts, max, finished_at, last_error; no payload
column is selected). `render_status` replaces non-printable characters with `?` and cuts `last_error` to 200
characters. `jobs-retry` parses the UUID before any session (a bad one exits 1). Then `retry_dead_job` locks
and checks the row and updates it; a refusal raises `JobNotRetryable` inside `work`, so `run_in_session`
commits nothing and the command exits 1.

### Data model changes

None. No migration (D3). The cleanups use existing columns: `jobs.status`, `finished_at`, `payload` (JSONB
`?|` and `-` operators), and the three `sessions` deadlines.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/jobs/service.py` | cleanup, status and retry helpers | +150/−3 |
| `backend/app/jobs/worker.py` | scheduler, recurring kinds, handler modules | +56/−8 |
| `backend/app/cli.py` | `jobs-status`, `jobs-retry`; placeholder removed | +36/−1 |
| `backend/app/jobs/report.py` | `render_status` | +33/−0 |
| `backend/app/auth/service.py` | `delete_ended_sessions`, `SESSION_RETENTION` | +25/−1 |
| `backend/app/jobs/handlers.py`, `backend/app/rate_limits/jobs.py`, `backend/app/auth/jobs.py` | the three handlers | +49/−0 |
| `backend/app/logging_config.py`, `backend/app/rate_limits/service.py` | log fields; TODO removed | +4/−2 |
| `backend/tests/jobs/test_scheduler.py`, `test_cleanup.py`, `test_cli_jobs.py` | 9 + 8 + 30 tests (with parameters) | +1049/−0 |
| `backend/tests/jobs/conftest.py`, `test_worker.py`, `backend/tests/test_architecture.py`, `backend/tests/test_cli_seed.py` | carried changes (§7, PR "Gate changes") | +23/−6 |
| `docs/tickets/P3-01b-scheduler-cleanup-and-cli.md` | framing | +69/−10 |

**Key excerpts**

`backend/app/jobs/worker.py::schedule` and `_schedule_logged`:

```python
    async def schedule(self) -> list[str]:
        today = clock.now().astimezone(UTC).date().isoformat()
        added: list[str] = []
        async with self._sessions() as db:
            for kind in self._recurring:
                if await enqueue(db, kind, {}, dedupe_key=f"{kind}:{today}") is not None:
                    added.append(kind)
            await db.commit()
        return added
    # ...
    async def _schedule_logged(self) -> None:
        if not self._recurring:
            return
        try:
            await self.schedule()
        except Exception as exc:
            # As `worker_loop_error`: type only, and the next tick tries again.
            logger.error("scheduler_error", extra={"error_type": type(exc).__name__})
```

- What it does: one transaction adds today's missing recurring jobs. An error is logged and swallowed.
- Why this way: the unique key does the deduplication, so no lock or "last run" table is needed (ticket,
  ARCHITECTURE §9).
- What breaks without it: a key with the full timestamp (M1) or no key (M7) fails
  `test_scheduling_twice_on_one_day_keeps_one_job_per_kind_and_the_next_day_adds_one`. The local date (M2)
  fails `test_the_dedupe_key_uses_the_utc_date`. Catching too little (M5) or logging the message (M6) fails
  `test_a_scheduler_error_is_logged_by_type_and_the_worker_goes_on`.

`backend/app/jobs/service.py::scrub_dead_jobs` (trimmed):

```python
    cutoff = clock.now() - DEAD_RETENTION
    scrubbed = 0
    for kind, keys in sensitive_keys.items():
        if not keys:
            continue
        key_array = cast(postgresql.array(list(keys)), postgresql.ARRAY(Text))
        result = await db.execute(
            update(Job)
            .where(
                Job.kind == kind,
                Job.status == JobStatus.DEAD,
                Job.finished_at < cutoff,
                Job.payload.has_any(key_array),
            )
            .values(payload=Job.payload.op("-")(key_array))
            .execution_options(synchronize_session=False)
        )
        scrubbed += result.rowcount  # type: ignore[attr-defined]
    return scrubbed
```

- What it does: `payload - ARRAY[...]` removes those top-level keys in SQL. `?|` limits it to rows that
  still have one, so a second pass changes nothing.
- Why per kind: each handler declares its own keys (P3-01a `HandlerSpec.sensitive_keys`).
- What breaks without each condition: the status (M10), the `<` boundary (M11) and the kind (M12) each fail
  `test_jobs_cleanup_scrubs_secrets_of_jobs_dead_more_than_7_days`.

`backend/app/jobs/service.py::retry_dead_job` (trimmed):

```python
    row = (
        await db.execute(
            select(Job.status, Job.finished_at).where(Job.id == job_id).with_for_update()
        )
    ).one_or_none()
    if row is None:
        raise JobNotRetryable(f"no job {job_id}")
    status, finished_at = row
    if status is not JobStatus.DEAD:
        raise JobNotRetryable(f"job {job_id} is {status.value}, not dead")
    now = clock.now()
    if finished_at is None or finished_at < now - DEAD_RETENTION:
        raise JobNotRetryable(...)
    await db.execute(
        update(Job)
        .where(Job.id == job_id)
        .values(status=JobStatus.QUEUED, attempts=0, run_at=now, locked_by=None,
                locked_until=None, finished_at=None)
        # ...
    )
```

- What it does: once the row is locked, no scrub can change it until this transaction ends. The clock is
  read after the lock, so a scrub that committed first had an earlier clock, and this check refuses too.
  `attempts = 0` makes the job look new to the worker's guard and to the claim's `attempts + 1`.
- What breaks without it: reading the clock first (R1) fails
  `test_a_retry_delayed_across_the_boundary_does_not_requeue_a_scrubbed_job`. Dropping `FOR UPDATE` (R2)
  fails `test_a_scrub_waits_for_a_retry_paused_between_its_check_and_its_update`. Dropping the age, the
  status, `attempts=0`, `finished_at=None` or the lease columns (M23–M27) fails the refusal and requeue
  tests.

`backend/app/jobs/report.py::_safe`:

```python
def _safe(text: str | None) -> str:
    # Stored text comes from exception messages: control and format characters (escape
    # sequences, bidi overrides) could drive the operator's terminal, so each becomes `?`.
    return "".join(ch if ch.isprintable() else "?" for ch in text or "")
```

- Why: `last_error` holds exception text, which can come from outside (an SMTP server's reply). `\x1b]0;…`
  could retitle or recolour the operator's terminal. On the stack, a raw ESC printed as `?[31m`.
- What breaks without it: M21 fails
  `test_render_prints_no_payload_no_control_characters_and_200_error_characters`.

<details><summary>Deeper: the concurrency tests and why two use real connections</summary>

`backend/tests/jobs/test_scheduler.py::test_two_schedulers_at_the_same_moment_leave_one_job_per_kind` holds
worker A's commit until worker B has started. It asserts that B is still running 0.2 s later: B's insert
waits on A's uncommitted unique keys. Then A commits, B's `ON CONFLICT DO NOTHING` returns nothing, and
there are three rows. Without a dedupe key, B doesn't wait, and the `not b.done()` assertion fails.

The interval and error tests use `committed_sessions`. In them the scheduler's timer and the job loop run at
once. Two savepoint sessions on the one test connection collided (`SAWarning: nested transaction already
deassociated`). In production each session has its own pooled connection.

The round-1 race tests pause a session's statement (`paused_statement`, which wraps `execute`, `scalar`
and `scalars`, so it doesn't depend on which method the code calls) and move the frozen clock. Codex's
original proof only hooked `scalar` and stopped working once the fix used `execute`, so it was not kept.

</details>

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Restart the same day, then midnight | one job per kind per date | `test_scheduling_twice_on_one_day_keeps_one_job_per_kind_and_the_next_day_adds_one` |
| Non-UTC clock | UTC date in the key | `test_the_dedupe_key_uses_the_utc_date` |
| Two workers schedule at once | one row per kind; the second waits, then adds nothing | `test_two_schedulers_at_the_same_moment_leave_one_job_per_kind` |
| Scheduler error | logged by type; loop continues; next tick works | `test_a_scheduler_error_is_logged_by_type_and_the_worker_goes_on` |
| Success exactly 14 d old; old dead/queued/running jobs | kept | `test_jobs_cleanup_deletes_only_successes_finished_more_than_14_days_ago` |
| Dead at exactly 7 d; no keys; unregistered kind; other statuses | not scrubbed | `test_jobs_cleanup_scrubs_secrets_of_jobs_dead_more_than_7_days` |
| Session ended by one deadline only; boundary at 30 d | deleted past 30 d, kept at or under | `test_sessions_cleanup_deletes_sessions_ended_more_than_30_days_ago` |
| A cleanup fails half-way | its deletes roll back, job retried | `test_a_failing_cleanup_rolls_its_deletions_back` |
| `last_error` with escapes, newlines, 300+ chars; payload with a token | `?`, cut at 200, no payload | `test_render_prints_no_payload_no_control_characters_and_200_error_characters`, `test_jobs_status_command_prints_the_report_and_changes_nothing` |
| Retry: unknown, queued, running, succeeded, too old, no finish time, twice | exit 1, row unchanged | `test_retry_refuses_*`, `test_a_second_retry_is_refused`, `test_jobs_retry_command_refuses_*` |
| Malformed id, including an escape sequence | exit 1 before any session, not echoed | `test_jobs_retry_command_refuses_a_malformed_id_before_any_session[5]` |
| Retry and scrub at the boundary, in each order | never a re-queued empty payload | the four round-1 tests in `test_cli_jobs.py` |

**Acceptance criteria → tests:**
- AC9: the first four scheduler tests.
- AC18: `test_run_forever_schedules_before_the_first_claim_and_runs_the_job`, the interval, error and
  no-recurring tests.
- AC19–22: one cleanup test each.
- AC23: `test_the_worker_imports_the_three_handler_modules`,
  `test_each_cleanup_job_runs_in_the_worker_and_commits_with_the_job`, the rollback test, and
  `backend/tests/test_architecture.py` (handlers may not commit; the helpers are in `NON_COMMITTING_HELPERS`).
- AC24: the status and render tests, plus the end-to-end command test.
- AC25: the requeue tests, plus `test_a_retried_job_is_claimed_and_run_like_a_new_one`.
- AC26: the refusal tests.

The stack transcripts are in the PR: three `succeeded` jobs after `make up`; still one per kind after
`docker compose restart worker` and after a second `make prodlike`; `jobs-status` and `jobs-retry` with
exit codes. The mutation runs M1–M29 and R1, R2, R4 are in the PR too; every one made a test fail.

## 6. Review log

Reviewers, per James's instruction for this run: a fresh Codex gpt-6.1-sol at high effort each round, with
the Tier 1 security pass in `--focus`. No Claude reviewer, which differs from the playbook's Tier 1 pair.

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol, high | `dc0f4e5` | MERGE | Medium: retry/scrub race at the boundary. Gap: no AC22 case isolated `expires_at` | both fixed in `82635b5` |
| 2 | Codex gpt-6.1-sol, high (fresh) | `82635b5` | MERGE | none | — |

- **Round 1, Medium.** Codex's proof put a dead job 10 ms inside the window and paused the retry before its
  statement. It then moved the clock 20 ms and ran the scrub. The retry re-queued the job with payload
  `{'to': 'proof@example.test'}`, its link gone. `test_a_retry_delayed_across_the_boundary_does_not_requeue_a_scrubbed_job`
  failed before the fix (`assert True is False`) and passes now. The PR lists the fix's neighbours, each with
  a test: a pause between the check and the update, a scrub open first, a retry open first, two retries,
  every refusal.
- **Round 1, gap.** The `expires_at` case also had an old idle deadline, so removing the `expires_at`
  clause went unnoticed (R4 would have survived). The new case has a live idle deadline, and R4 now fails.

## 7. Not verified, accepted risks and follow-ups

- **The Tier 1 pair was not used.** Both reviews were Codex, on James's instruction.
- **Rebase after round 2.** `bc90d08` is `82635b5` rebased onto #70. No reviewer saw the rebased commit;
  `make check` passed after it.
- **Per-user cap on live sessions:** deferred (D1), to the inbox.
- **Dead rows are kept forever;** only their secrets go (D2). An unregistered kind's secrets are never
  removed.
- **`jobs-status` prints 200 characters of `last_error`.** They are only as safe as P3-01a's redaction (its
  D8): a secret outside `sensitive_keys`, or encoded, would show.
- **Clock:** the 7-day boundary assumes the CLI and the worker share one clock (one host).
- **No audit event for `jobs-retry`.**
- **No index for the cleanups** (D3). At ADR-0006's "revisit" volumes the daily delete scans the table.
- **The 60 s tick and the midnight rollover** are tested with a frozen clock and a 0.05 s interval, not
  with real time.

## 8. How to change this safely

- **Adding a recurring job:** write a handler with `@job_handler("<domain>.<verb>")` in the domain's
  `jobs.py`, add the module to `HANDLER_MODULES` and the kind to `RECURRING_KINDS`. Use only `ctx.db`, never
  commit, and finish within 50 s. `test_the_recurring_kinds_are_the_three_cleanups_every_60_seconds` pins the
  list, so update it.
- **Changing a retention:** the constants are `SUCCEEDED_RETENTION`, `DEAD_RETENTION` (`backend/app/jobs/service.py`)
  and `SESSION_RETENTION` (`backend/app/auth/service.py`). `test_the_retention_periods` pins them. A longer
  invitation lifetime than 7 days needs a longer `DEAD_RETENTION` (D2).
- **Changing `jobs-retry`:** keep the lock before the clock. The four round-1 tests catch a regression.
- **Printing more in `jobs-status`:** pass every stored string through `_safe`, and never select `payload`.

## 9. Must explain, then quiz

**1. Why does a date-based dedupe key make the scheduler safe across restarts and several workers?**
- The key `jobs.cleanup:2026-10-18` is the same for every worker and every restart on that UTC day.
- `jobs.dedupe_key` is unique, and `enqueue` is `INSERT … ON CONFLICT (dedupe_key) DO NOTHING`. Postgres
  enforces "one per day" atomically, even for two inserts at the same moment: the second waits for the
  first's commit, then does nothing (`test_two_schedulers_at_the_same_moment_leave_one_job_per_kind`).
- No worker remembers whether it already scheduled, so a restart has nothing to lose. The next date is a
  new key, so midnight starts a new day without coordination.
- It works because the key stays taken while the row exists: success rows are kept 14 days, and dead rows
  forever, both longer than a day.

**2. What does `jobs.cleanup` leave behind, and why only `succeeded` rows?**
- It leaves every `queued` and `running` job (still to do), every `dead` job (the failure record that
  `jobs-status` shows and `jobs-retry` needs), and successes up to 14 days old.
- Dead jobs older than 7 days lose their sensitive keys but keep the row.
- Only `succeeded` rows are deleted because only they are finished with nothing left to act on, and P3-01a
  already scrubbed their secrets. Deleting dead rows would lose evidence of failures. Deleting queued or
  running ones would lose work (`test_jobs_cleanup_deletes_only_successes_finished_more_than_14_days_ago`).

**Quiz**

1. A worker starts at 23:59:30 UTC and runs for two minutes. How many `sessions.cleanup` jobs exist, and why?
2. What breaks if `retry_dead_job` reads `clock.now()` before its `SELECT … FOR UPDATE`?
3. Why does `jobs-retry` refuse a dead job that is 8 days old even if the scrub hasn't run yet?
4. What would break if `_schedule_logged` let the exception escape?
5. How would you add a weekly report job that must run at most once per ISO week?

<details><summary>Answers</summary>

1. Two, unless one already existed for either day. The start enqueues `…:<day 1>`. The first 60 s tick
   after midnight enqueues `…:<day 2>`. Every other tick finds both keys taken.
2. A retry delayed between reading the clock and locking the row could pass the age check with a stale
   time. Meanwhile the scrub, with a later clock, empties the payload, and the retry re-queues a job with no
   link. `test_a_retry_delayed_across_the_boundary_does_not_requeue_a_scrubbed_job` fails (R1).
3. The refusal uses the same age as the scrub, so whether a job is retryable never depends on when the
   daily cleanup happened to run (D2). The link it carries has also expired by then (invitations last 7
   days).
4. At start, `run_forever` awaits it before the loop, so a database outage at startup would crash the
   worker. In the timer task, the task would die and nothing would be scheduled again until a restart.
   `test_a_scheduler_error_is_logged_by_type_and_the_worker_goes_on` fails (M5).
5. Register a handler and add a scheduling rule keyed by week: `dedupe_key=f"reports.weekly:{year}-W{week}"`
   from `clock.now().astimezone(UTC).isocalendar()`. `schedule` today builds one key format for all kinds,
   so it would need a per-kind key function. Keep the succeeded retention longer than the period (14 days >
   7), or the key would be freed and the job re-enqueued within the same week.

</details>
