# Explanation — P3-02 Transactional email

> **PR:** #73 · **Source revision:** `b79f5be`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3, Codex gpt-6.1-sol high) reviewed `631a456`
> (now `34d6e01` after the rebase onto `519c94a`, #74). Round 3 said `BLOCK` on one Medium and one Low; their
> fixes (`87431ca`, now `b79f5be`) were **not reviewed**: James accepted them as they are (inbox B-4, option B,
> 2026-10-18). The rebase changed only bookkeeping files (`git diff --name-status 87431ca b79f5be`).
> **Merge commit:** not known when written; after the merge, `gh pr view 73 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)). No human reviewed the
> code before merge; James decided only whether the round-3 fixes needed another review. This describes the
> PR's changes at the source revision. Commits after it (bookkeeping) and the squash merge are not described
> here, and a rebase after it gives the same changes new SHAs. This is a snapshot: before the merge it is
> edited to match the PR head; once merged, write a new explanation for later changes and do not update this
> one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `b79f5be`: `git diff origin/main...HEAD` (every app file in full:
> `backend/app/email/{service,handler,templates}.py`, the templates, the `config.py`, `cli.py`,
> `logging_config.py` and `backend/app/jobs/worker.py` diffs), the assertions of the cited tests in `backend/tests/email/`,
> the changed fixtures in `backend/tests/test_config.py` and `backend/tests/auth/test_login.py`, `scripts/prodlike-checks.sh`,
> the PR #73 description, its one comment (the handoff) and the three review files. Ran (scratch Postgres 16
> on 127.0.0.1:55432; no Docker in this session) `uv run pytest -q tests/email tests/test_config.py
> tests/test_architecture.py tests/test_cli_seed.py tests/auth/test_login.py`: 394 passed;
> `uv run pytest -q --ignore=tests/files`: 1117 passed (the 86 `tests/files` tests need the S3 emulator; CI
> runs them). The stack checks were not run locally: their evidence is CI's `prodlike` job. Differences from
> the plan: yes, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C (one `email.send` job, from `queue_email` to Mailpit).

## 1. What was built and why

The app can now send templated email, and only through the job queue. A caller (later: invitations, password
resets, package notifications) calls `backend/app/email/service.py::queue_email` inside its own transaction.
That checks the arguments, renders the template once, and enqueues an `email.send` job. The worker's handler
`backend/app/email/handler.py::send_email` renders it again and sends it over SMTP with `aiosmtplib`: to
Mailpit locally, to SES's SMTP endpoint once staging exists. A recipient allowlist, required on staging,
stops mail to real people. No request ever waits on SMTP or fails because of it
([ADR-0006](../adr/0006-postgres-job-queue.md), `CLAUDE.md` rule 6).

The decisions that matter most: SMTP 5xx is permanent and everything else retries (D2), and the SMTP server's
reply text is never stored, because it can quote the message back (D4, from review round 1's High).

## 2. Decisions

### D1. Render at queue time as well as at send time

- **Problem or constraint:** the ticket asks `queue_email` to check that the template exists. A template that
  exists but uses a variable the caller didn't pass would still fail only in the worker, as a dead job that
  nobody sees.
- **Chosen:** `queue_email` calls `render_email` (all three parts, Jinja2 `StrictUndefined`) before
  `enqueue`; a failure is a `ValueError` (`EmailTemplateError` subclasses it). The worker renders again
  from the stored context.
- **Alternatives rejected:** checking file existence only (misses missing variables); storing the rendered
  message in the payload (a larger payload, and the rendered body would be a second copy of any link to
  scrub).
- **Tradeoffs and accepted limitations:** every email renders twice. A template edited between queue and
  send can still fail at send time; that job goes `dead` (criterion 14).
- **Basis:** autonomous. **Source:** recorded (PR #73 D1).

### D2. SMTP error classification

- **Problem or constraint:** the ticket says 5xx is permanent; 4xx and connection errors retry.
- **Chosen:** a reply exception (`aiosmtplib.SMTPResponseException`, or `SMTPRecipientsRefused` when every
  refusal is 5xx) with a code 500–599 raises `PermanentJobError` (dead at once). A 4xx raises
  `SMTPTemporaryError`; connection and timeout errors propagate unchanged. The worker retries both with
  backoff. The SMTP timeout is 20 s, below the worker's 50 s handler timeout.
- **Alternatives rejected:** listing the retryable exceptions instead: an unknown failure would go dead and
  the mail would be lost; retrying is the safer default with 8 attempts.
- **Tradeoffs and accepted limitations:** a 535 authentication failure (a config error) goes dead; an
  operator re-queues it with `jobs-retry` within 7 days after fixing the credentials.
- **Basis:** ticket. **Source:** recorded (PR #73 D2).

### D3. Allowlist semantics

- **Problem or constraint:** "addresses or `@domain` suffixes" must not match look-alike domains.
- **Chosen:** entries are lowercased. `@domain` matches an address whose part after the `@` equals `domain`
  exactly, so subdomains don't match. Any other entry must be one full address, and matches only that
  address. A malformed entry fails settings validation. Empty means allow all, which staging refuses.
- **Alternatives rejected:** a plain `endswith` without the `@` (matches `notexample.test`); matching
  subdomains (not needed: SES sandbox identities are exact).
- **Tradeoffs and accepted limitations:** `@example.test` doesn't cover `a@sub.example.test`; list it too.
- **Basis:** ticket + autonomous. **Source:** recorded (PR #73 D3).

### D4. The SMTP reply text is never stored (review round 1)

- **Problem or constraint:** a server's reply can quote the message back. In round 1, a 451 reply echoing a
  context value with quotes in it (`O'Reilly` and a reset link) reached `last_error`. `str()` of
  `SMTPDataError` is a tuple repr, which escapes the quote, so the worker's exact-value redaction
  (`backend/app/jobs/worker.py::describe_error`) missed the token. `last_error` is kept for 7 days and
  printed by `jobs-status`.
- **Chosen:** `backend/app/email/handler.py::_raise_for_reply` raises `SMTP <code> [<enhanced code>] (reply
  withheld)` with `from None`, for every reply exception and for `SMTPRecipientsRefused`.
- **Alternatives rejected:** redacting more spellings of each value (escaped, URL-encoded): open-ended, so a
  new encoding leaks again; keeping the text but cutting it short: still leaks a short token.
- **Tradeoffs and accepted limitations:** operators lose the server's human text ("no such user"); the basic
  and enhanced codes (`550 5.1.1`) carry the same meaning. Connection errors keep their message, because
  aiosmtplib writes it, not the server.
- **Basis:** review finding (round 1, High). **Source:** recorded (PR #73 D4, Independent review round 1).

Smaller decisions, one row each:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Keep `SES_FROM_EMAIL`; `EMAIL_FROM` is the sender | Rename it | An existing config test passes it; removing it is a D-01 follow-up | autonomous | PR table |
| The skip log holds the job id and recipient domain | The full address | Addresses are PII (`CLAUDE.md` rule 10) | `CLAUDE.md` | PR table |
| Subject: whitespace runs collapsed to one space | Reject newlines | A user's value (a name) must not make the job fail | autonomous | PR table |
| `to` is one bare address | Accept a list | One recipient, one allowlist decision per job | ticket | PR table |
| Locales `en`, `fr`; any other raises | Fall back to `en` for any locale | A typo would silently send English | autonomous | PR table |
| `to`, `template`, `locale` stay after success; only `context` is scrubbed | Scrub `to` too | The ticket names only `context`; operators need the recipient | ticket | PR table |
| SMTP credentials need `SMTP_STARTTLS=true`; prod needs STARTTLS | Only document it | Credentials in clear text; SES requires TLS | autonomous | PR table |
| `APP_BASE_URL` is an origin, the same rule as `TRUSTED_ORIGINS` | Allow a path prefix | Links are built as `${APP_BASE_URL}/invite/…` (P4-02, P4-04) | autonomous | PR table |
| Email checks in their own validator, after `validate_production_settings` | Inside it | The existing rejection tests keep their own error first | existing tests | PR table |
| The layout is resolved with `select_template`, then passed to `{% extends base %}` | A list in `extends` | Jinja 3.1's `extends` takes one name or a Template (first run: `TypeError`) | test result | PR table |
| Stack criteria checked in `scripts/prodlike-checks.sh`, run by CI | A manual transcript only | No Docker in this session; the check also runs on every later PR | autonomous | PR table |
| `queue_email` refuses what the jobs table would refuse: NaN/±Infinity, NUL, lone surrogates, a bad `dedupe_key` | Let the insert fail | The insert's error aborts the caller's whole transaction | review rounds 1, 3 | PR table, Independent review |
| Addresses: dot-atom, ASCII only, local part ≤ 64, labels ≤ 63, total ≤ 254 | The first pattern; SMTPUTF8 | A server refuses these anyway (dead jobs); ASCII makes the limits octets | review rounds 2, 3 | Independent review |
| `_is_loopback` also reads hosts with `inet_aton` (`127.1`, `0x7f.1`, octal) | `ipaddress` only | Browsers read those as 127.0.0.1; `TRUSTED_ORIGINS` shares the check | review round 2 | Independent review |
| `recipient_domain`, `email_template` added to `JsonFormatter`'s field list | Put them in the message | The formatter writes only listed fields | review round 1 | PR table |
| Deps: `jinja2` 3.1.6, `aiosmtplib` 5.1.3 | stdlib `smtplib` in a thread | The ticket names both; `aiosmtplib` is async like the worker | ticket | PR table |

**Framing changes:** the first commit added AC8–AC17 to the ticket: 4xx retry, the scrub on success, input
validation, rollback, `fr` fallback, header injection through the subject, a vanished template, allowlist
matching, deployed-settings checks, and the CLI usage error. Nothing was loosened. The tenant table doesn't
apply (no endpoint).

**Plan versus final code:**
- the planned `templates/fr/.gitkeep` became `backend/app/email/templates/fr/README.md` (deliberate; it says how the fallback works).
- 4xx no longer propagates unchanged: it is re-raised as `SMTPTemporaryError` with codes only (D4, round 1).
- `queue_email` validates more than the plan listed (rounds 1–3, the table above).
- The `email_recipient_allowlist` comment in `backend/app/core/config.py` says staging's refusal is in
  `validate_production_settings`. It is in `validate_email_settings`. This is a wrong reference in a comment,
  not in behaviour; it is left as accepted (§7).

## 3. How it is implemented

### Overview

- `backend/app/core/config.py`: the new settings and `validate_email_settings`; `is_email_address`, the one
  address check every caller shares.
- `backend/app/email/templates.py::render_email`: Jinja2 with per-part locale fallback, a shared layout,
  autoescape for `.html` only, and a one-line subject.
- `backend/app/email/service.py::queue_email`: validate, render, then `enqueue` in the caller's transaction.
- `backend/app/email/handler.py::send_email`: the `email.send` handler (`sensitive_keys=("context",)`),
  registered through `backend/app/jobs/worker.py::HANDLER_MODULES`.
- `backend/app/cli.py::email_test_command`: `email-test --to ADDRESS` queues the `test` template.

### Walkthrough (variant C: one job from queue to inbox)

1. **Trigger.** `python -m app.cli email-test --to dev@example.test`. `email_test_command` checks the address
   with `is_email_address` before opening any session (a bad one exits 1 without echoing it). Inside
   `run_in_session` it calls `queue_email(db, to=…, template="test", context={})`, then commits once.
2. **Queue.** `queue_email` checks:
   - `to` (ASCII dot-atom, length limits);
   - that `context` is a dict with string keys, encodable as JSON with `allow_nan=False` and as UTF-8;
   - no NUL anywhere (`_has_nul`);
   - `dedupe_key` (`_is_storable_key`).

   It then renders all three parts, and calls `backend/app/jobs/service.py::enqueue` with the payload
   `{to, template, locale, context}`. The job exists only if the caller's transaction commits.
3. **Claim.** The worker claims the due job (P3-01a) and calls the handler in a new session under its 50 s
   timeout.
4. **Allowlist.** `send_email` checks `is_allowlisted(to, settings.email_recipient_allowlist)`. A miss logs
   `email_skipped_not_allowlisted` with `job_id` and `recipient_domain`, and returns, so the job succeeds.
5. **Render and build.** `render_email` again; an `EmailTemplateError` becomes `PermanentJobError`. The
   handler builds a `multipart/alternative` `EmailMessage` (From `EMAIL_FROM`, To, Subject, Date from
   `clock.now()`, a Message-ID on the sender's domain), with the text part and then the HTML part.
6. **Send.** `aiosmtplib.send(...)` with the host, port, credentials, `start_tls=SMTP_STARTTLS` and
   `timeout=SMTP_TIMEOUT`. On success it logs `email_sent` (`job_id`, `email_template`); the worker marks the
   job `succeeded` and drops `context` from the payload.
7. **Where it fails and what you see:**

   | Failure | Exception | Job | `last_error` |
   |---|---|---|---|
   | 5xx reply | `PermanentJobError` | `dead` | `SMTP 550 5.1.1 (reply withheld)` |
   | 4xx reply | `SMTPTemporaryError` | `queued`, later `run_at` | the same shape |
   | Mailpit down | `SMTPConnectError` / `OSError` | `queued` (retried) | aiosmtplib's own message |
   | Server never answers | `SMTPConnectTimeoutError`, after 20 s | `queued` (retried) | aiosmtplib's own message |

   `jobs-status` shows dead jobs, and the worker logs `job_failed` with the `error_type` only.
8. **Recover.** `jobs-retry <id>` re-queues a dead job within 7 days, with `context` still in the payload.
   After that, the cleanup scrubs `context` and a new email must be queued.

<details><summary>Deeper: the stack check CI runs (criteria 1, 2, 7)</summary>

`scripts/prodlike-checks.sh` (the section after "P3-02 criteria 7, 1 and 2"), against `make prodlike`:
- It queues `email-test` through the API container. Then `delivered` polls Mailpit's API
  (`/api/v1/messages`, `/api/v1/message/{ID}`) for exactly one message to that address, with the From name
  and address and the test text in both parts.
- It runs `docker compose stop mailpit` and queues a second email. `job_is` waits for `queued 1`. After
  `start mailpit`, it waits for delivery and for `succeeded [2-8]`.

CI's run on `6a10d5e` printed `job …: queued 1` and then `succeeded 2`.
</details>

### Data model changes

None. No table or migration; the payload goes into the existing `jobs.payload` JSONB.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/email/service.py` | `queue_email`, `is_allowlisted`, validation helpers | +85 |
| `backend/app/email/handler.py` | `email.send` handler, error classification | +92 |
| `backend/app/email/templates.py` | `render_email`, the Jinja2 environment | +78 |
| `backend/app/email/templates/en/*`, `backend/app/email/templates/fr/README.md` | layout, `test` template, `fr` placeholder | +29 |
| `backend/app/core/config.py` | settings, `validate_email_settings`, `is_email_address`, `_is_loopback` | +106 / −6 |
| `backend/app/cli.py` | `email-test` replaces the placeholder | +20 / −2 |
| `backend/app/jobs/worker.py` | `app.email.handler` in `HANDLER_MODULES` | +7 / −2 |
| `backend/app/logging_config.py` | two log fields | +3 |
| `backend/.env.example`, `.env.dev`, `compose.prodlike.yml` | the new settings | +17 / −1 |
| `backend/pyproject.toml`, `uv.lock` | `jinja2`, `aiosmtplib` | +27 |
| `scripts/prodlike-checks.sh` | the stack email checks | +64 |
| `docs/ARCHITECTURE.md`, the ticket | §9 note; the framing | +53 / −4 |
| `backend/tests/email/*` (7 files) and 4 existing test files | tests; new required fixture inputs | +1155 / −2 |

`backend/app/email/service.py::queue_email` (trimmed)

```python
    if not is_email_address(to):
        raise ValueError("`to` must be one email address")
    if not isinstance(context, dict) or not all(isinstance(key, str) for key in context):
        raise ValueError("`context` must be a dict with string keys")
    # What the jobs table would refuse must fail here, not abort the caller's transaction with a
    # database error (review round 1): NaN and infinities, NUL, lone surrogates, a long key.
    try:
        json.dumps(context, allow_nan=False, ensure_ascii=False).encode()
    except (TypeError, ValueError) as exc:
        raise ValueError(f"`context` must be JSON that Postgres can store: {exc}") from None
    if _has_nul(context):
        raise ValueError("`context` must not contain NUL characters")
    if dedupe_key is not None and not _is_storable_key(dedupe_key):
        raise ValueError(
            f"`dedupe_key` must be at most {MAX_DEDUPE_KEY} characters of UTF-8, no NUL"
        )
    # Rendered now as well as when sent: a missing template or variable fails here, in the
    # caller, instead of as a dead job.
    render_email(template, context, locale)
    payload = {"to": to, "template": template, "locale": locale, "context": context}
    return await enqueue(db, "email.send", payload, dedupe_key=dedupe_key)
```

- What it does: every check raises `ValueError` before any SQL, so the caller's transaction stays usable
  (`test_queue_email_rejects_bad_arguments_and_enqueues_nothing` runs `SELECT 1` afterwards). Then it renders
  (D1) and enqueues without committing.
- Why: rounds 1 and 3 showed values that pass Python but make Postgres refuse the insert (NaN, a lone
  surrogate). A database error there aborts the caller's whole transaction: an invitation would fail for an
  unrelated reason.
- Without `allow_nan=False`, `{"n": float("nan")}` reaches the insert, and the caller gets a `DBAPIError`
  instead of a `ValueError`.

`backend/app/email/handler.py::send_email` (the send and its errors) and `_raise_for_reply`

```python
    try:
        await aiosmtplib.send(
            message,
            hostname=settings.smtp_host,
            port=settings.smtp_port,
            username=settings.smtp_username,
            password=password.get_secret_value() if password is not None else None,
            start_tls=settings.smtp_starttls,
            timeout=SMTP_TIMEOUT,
        )
    except aiosmtplib.SMTPRecipientsRefused as exc:
        # Our one recipient refused: as permanent as its reply code says.
        if not exc.recipients:
            raise SMTPTemporaryError("SMTP recipient refused, no reply code") from None
        _raise_for_reply(exc.recipients[0], all(_is_permanent(r.code) for r in exc.recipients))
    except aiosmtplib.SMTPResponseException as exc:
        _raise_for_reply(exc, _is_permanent(exc.code))
    # ...


def _raise_for_reply(reply: aiosmtplib.SMTPResponseException, permanent: bool) -> NoReturn:
    # ...
    enhanced = _ENHANCED_CODE.match(reply.message)
    text = f"SMTP {reply.code}" + (f" {enhanced[0]}" if enhanced else "") + " (reply withheld)"
    raise (PermanentJobError if permanent else SMTPTemporaryError)(text) from None
```

- What it does: it turns every server reply into an exception that holds only codes. 5xx raises
  `PermanentJobError`, which the worker marks `dead` without retrying; 4xx raises `SMTPTemporaryError`, which
  the worker retries.
- Why: D2 for the classification, D4 for the withheld text. `from None` keeps the reply out of
  `__cause__` too.
- Without `_raise_for_reply`, the 4xx path would put the server's text, which can quote the message (a
  reset link), into `last_error`. That was round 1's High.

`backend/app/email/templates.py::render_email` (the inner `render`)

```python
    def render(part: str) -> str:
        extension = part.rsplit(".", 1)[-1]
        # Set last, so a context key can't replace the layout or the app's own link.
        values = context | {
            "base": env.select_template(_candidates(locale, f"base.{extension}")),
            "locale": locale,
            "app_base_url": settings.app_base_url,
            "sender_name": sender_name or sender_address,
        }
        return env.select_template(_candidates(locale, f"{template}.{part}")).render(values)

    try:
        return RenderedEmail(
            subject=" ".join(render("subject.txt").split()),
            text=render("txt"),
            html=render("html"),
        )
```

- What it does: each part takes `<locale>/<name>.<part>`, falling back to `en/`. The layout (`base.txt` or
  `base.html`) is chosen the same way. The subject is collapsed to one line.
- Why: autoescape is on for names ending in `.html` only (`_environment`), so the HTML is escaped and the
  plain text isn't. Reserved keys are merged last, so a caller can't swap the layout or `app_base_url`
  (`test_caller_cannot_override_the_layout_values`).
- Without the `split()` join, a newline in a name used by the subject would become a new header line
  (`test_subject_is_one_line_whatever_the_context_holds`).

`backend/app/core/config.py::validate_email_settings` (trimmed)

```python
        if self.app_env in {"staging", "prod"} and _is_loopback(self.app_base_url):
            raise ValueError(f"APP_BASE_URL must not be a localhost URL in {self.app_env}")
        if self.app_env == "staging" and not self.email_recipient_allowlist:
            # Staging must never email real people (its SES sandbox identities = the allowlist).
            raise ValueError("EMAIL_RECIPIENT_ALLOWLIST must not be empty in staging")
        if self.is_production:
            if not self.app_base_url.startswith("https://"):
                raise ValueError("APP_BASE_URL must be https:// in production")
            if self.email_from == DEV_EMAIL_FROM:
                raise ValueError("EMAIL_FROM must be set to a real verified sender in production")
            if not self.smtp_starttls:
                raise ValueError("SMTP_STARTTLS must be true in production")
```

- What it does: it refuses to start staging without an allowlist (criterion 6). It refuses deployed links
  that point at localhost, including shorthand forms like `127.1`, read by `_is_loopback` through
  `inet_aton`. In production it refuses dev senders and plaintext SMTP.
- Without the staging check, staging with an unset variable would email every recipient, real people
  included.

`backend/tests/email/test_send.py::test_smtp_reply_text_never_reaches_last_error` (the hardest criterion, AC8)

```python
async def test_smtp_reply_text_never_reaches_last_error(
    sessions: Sessions,
    smtp: FakeSMTP,
    frozen_clock: FrozenClock,
    command: str,
    reply: str,
    status: JobStatus,
    kept: str,
) -> None:
    smtp.replies[command] = reply.format(QUOTED_PRIVATE)
    job_id = await queue(sessions, context={"name": QUOTED_PRIVATE})

    await worker(sessions).run_once()

    job = await load(sessions, job_id)
    assert job.status is status
    assert job.last_error is not None
    assert "synthetic-reset-token-73" not in job.last_error
    assert "Reilly" not in job.last_error
    assert kept in job.last_error
```

- It runs a real `Worker` and real `aiosmtplib` against a fake SMTP server on a socket
  (`backend/tests/email/conftest.py::FakeSMTP`). It is parametrized over 451 DATA, 450 RCPT, 421 MAIL,
  554 DATA and 550 RCPT. Before the round-1 fix it failed 5 of 5 (PR #73 Independent review).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A context value `<script>` | escaped in HTML, plain in text | `backend/tests/email/test_render.py::test_html_part_escapes_context_text_part_does_not` |
| A newline in the subject's values | collapsed to spaces | `backend/tests/email/test_render.py::test_subject_is_one_line_whatever_the_context_holds` |
| A caller passes `base` or `app_base_url` | reserved keys win | `backend/tests/email/test_render.py::test_caller_cannot_override_the_layout_values` |
| `fr` has no file for a part | that part uses `en` | `backend/tests/email/test_render.py::test_fr_falls_back_to_en_per_part`, `::test_fr_falls_back_to_en_when_fr_has_no_file` |
| An unknown or traversing name, or a bad locale | `EmailTemplateError` | `backend/tests/email/test_render.py::test_unknown_or_malformed_template_name_is_an_error`, `::test_unsupported_locale_is_an_error` |
| A missing variable or part | `EmailTemplateError` | `backend/tests/email/test_render.py::test_missing_variable_is_an_error`, `::test_missing_part_is_an_error`, `backend/tests/email/test_queue.py::test_queue_email_rejects_a_context_missing_a_variable` |
| A bad `to`, context or `dedupe_key` (37 cases) | `ValueError`, nothing enqueued, transaction usable | `backend/tests/email/test_queue.py::test_queue_email_rejects_bad_arguments_and_enqueues_nothing` |
| A valid long or dotted address | accepted | `backend/tests/email/test_queue.py::test_queue_email_accepts_the_longest_address`, `::test_queue_email_accepts_dotted_local_parts` |
| A rollback | no job | `backend/tests/email/test_queue.py::test_rolled_back_transaction_leaves_no_job`; fitness `backend/tests/test_architecture.py::test_only_services_and_entry_points_commit` |
| Mailpit down, then back | retried, then delivered | `backend/tests/email/test_send.py::test_connection_refused_is_retried_then_delivered` |
| A silent server | 20 s timeout, retried | `backend/tests/email/test_send.py::test_server_that_never_answers_times_out_and_is_retried` |
| 5xx | dead, 1 attempt | `backend/tests/email/test_send.py::test_smtp_5xx_goes_dead_without_retry` |
| 4xx, and 4xx on the last attempt | retried, then dead after 8 | `backend/tests/email/test_send.py::test_smtp_4xx_is_retried_and_error_has_no_context`, `::test_last_attempt_4xx_goes_dead` |
| The reply quotes a token | text withheld | `backend/tests/email/test_send.py::test_smtp_reply_text_never_reaches_last_error` |
| The template is gone at send time | dead, nothing sent | `backend/tests/email/test_send.py::test_missing_template_at_send_time_goes_dead` |
| Not allowlisted | succeeded, skip log with the domain only | `backend/tests/email/test_send.py::test_non_allowlisted_recipient_is_skipped_and_succeeds` |
| A look-alike domain | no match | `backend/tests/email/test_allowlist.py::test_domain_entry_matches_no_other_domain` |
| Credentials over plaintext | settings refuse | `backend/tests/email/test_config_email.py::test_smtp_credentials_need_starttls` |
| Duplicate send after a worker crash | sent twice | No test (accepted, ADR-0006; §7) |

Acceptance criteria → tests:

1. `email-test` reaches Mailpit with text, HTML and From:
   - `backend/tests/email/test_send.py::test_sends_multipart_text_and_html_with_from_header`;
   - `backend/tests/email/test_cli_email.py::test_email_test_queues_one_test_email`;
   - CI `prodlike`.
2. Mailpit stopped, then back: `backend/tests/email/test_send.py::test_connection_refused_is_retried_then_delivered`; CI `prodlike`.
3. 550 goes dead without retries: `backend/tests/email/test_send.py::test_smtp_5xx_goes_dead_without_retry`.
4. Allowlist skip: `backend/tests/email/test_send.py::test_non_allowlisted_recipient_is_skipped_and_succeeds`.
5. Escaping: `backend/tests/email/test_render.py::test_html_part_escapes_context_text_part_does_not`.
6. Staging needs an allowlist: `backend/tests/email/test_config_email.py::test_staging_requires_an_allowlist`.
7. Through the image's worker: CI `prodlike`, `scripts/prodlike-checks.sh`.
8. 4xx retried, no context in the error: `backend/tests/email/test_send.py::test_smtp_4xx_is_retried_and_error_has_no_context`,
   `::test_smtp_reply_text_never_reaches_last_error`.
9. Scrub on success: `backend/tests/email/test_send.py::test_success_scrubs_context_and_keeps_the_rest`.
10. Bad arguments: `backend/tests/email/test_queue.py::test_queue_email_rejects_bad_arguments_and_enqueues_nothing`.
11. Rollback: `backend/tests/email/test_queue.py::test_rolled_back_transaction_leaves_no_job`.
12. `fr` fallback: `backend/tests/email/test_render.py::test_fr_falls_back_to_en_per_part`.
13. One-line subject: `backend/tests/email/test_render.py::test_subject_is_one_line_whatever_the_context_holds`.
14. Template gone at send time: `backend/tests/email/test_send.py::test_missing_template_at_send_time_goes_dead`.
15. Allowlist matching and the skip log: `backend/tests/email/test_allowlist.py`, `backend/tests/email/test_config_email.py::test_malformed_allowlist_entry_fails`.
16. Deployed settings: `backend/tests/email/test_config_email.py::test_deployed_app_base_url_is_not_loopback`,
    `::test_prod_app_base_url_is_https`, `::test_prod_email_from_is_not_the_dev_default`.
17. CLI usage error: `backend/tests/email/test_cli_email.py::test_bad_address_exits_1_without_a_session`.

Mutation evidence: the PR lists 12 mutation probes on `6a10d5e` (removing the allowlist check, autoescape,
the 5xx/4xx split, the scrub, the subject collapse, the staging check, and more), each caught by the named
tests. The review-round fixes have red-then-green evidence instead (§6).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol, high, fresh | `6a10d5e` | BLOCK | High: SMTP 4xx text bypassed the redaction. Medium: NaN/Infinity aborted the caller's transaction. Low: `JsonFormatter` dropped `recipient_domain`. Note: the missing-variable tests had no layout | All fixed in `7e9f27b` |
| 2 | Codex gpt-6.1-sol, high, fresh | `7e9f27b` | MERGE | Medium: `https://127.1`-style hosts passed the loopback check. Medium: `ann..lee@`, `.ann@`, `ann.@` reached `enqueue` | Both fixed in `631a456` |
| 3 | Codex gpt-6.1-sol, high, fresh | `631a456` | BLOCK | Medium: a lone surrogate or non-ASCII in `to` (the insert fails; 66 octets). Low: a lone surrogate in `dedupe_key` | Fixed in `87431ca`, not reviewed; James accepted (B-4 option B) |

James named the reviewer for this run (no Claude cross-check). That is not the playbook's Tier 2 default of
one fresh Claude reviewer.

Failures and evidence, per fix:
- **Round 1, High:** a 451 DATA reply quoting `For "O'Reilly": https://…/reset?token=synthetic-reset-token-73`
  left the token in `last_error`. Fixed by D4. `test_smtp_reply_text_never_reaches_last_error` failed 5/5
  before the fix and passes after; Codex's proof failed before and passed after.
- **Round 1, Medium:** `queue_email(context={"measurement": float("nan")})` reached the insert and raised
  `DBAPIError`. The NaN, Infinity and -Infinity rows of the bad-arguments test now also assert `SELECT 1`.
  Neighbours (NUL in a value, a key or a tuple; lone surrogates in the context; a long `dedupe_key`) were
  added at the same time, each failing first.
- **Round 1, Low:** the skip test asserted on the `LogRecord`, so it missed the formatter. It now formats
  the record with `JsonFormatter`. Without the field it fails with `KeyError: 'recipient_domain'` (checked by
  a mutation in this session).
- **Round 2:** the new address and base-URL cases failed before the fixes (34 failures in the red run, plus
  one from my own wrong arithmetic in the longest-address test, corrected). The same rule was applied to every caller
  of `is_email_address` (allowlist entries, `EMAIL_FROM`, the CLI) and of `_is_loopback`
  (`TRUSTED_ORIGINS`: `test_deployed_trusted_origins_reject_numeric_loopback`).
- **Round 3:** `to="\ud800@example.test"` raised `DBAPIError` at the insert. `"é"*33 + "@example.test"`
  was enqueued with a 66-octet local part. `dedupe_key="email:\ud800"` failed at the insert. Fixed by
  `is_email_address` requiring ASCII and by `_is_storable_key`. The new rows failed before and pass after;
  Codex's 4 proofs pass. This is the one fix no reviewer checked.

Round 3's finding is a neighbour of round 1's fix that the round-1 list missed: it named other *values*,
not other *fields* reaching the same insert (logged in `docs/AGENT_MISTAKES_LOG.md`).

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **No review of the round-3 fix** (`87431ca`). James accepted it as it is (inbox B-4).
- Delivery through SES, STARTTLS and SMTP authentication against a real server: the credentials path is
  checked only with a fake `aiosmtplib.send` (`backend/tests/email/test_send.py::test_credentials_and_starttls_reach_aiosmtplib`).
  Tracked in D-06.
- No session ran the stack locally (no Docker). The stack criteria (1, 2, 7) rest on CI's `prodlike` job.
- Local tests ran on Postgres 16; CI runs 18.
- How mail clients render the HTML layout: not checked.

Accepted risks:
- At-least-once delivery: a worker that dies between the SMTP accept and the job update sends twice
  (ADR-0006). Tracked only here and in ADR-0006.
- Internationalized (SMTPUTF8) addresses are refused. Tracked only here.
- `@domain` doesn't cover subdomains. Tracked only here.
- `to` stays in a succeeded job's payload for 14 days. Tracked only here.
- An `APP_BASE_URL` hostname that resolves to loopback is not detected (no DNS at startup). D-06 checks
  staging's real links.

Follow-ups:
- Remove the unused `SES_FROM_EMAIL` (and its prod check) once D-01 sets `EMAIL_FROM`. Fix the
  `email_recipient_allowlist` comment in `config.py`, which names the wrong validator. Both are added to
  the D-01 ticket in the bookkeeping commit.

## 8. How to change this safely

- **Add an email** (P4-02's invitation):
  - add `en/<name>.subject.txt`, `.txt` and `.html` under `backend/app/email/templates/` (the bodies use
    `{% extends base %}` and a `body` block);
  - call `queue_email` from the service, before its single commit;
  - put links and tokens **in `context`**, never in `to` or the template name: only `context` is scrubbed
    and redacted.

  `backend/tests/email/test_render.py` patterns show how to test a template with a temp root (include `LAYOUT`).
- **Change error handling:** keep `_raise_for_reply` the only way a reply reaches an exception.
  `test_smtp_reply_text_never_reaches_last_error` and `test_smtp_5xx_goes_dead_without_retry` will catch a
  regression.
- **Change address rules:** edit `is_email_address` only. The CLI, the allowlist, `EMAIL_FROM` and
  `queue_email` all use it, and their tests (`backend/tests/email/test_queue.py`, `backend/tests/email/test_config_email.py`, `backend/tests/email/test_cli_email.py`)
  cover each caller.
- **Add a log field:** add it to `backend/app/logging_config.py::JsonFormatter`'s list, or it is dropped
  silently. Test it through the formatter, not the `LogRecord`.

## 9. Must explain, then quiz

**1. Why is email sent by the worker and never inside the request?**
- SMTP is slow and fails on its own schedule. In a request, a Mailpit or SES outage would turn "invite a
  staff member" into a 500, and the user would retry and send twice.
- Through `queue_email`, the job commits atomically with the business change (the outbox,
  [ADR-0006](../adr/0006-postgres-job-queue.md)): no invitation row without its email job, and no email for
  a rolled-back invitation (`test_rolled_back_transaction_leaves_no_job`).
- The worker retries with backoff (`test_connection_refused_is_retried_then_delivered`). `CLAUDE.md` rule 6
  makes it a rule.

**2. Why does a non-allowlisted recipient count as "succeeded" rather than "failed"?** The skip is the
intended outcome on staging, not an error. Retrying can't change the allowlist answer, so a failure would
burn 8 attempts and then sit in the dead list, where operators look for real problems. `send_email` returns
after logging `email_skipped_not_allowlisted` with the domain only.
`test_non_allowlisted_recipient_is_skipped_and_succeeds` asserts `succeeded` after 1 attempt with nothing sent.

**3. Which SMTP errors are worth retrying, and which aren't?**
- 4xx replies are the server saying "not now": greylisting, mailbox busy, rate limits.
- Connection refused, DNS failure and timeouts are outages.
- 5xx replies are a definite "no" that the same message won't change: an unknown user, a rejected sender or
  content.

`_is_permanent` draws the line at 500–599 (D2). `test_smtp_5xx_goes_dead_without_retry` and
`test_smtp_4xx_is_retried_and_error_has_no_context` prove it.

**4. Why must HTML templates autoescape?** Context values come from users: a resident's name, a package
note. Without escaping, a name like `<a href=…>` or `<script>` becomes markup in an email sent from the
building's address, so phishing looks official. `_environment` turns on autoescape for `.html` names only
(plain text must not show `&lt;`). `test_html_part_escapes_context_text_part_does_not` and
`test_layout_values_are_escaped_in_html_too` check both sides.

Quiz:

1. A caller queues an invitation inside a transaction that later raises and rolls back. What does the
   recipient get, and why?
2. Why does `queue_email` refuse `{"n": float("nan")}` itself, instead of letting the database refuse it?
3. What would break if `_raise_for_reply` kept `reply.message` in its exception's text?
4. What would break if `sensitive_keys=("context",)` were removed from `send_email`'s registration?
5. How would you add SMS later: what is reused and what is new?

<details><summary>Answers</summary>

1. Nothing. `enqueue` inserts the job in the caller's transaction, and `queue_email` never commits; the
   rollback removes the job (`test_rolled_back_transaction_leaves_no_job`).
2. JSONB refuses `NaN`, and that database error aborts the caller's whole transaction, so the business
   change fails for an email detail. A `ValueError` before any SQL leaves the transaction usable (the test's
   `SELECT 1`).
3. A server that quotes the message back would put context values (reset links, tokens) into `last_error`,
   kept for 7 days and shown by `jobs-status`. The worker's exact-value redaction misses escaped spellings
   (round 1's High).
4. Two things. A succeeded job would keep its `context` (links, tokens) in the payload for 14 days, so
   `test_success_scrubs_context_and_keeps_the_rest` fails. And `describe_error` would no longer redact
   context values from `last_error`. The probe M5 removed it and 5 tests failed.
5. Reuse the outbox pattern: a `queue_sms` that validates and calls `enqueue("sms.send", …)`, a handler with
   its own `sensitive_keys`, the allowlist idea (`SMS_RECIPIENT_ALLOWLIST` required on staging), and a
   permanent/temporary split mapped from the provider's errors. New: a provider client (a new external
   service needs an ADR, `CLAUDE.md` rule 13), number validation, and templates without HTML.

</details>
