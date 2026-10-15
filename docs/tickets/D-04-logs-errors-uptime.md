# D-04 — Logs, error tracking and uptime

| Field | Value |
|---|---|
| Phase / lane | D / A |
| Risk tier | 2 |
| Depends on | D-03 (the SDK code and the scrubber test can be written locally while D-01…D-03 are in progress) |
| Replaces old | M14-T11 (basic), M14-T12 |
| Status | todo |

> **Milestone D ([ADR-0013](../adr/0013-local-first-deployment-milestone.md)).** This was P1-11, moved out of
> the local weeks. It stays detailed, but re-frame it before starting: the code it builds on will have
> changed by then.

## Goal

Staging logs are searchable in CloudWatch by request ID. Backend and frontend errors reach Sentry, tagged
with the release SHA. An external monitor emails James when the API is down.

## Why

You cannot fix what you cannot see. With agents shipping code daily, fast feedback from the real environment
is the safety net behind tests.

## Scope

- In:
  - **Compose logging:** `driver: awslogs` for `api` and `worker`, with `awslogs-region`,
    `awslogs-group=/condo/staging/{api,worker}` and `awslogs-stream` set to the container name. The log
    groups come from D-01.
  - **Request log fields:** keep the existing JSON fields, including `user_id` and `building_id` (add them
    here if P2 didn't). Never log cookies, Authorization headers or request bodies.
  - **Backend Sentry:**
    - `sentry-sdk[fastapi]`, initialized only when `SENTRY_DSN` is set
    - `environment=APP_ENV`, `release=GIT_SHA`, `send_default_pii=False`, `traces_sample_rate=0.05`
    - a `before_send` that removes the `cookie` and `x-requested-with` headers
  - **Frontend Sentry:**
    - `@sentry/react` with `VITE_SENTRY_DSN` and `VITE_RELEASE`
    - an error boundary that reuses the existing `ErrorBoundary.jsx` pattern
    - the CSP `connect-src` allows the Sentry ingest host (update the shared `deploy/Caddyfile`, for example
      from an optional `{$SENTRY_ORIGIN}`, so the prod-like stack still validates)
  - **CLI `sentry-test`:** raises and captures a test exception (for verification).
  - **Uptime:** an external monitor (UptimeRobot or Better Stack free tier) on `https://<domain>/api/health`
    every 5 minutes, emailing James. Document it in `docs/runbooks/monitoring.md`. It is configured by
    hand; record the monitor URL.
  - **Saved CloudWatch Logs Insights queries** in the runbook:
    - errors by route
    - p95 duration by route
    - all lines for one `request_id`
- Out:
  - alarms on metrics (pilot)
  - the backup-age alert (D-05, which reuses this ticket's uptime service)

## Interfaces

Env `SENTRY_DSN` (SSM), `VITE_SENTRY_DSN` (build-time, public), `VITE_RELEASE`.

## Acceptance criteria

1. **Given** a request to staging, **then** its log line appears in CloudWatch within 1 minute, and the
   Insights query by `request_id` finds it.
2. **Given** `python -m app.cli sentry-test` on staging, **then** Sentry shows the event with
   `release=<sha>`, `environment=staging`, and no cookie values.
3. **Given** a thrown error in a React component on staging, **then** Sentry shows it with the same release.
4. **Given** the API container is stopped for 10 minutes, **then** James receives a downtime email, and a
   recovery email after restart.
5. **Given** a search of the staging logs, **then** no `session` cookie values or passwords appear (spot
   check after P2-01 as well).

## Test plan

Manual verification on staging with screenshots or links in the PR. A unit test for the Sentry `before_send`
scrubber.

## Likely files

`deploy/compose.staging.yml`, `backend/app/observability.py`, `backend/app/main.py`, `backend/app/cli.py`,
`frontend/src/main.jsx` (or `main.tsx`), `deploy/Caddyfile`, `docs/runbooks/monitoring.md`.

## Must explain (learning checkpoint)

1. How does a request ID let you follow one user's problem across logs and Sentry?
2. Why is `send_default_pii=False` important, and what still might leak?
3. Why use an *external* uptime monitor rather than one running on the same host?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
