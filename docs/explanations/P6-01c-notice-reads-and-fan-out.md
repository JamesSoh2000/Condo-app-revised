# Explanation — P6-01c Notice reads, unread summary and publish fan-out

> **PR:** #126 · **Source revision:** `2626da3941b7a5411bf7bd747b0558a3cadf781f`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 126 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (25 paths) at `2626da3`, the whole of
> `backend/app/notices/service.py` changes and the helpers it calls (`backend/app/notifications/service.py::notify`,
> `backend/app/email/service.py::queue_emails`, `backend/app/jobs/service.py::enqueue_many`,
> `backend/app/notices/queries.py::visible_notices`), the model and migration, and the assertions of every test cited
> below; ran `make test DB_PORT=55432 PYTEST_ADDOPTS="-q tests/notices tests/notifications tests/jobs/test_queue.py
> tests/email/test_queue.py tests/test_world.py"`: **409 passed in 46.21s**. CI on this commit: all five jobs green.
> Differences from the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A.

## 1. What was built and why

The member's half of notices. A member marks a notice read (`POST /notices/{id}/read`, 204) and asks how many
live notices they haven't read (`GET /notices/summary` → `{unread, urgent_unread}`), for P6-02's badge and urgent
banner; every `NoticeOut` now carries the caller's own `read_at`. Publishing a notice now tells every active member
of the building but the publisher: one notification INSERT for all of them and, for an urgent notice, one email-job
INSERT for all of them, both in the publish's transaction. The ticket's "Watch" was the fan-out's cost: `notify`
queued each email with its own INSERT, so an urgent notice to 600 members was about 600 statements. Now
`notify` queues a call's emails in one statement for every caller (D4), and the publish runs **13 statements at 6
recipients and at 606** (measured by a test). Review round 1 added one more rule: the publish re-checks the expiry
after the fan-out, because the fan-out's INSERTs can wait on locks (§6).

## 2. Decisions

### D1. A publish notifies every active member but the publisher

- **Problem or constraint:** the ticket left open who "every active member" is ("the publisher too? council?").
- **Chosen:** every `active` membership of the building, whatever its roles (residents, security, council, other
  managers), minus the publishing user; pending, suspended and other buildings' members get nothing. The list comes
  from `backend/app/notifications/service.py::active_member_user_ids`, in user-id order.
- **Alternatives rejected:** everyone including the publisher: emails the author their own urgent notice. Residents
  only: PRODUCT_SCOPE gives security and council building notices to read.
- **Tradeoffs and accepted limitations:** the publisher gets no notification of their own notice, yet it still counts
  as unread in their summary until they mark it read (the summary is about the feed, not notifications).
- **Basis:** autonomous (decision rule 3); criterion 3 sharpened in the frame.
- **Source:** recorded (PR #126 D1, ticket Frame notes D1).

### D2. Two notification kinds; the urgent email reuses the `notification` template, title only

- **Problem or constraint:** one kind with an email flag or two kinds; which template the urgent email uses and what
  it holds.
- **Chosen:** `notice.published` (in-app only) and `notice.published_urgent` (in-app plus the generic
  `notification` email). The notification's title is fixed ("New notice" / "Urgent notice"), its body is the
  notice's title, its link `/notices/{id}`, its entity `notice`/id. The email carries the same three values, not the
  notice's Markdown body.
- **Alternatives rejected:** one kind with a flag: `NotificationKind` already fixes one template per kind, so a flag
  would add a `notify` parameter for every caller. A dedicated template: the same text as `notification` in en and
  fr. The body in the email: Markdown renders in the app (P6-02), and 600 copies of up to 10 000 characters would go
  into the single jobs INSERT.
- **Tradeoffs and accepted limitations:** the email says what was posted and links to it but doesn't carry the full
  text. The `/notices/{id}` page is P6-02's to build.
- **Basis:** existing convention (`backend/app/notifications/kinds.py::NotificationKind`), autonomous.
- **Source:** recorded (PR #126 D2).

### D3. Reads follow `visible_notices`; the summary counts live published notices for every role

- **Problem or constraint:** may a manager mark a draft read; the status code; what the summary counts for a manager,
  who sees drafts, archived and expired notices.
- **Chosen:** `mark_read` checks `visible_notices(ctx)` with `.exists()` (else 404 `notice_not_found`), so a manager
  may mark any notice they can see; then `INSERT … ON CONFLICT DO NOTHING`; 204; no audit row. The summary narrows
  `visible_notices(ctx)` with `live()` (published and not expired, the same predicate non-managers are granted, now
  one function) and "no read of this membership". A read belongs to the membership, not the user.
- **Alternatives rejected:** refusing a manager's read of a draft: a 404 or 409 on a notice they can open, and a second
  visibility rule (CLAUDE.md rule 3). Counting everything a manager sees: a draft would light the urgent banner.
  200 with a body: the notifications read is 204.
- **Tradeoffs and accepted limitations:** a manager's read of a draft is a row nothing uses except `read_at`.
- **Basis:** CLAUDE.md rule 3; existing convention (`POST /notifications/{id}/read`); autonomous.
- **Source:** recorded (PR #126 D3).

### D4. `notify` queues every email of one call in one INSERT, for every caller

- **Problem or constraint:** `notify` queued each email through `queue_email` → `enqueue`, one INSERT each. The
  per-recipient dedupe keys had to stay, in a stable order: two concurrent `notify` calls of one entity that insert
  the same keys in different orders deadlock (P3-03, Codex round 2 there).
- **Chosen:** `notify` collects `EmailRecipient`s in sorted user-id order and calls `queue_emails` once. `queue_emails`
  checks every recipient and the shared context before any SQL (the template is rendered once per locale), then
  `enqueue_many` sends one `INSERT … VALUES (…), (…) ON CONFLICT (dedupe_key) DO NOTHING RETURNING id`, rows in the
  given order. `queue_email` keeps its signature and shares the checks.
- **Alternatives rejected:** a notices-only bulk path: `notify` itself was the N-statement path, and packages'
  fan-out would keep it. Turning `queue_email` into a list API: its callers want one job id back.
- **Tradeoffs and accepted limitations:** a statement takes at most 32 767 bind parameters (asyncpg), so one call
  tops out near 3 600 recipients (the notifications INSERT, 9 per row). `emails=` in `notify`'s timing log now counts
  the rows the INSERT returned.
- **Basis:** the ticket's Why and Interfaces.
- **Source:** recorded (PR #126 D4).

### D5. `read_at` on list and get is a SQLAlchemy `query_expression`

- **Problem or constraint:** `paginate` reads one entity with `db.scalars`, so a second selected column never reaches
  its mapper; yet `NoticeOut` must carry the caller's `read_at`.
- **Chosen:** `Notice.read_at = query_expression()`, filled by `.options(with_expression(Notice.read_at,
  _read_at(ctx)))`, where `_read_at` is a correlated scalar subquery on `notice_reads` for `ctx.membership_id`. Write
  routes build their answer with `_out`, one SELECT of the caller's read.
- **Alternatives rejected:** a second query for the page's reads plus `model_copy` per item: more code, same result.
  A default `read_at = None` on `NoticeOut`: the OpenAPI schema would mark it optional.
- **Tradeoffs and accepted limitations:** a per-viewer attribute on the ORM class; it is None wherever no query loads
  it.
- **Basis:** autonomous, found while implementing.
- **Source:** recorded (PR #126 D5, and the deviation note below the Plan).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `notice_reads` PK `(notice_id, membership_id)`, RESTRICT FKs, `read_at` default `now()` | surrogate id + unique | the pair is what the upsert keys on | ticket, convention | PR table |
| `datetime.max` UTC refused (422 `datetime_range`) | clamp it | a silent change of input | P6-01b carry | PR table |
| `statements` fixture moved to `backend/tests/conftest.py`, skipping the harness's savepoints | a copy per file | three files use it | convention | PR table |
| CLAUDE.md "slow await" lesson sharpened to "after the *last* wait" | a fitness test | a lock-holding test helper is a ticket of its own; the lesson only adds | playbook step 8 | PR table |
| Replaced draft attachments stay claimed; feed order left to P6-02 | a retention rule; an index now | product decision; the order shows only in P6-02 | P6-01b carries | PR table |

**Framing changes:** criteria 1–5 sharpened (204; the summary counts live published notices; the recipients and the
two kinds; statements counted at two sizes; the failure injected after `notify`); 1a (a read writes nothing else),
2a (`read_at` on every answer) and 3a (every `notify` caller now bulk-enqueues) added; the `datetime.max` carry
added. Nothing loosened; "every active member" resolved to exclude the publisher (D1), an open question the ticket
asked, listed for audit.

**Plan versus final code:** two deviations, both deliberate. (1) The Plan said list and get would select `read_at`
with an outer join; the code uses `query_expression` (D5), recorded below the PR's Plan. (2) The Plan described the
summary as an anti-join with two `count(*) FILTER`s; the code expresses "not read" as the correlated subquery
`_read_at(ctx) IS NULL` and counts with `count(*)` plus one `FILTER` — the same rows, one query. One review-driven
addition the Plan didn't have: the expiry re-check at the end of `publish_notice` (§6, R1-F1).

## 3. How it is implemented

### Overview

- `notice_reads` holds one row per (notice, membership) that has been read.
- `backend/app/notices/service.py::mark_read` writes it; `::notice_summary` counts what has none;
  `::_read_at` is the subquery both reads and the `NoticeOut`s use.
- `backend/app/notices/service.py::publish_notice` calls `::_tell_members` after its conditional UPDATE: one
  `notify` call with every active member but the publisher.
- `notify` → `queue_emails` → `enqueue_many`: one INSERT for the rows, one for the email jobs.
- The worker sends the emails later (ADR-0006); nothing here talks to SMTP.

### Walkthrough (variant A): an urgent publish

1. **HTTP:** `POST /api/buildings/{b}/notices/{id}/publish` → `backend/app/notices/router.py::publish`
   (manager only, `notices` feature on).
2. **Tenant context:** session → `get_tenant_context` (one SELECT of the membership and its roles).
3. **Lock and state:** `::_locked` selects the notice through `visible_notices(ctx)` `FOR UPDATE`; a concurrent
   publish waits here and then sees `published` (409 `invalid_transition`).
4. **Publish:** `UPDATE notices SET status='published', published_at=statement_timestamp(), … WHERE id=… AND
   building_id=… AND status IN ('draft') AND (expires_at IS NULL OR expires_at > statement_timestamp()) RETURNING
   notices.*`. No row → 422 `notice_expired`.
5. **Fan-out:** `::_tell_members` reads the recipients
   (`SELECT building_memberships.user_id … WHERE building_id=… AND status='active' ORDER BY user_id`) and calls
   `notify` with kind `notice.published_urgent`. `notify` sends `INSERT INTO notifications … VALUES (…), (…)` (one
   row per recipient), `SELECT users.id, email, locale, is_active … WHERE id IN (…)`, then
   `INSERT INTO jobs … VALUES (…), (…) ON CONFLICT (dedupe_key) DO NOTHING RETURNING jobs.id` with one `email.send`
   job per active user with a sendable address, in user-id order, each keyed
   `notice.published_urgent:<notice id>:<user id>`.
6. **Audit and answer:** `record_audit` adds `notice.published`; `::_out` selects the manager's own `read_at`.
7. **Expiry again:** only if the notice has `expires_at`: flush (the audit INSERT), then `::_check_future` reads a
   fresh `statement_timestamp()`; past → 422 and everything rolls back (§6).
8. **Commit** once; **200** with `NoticeOut` (its `read_at` the manager's own).

A normal notice is the same without the jobs INSERT. The read is shorter: `SELECT EXISTS (<visible_notices> AND
id=…)`, then `INSERT INTO notice_reads (building_id, notice_id, membership_id) VALUES (…) ON CONFLICT (notice_id,
membership_id) DO NOTHING`, commit, 204. The summary is one statement:
`SELECT count(*), count(*) FILTER (WHERE priority='urgent') FROM (SELECT notices.priority FROM notices WHERE
building_id=… AND <grant> AND status='published' AND (expires_at IS NULL OR expires_at > now()) AND (SELECT read_at
FROM notice_reads WHERE notice_id=notices.id AND membership_id=…) IS NULL)`.

### Data model changes

`notice_reads` (migration `b006d25a3f56`):

| Column / constraint | Why |
|---|---|
| PK `(notice_id, membership_id)` | one read per member per notice; it is the conflict target that keeps the first `read_at` |
| FK `(building_id, notice_id)` → `notices(building_id, id)` | a read can't point at another building's notice (ADR-0005); P6-01a added the unique pair it targets |
| FK `(building_id, membership_id)` → `building_memberships(building_id, id)` | nor at another building's membership |
| FK `building_id` → `buildings`, all RESTRICT | as the notices table: history isn't deleted from under it |
| `read_at` NOT NULL, default `now()` | the database sets it; the API never sends it |

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/notices/service.py` | `mark_read`, `notice_summary`, `_read_at`, `_out`, `_tell_members`; publish fan-out and expiry re-check | +98 / −10 |
| `backend/app/notices/models.py` | `NoticeRead`; `Notice.read_at` expression | +30 / −1 |
| `backend/app/notices/queries.py` | `live()` shared by the grant and the summary | +9 / −3 |
| `backend/app/notices/router.py`, `schemas.py` | two routes; `read_at`, `NoticeSummary`, `datetime.max` refusal | +34 / −2 |
| `backend/app/notifications/service.py`, `kinds.py` | bulk emails in `notify`; `active_member_user_ids`; two kinds | +36 / −16 |
| `backend/app/email/service.py`, `backend/app/jobs/service.py` | `queue_emails`, `EmailRecipient`; `enqueue_many` | +86 / −8 |
| `backend/migrations/versions/b006d25a3f56_notice_reads_p6_01c.py` | the table | +57 |
| `backend/tests/…` (10 files) | new `test_reads.py`, `test_fan_out.py`; additions elsewhere | +1093 / −27 |
| `frontend/src/api/schema.d.ts`, `client.test.ts` | regenerated types; the summary path | +169 |
| `CLAUDE.md`, ticket, index | lesson sharpened; frame; status | +60 / −5 |

`backend/app/notices/service.py::publish_notice` (the end)

```python
    if published is None:
        # The row is locked and a draft: only the expiry can have refused it.
        raise NoticeExpired(detail="This notice's expiry has passed; change it, then publish.")
    # After the UPDATE that won the row, before the audit: one transaction (the P6-01b carry).
    await _tell_members(db, ctx, published)
    await _audit(db, ctx, actions.NOTICE_PUBLISHED, notice_id, {})
    out = await _out(db, ctx, published)
    if published.expires_at is not None:
        # Again after the last statement that can wait: the fan-out's INSERTs wait on a membership
        # or a dedupe key another transaction holds, and the expiry may pass meanwhile (review
        # round 1, Codex). The flush sends the pending audit row first (autoflush is off). Raising
        # rolls the publish, the notifications and the jobs back.
        await db.flush()
        await _check_future(db, published.expires_at)
    await db.commit()
    return out
```

- The fan-out runs only for the publish that won the row lock and the conditional UPDATE, so a losing concurrent
  publish (409) never notifies anyone (criterion 6).
- Everything before `commit` is one transaction: a failure anywhere leaves no publish, notifications or jobs
  (criterion 5).
- Without the flush, the audit INSERT would go out at commit, after the check; without the check, an expiry passing
  during a lock wait in the fan-out is published (R1-F1).

`backend/app/notices/service.py::_tell_members`

```python
    urgent = notice.priority is NoticePriority.URGENT
    members = await active_member_user_ids(db, ctx.building_id)
    await notify(
        db,
        building_id=ctx.building_id,
        recipient_user_ids=[user_id for user_id in members if user_id != ctx.user_id],
        kind="notice.published_urgent" if urgent else "notice.published",
        # Fixed; the notice's title (at most 200 characters) fits the notification's body.
        title="Urgent notice" if urgent else "New notice",
        body=notice.title,
        link=f"/notices/{notice.id}",
        entity_type=NOTICE_ATTACHED_TYPE,
        entity_id=notice.id,
    )
```

- D1 is the list comprehension; D2 is the kind choice. The notification body column is 1 000 characters and the
  notice title at most 200, so `notify`'s length check never refuses it. The entity id makes each email's dedupe key
  unique per notice and user.

`backend/app/notifications/service.py::notify` (the email part)

```python
        emails: list[EmailRecipient] = []
        # In id order: each dedupe key is a unique-index entry that a concurrent `notify` of the
        # same entity also inserts, so callers taking them in different orders would deadlock
        # (Codex review round 2). One INSERT for them all (P6-01c), in this order.
        for user_id in sorted(recipients):
            user = by_id[user_id]
            if not user.is_active or not is_email_address(user.email):
                # ...
                continue
            emails.append(
                EmailRecipient(
                    to=user.email,
                    locale=user.locale if user.locale in SUPPORTED_LOCALES else DEFAULT_LOCALE,
                    # Without an entity there is nothing to tell two events apart by.
                    dedupe_key=f"{kind}:{entity_id}:{user_id}" if entity_id is not None else None,
                )
            )
        # Counts only the jobs added: a dedupe key an earlier call queued adds none.
        emailed = await queue_emails(
            db, template=spec.email_template, context=context, recipients=emails
        )
```

- Remove `sorted(...)` and the deadlock guard is gone: mutation m1 makes
  `test_every_email_of_a_call_is_queued_in_one_statement` fail on the key order.

`backend/app/jobs/service.py::enqueue_many`

```python
    if not jobs:
        return 0
    now = clock.now()
    statement = (
        insert(Job)
        .values(
            [
                {
                    "kind": kind,
                    "payload": payload,
                    "run_at": now,
                    "dedupe_key": dedupe_key,
                    "max_attempts": DEFAULT_MAX_ATTEMPTS,
                }
                for payload, dedupe_key in jobs
            ]
        )
        .on_conflict_do_nothing(index_elements=[Job.dedupe_key])
        .returning(Job.id)
    )
    return len((await db.execute(statement)).all())
```

- A multi-row VALUES is one statement for any number of jobs; Postgres inserts its rows in VALUES order, which is
  the order the deadlock rule needs. `DO NOTHING` also skips a key repeated within the same statement
  (`test_enqueue_many_skips_existing_and_repeated_dedupe_keys`). `RETURNING` lists only the rows added, so the count
  is what was really queued. Mutation m2 (one INSERT per job) made the statement test see 618 statements against 18.

`backend/app/notices/service.py::mark_read` and `::notice_summary`

```python
    seen = await db.scalar(select(visible_notices(ctx).where(Notice.id == notice_id).exists()))
    if not seen:
        raise NoticeNotFound(detail="Notice not found.")
    # ...
    await db.execute(
        pg_insert(NoticeRead)
        .values(building_id=ctx.building_id, notice_id=notice_id, membership_id=ctx.membership_id)
        .on_conflict_do_nothing(index_elements=[NoticeRead.notice_id, NoticeRead.membership_id])
    )
    await db.commit()
# ...
    unread = (
        visible_notices(ctx)
        .where(live(), _read_at(ctx).is_(None))
        .with_only_columns(Notice.priority)
        .subquery()
    )
    urgent = func.count().filter(unread.c.priority == NoticePriority.URGENT)
    total, urgent_total = (await db.execute(select(func.count(), urgent).select_from(unread))).one()
```

- Both start from `visible_notices(ctx)` (CLAUDE.md rule 3), so another building's notice and a hidden one answer
  like a missing one. `DO NOTHING` keeps the first `read_at` (m4: `DO UPDATE SET read_at = now()` fails
  `test_marking_read_twice_keeps_one_row_and_the_first_read_at`). Without `live()` a manager's drafts would count
  (m3).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A member reads a draft, archived or expired notice | 404 `notice_not_found`, same body as a random id | `backend/tests/notices/test_reads.py::test_a_notice_hidden_from_a_member_is_404_like_an_unknown_one` (3 personas × 3 states) |
| Another building's notice through this building | 404 `notice_not_found`, no row | `backend/tests/notices/test_reads.py::test_another_buildings_notice_is_404_through_this_building` |
| Non-member, pending, suspended; no session; feature off | 404 `building_not_found`; 401; 403 `feature_disabled` | `test_non_members_get_404_on_read_and_summary`, `test_read_and_summary_are_401_without_a_session`, `test_read_and_summary_are_403_when_the_feature_is_off` |
| Reading twice, or two reads at once | one row, the first `read_at` | `test_marking_read_twice_keeps_one_row_and_the_first_read_at`; `backend/tests/notices/test_concurrency.py::test_two_simultaneous_reads_keep_one_row_and_the_first_read_at` |
| A read row pointing across buildings | composite FK refuses it | `backend/tests/notices/test_reads.py::test_the_table_refuses_a_read_across_buildings` |
| A member of two buildings | reads count per membership | `test_a_read_in_one_building_does_not_count_in_another` |
| An expired notice in the summary | not counted, read or not | `test_the_summary_counts_only_live_published_notices_for_every_role` |
| Another member's read leaking into `read_at` | each answer uses the caller's membership | `test_list_and_get_show_the_callers_own_read_at`, `test_the_write_answers_show_the_managers_own_read_at` |
| Publisher, pending, suspended or B members notified | only other active members of A | `backend/tests/notices/test_fan_out.py::test_a_normal_notice_tells_every_other_active_member_in_app_only` (m5) |
| Inactive user or unsendable address | the row, no job | `test_an_urgent_notice_also_emails_each_sendable_active_member_in_one_insert` |
| Nobody else to tell | no INSERT at all | `test_a_building_with_nobody_else_publishes_without_notifications` |
| Statements growing with members | 13 at 6 and at 606 | `test_the_publish_runs_the_same_statements_for_6_and_606_recipients` (m2) |
| A failure after the fan-out | all rolled back | `test_a_failure_after_the_fan_out_leaves_nothing` |
| Two publishes at once | one notification set, one job set | `backend/tests/notices/test_concurrency.py::test_two_concurrent_publishes_tell_the_members_once` |
| Expiry passing while the fan-out waits | 422, nothing persists | `backend/tests/notices/test_concurrency.py::test_a_notice_expiring_while_its_fan_out_waits_is_not_published` (m8) |
| Other `notify` callers (packages, onboarding) | same behaviour, bulk emails | their suites, unchanged and green; `backend/tests/notifications/test_concurrency.py` (pause moved, assertions unchanged) |
| `expires_at` = `datetime.max` UTC | 422 | `backend/tests/notices/test_api.py::test_invalid_input_is_a_422_and_writes_nothing`, `test_an_invalid_edit_is_a_422_and_changes_nothing` (m7) |

Acceptance criteria → tests: **1** the read rows above; **1a** `test_a_read_writes_no_audit_row_and_changes_no_notification`
(compares every notification column, R1-N1); **2** `test_reading_the_urgent_notice_takes_it_out_of_both_counts`;
**2a** the two `read_at` tests; **3/3a** the four `test_fan_out.py` recipient tests and
`backend/tests/notifications/test_notify.py::test_every_email_of_a_call_is_queued_in_one_statement`; **4** the 6/606 statement test (time in
the PR: 158, 160, 166 ms); **5** `test_a_failure_after_the_fan_out_leaves_nothing`; **6**
`test_two_concurrent_publishes_tell_the_members_once`. Stack journey (curl on `make up`, PR evidence): summary
`{2,1}` → `{1,0}` for the reader, unchanged for resident2, 13 "Urgent notice" emails in mailpit.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high | `3bad916` | MERGE | R1-F1 Low: expiry not re-checked after the fan-out's waits; R1-N1 coverage: criterion 1a only counted rows | both fixed in `b64471a` (typing `2626da3`) |
| 2 | Codex `gpt-6.1-sol`, high (new run) | `2626da3` | MERGE | none | — |

James's instruction for this run: Codex at high effort as the reviewer, with no fresh Claude reviewer.

**R1-F1.** Inputs: an urgent draft whose `expires_at` is one second away, and another transaction holding resident1's
membership `FOR UPDATE`. The notifications INSERT needs KEY SHARE on each recipient's membership (the foreign key),
so the publish waited there past the expiry; it then answered **200** and committed an expired notice with 6
notifications and 6 email jobs. Codex's proof, moved to
`backend/tests/notices/test_concurrency.py::test_a_notice_expiring_while_its_fan_out_waits_is_not_published`
(normal and urgent), failed with `assert '200' == '422 notice_expired'` and passes after the fix; mutation m8
(removing the re-check) fails it again. No new decision record: it applies the CLAUDE.md lesson this PR sharpened —
check after the *last* statement that can wait. The PR lists the fix's neighbours (no expiry, the jobs and audit
waits, other ways to publish).

**R1-N1.** With no notifications in place, "no notification change" was proven only by a count. The test now
creates the reader's `notice.published` notification first and compares every column of every notification
before and after.

Codex's two passing independent checks (the cross-building FKs, simultaneous reads) were kept as tests.

## 7. Not verified, accepted risks and follow-ups

- **Not verified:** the fan-out beyond 606 recipients; the bind-parameter ceiling (about 3 600 recipients per
  `notify` call) is reasoned from asyncpg's limit, not run. The 158–166 ms is the whole request through the test
  client on a local Postgres, not production hardware. The two waits besides the membership one (a dedupe-key
  collision at the jobs INSERT, a lock at the audit INSERT) have no test of their own; the re-check runs after both.
  Mutation probes were not run for criteria 5 and 6 (their tests were not mutated).
- **Accepted:** a manager's own published notice counts as unread for them until read (D1). A manager's read of a
  draft is stored and unused (D3). An expiry passing between the re-check and the commit is accepted: nothing between
  them waits.
- **Follow-ups** (in the PR's follow-ups; the bookkeeping commit carries them to P6-02's stub or the inbox):
  chunk `notify` if a building ever nears the parameter ceiling; P6-02 owns the `/notices/{id}` route the
  notifications link to and the feed order; replaced draft attachments stay claimed (P6-01b D6).

## 8. How to change this safely

- **A new thing that counts as "unread"** (a reminder, a pinned notice): narrow the summary in
  `backend/app/notices/service.py::notice_summary`, never with a hand-written visibility filter; extend
  `test_the_summary_counts_only_live_published_notices_for_every_role`.
- **A new fan-out** (P7 maintenance updates): call `notify` once with every recipient; don't loop over it. The
  `statements` fixture in `backend/tests/conftest.py` counts statements; copy
  `test_the_publish_runs_the_same_statements_for_6_and_606_recipients`.
- **Anything added to `publish_notice` after the fan-out that can wait on a lock** must stay before the expiry
  re-check; `test_a_notice_expiring_while_its_fan_out_waits_is_not_published` catches a re-check moved too early.
- **Changing `enqueue_many`'s row order** breaks the deadlock guard; `backend/tests/notifications/test_concurrency.py` and
  `test_the_email_jobs_are_inserted_in_recipient_id_order` cover it.

## 9. Must explain, then quiz

**1. Count the statements of an urgent publish to 600 members, and say which one grows with N.** Measured by
`test_the_publish_runs_the_same_statements_for_6_and_606_recipients`: 13 at 606 recipients and 13 at 6. Three are
the test's login (`as_user`), one reads the session, and nine are the publish: the tenant context, the notice
`FOR UPDATE`, the `UPDATE … RETURNING`, the recipients' SELECT, `INSERT INTO notifications`, the users' SELECT,
`INSERT INTO jobs`, the caller's `read_at`, `INSERT INTO audit_events`. With an `expires_at` the re-check adds one
SELECT, still constant. None repeats per recipient; three grow in **size**: the two INSERTs (rows) and the users'
`IN (…)` (parameters).

**2. Why is the email queued in the request's transaction but sent by the worker?** Queued in the transaction
(`backend/app/jobs/service.py::enqueue_many`, never committing) so the job exists only if the publish commits: a
rollback (criterion 5, R1-F1's 422) leaves no email for a notice that was never published — the outbox of ADR-0006.
Sent by the worker so SMTP's latency and failures (retries, `max_attempts`) never hold the request or the notice's
row lock (CLAUDE.md rule 6).

**3. Why `ON CONFLICT DO NOTHING` for the read marker, and what does a second read return?** The PK
`(notice_id, membership_id)` makes a second row impossible; `DO NOTHING` turns the conflict into a no-op instead of
an `IntegrityError`, and keeps the first `read_at` (an update would move it). Two reads at once: the second INSERT
waits on the first's uncommitted row, then does nothing (`test_two_simultaneous_reads_keep_one_row_and_the_first_read_at`).
A second read returns 204 with no body, the same as the first.

Quiz:

1. The world's `multi` user is a resident in building A and security in building B. They read an A notice. What
   does their B summary say, and why?
2. Why does `notify` sort the recipients before queueing emails, when `active_member_user_ids` already returns them
   sorted?
3. A manager has two unread drafts and one unread expired urgent notice. What does their summary return?
4. What breaks if the `await db.flush()` before `_check_future` in `publish_notice` is removed?
5. How would you extend the fan-out so a council member can opt out of normal-notice notifications?

<details><summary>Answers</summary>

1. Unchanged by it: reads belong to the membership (`notice_reads.membership_id`), and B's summary uses B's
   membership (`test_a_read_in_one_building_does_not_count_in_another`). It also couldn't be an A notice: B's
   `visible_notices` filters by building.
2. `notify` has other callers (packages pass unit occupants in start-date order, onboarding passes one user); the
   order rule belongs where the keys are inserted, not with each caller. `test_every_email_of_a_call_is_queued_in_one_statement`
   passes recipients out of order.
3. `{unread: 0, urgent_unread: 0}`: the summary narrows to `live()` for every role, so drafts and expired notices
   never count (D3).
4. With autoflush off, the audit INSERT would go out at commit, after the check, so a lock wait there (on the
   building row its FK shares) could again let an expiry pass unseen. No test isolates that wait (§7).
5. Store the preference (a table or a membership column), filter it in `_tell_members` before calling `notify`
   (one SELECT, so the statement count stays constant), and add a case to the recipient test and the 6/606
   statement test.

</details>
