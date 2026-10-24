# Explanation — P6-01b Notice authoring API

> **PR:** #125 · **Source revision:** `63105109326d7b54c3676c1eddbb12a20b21fe1d`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 125 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (11 paths), `backend/app/notices/{service,schemas,router}.py`
> in full, the P6-01a helpers they call (`backend/app/notices/queries.py::visible_notices`, `backend/app/notices/state.py::sources`,
> `backend/app/notices/attachments.py::can_view_notice_attachment`, `backend/app/files/service.py::claim_file`), and the assertions of every test
> cited below, at `6310510`; ran `make test DB_PORT=55432 PYTEST_ADDOPTS="tests/notices -q"`: **174 passed in
> 30.38s**. The last full `make check` on this commit: 2640 backend passed, 1083 frontend passed, exit 0. Differences
> from the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A.

## 1. What was built and why

The manager's half of building notices: six routes under `/api/buildings/{building_id}/notices` to create a
draft, edit it, publish it, archive it, list and get. P6-01a built the table, the state machine and
`visible_notices`; this ticket puts an API on them, following the packages transitions (P5-02b): lock the row,
check the state machine, write with a conditional `UPDATE … WHERE status IN (…) RETURNING`, audit in the same
transaction, commit once. Two choices matter most: **publish checks the expiry in its own UPDATE with one
statement clock** (D5), so an expired notice is never published and the table's check constraint never fires as a
500; and **a draft's attachment can be replaced without releasing the old file**, relying on P6-01a's rule that the
file and the notice must both point at each other (D6). Reads, the unread summary and the publish fan-out are
P6-01c; the UI is P6-02.

## 2. Decisions

### D5. Expiry is refused at create, edit and publish; publish checks it inside its UPDATE

- **Problem or constraint:** P6-01a's carry: publish must refuse an `expires_at` already past by the database clock,
  and `ck_notices_expires_after_published` would otherwise refuse the row as an `IntegrityError` (500). The CLAUDE.md
  lesson (P4-02b) says to re-check after any lock wait, with a fresh clock, in the writing statement.
- **Chosen:** `_NOW = func.statement_timestamp()`. Publish locks the row, then runs
  `UPDATE … WHERE status IN ('draft') AND (expires_at IS NULL OR expires_at > statement_timestamp())` with
  `published_at = statement_timestamp()`. Zero rows on a locked draft can only mean "expired" → 422 `notice_expired`.
  Create and edit call `_check_future` *after* every statement that can wait (round 1 moved it; §6).
- **Alternatives rejected:** `clock_timestamp()`, as packages use: read on each call, so the SET can see a later
  instant than the WHERE and trip the check constraint. `now()`: the transaction's start, before the lock wait.
- **Tradeoffs and accepted limitations:** `published_at` is when the UPDATE statement started, microseconds before
  the row is written. Create/edit refusing a past expiry goes beyond the ticket's "at publish": the same rule, applied
  earlier (Frame notes D5).
- **Basis:** P6-01a carry, CLAUDE.md lesson; autonomous for create/edit.
- **Source:** recorded (ticket Frame notes D5, PR decision D5).

### D6. A draft's attachment can be set, replaced or cleared; the old file is not released

- **Problem or constraint:** `claim_file` has no release, and a manager who uploads the wrong file needs a way to fix
  the draft.
- **Chosen:** an edit claims the new file and points `attachment_file_id` at it, or sets it to null. The old file
  keeps `attached_type='notice'` and `attached_id=<notice>`, but `can_view_notice_attachment` grants a file only when
  the notice's column also names it, so nobody (the manager included) can download it any more. Sending the current
  id back is a no-op.
- **Alternatives rejected:** an attachment fixed at create (a wrong upload would force archiving the draft); a new
  `release_file` in the files module (files is Tier 1, outside this ticket).
- **Tradeoffs and accepted limitations:** the replaced object stays in S3 and its row stays claimed (§7).
- **Basis:** autonomous; relies on P6-01a's both-sides rule.
- **Source:** recorded (Frame notes D6, PR decision D6).

### D9. Every write locks the notice row first, then writes conditionally

- **Problem or constraint:** CLAUDE.md rule 7, a clean 409 for the loser of a race, and a fresh clock for D5.
- **Chosen:** `_locked` runs `visible_notices(ctx) … FOR UPDATE`; then the state check; then a conditional UPDATE.
  Under READ COMMITTED a second writer waits on the lock and then reads the row the first one committed, so it answers
  409 from the new status.
- **Alternatives rejected:** the packages shape (UPDATE first, re-read on zero rows): it leaves publish's clock read
  before a possible lock wait.
- **Tradeoffs and accepted limitations:** one more statement per write.
- **Basis:** CLAUDE.md rule 7, `backend/app/packages/service.py::_transition`.
- **Source:** recorded (PR decision D9).

### D3. Editing a non-draft is 409 `notice_not_editable`

- **Problem or constraint:** the ticket left the code open; an edit isn't a status move.
- **Chosen:** a dedicated `notice_not_editable`.
- **Alternatives rejected:** `invalid_transition`: one code fewer, but one code would then mean two things on one
  resource.
- **Tradeoffs and accepted limitations:** one more code for P6-02 to map.
- **Basis:** autonomous (decision rule 3). **Source:** recorded (PR decision D3).

### D4. The list is ordered by `id DESC` (creation), not `published_at`

- **Problem or constraint:** `paginate` orders by `id`; a draft published later sorts by when it was written.
- **Chosen:** keep `paginate`'s order, which `ix_notices_building_id_status_id` (P6-01a) serves.
- **Alternatives rejected:** a `published_at` keyset with its own cursor and a new index: a second cursor shape and a
  migration here, for drafts published long after they were written.
- **Tradeoffs and accepted limitations:** such a notice lists below newer ones (§7).
- **Basis:** existing convention (`backend/app/core/pagination.py::paginate`). **Source:** recorded (PR decision D4).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D1 Only property management writes | security authors | stub default | ticket | recorded |
| D2 No edit after publish | a new version | stub default; `ALLOWED` has no `published → draft` | ticket, P6-01a | recorded |
| D7 No `Idempotency-Key` on create | as packages | a duplicate draft is harmless and archivable | ticket | recorded |
| D8 Edit: `expires_at`/`attachment_file_id` may be `null`; `title`/`body`/`priority` may not; `{}` is 422 | an empty edit as a no-op | nothing to change is a client error | autonomous | recorded |
| `null` hidden from the edit schema with `SkipJsonSchema[None]` | leaving `T | None` | the generated client would offer a value the server refuses | review round 1 F2 | recorded |
| Body allows `\t \n \r`, refuses every other control character | `printable` as for titles | Markdown needs line breaks and tab indents | autonomous (P6-01a carry) | inferred from `backend/app/notices/schemas.py::_markdown_before_strip`'s comment |

**Framing changes:** criteria 1–8 sharpened (the `multi` persona, a building-B notice on every id route, the edit's
cross-building file, the 409 code, the edit/publish race, the archive columns, list order and filters, the edit's
failure case, control characters and `null` edits); 9 (expiry), 10 (attachment on a draft) and 11 (audit metadata)
added. None loosened (ticket Frame notes, commit `9bd79a2`).

**Plan versus final code:** (1) the Plan's "flow of a write" puts the expiry check before the claim; round 1 found
that wrong and the code now checks after it (§6). (2) The edit's conditional UPDATE is `status = 'draft'`, not
`status IN (sources(…))`: an edit isn't a transition, so there is no `sources` for it. (3) Create has no `_locked`
step (there is no row yet); its only wait is the claim. Otherwise the files, interfaces and tests are as planned.

## 3. How it is implemented

### Overview

- `backend/app/notices/router.py::router`: six routes on `building_router`; every one depends on
  `require_feature(Feature.NOTICES)`, the four writes also on `require_roles(Role.PROPERTY_MANAGEMENT)` (`_AUTHOR`).
- `backend/app/notices/schemas.py`: `NoticeCreate`, `NoticeUpdate`, `NoticeOut`, and the `Title`, `Body`,
  `Expiry` input types that refuse what Postgres or the check constraints would.
- `backend/app/notices/service.py`: one function per route; `_locked`, `_check_future`, `_claim`, `_audit`.
- Reuses P6-01a: `visible_notices` for every read and lock, `assert_transition`/`sources` for publish and archive,
  and the attachment hook for downloads. Audit through `app.audit.service.record_audit`.

### Walkthrough (variant A): `POST /api/buildings/{b}/notices/{id}/publish`

1. **HTTP** → `backend/app/notices/router.py::publish`. CSRF middleware has already checked `X-Requested-With`
   and `Origin` (unsafe method).
2. **Dependencies:** `get_tenant_context` (an active membership of `b`, else 404 `building_not_found`), then
   `require_feature(NOTICES)` (403 `feature_disabled`) and `require_roles(PROPERTY_MANAGEMENT)` (403
   `forbidden_role`).
3. **Service** `backend/app/notices/service.py::publish_notice`:
   - `_locked`: `SELECT notices.* FROM notices WHERE building_id = :b AND id = :id FOR UPDATE` (the manager's
     `_grant` is `true()`, which SQLAlchemy drops; SQL compiled from the statement, not taken from logs). None → 404 `notice_not_found`. A concurrent publish holding the row makes this wait; once
     it commits, Postgres returns the committed row.
   - `assert_transition(status, PUBLISHED)`: anything but `draft` → 409 `invalid_transition`.
   - The conditional UPDATE:
     `UPDATE notices SET status='published', published_at=statement_timestamp(), published_by_membership_id=:m, updated_at=now() WHERE notices.id = :id AND notices.building_id = :b AND notices.status IN ('draft') AND (notices.expires_at IS NULL OR notices.expires_at > statement_timestamp()) RETURNING notices.*`.
     Zero rows → 422 `notice_expired` (the row is locked and a draft, so nothing else can have refused it).
4. **Side effects:** one `audit_events` row `notice.published` with empty metadata, in the same transaction.
5. **Commit** once; **response** 200 `NoticeOut`.

Create follows the same shape without the lock: claim the file (if any) for a fresh `uuid7`, check the expiry,
`INSERT … RETURNING`, audit, commit. Edit: lock, 409 `notice_not_editable` unless `draft`, claim a *new* file,
check the expiry, `UPDATE … WHERE status = 'draft'` with only the fields sent, audit, commit.

### Data model changes

None. No migration (D4 keeps the order the existing index serves).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/notices/service.py` | new: the six use-cases and helpers | +255 |
| `backend/app/notices/schemas.py` | new: input and output models | +112 |
| `backend/app/notices/router.py` | new: the routes | +96 |
| `backend/app/audit/actions.py` | four `NOTICE_*` actions | +5 |
| `backend/app/main.py` | include the router | +2 |
| `frontend/src/api/schema.d.ts` | regenerated | +626 |
| `frontend/src/api/client.test.ts` | the two new GET paths in the path-list type test | +2 |
| `backend/tests/notices/test_api.py`, `test_transitions.py`, `test_concurrency.py` | new tests | +731, +197, +237 |
| `docs/tickets/P6-01b-notice-authoring-api.md` | framing | +87 −21 |

`backend/app/notices/service.py::publish_notice`

```python
    notice = await _locked(db, ctx, notice_id)
    assert_transition(notice.status, NoticeStatus.PUBLISHED)
    published = await db.scalar(
        update(Notice)
        .where(
            Notice.id == notice_id,
            Notice.building_id == ctx.building_id,
            Notice.status.in_(sources(NoticeStatus.PUBLISHED)),
            # Here, not before the lock: a notice that expired while this waited stays a draft,
            # and `expires_after_published` never sees an expired one.
            or_(Notice.expires_at.is_(None), Notice.expires_at > _NOW),
        )
        .values(
            status=NoticeStatus.PUBLISHED,
            published_at=_NOW,
            published_by_membership_id=ctx.membership_id,
        )
        .returning(Notice)
        .execution_options(populate_existing=True)
    )
    if published is None:
        # The row is locked and a draft: only the expiry can have refused it.
        raise NoticeExpired(detail="This notice's expiry has passed; change it, then publish.")
```

- The whole publish decision is in one statement: status and expiry are checked against the same clock value that
  becomes `published_at` (D5).
- Without the `or_(…)` line, an expired draft reaches the check constraint: the round-0 mutation probe of that line
  failed `test_publishing_a_draft_whose_expiry_has_passed_is_422` and the expiring-while-waiting race (PR evidence).

`backend/app/notices/service.py::_locked`

```python
    notice = await db.scalar(
        visible_notices(ctx)
        .where(Notice.id == notice_id)
        .with_for_update()
        .execution_options(populate_existing=True)
    )
    if notice is None:
        # The same answer for another building's notice and none (ADR-0004).
        raise NoticeNotFound(detail="Notice not found.")
    return notice
```

- Through `visible_notices`, so the building filter is the one P6-01a defines (CLAUDE.md rule 3); a building-B id is
  the same 404 as a random one.
- `populate_existing` makes the ORM take the locked row's values, not an identity-map copy from earlier in the session.
- Without `.with_for_update()`, the mutation probe failed 4 of the 8 tests in `test_concurrency.py` at the time.

`backend/app/notices/service.py::update_notice` (the attachment and expiry part)

```python
    values: dict[str, Any] = {name: getattr(data, name) for name in data.model_fields_set}
    if "attachment_file_id" in values:
        file_id = values["attachment_file_id"]
        if file_id == notice.attachment_file_id:
            # The current attachment sent back: already claimed for this notice.
            del values["attachment_file_id"]
        elif file_id is not None:
            await _claim(db, ctx, file_id, notice_id)
    if values.get("expires_at") is not None:
        # After every wait (the row lock, the file claim), as in `create_notice`.
        await _check_future(db, values["expires_at"])
```

- `model_fields_set` is what the client sent: an absent field isn't touched, an explicit `null` clears it (D8).
- The claim runs before the UPDATE, so another building's file is `claim_file`'s 404, not a composite-FK error. If
  anything after it raises, the request's rollback undoes the claim (`test_a_failure_after_an_edits_claim_leaves_both_files_as_they_were`).
- `_check_future` comes last because `claim_file`'s UPDATE can wait on a file row lock (round 1, §6).

`backend/app/notices/schemas.py::NoticeUpdate`

```python
    title: Title | SkipJsonSchema[None] = None
    body: Body | SkipJsonSchema[None] = None
    priority: NoticePriority | SkipJsonSchema[None] = None
    expires_at: Expiry | None = None
    attachment_file_id: UUID | None = None

    @model_validator(mode="after")
    def _something_to_change(self) -> NoticeUpdate:
        if not self.model_fields_set:
            raise ValueError("send at least one field to change")
        required = {"title", "body", "priority"} & self.model_fields_set
        cleared = sorted(name for name in required if getattr(self, name) is None)
        if cleared:
            raise ValueError(f"{', '.join(cleared)} can't be null")
        return self
```

- Optional but never null for the three content fields; the OpenAPI schema says so too (round 1 F2).
- `Expiry` is `AwareDatetime` plus `_in_utc`, which converts to UTC and turns an out-of-range result into a 422
  (round 2).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Two publishes at once | the second waits on `_locked`, reads `published`, 409 | `backend/tests/notices/test_concurrency.py::test_two_concurrent_publishes_have_one_winner` (one 200, one 409, one audit row) |
| Publish and archive at once | either order ends `archived`; if archive won first, publish is 409 | `test_a_concurrent_publish_and_archive_of_a_draft_both_follow_the_state_machine` |
| Edit while a publish is open (commits / rolls back) | edit waits, then 409 `notice_not_editable` / 200 | `test_a_write_waits_for_a_held_one_and_answers_from_its_result` |
| Publish while an edit is open | publish waits, then publishes the edited (or original) row | same test, `held=edit` |
| The expiry passes while publish waits | 422, still a draft, no audit | `test_a_notice_expiring_while_its_publish_waits_is_not_published` |
| The expiry passes while create/edit wait on the file or row lock | 422, no claim, no row | `test_an_expiry_passing_while_the_attachment_claim_waits_is_refused` (create, edit, edit-no-file) |
| A draft whose expiry already passed is published | 422, unchanged | `backend/tests/notices/test_transitions.py::test_publishing_a_draft_whose_expiry_has_passed_is_422` |
| Forbidden moves (publish published/archived, archive archived, edit non-draft) | 409, row and audits unchanged | `test_a_move_the_state_machine_forbids_is_409_and_changes_nothing` |
| A building-B notice reached through A | 404 `notice_not_found`, same body as a random id, on GET/PATCH/publish/archive | `backend/tests/notices/test_api.py::test_another_buildings_notice_is_404_through_this_building` |
| A building-B or unknown file | 404 `file_not_found`, nothing written, on create and edit | `test_a_file_of_another_building_looks_like_an_unknown_file`, `test_an_edit_with_a_file_of_another_building_changes_nothing` |
| A file attached elsewhere | 422 `invalid_file` | `test_a_file_already_attached_elsewhere_is_refused` |
| A replaced or cleared attachment | no longer downloadable, even by the manager | `test_replacing_an_attachment_stops_granting_the_old_file`, `test_clearing_an_attachment_stops_granting_it` |
| A failure after the insert / after an edit's claim | rollback: no notice, claim or audit | `test_a_failure_after_the_insert_leaves_nothing`, `test_a_failure_after_an_edits_claim_leaves_both_files_as_they_were` |
| Control characters, blank, too long, naive or out-of-range datetimes, unknown fields, `null` edits | 422 `validation_error`, nothing written | `test_invalid_input_is_a_422_and_writes_nothing` (23 cases), `test_an_invalid_edit_is_a_422_and_changes_nothing` (10), `test_a_lone_surrogate_is_refused` |
| Longest multi-byte title and body | stored | `test_the_longest_title_and_body_are_stored` |
| An edit sending only the current attachment back | 200, no UPDATE and no audit row | **No test** for that exact body (the tested case also sends a title); §7 |

Acceptance criteria → tests:
1. `test_only_the_manager_may_write` (security, resident1, council, multi), `test_non_members_get_404_on_every_route`,
   `test_every_route_is_401_without_a_session`, `test_members_list_and_get_the_live_published_notices_newest_first`,
   `test_another_buildings_notice_is_404_through_this_building`, the two cross-building file tests.
2. `test_the_manager_publishes_a_draft`, `test_publishing_twice_is_409`, `test_two_concurrent_publishes_have_one_winner`.
3. The edit rows of the 409 matrix; `test_a_write_waits_for_a_held_one_and_answers_from_its_result`.
4. `test_the_manager_archives_a_draft_or_published_notice`, the 409 matrix.
5. The list tests in `test_api.py` (members, manager with status filters, resident `?status=draft`, 422, cursor).
6. `test_every_notice_route_is_403_when_the_feature_is_off`.
7. The two failure-rollback tests.
8. The input tests above and `test_the_edit_schema_does_not_offer_null_where_it_refuses_it`.
9. The expiry tests in `test_api.py`, `test_transitions.py` and `test_concurrency.py`.
10. The four attachment-edit tests.
11. The metadata assertions in the create, edit, publish and archive tests.

## 6. Review log

James's instruction for this run: Codex `gpt-6.1-sol` at high effort as the only reviewer, no Claude reviewer.

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol, high | `093dbb9` | MERGE | Medium: expiry checked before the claim's lock wait. Low: OpenAPI allowed `null` for title/body/priority | both fixed in `ab0e283` |
| 2 | Codex gpt-6.1-sol, high | `ab0e283` | MERGE | Low: `9999-12-31T23:59:59-01:00` overflowed to a 500 | fixed in `6310510` |
| 3 | Codex gpt-6.1-sol, high | `6310510` | MERGE | Low: `datetime.max` UTC stored as `infinity` | not fixed: follow-up (§7) |

- **R1 Medium.** Failure: with the attachment's file row held by another transaction, a create (or edit) whose
  `expires_at` was 1 s ahead waited on `claim_file`'s UPDATE past that instant and was saved (201/200). Fix: check
  after the claim. Evidence: `test_an_expiry_passing_while_the_attachment_claim_waits_is_refused[create|edit]` failed
  before and passes after; a mutation probe moving the check back failed it. Neighbour added: `[edit-no-file]`, the
  wait on the notice's own lock.
- **R1 Low.** Failure: `schema.d.ts` let a typed client send `{title: null}`, which the server answers 422. Fix:
  `SkipJsonSchema[None]`. Evidence: `test_the_edit_schema_does_not_offer_null_where_it_refuses_it` (3 cases) red,
  then green.
- **R2 Low.** Failure: an aware time valid in its own offset but past year 9999 in UTC failed in asyncpg as a 500.
  Fix: `backend/app/notices/schemas.py::_in_utc`. Evidence: four new cases in the two input tests failed, then passed (the year-1
  underflow is the neighbour).
- Codex's gaps: AC1 `multi` only on create (now on all writes); AC2 stored clock (round 3 confirmed it with a scratch
  probe).

## 7. Not verified, accepted risks and follow-ups

- **R3 Low, unfixed:** `expires_at` exactly `9999-12-31T23:59:59.999999Z` is accepted and stored as Postgres
  `infinity`; the response then shows it without a timezone. Not fixed because round 3 was the last review round.
  To be tracked in P6-01c's follow-ups by this PR's bookkeeping commit (written after this explanation).
- **Replaced attachments (D6):** the old file's S3 object and claimed row remain; nothing deletes them. To be tracked in
  P6-01c's follow-ups and the inbox ("Decisions to audit") by the bookkeeping commit.
- **List order (D4):** a draft published long after it was written lists by creation. To be tracked in the inbox by the
  bookkeeping commit.
- **No test** for an edit whose only field is the current attachment (the code skips the UPDATE and the audit).
- **Not exercised with S3:** the attachment tests use file rows without objects; the download-url answers are
  authorization only.
- **Stack run:** one curl journey on `make up` (create, resident 404 on the draft, edit, resident 403 on publish,
  publish, publish again 409, edit 409, resident list and get, archive, resident 404, a past expiry 422), pasted in the
  PR. No browser: there is no UI yet (P6-02).
- One unrelated flaky run in Codex's round-2 check (`test_join_units_is_rate_limited_in_a_bucket_of_its_own`, a
  rate-limit window boundary); it passed alone and in every `make check` here.

## 8. How to change this safely

- A new action (say, "pin"): add the status or column in P6-01a's model and `ALLOWED`, a service function shaped like
  `archive_notice` (`_locked`, `assert_transition`, conditional UPDATE, `_audit`, one commit), a route on `_AUTHOR`, and
  rows in `test_transitions.py` and `test_concurrency.py`.
- Anything that can wait (a new lock, another claim) before a write that depends on time must come **before**
  `_check_future`; the race tests in `test_concurrency.py` will show if it doesn't.
- Never filter notices outside `visible_notices`; a new list filter is a `.where` on it in `list_notices`.
- Changing an input type: the parametrized input tests in `test_api.py` hold what Postgres refuses; run `make gen-api`
  and commit `schema.d.ts`.

## 9. Must explain, then quiz

1. **Trace `POST /notices/{id}/publish` from HTTP to COMMIT; which statement decides a race?** See §3. The
   `SELECT … FOR UPDATE` in `backend/app/notices/service.py::_locked` serializes the writers: the second waits until
   the first commits, then reads `published` and `assert_transition` answers 409. The conditional UPDATE in
   `publish_notice` still checks `status IN ('draft')` and the expiry, so even without the lock no row could be
   published twice or expired.
2. **Why is editing a published notice a 409 rather than a new version?** The stub's default, encoded in P6-01a's
   `ALLOWED` (no `published → draft`): residents may already have read it (and P6-01c will notify them), so changing it
   silently would change what they were told. The manager archives it and writes a new one
   (`update_notice` raises `NoticeNotEditable`; recorded: ticket D2).
3. **How does a draft's attachment stay invisible to residents until publish?** The download route asks
   `backend/app/notices/attachments.py::can_view_notice_attachment`, which looks the notice up through
   `visible_notices(ctx)`; for a resident that query holds only published, unexpired notices. The file must also be
   the notice's current `attachment_file_id`, which is what makes a replaced file invisible to everyone (D6).

Quiz:

1. Why does publish use `statement_timestamp()` rather than `clock_timestamp()` or `now()`?
2. A create sends `attachment_file_id` of a file in building B. Which statement refuses it, with what answer, and
   what is left in the database?
3. What breaks if `_check_future` in `update_notice` is moved above the attachment claim?
4. What breaks if `_locked` drops `.with_for_update()`?
5. How would you order the feed by `published_at` instead of creation?

<details><summary>Answers</summary>

1. `clock_timestamp()` is read per call, so the SET could be later than the value the WHERE compared and trip
   `expires_after_published` (a 500); `now()` is the transaction's start, before the lock wait, so an expiry passing
   during the wait wouldn't be seen (D5).
2. `claim_file`'s conditional UPDATE matches no row (it filters `building_id = ctx.building_id`), its follow-up lookup
   finds none in A, and it raises 404 `file_not_found`, the same body as an unknown id. The notice was never inserted
   (the claim runs first) and the request rolls back, so nothing is left.
3. The check would read the clock before `claim_file` waits on a held file row; an expiry passing during the wait would
   be saved. `test_an_expiry_passing_while_the_attachment_claim_waits_is_refused[edit]` fails (round 1).
4. Two publishes would no longer serialize at the SELECT: the loser would pass `assert_transition` on a stale `draft`
   and reach an UPDATE matching zero rows, which `publish_notice` reads as "expired" (422 instead of 409), and an edit
   could run against a row a publish is changing. The probe failed 4 concurrency tests.
5. A keyset on `(published_at, id)` (a new cursor shape in `backend/app/core/pagination.py` or a notices-specific one), an
   index `(building_id, status, published_at DESC, id DESC)` in a migration, and drafts (null `published_at`) listed
   separately or by `created_at`; the list tests' expected orders change (D4).

</details>
