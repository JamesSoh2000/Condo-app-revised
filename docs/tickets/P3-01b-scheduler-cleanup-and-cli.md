# P3-01b — Scheduler, cleanup jobs and jobs CLI (split from P3-01)

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 1 |
| Depends on | P3-01a, P2-05, P2-01b |
| Replaces old | M14-T16 (demo subset) (part of [P3-01](./P3-01-job-queue-and-worker.md)) |
| Status | todo |

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

9. **Given** the scheduler runs twice on the same day (simulated restart), **then** one `jobs.cleanup` job
   exists for that date (and one of each other recurring kind); on the next day a new one is enqueued.
   (P3-01 criterion 9.)
- To sharpen while framing P3-01b: `jobs.cleanup` deletes only `succeeded` jobs finished more than 14 days
  ago; `rate_limits.cleanup` deletes only ended windows; `sessions.cleanup` per the decision below;
  `jobs-retry` on a job that isn't `dead`, an unknown id or a malformed id exits 1 and changes nothing;
  `jobs-status` prints no payload.

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
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: second part of P3-01; see the parent ticket.
