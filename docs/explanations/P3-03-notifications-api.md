# Explanation — P3-03 In-app notifications API

> **PR:** #76 · **Source revision:** `d0068ea`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 76 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** at `d0068ea` I re-read `git diff origin/main...HEAD` (23 paths), these files in full:
> `backend/app/notifications/{service,models,router,schemas,kinds}.py`, the migration `05c58ec89743`, the
> `notification` email templates and `backend/tests/notifications/*` (their assertions), and the PR body (no
> comments or reviews on the PR). I compiled the mark-read UPDATE and the summary COUNT with SQLAlchemy's
> Postgres dialect (pasted in §3) and ran
> `pytest tests/notifications tests/test_architecture.py tests/test_world.py`: 126 passed. Differences from
> the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A (the routes), plus the `notify` call path.
> **Reviewer note:** at James's instruction in the session, every review round was a fresh Codex
> `gpt-6.1-sol` run at high effort, not a Claude subagent (PR "Independent review").

## 1. What was built and why

Domain code (packages, onboarding, notices) now notifies people with one call. `notify()` writes one
`notifications` row per recipient in **one** multi-row `INSERT`, then queues each recipient's email through
P3-02's `queue_email`. Both happen in the caller's transaction, so a package and its notifications commit or
roll back together. Each user gets four routes in each building where they are an active member: a
paginated list, an unread count for the badge, mark one read (idempotent), and mark all read.

The decisions that matter most:
- The recipient is tied to a **membership in the building** by a composite FK, of any status, so a denied
  applicant can still be emailed (D1).
- Email goes only to active users with a sendable address. Everyone else gets the in-app row only (D3).

## 2. Decisions

### D1. The recipient references their membership in the building

- **Problem or constraint:** `notify` takes user ids from domain code. A wrong id (someone from another
  building) would write a row nobody can read, then email a person outside the building. ADR-0005 and
  CLAUDE.md rule 2 say new references use composite FKs.
- **Chosen:** FK `(building_id, recipient_user_id)` → `building_memberships (building_id, user_id)`, named
  `fk_notifications_building_id_recipient_user_id`. It accepts any membership status. Only active members can
  *read* rows, because the routes run behind `get_tenant_context`.
- **Alternatives rejected:**
  - An FK to `users` only: it allows recipients outside the building.
  - Filtering to active members inside `notify`: it would drop the `membership.denied` email silently.
  - Storing `membership_id`: the ticket names `recipient_user_id`, and the routes filter by user.
- **Tradeoffs and accepted limitations:** a bad id raises `IntegrityError` and aborts the caller's whole
  transaction, not a clean `ValueError`.
- **Basis:** ADR-0005; "any status" is autonomous. **Source:** recorded (PR D1, ticket Frame notes).

### D2. One generic `notification` email template for the four starting kinds

- **Problem or constraint:** each kind may name a default email template, and `queue_email` refuses a template
  that doesn't exist. Four kinds start now; their real wording comes with P4-05 and P5-02.
- **Chosen:** all four in `backend/app/notifications/kinds.py::KINDS` use `notification`. It renders the row's
  own title, body and `APP_BASE_URL + link`, so the email says what the app says. A kind can switch to its own
  template later; `email_context` carries the extra values.
- **Alternatives rejected:**
  - Four bespoke templates now: 12 files of copy that later tickets would rewrite.
  - No email yet: contradicts criterion 1 and "all registered kinds email by default".
- **Tradeoffs and accepted limitations:** the emails stay generic until the domain tickets add their own. French
  falls back to the English files (P3-02's file-by-file fallback), so a French user gets English wording.
- **Basis:** ticket; autonomous. **Source:** recorded (PR D2).

### D3. Who gets the email

- **Problem or constraint:** `queue_email` raises `ValueError` for an address it can't send (P3-02 allows
  ASCII dot-atoms only) or for an unsupported locale. Raising inside `notify` would block a whole building's
  notification because of one user.
- **Chosen:** every recipient gets the row. Email goes only to users with `is_active` and an address that
  `is_email_address` accepts, in `user.locale` when it is supported, else `en`. A skipped recipient is logged by
  user id only, never by address (rule 10).
- **Alternatives rejected:** letting `queue_email` raise (one bad address blocks everyone); skipping the row
  too (that user can still read the app).
- **Tradeoffs and accepted limitations:** a deactivated user still gets rows they can't read.
- **Basis:** autonomous. **Source:** recorded (PR D3).

### D4. Emails are queued in user-id order (review round 2)

- **Problem or constraint:** each email carries a dedupe key, and the jobs table holds those keys in a unique
  index. Codex reproduced the problem with two concurrent `notify` calls for one entity, recipients `[A, B]`
  and `[B, A]`. Each call held the key the other needed next, and Postgres aborted one caller with
  `deadlock detected`.
- **Chosen:** the email loop runs over `sorted(recipients)`. The row insert keeps the caller's order: rows have
  no unique key, so they take no conflicting locks.
- **Alternatives rejected:**
  - Sorting the rows too: not needed, no unique index.
  - Retrying the deadlock inside `notify`: it can't retry the caller's transaction.
- **Tradeoffs and accepted limitations:** a domain caller that enqueues *its own* deduped jobs in the same
  transaction can still deadlock against another caller. `notify` controls only its own loop (§7).
- **Basis:** review finding (round 2, Medium). **Source:** recorded (PR "Independent review", round 2).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| No dedupe key when `entity_id` is None | `kind:None:user` | would swallow every later email of that kind to that user while the job row lives | autonomous | PR table |
| `link` must be an app path (`/…`, not `//…`, `/\…`, no whitespace or controls) | any string | an email link to another site or a `javascript:` URL from a buggy caller | autonomous | PR table |
| Values over their column length, or containing NUL, raise `ValueError` before any write | let Postgres refuse | a database error aborts the caller's transaction with an unclear message; matches `queue_email` | convention (P3-02) | PR table |
| Mark-read is one `UPDATE … SET read_at = COALESCE(read_at, now)`; no row → 404 | `WHERE read_at IS NULL`, then a `SELECT` to tell "already read" from "not yours" | two statements for the same answer | CLAUDE.md rules 1, 7 | PR table |
| One multi-row `INSERT … VALUES`, ids from `uuid7()` | ORM `add_all` / `executemany` | the criterion is one statement; multi-row VALUES guarantees it | ticket criterion 6 | PR table |
| A `ck_notifications_entity_complete` CHECK (both or neither) | rely on `notify`'s check | a backstop for any other writer; mirrors `files.attachment_complete` | convention | PR deviation |
| The ticket's index `(recipient_user_id, building_id, read_at, id DESC)` kept | a partial unread index plus `(recipient, building, id DESC)` | the ticket names it; revisit with real data | ticket | PR table |

**Framing changes** (ticket Frame notes, commit `6a1ea84`):
- Criterion 1 now names the job fields, the dedupe key and how rollback is shown.
- New criteria: 1a–1d (dedupe, duplicate and empty recipients, input checks, who gets email); 8 (summary
  scope); 9 (10-case row 7); 10 (the P1-03 carry: active occupants only, tested with `a_suspended`); 11 (staff);
  12 (templates).
- **Criterion 6 was narrowed** to "the row insert is one statement and takes < 300 ms". The whole call isn't
  bounded, because a probe showed 600 `queue_email` calls alone take 479 ms, and the ticket requires one per
  recipient. The total is logged. This is listed for audit in the inbox.

**Plan versus final code** (all recorded in the PR below its Plan):
- **Size:** 489 non-test lines against the ~380 estimate. The migration is 79 of them, and docstrings and
  comments account for much of the rest.
- **The CHECK** was added (above).
- **Route function names:** `list`, `summary`, `read` and `read_all`, because operation ids are
  `<tag>_<function>` (`backend/app/main.py::operation_id`).
- **Return type:** `notify` returns `None`, not the planned `list[UUID]`.
- **Review rounds:**
  - Round 1: the timing line is logged on every call and counts only emails actually queued.
  - Round 2: D4 (emails in user-id order), plus `test_concurrency.py`, which the plan didn't have.

## 3. How it is implemented

### Overview

- `notify` (`backend/app/notifications/service.py::notify`):
  1. validates, de-duplicates the recipients and runs one `INSERT` into `notifications`;
  2. for an email kind, loads the recipients' users in one `SELECT`;
  3. calls `queue_email` per sendable user, in id order;
  4. logs one timing line.

  It never commits.
- **Recipient helpers:**
  - `backend/app/notifications/service.py::staff_user_ids`: active members holding any of the roles.
  - `backend/app/notifications/service.py::unit_resident_user_ids`: current occupants with an active
    membership.
- **The four routes** (`backend/app/notifications/router.py`) sit on `building_router`, so they run after
  `get_tenant_context` (any active role). Each service call filters by
  `backend/app/notifications/service.py::_own`: this building and this user.
- **The worker** sends the queued `email.send` jobs later (P3-02). This ticket adds only the template.

### Walkthrough (variant A): `POST /api/buildings/{b}/notifications/{id}/read`

1. **HTTP:** `backend/app/notifications/router.py::read`, status 204. CSRF headers are required, as on every
   unsafe method. The journey in the PR shows a 403 without them, on read-all.
2. **Dependencies:** session cookie → `get_tenant_context`. A non-member, a pending or suspended member, or
   another building's member gets 404 `building_not_found`
   (`backend/tests/notifications/test_api.py::test_routes_refuse_outsiders`).
3. **Service:** `backend/app/notifications/service.py::mark_read` runs one statement (compiled at
   `d0068ea`):

   ```sql
   UPDATE notifications SET read_at=coalesce(notifications.read_at, %(coalesce_1)s::TIMESTAMP WITH TIME ZONE),
     updated_at=now()
   WHERE notifications.id = %(id_1)s::UUID AND notifications.building_id = %(building_id_1)s::UUID
     AND notifications.recipient_user_id = %(recipient_user_id_1)s::UUID
   RETURNING notifications.id
   ```

   `COALESCE` keeps an existing `read_at`, so a repeat changes nothing visible. `updated_at=now()` comes from
   `TimestampMixin`'s `onupdate`, so a repeat still bumps `updated_at`.
4. **No row** (another user's, another building's, or no such id) → `NotificationNotFound`, 404
   `notification_not_found`. All three cases get the same body.
5. **Commit:** once, in the use case (rule 5). **Response:** an empty 204.

The **summary** is one `COUNT(*)` with the same filter plus `read_at IS NULL`:

```sql
SELECT count(*) AS count_1 FROM notifications
WHERE notifications.building_id = %(building_id_1)s::UUID
  AND notifications.recipient_user_id = %(recipient_user_id_1)s::UUID AND notifications.read_at IS NULL
```

The **list** is `paginate()` over `select(Notification).where(*_own(ctx))`, with `read_at IS NULL` for
`unread_only`: ordered `id DESC`, with a keyset cursor `id < cursor`. **Read-all** is
`UPDATE … WHERE <own> AND read_at IS NULL`, so rows already read keep their time.

### Data model changes

The `notifications` table (migration `05c58ec89743`, revises `478316869a1a`):
- **Columns:**
  - `building_id`, `recipient_user_id`
  - `kind` (64), `title` (200), `body` (1000), `link` (300, null)
  - `entity_type` (40, null), `entity_id` (null)
  - `read_at` (null)
  - `id` (uuid7), `created_at`, `updated_at`
- **Constraints:**
  - `fk_notifications_building_id_buildings`: the building exists.
  - `fk_notifications_building_id_recipient_user_id` (D1): prevents a recipient outside the building.
  - `ck_notifications_entity_complete`: prevents a dedupe key or a client link built from half an entity.
- **Index:** `ix_notifications_recipient_user_id_building_id_read_at_id` on
  `(recipient_user_id, building_id, read_at, id DESC)`. It is the ticket's index, and it serves the summary and
  `unread_only` with equality on `read_at IS NULL`.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/notifications/service.py` | `notify`, helpers, the four use cases | +244 |
| `backend/app/notifications/models.py` | `Notification`, FK, CHECK, index | +58 |
| `backend/app/notifications/router.py` | four routes | +48 |
| `backend/app/notifications/kinds.py` | `KINDS` registry | +32 |
| `backend/app/notifications/schemas.py` | `NotificationOut`, `NotificationSummary` | +22 |
| `backend/migrations/versions/05c58ec89743_notifications_p3_03.py` | the table | +79 |
| `backend/app/email/templates/en/notification.{subject.txt,txt,html}` | the generic email | +14 |
| `backend/app/main.py`, `backend/app/models/registry.py` | register router and model | +3 |
| `backend/tests/notifications/*` | `test_notify.py`, `test_api.py`, `test_concurrency.py`, `conftest.py` | +967 |
| `backend/tests/test_architecture.py`, `backend/tests/test_world.py` | gate additions (`NON_COMMITTING_HELPERS`, row count) | +4 −1 |
| `frontend/src/api/schema.d.ts`, `frontend/src/api/client.test.ts` | regenerated types; two new GET paths pinned | +328 |
| `docs/tickets/P3-03-notifications-api.md`, `docs/tickets/README.md` | frame, status | +64 −13 |

`backend/app/notifications/service.py::notify` (trimmed):

```python
    started = time.perf_counter()
    spec = KINDS.get(kind)
    if spec is None:
        raise ValueError(f"unknown notification kind {kind!r}")
    _check_text(title=title, body=body, link=link, entity_type=entity_type)
    # ...  (empty title, link shape, entity both-or-neither)
    # In order, each once.
    recipients = list(dict.fromkeys(recipient_user_ids))
    if not recipients:
        _log_timing(kind, 0, 0, started)
        return

    # Multi-row VALUES: one statement for any number of recipients (criterion 6).
    await db.execute(
        insert(Notification).values(
            [
                {
                    "id": uuid7(),
                    "building_id": building_id,
                    "recipient_user_id": user_id,
                    # ... kind, title, body, link, entity_type, entity_id
                }
                for user_id in recipients
            ]
        )
    )

    emailed = 0
    if spec.email_template is not None:
        users = await db.execute(
            select(User.id, User.email, User.locale, User.is_active).where(User.id.in_(recipients))
        )
        by_id = {row.id: row for row in users}
        # Set last, so the email says what the in-app row says.
        context = (email_context or {}) | {"title": title, "body": body, "link": link}
        # In id order: ... (Codex review round 2).
        for user_id in sorted(recipients):
            user = by_id[user_id]
            if not user.is_active or not is_email_address(user.email):
                # By id only: never log the address (CLAUDE.md rule 10).
                logger.info(
                    "notify: no email for user %s (inactive or unsendable address)", user_id
                )
                continue
            job_id = await queue_email(
                db,
                to=user.email,
                template=spec.email_template,
                context=context,
                locale=user.locale if user.locale in SUPPORTED_LOCALES else DEFAULT_LOCALE,
                # Without an entity there is nothing to tell two events apart by.
                dedupe_key=f"{kind}:{entity_id}:{user_id}" if entity_id is not None else None,
            )
            # None: an earlier call already queued this email (the dedupe key).
            if job_id is not None:
                emailed += 1
    _log_timing(kind, len(recipients), emailed, started)
```

- **What it does:** it validates everything before writing anything, writes all rows in one statement, then
  queues the emails.
- **Why:**
  - Validation comes first because a Postgres error would abort the caller's transaction (PR table).
  - The rows go in one statement because of criterion 6.
  - The emails go in sorted order because of D4.
- **What breaks without parts of it:**
  - Drop `sorted(...)`: concurrent opposite-order calls deadlock
    (`backend/tests/notifications/test_concurrency.py::test_concurrent_notifies_of_one_entity_in_opposite_orders_both_finish`
    fails with `deadlock detected`; probe in the PR).
  - Drop the `is_active` / address check: inactive users get email (mutation M7 in the PR).
  - Drop the dedupe key: a repeat sends a second email (M3).

`backend/app/notifications/service.py::_own` and `mark_read`:

```python
def _own(ctx: TenantContext) -> tuple[Any, ...]:
    """The caller's notifications in the URL's building: the filter of every route below."""
    return (
        Notification.building_id == ctx.building_id,
        Notification.recipient_user_id == ctx.user_id,
    )
# ...
async def mark_read(db: AsyncSession, ctx: TenantContext, notification_id: UUID) -> None:
    """Mark one of the caller's notifications read; again is a no-op, `read_at` is kept."""
    marked = await db.scalar(
        update(Notification)
        .where(Notification.id == notification_id, *_own(ctx))
        .values(read_at=func.coalesce(Notification.read_at, clock.now()))
        .returning(Notification.id)
    )
    if marked is None:
        # The same answer for another user's, another building's and no notification (ADR-0004).
        raise NotificationNotFound(detail="Notification not found.")
    await db.commit()
```

- **What it does:** one filter, shared by all four routes, holds both tenancy rules: the building from the URL
  and the user from the session.
- **What breaks without it:**
  - Drop the recipient filter: five API tests fail (mutation M2).
  - Drop the building filter: `multi` sees, counts and marks B's rows through A, and four tests fail (M4).

`backend/app/notifications/models.py::Notification` (the constraints):

```python
    __table_args__ = (
        # The recipient has a membership in this building, of any status: a denied applicant is
        # still told (ADR-0005). Memberships aren't deleted, so RESTRICT never fires in practice.
        ForeignKeyConstraint(
            ["building_id", "recipient_user_id"],
            ["building_memberships.building_id", "building_memberships.user_id"],
            ondelete="RESTRICT",
            name="fk_notifications_building_id_recipient_user_id",
        ),
        CheckConstraint("(entity_type IS NULL) = (entity_id IS NULL)", name="entity_complete"),
    )
```

- **Why the FK works:** its target is the existing unique constraint `UniqueConstraint("building_id",
  "user_id")` on `building_memberships`.
- **Proof:** `backend/tests/notifications/test_notify.py::test_a_recipient_without_a_membership_is_refused`.
  Both `b_resident1` (building B) and `no_membership` are refused, by this constraint name.

`backend/tests/notifications/test_notify.py::test_600_recipients_are_inserted_in_one_statement_under_300_ms`
(trimmed). It is the hardest criterion: it counts statements, not ORM calls.

```python
    def before(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        if statement.startswith("INSERT INTO notifications"):
            timings.append(-time.perf_counter())

    def after(_conn: Any, _cursor: Any, statement: str, *_args: Any) -> None:
        if statement.startswith("INSERT INTO notifications"):
            timings[-1] += time.perf_counter()
    # ... listeners on engine.sync_engine, then notify() for 600 members
    assert len(timings) == 1
    assert timings[0] < 0.3
    assert await db.scalar(select(func.count()).select_from(Notification)) == 600
    assert len(await email_jobs(db)) == 600
    assert "recipients=600" in caplog.text
```

Three local runs logged `row insert 16 ms`, `16 ms` and `17 ms`, with the whole call at 544–565 ms (PR
evidence).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| The caller rolls back | rows and jobs go with it | `backend/tests/notifications/test_notify.py::test_notify_writes_nothing_when_the_caller_rolls_back` |
| A retry of the same event | a new row, no second email | `::test_same_entity_again_adds_a_row_but_no_second_email` |
| No entity | no dedupe key; each call emails | `::test_no_entity_means_no_dedupe_key` |
| A recipient listed twice; an empty list | one row and email; nothing sent to the DB, but a timing line | `::test_a_repeated_recipient_gets_one_row_and_one_email`, `::test_no_recipients_writes_nothing`, `::test_an_empty_call_still_logs_its_timing` |
| Over-long, NUL, empty title, off-site or `javascript:` link, half an entity | `ValueError`, nothing written | `::test_notify_refuses_bad_input` (19 cases), `::test_notify_accepts_inputs_at_their_limits` |
| Half an entity written by another writer | CHECK refuses | `::test_the_table_refuses_half_an_entity` |
| A recipient outside the building | FK refuses | `::test_a_recipient_without_a_membership_is_refused` |
| A denied applicant | gets the row and the email | `::test_a_denied_applicant_can_be_notified` |
| An inactive user; a non-ASCII address | row only; logged by id, not address | `::test_inactive_users_and_refused_addresses_get_no_email` |
| Locale `fr` / unsupported `de` | `fr` / `en` | `::test_email_uses_the_recipients_locale` |
| A deduped or skipped email in the log | `emails=` counts only queued jobs | `::test_the_timing_counts_only_emails_actually_queued` |
| Concurrent opposite-order `notify`; one caller rolls back | both finish; each recipient emailed once | `backend/tests/notifications/test_concurrency.py::test_concurrent_notifies_of_one_entity_in_opposite_orders_both_finish` |
| Concurrent mark-read / read-all | first `read_at` kept | `backend/tests/notifications/test_concurrency.py::test_concurrent_mark_reads_keep_the_first_read_at` |
| A suspended or former occupant | not in `unit_resident_user_ids` | `::test_unit_resident_user_ids_keeps_active_current_occupants` |
| Staff of another building; a suspended staff member | not in `staff_user_ids` | `::test_staff_user_ids_returns_active_staff_of_the_building` |

**Acceptance criteria → tests:**
- **1:** `backend/tests/notifications/test_notify.py::test_notify_writes_rows_and_email_jobs_that_commit_together`, `…_rolls_back`, and
  fitness `test_only_services_and_entry_points_commit`.
- **1a–1d:** see the table above.
- **2:** `backend/tests/notifications/test_api.py::test_resident_lists_only_own_notifications_newest_first`, `::test_unread_only_and_pagination`,
  `::test_bad_cursor_is_400`, `::test_multi_sees_each_buildings_notifications_on_its_route`.
- **3:** `::test_resident_cannot_mark_another_residents_notification_read`.
- **4:** `::test_mark_read_twice_is_204_and_keeps_the_first_read_at`.
- **5:** `::test_read_all_marks_only_own_in_this_building`.
- **6:** the 600-recipient test (§4).
- **7:** fitness `test_another_buildings_member_gets_404_on_every_building_route` and
  `test_every_building_route_without_a_session_is_401` (8 collected cases for the four routes), plus
  `::test_routes_refuse_outsiders` and `::test_every_active_role_can_use_the_routes`.
- **8:** `::test_summary_counts_own_unread_in_this_building`.
- **9:** `::test_multi_cannot_mark_its_b_notification_read_through_a`.
- **10, 11:** the helper tests above.
- **12:** `backend/tests/notifications/test_notify.py::test_every_kinds_template_renders` (4 kinds × en, fr).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `63b9cd5` | MERGE | Low: no timing line for an empty call; deduped emails counted | fixed in `c84e579` |
| 2 | Codex `gpt-6.1-sol` (high), fresh | `c84e579` | MERGE | Medium: concurrent `notify` deadlock | fixed in `6c4c1e2` (+ typing `d0068ea`) |
| 3 | Codex `gpt-6.1-sol` (high), fresh | `d0068ea` | MERGE | none | — |

- **Round 1.**
  - Failure: `notify(recipient_user_ids=[])` returned before logging, contradicting criterion 6's "on every
    call". A repeat that `queue_email` deduped (it returned None) was still logged as `emails=1`.
  - Evidence: Codex's two proofs failed on `63b9cd5`. I re-ran them: 2 failed. The two permanent tests above
    failed before the fix and pass after it. Neighbours (no SQL for an empty call, inactive users counted 0,
    the 600 case) are listed in the PR.
- **Round 2.**
  - Failure: two real connections ran `notify` for one entity with `[A, B]` and `[B, A]`, each pausing after
    its first email. Postgres reported `DBAPIError('… deadlock detected')`, and one caller's transaction was
    lost.
  - Evidence: the concurrency test fails with `sorted` removed (both parametrizations) and passes with it
    (three runs). The `[read_all]` case fails if read-all loses its `read_at IS NULL` filter (probe).
  - Decision D4.

## 7. Not verified, accepted risks and follow-ups

**Not verified:**
- **Total broadcast latency is unbounded.** About 550 ms for 600 recipients locally, all in the caller's
  request. Criterion 6 bounds only the row insert (inbox, Decisions to audit).
- **The "all" list's query plan wasn't checked** (no `EXPLAIN`). With `read_at` before `id` in the index, an
  unfiltered list probably sorts the user's rows in memory. Inferred, not measured.
- **Delivery through a real SMTP server wasn't tested.** Only Mailpit was, in the PR's stack journey (2 emails
  received).
- **The French emails are in English** (D2). The template rendering test only checks that they render.

- **A lone surrogate is not refused by `notify`'s checks.** I found this in the reality pass, after round 3,
  with a throwaway probe. With `title="a\ud800b"`, `notify` raises asyncpg's `DBAPIError` ("invalid input for
  query argument … 'utf-8' codec can't encode"), not the `ValueError` its docstring promises. Nothing is
  written, and the caller's transaction stays usable (a `SELECT` after it worked in the probe). It is the
  P3-02 pattern again: input validated with Python's rules, not the database's. It is Low and unfixed (no
  review round left), and no test covers it.

**Accepted risks and follow-ups:**
- **`notify`'s text checks should also refuse lone surrogates** (`str.encode()` fails), so callers always get
  `ValueError`. Tracked: the PR's follow-ups and `docs/AGENT_MISTAKES_LOG.md` (P3-03 step 8 note).
- **No retention for `notifications`.** Rows are never deleted, so the table grows. A cleanup job needs a
  retention decision. Tracked: the PR's follow-ups, to the inbox in the bookkeeping commit.
- **Domain callers that enqueue their own deduped jobs** next to `notify` need a stable key order too (D4).
  Tracked: the PR's follow-ups and the inbox.
- **Bulk email enqueue** if broadcasts must get faster. Tracked: the PR's follow-ups.
- **A deactivated user's rows are kept unread and unreadable** (D3). Tracked only here.
- **A repeated mark-read bumps `updated_at`** while `read_at` stays put. Harmless; tracked only here.
- **The dedupe key only works while its job row exists.** `jobs.cleanup` deletes succeeded jobs after
  `backend/app/jobs/service.py::SUCCEEDED_RETENTION` (14 days), so a `notify` for the same entity after that
  emails again. Tracked only here.

## 8. How to change this safely

- **To add a kind:**
  - Add a `NotificationKind` to `backend/app/notifications/kinds.py::KINDS`.
  - If it needs its own email, add `app/email/templates/en/<name>.{subject.txt,txt,html}` and name it.
  - `test_every_kinds_template_renders` then checks it renders in en and fr.
- **To add a route:** use `_own(ctx)` for the filter. The fitness test picks the route up automatically.
  Add it to `ROUTES` in `test_api.py` for the real-body 10-case rows.
- **To change `notify`'s loop:** keep the email order deterministic. `test_concurrency.py` will fail
  otherwise.
- **To retain rows for a fixed time:** write a `notifications.cleanup` job on P3-01b's scheduler, as
  `sessions.cleanup` does. Add `delete_*` to `NON_COMMITTING_HELPERS`.

## 9. Must explain, then quiz

**Why one row per recipient instead of one row per event plus a read-receipts table?**
- The ticket's own records don't state the reason; this answer is inferred, with the evidence cited.
- **The gain:** read state is a column on the row each user reads. So the list, the unread count, mark-read
  and read-all are single-table statements on `(recipient_user_id, building_id, …)`
  (`backend/app/notifications/service.py::_own`), with no join and no "missing receipt means unread" logic.
- **The cost:** storage. Title and body are copied per recipient, and a broadcast writes N rows. Criterion 6
  shows the write is cheap: 600 rows in one 16 ms statement.
- **What an event + receipts design would need instead:** an outer join on every badge poll, and a receipt row
  per (user, event) whenever anyone reads.

**Why is the email dedupe key `kind:entity:user`, and what duplicate does it prevent?**
- **It prevents** a second email to the same person about the same event, when `notify` runs again for that
  entity: a retried request, a double submit, two concurrent operations
  (`test_same_entity_again_adds_a_row_but_no_second_email`; the concurrency test).
- **Each part is needed:**
  - Without `user`, only the first recipient of an event would be emailed.
  - Without `entity`, a user would get only one email of each kind, ever.
  - Without `kind`, `package.arrived` and `package.picked_up` for one package would collide.
- **When there's no key:** with no entity there is nothing to tell events apart, so `notify` sets no key
  (the PR's smaller-decision table).
- **What it doesn't dedupe:** the in-app row. A repeat adds a second row.

**Why is the summary endpoint separate from the list?**
- **The badge polls it** every 30 s while the app is open (ADR-0012, docs/ARCHITECTURE.md §10, P3-05). The
  summary answers that poll with one `COUNT(*)` on the index (the SQL in §3) and a tiny body.
- **The list** is paginated, returns full rows, and is fetched only when the panel opens. A count inside the
  list would need a total over every page on every poll.
- Inferred: keeping them apart also lets P3-05 cache and invalidate the two queries separately (its ticket
  plans `useMarkRead` to invalidate both).

**Quiz**

1. A manager approves a resident, and then the approval request fails on a later step and rolls back. Does
   the resident get the email?
2. Why does `mark_read` answer 404, not 403, for another resident's notification, and what in the code makes
   the two cases look identical?
3. What would break if `sorted(recipients)` in `notify` became `recipients`?
4. What would break if the composite FK were replaced by an FK to `users.id` alone?
5. How would you extend this so users can opt out of email for `package.picked_up`?

<details><summary>Answers</summary>

1. **No.** `notify` only adds rows to the caller's transaction (the rows, and the `email.send` jobs via
   `queue_email` → `enqueue`). The rollback removes both, so the worker never sees a job
   (`test_notify_writes_nothing_when_the_caller_rolls_back`).
2. **ADR-0004:** another person's record must not be distinguishable from a missing one. Both cases run the
   same `UPDATE … WHERE id AND <own>`, return no row and raise the same `NotificationNotFound`. The test
   compares the two bodies minus `request_id`.
3. **The deadlock.** Two concurrent `notify` calls for one entity with recipients in different orders can
   deadlock on the jobs table's unique dedupe keys, and Postgres aborts one caller's whole transaction (the
   package with it). `test_concurrency.py` fails with `deadlock detected`.
4. **Recipients outside the building.** `notify` could write a row for someone from another building (and
   email them) without any error. `test_a_recipient_without_a_membership_is_refused` would fail.
5. **Add a preference table** keyed by `(user_id, kind)` or `(membership_id, kind)`. Then in `notify`'s email
   loop, load the opted-out users in the same `SELECT` and skip them like inactive users. Keep the in-app row.
   Add a test next to `test_inactive_users_and_refused_addresses_get_no_email`, and keep the loop's sorted
   order.

</details>
