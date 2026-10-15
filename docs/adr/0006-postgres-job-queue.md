# ADR-0006: PostgreSQL job queue (transactional outbox) for email and background work

- Status: Accepted
- Date: 2026-10-13

## Context

Business actions such as package creation and resident approval must trigger emails, but email providers
fail. Calling SES inside the request either loses emails, if we commit first and the call fails, or loses
business data, if the call fails and we roll back. This is the **dual-write problem**.

We also need scheduled cleanup jobs. The old plan already rejected Redis/Celery for the MVP.

## Decision

- **One generic `jobs` table**:
  - `kind`, `payload` jsonb
  - `status` (queued/running/succeeded/dead)
  - `run_at`, `attempts`, `max_attempts`
  - `locked_by`, `locked_until`
  - `last_error`
  - `dedupe_key` (unique)
- **`enqueue()`** inserts rows in the **same transaction** as the business change (the outbox). Duplicates are
  ignored through `ON CONFLICT (dedupe_key) DO NOTHING`.
- **Worker process** (`python -m app.worker`, same image):
  - claims batches with `FOR UPDATE SKIP LOCKED` and a 60 s lease
  - reclaims expired leases
  - backs off exponentially with jitter, capped at 1 h
  - marks jobs `dead` after `max_attempts`
  - scrubs sensitive payload fields on success
- **Delivery is at-least-once.** Handlers are idempotent where possible. Docs never promise exactly-once email.
- **Email goes over SMTP everywhere:** Mailpit locally and the SES SMTP interface in the cloud. There is one
  adapter.
- **Recurring jobs** are enqueued by a scheduler loop in the worker with date-based dedupe keys.
- **Operations:** the CLI `jobs-status` shows counts by status, the oldest due age and recent dead jobs; the
  CLI `jobs-retry <id>` re-queues a dead job.

## Consequences

- An email is never lost because the provider was down, and business actions never wait for SMTP.
- No new infrastructure, and the job state is inspectable with SQL.
- **Throughput limit:** thousands of jobs per minute on this host, which is far above the pilot's needs.
- **A crash between SMTP acceptance and the status update causes a duplicate.** Accepted and documented.

## Alternatives considered

- **Celery/RQ + Redis:** an extra stateful service to run and back up, with no MVP benefit.
- **FastAPI `BackgroundTasks`:** runs in the API process after the response, with no durability or retry, and
  is lost on restart.
- **AWS SQS:** durable, but cannot share a transaction with Postgres, so we would need an outbox anyway.

## Revisit when

There are sustained > 50 jobs/s, multiple worker hosts with fairness needs, or a need for complex workflows
(fan-out pipelines, long-running tasks).
