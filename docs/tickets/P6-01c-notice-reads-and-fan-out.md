# P6-01c — Notice reads, unread summary and publish fan-out

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-01b, P3-03, P3-02 |
| Replaces old | M6-T03 (read and notify part) |
| Status | in progress |

Split from the P6-01 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); after
[P6-01a](./P6-01a-notice-schema-and-visibility.md) and [P6-01b](./P6-01b-notice-authoring-api.md).

## Goal

Members mark notices read and get `{unread, urgent_unread}` for badges and the urgent banner; publishing a
notice notifies every active member in one insert, and emails them only when it is urgent.

## Why

The stub's **Watch** item: a 600-recipient fan-out must stay a single notification insert plus a bulk job
enqueue, measured. Today `app/notifications/service.py::notify` inserts the rows in one statement but queues
each email with its own `queue_email` → `enqueue` INSERT, so an urgent notice to 600 members would be about
600 statements in the request.

## Scope

- In:
  - **table `notice_reads`**: `building_id`, `notice_id`, `membership_id`, `read_at`; unique per
    `(notice_id, membership_id)`; composite FKs to `notices(building_id, id)` and
    `building_memberships(building_id, id)` (ADR-0005); one migration
  - **`POST /notices/{id}/read`** (any member who sees the notice): idempotent; again keeps the first
    `read_at`
  - **`GET /notices/summary`** → `{unread, urgent_unread}` over the caller's visible published notices
  - `NoticeOut` gains the caller's `read_at`
  - **on publish** (P6-01b's `publish_notice`): `notify` to every active member of the building, one bulk
    insert; email only for `urgent`, queued as a bulk job enqueue in the same transaction (ADR-0006)
  - notification kinds and, for urgent, the email template under `app/email/templates/en/`
  - a measurement of the fan-out at 600 recipients (statement count and time), pasted in the PR
- Out: the banner and feed (P6-02); reminders; deleting reads

## Interfaces

Operation ids `notices_read`, `notices_summary`.

- `NoticeSummary(APIModel)`: `unread: int`, `urgent_unread: int`
- `notice_reads` as above; the read is `INSERT … ON CONFLICT DO NOTHING`
- `notify` (or a new bulk helper beside it) enqueues every email job of one call in one statement, keeping
  the per-recipient dedupe keys and their stable order (the P3-03 carry)

## Acceptance criteria

1. **The 10-case table** for read and summary: every active member who sees the notice may mark it read
   (204 or 200, decided in framing); unauthenticated 401; another building, `a_pending`, `a_suspended` 404
   `building_not_found`; a draft or archived notice (for non-managers) or a random id 404
   `notice_not_found`; marking read twice keeps one row and the first `read_at`.
2. **Given** two published notices (one urgent) for `a_resident1`, **when** they read the urgent one,
   **then** the summary goes from `{2, 1}` to `{1, 0}`, and another resident's summary is unchanged.
3. **Given** a publish, **then** every active member of A gets exactly one `notice.published` notification
   (pending, suspended and B members none), in one INSERT; a normal notice queues no email; an urgent one
   queues one `email.send` job per active member with a sendable address, in one INSERT.
4. **Given** 600 active members, **when** an urgent notice is published, **then** the number of statements
   the publish runs does not grow with the recipient count (a test counts them), and the PR records the
   measured time.
5. **Given** a failure after the notifications are inserted and before commit, **then** neither the publish,
   the notifications nor the jobs persist.
6. **Given** two concurrent publishes of one notice, **then** one notification set and one job set.

## Test plan

- `backend/tests/notices/test_reads.py`, `test_fan_out.py` (a statement counter on the engine, as
  `tests/notifications` measured `notify`), `backend/tests/notifications/*` for the bulk enqueue.
- Commands: `make check DB_PORT=55432`; `make gen-api`.

## Likely files

`backend/app/notices/{models,service,router,schemas}.py`, `backend/app/notifications/{service,kinds}.py`,
`backend/app/email/service.py`, `backend/app/jobs/service.py`, `backend/app/email/templates/en/*`,
`backend/migrations/versions/*_notice_reads.py`, `backend/tests/notices/*`.

## Must explain (learning checkpoint)

1. Count the statements of an urgent publish to 600 members, and say which one grows with N, if any.
2. Why is the email queued in the request's transaction but sent by the worker?
3. Why `ON CONFLICT DO NOTHING` for the read marker, and what does a second read return?

## Open decisions (resolve while framing)

Left open by the stub:
- who counts as "every active member" (the publisher too? council?)
- one kind with an email flag, or two kinds (`notice.published`, `notice.published_urgent`)
- whether a manager may mark a draft read, and the read endpoint's status code
- whether the bulk enqueue changes `notify` for every caller or is a notices-only path

## Carried from P6-01b (do while framing)

From PR #125 (explanation `docs/explanations/P6-01b-notice-authoring-api.md` §7):
- **First follow-up (open Low, review round 3):** `expires_at` equal to `datetime.max` in UTC
  (`9999-12-31T23:59:59.999999Z`) is accepted and asyncpg stores Postgres `infinity`; refuse it in
  `app/notices/schemas.py::_in_utc` (422) with a case in `tests/notices/test_api.py`'s input tests.
- The fan-out on publish goes in `publish_notice` after its conditional UPDATE and before `_audit`, inside the same
  transaction; the publish race tests in `tests/notices/test_concurrency.py` must still show one notification set.
- A replaced or cleared draft attachment keeps its claim and S3 object (P6-01b D6); nothing deletes it. Decide whether
  a retention job (P3-04c's deletion path) should, or leave it tracked.
- The feed orders by creation (P6-01b D4); if the resident feed should order by `published_at`, it needs a keyset and
  an index migration.
- Mistake pattern seen twice now (P4-02b, P6-01b R1): a time check read before a later lock wait. Consider a test
  helper that holds a row lock across a request, or a CLAUDE.md lesson sharpening: "check after the *last* wait".

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - 1: the read is **204** (as `POST /notifications/{id}/read`), no body, the same on a repeat. "Who sees the
    notice" is `visible_notices(ctx)`: residents, security and council may mark a live published notice read;
    an expired one (for them) 404s too. A manager may mark any notice they can see (D3). Added: the read and
    the summary need the `notices` feature (403 `feature_disabled` when it is off, as the other notice
    routes); `a_former` (a member with no current unit) may read; a `multi` caller marks it read as their
    membership in A only, and it doesn't show as read through B (the read belongs to a membership).
  - 1a (added): a read writes nothing else: no audit row, no notification change.
  - 2: the summary counts the caller's **live** published notices (published, not expired, by the database
    clock) with no read row of theirs: the same set for a manager, so drafts, archived and expired notices
    never count (D3). Added: an expired unread notice drops out of both counts; a read of an archived
    notice no longer matters once it is archived.
  - 2a (added): `GET /notices` and `GET /notices/{id}` give each notice the caller's `read_at` (null when
    unread), and the write routes' answers give the manager's own; another member's read never shows.
  - 3: recipients are every **active** membership of the building except the publisher's own (D1), each
    user once. A normal notice is kind `notice.published` (in-app only); an urgent one `notice.published_urgent`
    (in-app and email, the `notification` template) (D2). Title fixed ("New notice" / "Urgent notice"),
    body the notice's title, link `/notices/{id}`, entity `notice`/id. The email jobs keep the dedupe key
    `<kind>:<notice id>:<user id>` and are inserted in user-id order (the P3-03 carry).
  - 3a (added): inactive users and unsendable addresses get the in-app row and no job, as `notify` does today;
    every other `notify` caller (packages, onboarding) now queues its emails in one INSERT too (D4), and its
    tests stay green unchanged except where they patch the removed per-email call.
  - 4: the test counts every statement of the publish request at 3 and at 600 recipients and asserts the
    counts equal; the PR records both counts and the 600-recipient time.
  - 5: the failure is injected after `notify` returns (the audit write raises); nothing persists: the notice
    stays a draft, no notifications, no jobs, no audit row.
  - 6: kept, now checked by `tests/notices/test_concurrency.py`'s publish race (one set of notifications, one
    set of jobs).
  - Carried (first follow-up from P6-01b): `expires_at` equal to `datetime.max` UTC is refused with 422 on
    create and edit.
- Criteria loosened (with reason; also listed in the inbox): none. Criterion 3's "every active member" now
  leaves out the publisher: the ticket left that open ("the publisher too?"), so it is a resolution, not a
  loosening; it goes to the inbox for audit with D1.
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
  - **D1 recipients** (autonomous, consequential): every active membership, any role, minus the publisher.
    Alternatives: everyone including the publisher (lost: emails the author their own urgent notice);
    residents only (lost: PRODUCT_SCOPE gives security and council building notices to read). Other managers
    are told.
  - **D2 two kinds** (autonomous, convention): `NotificationKind` already fixes one email template per kind,
    so a second kind needs no change to `notify`. A flag on one kind would add a parameter to every caller.
    The urgent email reuses the `notification` template (title, body, link; en and fr exist): the ticket
    asks for "the email template", and a copy of it would add two locales of identical text. The email holds
    the notice's title and a link, not its Markdown body: the body renders in the app (P6-02), and 600 copies
    of 10 000 characters would go into the jobs INSERT.
  - **D3 reads and the summary** (autonomous): visibility is `visible_notices` alone (CLAUDE.md rule 3), so a
    manager may mark a draft read (harmless, and a 404 on a notice they can open would be odd); the summary
    narrows that query to live published notices with `.where`, so it means "unread on the feed" for every
    role. Status 204 as the notifications read. The read row belongs to the membership (the ticket's
    table), not the user.
  - **D4 bulk enqueue for every caller** (autonomous, ticket Why): `notify` itself made the N statements, so
    fixing it there fixes packages too. New `enqueue_many` in `app/jobs/service.py` and `queue_emails` in
    `app/email/service.py` (one template and context, validated and rendered once per locale); `queue_email`
    stays for single emails.
  - Carried P6-01b items: the attachment retention stays tracked (P3-04c deletes only unclaimed files; a
    retention rule for replaced claims is a product decision, left as a follow-up). The feed order by
    `published_at` is P6-02's (its feed is where the order shows). The twice-seen "time check before the last
    lock wait" pattern: sharpen the CLAUDE.md lesson in this PR (step 8 says the next PR promotes it).
- Split: none (estimate ~320 non-test lines).
