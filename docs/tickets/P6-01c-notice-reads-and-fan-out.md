# P6-01c — Notice reads, unread summary and publish fan-out

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-01b, P3-03, P3-02 |
| Replaces old | M6-T03 (read and notify part) |
| Status | todo |

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
