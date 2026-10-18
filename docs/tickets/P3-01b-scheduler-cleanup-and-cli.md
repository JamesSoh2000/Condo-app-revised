# P3-01b — Scheduler, cleanup jobs and jobs CLI (split from P3-01)

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 1 |
| Depends on | P3-01a, P2-05, P2-01b |
| Replaces old | M14-T16 (demo subset) (part of [P3-01](./P3-01-job-queue-and-worker.md)) |
| Status | done |

## Goal

The worker enqueues recurring jobs on a schedule, old rows are cleaned up by them, and operators can see and
retry jobs from the CLI.

## Why

Recurring cleanup keeps the `jobs`, `rate_limits` and `sessions` tables bounded, and the CLI is the
operations surface ADR-0006 names ([ADR-0006](../adr/0006-postgres-job-queue.md)).

## Scope

- In:
  - **Scheduler loop** (in the worker's `run_forever`, at start and every 60 s): enqueue recurring jobs with
    `dedupe_key=f"{kind}:{yyyy-mm-dd}"` (UTC date of `clock.now()`):
    - `jobs.cleanup` (delete succeeded jobs older than 14 days)
    - `rate_limits.cleanup` (P2-05's `delete_expired_rate_limits`)
    - `sessions.cleanup` (Carried from P2-01b, below)
  - **CLI:**
    - `jobs-status`: counts by status, oldest due age, last 10 dead jobs (never payloads)
    - `jobs-retry <id>`: dead → queued, attempts reset
- Out: the queue, worker and compose (P3-01a); email (P3-02); notification fan-out (P3-03).

## Acceptance criteria

Numbered after P3-01a (AC9 is P3-01's criterion 9). Time is `clock.now()` throughout (frozen in tests);
"day" is its UTC date. No endpoint is added, so the 10-case tenant table does not apply: the jobs,
`rate_limits` and `sessions` tables are not building-scoped, and the CLI is operator-only.

9. **Restart-safe schedule.** **Given** the scheduler runs on two separate `Worker` instances on the same
   day (a simulated restart), **then** exactly one `queued` job exists for each recurring kind
   (`jobs.cleanup`, `rate_limits.cleanup`, `sessions.cleanup`) with `dedupe_key = "<kind>:<yyyy-mm-dd>"`;
   **when** the clock moves to the next day and it runs again, **then** one more of each exists (six in
   all). Two schedulers running at the same moment on separate connections also leave one per kind.
18. **Scheduler in the worker.** `Worker.run_forever` runs the scheduler once at start, before the first job
    is claimed, and then every 60 s (`SCHEDULE_INTERVAL`), next to the heartbeat timer. **Given** the
    scheduler raises, **then** `scheduler_error` is logged at ERROR with `error_type` only (no message), the
    job loop keeps claiming jobs, and the next tick tries again.
19. **`jobs.cleanup` deletes old successes only.** It deletes `succeeded` jobs whose `finished_at` is more
    than 14 days before now. It keeps a `succeeded` job finished exactly 14 days ago or later, and every
    `queued`, `running` and `dead` job of any age.
20. **Dead jobs' secrets expire.** `jobs.cleanup` also removes the registered handler's `sensitive_keys`
    from the payload of `dead` jobs finished more than 7 days ago (`DEAD_RETENTION`), keeping the row, its
    other payload keys and `last_error`. A dead job finished 7 days ago or later, a job of another status,
    and a dead job whose kind has no registered handler are unchanged.
21. **`rate_limits.cleanup`** runs `delete_expired_rate_limits` (windows that started more than a day ago);
    the current window's row is kept. The `TODO(P3-01)` is removed.
22. **`sessions.cleanup`** deletes sessions that ended more than 30 days ago (`SESSION_RETENTION`): revoked,
    past `expires_at`, or past `idle_expires_at`, more than 30 days before now. It keeps live sessions and
    sessions that ended (each of the three ways) 30 days ago or later.
23. **The handlers run in the worker.** `HANDLER_MODULES` lists their modules; after `load_handlers()` the
    three kinds are registered. Each, enqueued and run by `Worker.run_once`, ends `succeeded` with its
    deletions committed with the job (they use `ctx.db` and never commit; the architecture fitness test's
    commit allow-list is unchanged).
24. **`jobs-status`** (exit 0, read-only) prints the count of each of the four statuses, zeros included; the
    age of the oldest due job (the claim's predicate: `queued` with `run_at <= now`, or `running` past its
    lease), or `none`; and the 10 most recently finished `dead` jobs (id, kind, attempts/max, finished_at,
    the first 200 characters of `last_error` with control characters replaced). It never prints a payload
    value, nor `last_error` past 200 characters.
25. **`jobs-retry <id>`** (exit 0) sets a `dead` job finished within `DEAD_RETENTION` to `queued`,
    `attempts = 0`, `run_at = now`, and clears `locked_by`, `locked_until` and `finished_at`; payload,
    `max_attempts` and `last_error` are kept. The worker then claims and runs it like a new job.
26. **`jobs-retry` refusals** exit 1 with a message on stderr and change no row: a malformed id (refused
    before any session), an unknown id, a job that is `queued`, `running` or `succeeded`, a `dead` job
    finished more than `DEAD_RETENTION` ago (its secrets may be gone), and a second retry of the same job.

## Carried from P2-01b (do while framing)

- Expired and revoked `sessions` rows are never deleted, and there is no per-user cap on live sessions
  (PR #57 review round 2 L3). Add a periodic job that deletes rows past `expires_at`/`idle_expires_at` or
  revoked for some retention period, and decide on a cap.

## Carried from P2-05

- Remove the `TODO(P3-01)` in `app/rate_limits/service.py::delete_expired_rate_limits` once it is scheduled.

## Carried from P3-01a

- Replace the `jobs-status` placeholder in `app/cli.py` (its placeholder test names P3-01b).
- Register each new handler module in `app/jobs/worker.py::HANDLER_MODULES`; handlers get `ctx.db` (the
  job's transaction), never commit, and must finish within `HANDLER_TIMEOUT` (50 s).
- The scheduler loop goes into `Worker.run_forever` (`app/jobs/worker.py`), next to the heartbeat timer task.
- Decide while framing: dead jobs keep their sensitive payload keys indefinitely (only success scrubs them,
  and `jobs.cleanup` deletes only `succeeded` rows). Choose a retention for `dead` jobs, or scrub sensitive
  keys when a job dies, keeping `jobs-retry` workable (PR #69 follow-ups, explanation §7).
- `jobs-retry` sets `attempts = 0`: the worker's guard (`attempts > max_attempts` → dead unrun) and the
  claim's `attempts + 1` then work as for a new job. Clear `locked_by`/`locked_until`, set `run_at` to now.

## Must explain (learning checkpoint)

1. Why does a date-based dedupe key make the scheduler safe across restarts and several workers?
2. What does `jobs.cleanup` leave behind, and why only `succeeded` rows?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - AC9 is P3-01's criterion 9, made concrete: two separate `Worker` instances, the exact key, a day
    boundary with `frozen_clock.advance(days=1)`, and two concurrent schedulers.
  - The "to sharpen" bullet became AC19 (`finished_at`, strict 14 days, every other status kept), AC21,
    AC22, AC24 (zeros, the due predicate, what a dead-job line holds) and AC26 (each refusal).
  - New: AC18 (scheduler placement and its error path), AC20 (dead-job secrets), AC23 (the handlers are
    registered and run through the worker), AC25 (what retry sets and keeps).
  - Missed cases added: two schedulers at once (AC9); control characters in `last_error`, which could drive
    an operator's terminal (AC24); a retry after the secrets' retention, and a second retry (AC26).
- Criteria loosened: none.
- Decisions taken (basis; in full in the PR's "Decisions and alternatives"):
  - **Scope line versus cleanup.** PRODUCT_SCOPE says "Nothing is deleted automatically in the demo". That
    line is the retention of domain records (packages, photos). `jobs`, `rate_limits` and `sessions` are
    operational rows, and ADR-0006 and this ticket name their cleanup. (ticket, ADR-0006; inbox)
  - **Sessions are kept 30 days after they end** (autonomous; inbox). Long enough to tie an audit event's
    session id to its IP and user agent in an investigation, short enough to bound that PII. It matches
    `SESSION_ABSOLUTE_DAYS` (30) and the 30-day log retention (ARCHITECTURE §16).
  - **No per-user cap on live sessions** (deferred; inbox). A cap changes login (lane A, auth), outside this
    ticket's scope.
  - **Dead jobs: secrets scrubbed 7 days after death; retry allowed only within those 7 days**
    (autonomous; inbox). Scrubbing at death would break `jobs-retry` for email, its main use. 7 days is the
    longest token lifetime the plan has (invitations; password reset is 1 hour), so a retry later would
    send a dead link anyway. Dead rows themselves are kept (evidence for `jobs-status`).
  - **No index for the cleanup, so no migration** (autonomous). The deletes run once a day over a few
    thousand rows at pilot volume (ADR-0006 "Throughput"); a sequential scan is fine. This also keeps
    `migrations/versions/` free for P3-04a.
  - **`jobs-retry` records no audit event** (autonomous): the CLI is operator-only and `audit_events` is
    the users' action history; the CLI prints the id. Follow-up if James wants operator actions audited.
- Size: about 300 non-test lines. No split.
- Split: second part of P3-01; see the parent ticket.
