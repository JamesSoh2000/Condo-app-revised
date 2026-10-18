# P3-02 — Transactional email

| Field | Value |
|---|---|
| Phase / lane | P3 / B (moved from A: builds on P3-01, also lane B) |
| Risk tier | 2 |
| Depends on | P3-01 |
| Replaces old | M5-T08 (email), M3-T13 (delivery part), M14-T04 (staging use, now D-06), M14-T17 |
| Status | done |

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

Added in framing (see Frame notes):

8. **Given** an SMTP 4xx reply (451 on `RCPT` or `DATA`, mock), **then** the job is retried like criterion 2,
   and its `last_error` holds no value from `context`.
9. **Given** a succeeded `email.send` job, **then** its payload has no `context` key (the scrub), and `to`,
   `template` and `locale` remain.
10. **Given** a template name that doesn't exist, a name that isn't `[a-z][a-z0-9_]*`, a locale other than
    `en`/`fr`, a context missing a variable the template uses, a `to` that isn't one address (no `@`, a
    comma, CR/LF, over 254 characters), or a context that isn't JSON, **then** `queue_email` raises
    `ValueError` and enqueues nothing.
11. **Given** `queue_email` inside a transaction that rolls back, **then** no job exists (it never commits).
12. **Given** `locale="fr"` and no `fr/` file for the template, **then** the `en` file is used, per part.
13. **Given** a context value with a newline in a value the subject uses, **then** the `Subject` header is one
    line (no header injection).
14. **Given** a job whose template no longer exists when it runs, **then** it goes `dead` without retries.
15. **Allowlist matching:** case-insensitive; `@example.test` matches `a@example.test` and `A@Example.Test`
    but not `a@sub.example.test` or `a@notexample.test`; an exact-address entry matches only that address;
    a malformed entry (no `@`, empty, whitespace inside) fails settings validation. The skip log line holds
    the job id and the recipient's domain, never the full address.
16. **Given** `APP_ENV=staging` or `prod`, **then** `APP_BASE_URL` must not be a loopback URL, and in prod it
    must be `https://`; in prod `EMAIL_FROM` must not be the dev default. `EMAIL_FROM` must parse as
    one address everywhere.
17. **Given** `email-test --to not-an-address`, **then** it exits 1 with an error and touches no database.

Tenant table (ENGINEERING_PRACTICES §7): n/a, this ticket adds no endpoint.

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

## Carried from P3-01b

- A dead `email.send` job keeps its `sensitive_keys` for 7 days (`DEAD_RETENTION`); `jobs.cleanup` then removes
  them and `jobs-retry` refuses the job. Keep every link or token the email needs under a sensitive key, so
  the scrub finds it.
- Register the handler module in `backend/app/jobs/worker.py::HANDLER_MODULES`.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: AC8 to AC17 above. AC8 covers the 4xx half of the retry rule the
  ticket only stated in scope; AC9 and AC14 make the `sensitive_keys` scrub and a vanished template
  testable; AC10 to AC13 are the input cases the ticket missed (bad names, locale fallback, header
  injection through the subject, `to` with CR/LF); AC15 makes "addresses or `@domain` suffixes" precise;
  AC16 keeps dev values of the new settings out of deployed environments, as the validator already does for
  the others; AC17 is the CLI's usage error. The tenant table does not apply (no endpoint).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Dependencies `jinja2` and `aiosmtplib` (ticket names both).
  - `queue_email` renders all three parts once at queue time with `StrictUndefined`, so a missing template
    or variable fails in the caller, not later as a dead job (autonomous; ticket says "validates that the
    template exists").
  - A failure in rendering at send time (template gone, AC14) and SMTP 5xx are `PermanentJobError`; 4xx,
    connection and timeout errors retry (ticket). SMTP timeout 20 s, below the worker's 50 s handler timeout
    (autonomous).
  - Allowlist semantics as in AC15; `@domain` matches that domain only, not subdomains (autonomous, simplest
    reading of "suffix" that can't match `notexample.test`).
  - `SES_FROM_EMAIL` stays as it is (unused; an existing test passes it). `EMAIL_FROM` is the sender from
    now on; removing `SES_FROM_EMAIL` is a follow-up for D-01 (autonomous).
  - Supported locales are `en` and `fr`; `fr/` holds no templates yet, so every part falls back to `en`
    (ticket).
- Split: none. Estimate about 330 non-test lines (settings 60, `app/email` 190, templates 40, CLI 20,
  env example 15).
