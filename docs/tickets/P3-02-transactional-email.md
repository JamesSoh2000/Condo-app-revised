# P3-02 — Transactional email

| Field | Value |
|---|---|
| Phase / lane | P3 / B (moved from A: builds on P3-01, also lane B) |
| Risk tier | 2 |
| Depends on | P3-01 |
| Replaces old | M5-T08 (email), M3-T13 (delivery part), M14-T04 (staging use, now D-06), M14-T17 |
| Status | todo |

## Goal

The app sends templated emails through the job queue to Mailpit locally. The same SMTP settings point at
SES once staging exists (milestone D). A recipient allowlist, required on staging by the settings
validator, makes it impossible to email real people by accident.

## Why

Invitations, password resets and package notifications all depend on email. One SMTP adapter everywhere keeps
it simple ([ADR-0006](../adr/0006-postgres-job-queue.md)).

## Scope

- In:
  - **Settings:**
    - `SMTP_HOST`, `SMTP_PORT`, `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_STARTTLS`
    - `EMAIL_FROM` (for example `"Maple Tower <no-reply@<domain>>"`)
    - `APP_BASE_URL`
    - `EMAIL_RECIPIENT_ALLOWLIST` (comma-separated addresses or `@domain` suffixes; empty means allow all,
      which is **required to be non-empty on staging** by the settings validator)
  - **`app/email/`:**
    - Jinja2 environment with autoescape for HTML
    - templates per message: `<name>.subject.txt`, `.txt`, `.html`; base layout with building name and a
      footer
    - locale folders `en/`, with `fr/` placeholders that fall back to `en`
  - **`queue_email(db, *, to, template, context, locale="en", dedupe_key=None)`:** validates that the template
    exists, then `enqueue("email.send", …)`. Never commits.
  - **Handler `email.send`:**
    - renders and sends with `aiosmtplib` (multipart text + HTML)
    - allowlist check: a non-allowlisted recipient logs `email_skipped_not_allowlisted` and **succeeds** (no
      retry)
    - SMTP 5xx raises `PermanentJobError`; 4xx and connection errors are retryable
    - `sensitive_keys=("context",)` scrubs the rendered context after sending
  - **Template `test`**, plus CLI `email-test --to ADDRESS`.
  - **Staging (milestone D, not this ticket):** SES SMTP credentials in SSM (D-01 placeholders filled by
    humans), and the SES sandbox verified identities = the allowlist. D-06 checks delivery.
- Out:
  - invitation, reset and notification templates (added by their tickets)
  - bounce/complaint handling (pilot)
  - SMS (pilot option)

## Interfaces

`queue_email()`, the template folder convention, CLI `email-test`, and the settings above.

## Acceptance criteria

1. **Given** the local stack, **when** `email-test --to dev@example.test` runs and the worker is up, **then**
   Mailpit shows one message with text and HTML parts and the correct From header.
2. **Given** Mailpit is stopped, **when** a job runs, **then** it is retried (status back to `queued` with a
   later `run_at`). After Mailpit restarts, it is delivered.
3. **Given** an SMTP 550 response (mock), **then** the job goes `dead` without retries.
4. **Given** `EMAIL_RECIPIENT_ALLOWLIST=@example.test`, **when** emailing `someone@gmail.com`, **then** nothing
   is sent, and the job is `succeeded` with a skip log line.
5. **Given** context `{"name": "<script>"}`, **then** the HTML body contains the escaped `&lt;script&gt;`.
6. **Given** `APP_ENV=staging` and an empty allowlist, **then** settings validation fails at startup.
7. **Given** the prod-like stack (`make prodlike`), **when** `email-test` runs, **then** the message reaches
   Mailpit through the image's worker. (Delivery through SES is checked in D-06.)

## Test plan

- `tests/email/test_render.py`; `tests/email/test_send.py` (a fake SMTP via an `aiosmtplib` mock, or a
  Mailpit container in CI).
- Manual criteria 1, 2 and 7.

## Likely files

`backend/app/email/{service,handler,templates/**}.py`, `backend/app/core/config.py`, `backend/app/cli.py`,
`backend/.env.example`, `backend/tests/email/*`.

## Must explain (learning checkpoint)

1. Why is email sent by the worker and never inside the request?
2. Why does a non-allowlisted recipient count as "succeeded" rather than "failed"?
3. Which SMTP errors are worth retrying, and which aren't?
4. Why must HTML templates autoescape?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
