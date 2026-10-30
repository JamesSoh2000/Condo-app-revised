# Explanation — P6-03d Maintenance comments: public and internal

> **PR:** #157 · **Source revision:** `c9afc65` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (1, Codex `gpt-6.1-sol` high, the only reviewer this
> run, by James's instruction) reviewed this commit and said `MERGE`.
> **Merge commit:** not known when written; after the merge, `gh pr view 157 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `c9afc65`: `git diff origin/main...HEAD` for every changed app file
> (`backend/app/maintenance/{models,queries,schemas,service,router}.py`, `backend/app/core/pagination.py`,
> `backend/app/notifications/kinds.py`, `backend/app/audit/actions.py`), the migration `27ffbfae7d14`, the
> ticket's criteria and Frame notes, the PR body (plan, decisions, evidence, review round 1), and the assertions
> of every test cited below. Compiled the resident's list query to SQL (§3). Ran `uv run pytest tests/maintenance
> tests/notifications/test_notify.py tests/test_world.py tests/test_scratch_tests_run.py` on the compose
> Postgres 18 (127.0.0.1:55432): `477 passed`. Differences from the plan: none (§2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: A.

## 1. What was built and why

Members who can see a maintenance request can now comment on it
(`POST /api/buildings/{b}/maintenance-requests/{id}/comments`) and read the thread oldest first (`GET …/comments`).
Security and property management may mark a comment **internal**. An internal comment never reaches a resident:
it isn't in their list, it doesn't shorten their pages, it notifies nobody, and its text is in no email or audit
row. Journey 6's privacy promise rests on this ("the resident sees … the public comment, never the internal
note"), and P6-07b will test it end to end.

Two decisions carry the ticket:

- **One query decides who sees what.** `backend/app/maintenance/queries.py::visible_maintenance_comments` reads
  comments only of requests `visible_maintenance(ctx)` returns, and adds `is_internal = false` for everyone but
  staff. The flag only ever *narrows*.
- **Notifications follow the author's side.** A staff reply tells the requester, in-app and by email. A resident's
  comment tells the managers, in-app only. An internal comment tells nobody. Each notification's entity is the
  *comment*, so a second reply still gets its own email.

## 2. Decisions

All are recorded in the ticket's Frame notes (D1–D8) and the PR's "Decisions and alternatives". The ones marked
autonomous are also listed for audit in the inbox (bookkeeping commit).

### D1. Security reads and writes internal comments

- **Problem or constraint:** the ticket left open whether security, which already sees every request (P6-03a),
  sees internal notes.
- **Chosen:** staff for comments means `_SEE_ALL` (security and property management).
  `backend/app/maintenance/queries.py::sees_internal_comments` is the one test, used for reading, for writing `internal`, and for
  the `author_is_staff` stamp.
- **Alternatives rejected:** property management only. The stub's default for security is "read and comment",
  and internal means staff-only, which security is.
- **Tradeoffs and accepted limitations:** there is no way to write a note for managers alone.
- **Basis:** stub default plus autonomous judgment. **Source:** recorded (Frame notes D1, PR D1).

### D2. Who a comment notifies

- **Problem or constraint:** "who is notified for each kind" (stub recipe check), and nobody who can't see the
  request may be.
- **Chosen:**
  - A staff author's public comment notifies the requester, but only if the requester's membership is
    `active` and holds resident, security or property management (`backend/app/maintenance/service.py::_requester_who_sees`). Kind
    `maintenance.staff_commented`, which emails.
  - A resident author's public comment notifies the active property managers (`staff_user_ids`). Kind
    `maintenance.resident_commented`, in-app only.
  - The author is always filtered out. Internal comments skip notification entirely.
  - `entity_type`/`entity_id` are `maintenance_comment`/the comment id. The link points at the request.
- **Alternatives rejected:**
  - Notifying every resident who sees the request (co-occupants, former occupants): this needs a per-person
    visibility computation at write time.
  - Telling managers about security's comments: staff read the thread in their own tools.
  - One kind with a flag: the kind fixes the email (P6-01c D2).
  - The request as the entity: `notify`'s dedupe key `<kind>:<entity_id>:<user_id>` would then swallow every
    reply's email after the first (P6-03c criterion 6a).
- **Tradeoffs and accepted limitations:** a co-occupant isn't told of a staff reply. Inferred: the bell's
  "entity" no longer names the request directly; P6-04 reads the link.
- **Basis:** autonomous. **Source:** recorded (Frame notes D2, PR D2).

### D3. Comments take no photos

- **Problem or constraint:** the ticket left comment photos to framing.
- **Chosen:** no photos. `photo_file_ids` on a comment is an unknown field (422). The photo hook keeps refusing
  every `attached_type` but the request's.
- **Alternatives rejected:** a `maintenance_comment_photos` table and a second hook branch (~60 lines). That
  adds a leak path for internal comments that no criterion needs.
- **Tradeoffs and accepted limitations:** residents can't attach a photo to a reply.
- **Basis:** autonomous (simplest reversible). **Source:** recorded (Frame notes D3, PR D3).

### D4. Comments follow their request

- **Problem or constraint:** does a moved-out resident still see later comments on a request from their
  occupancy?
- **Chosen:** yes. There is no per-comment occupancy window: whoever sees the request sees all its public comments.
- **Alternatives rejected:** a window on each comment's `created_at`. Comments have no `unit_id`, so the record
  fence (ADR-0021) can't register them, and one thread would read differently for different viewers. The
  request's own status, which keeps changing after a move-out, is already shown to them.
- **Tradeoffs and accepted limitations:** a former co-occupant reads replies written after they left, but only
  on a request they already see.
- **Basis:** autonomous. **Source:** recorded (Frame notes D4, PR D4).

### D7. Author identity: a stored staff flag; names for staff and the author only

- **Problem or constraint:** what a resident sees of a staff author, and whether a label changes when roles do.
- **Chosen:** `author_is_staff` is stamped at write time. It also backs the database check
  `internal_needs_staff`. `author_name` (the author's current full name) is filled only for staff callers and
  for the author's own comments.
- **Alternatives rejected:**
  - Computing staff-ness from current roles at read time: a demoted manager's old replies would turn into
    "Resident", and the database couldn't enforce internal ⇒ staff.
  - Showing staff names to residents: P6-03b D8 shows residents no other person's name.
- **Tradeoffs and accepted limitations:** the frontend renders "Building management" or "Resident" from the flag.
- **Basis:** autonomous. **Source:** recorded (Frame notes D7, PR D7).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| D5 every status takes comments, for every role | 409 on `resolved`/`cancelled` | a "still leaking" reply is what reopen answers | autonomous | Frame notes D5 |
| D6 body varchar(2000), the description's validator | a shorter limit | one rule for the request's two free texts | convention (P6-03b) | Frame notes D6 |
| D8 `paginate(descending=False)` | reverse a newest-first page | cursors would mean the opposite of the order shown | ticket ("oldest first") | Frame notes D8 |
| 403 `internal_comment_forbidden` | 422 | valid input; the caller lacks the right (as `not_requester`) | ticket offered either | PR table |
| no partial index on public comments | `WHERE NOT is_internal` | threads are short; one index serves both reads | autonomous | Frame notes D8, PR table |
| no row lock on the request | `FOR KEY SHARE` | the comment INSERT's FK check takes it anyway; no status is checked (D5) | autonomous | PR table |

**Framing changes:** the 10-case rows were decided (a council-only caller gets 404; `multi_in_a` was added).
"No gap in the cursor" was made testable (full pages at limits 1–3, and a cursor at an internal comment's id).
Criterion 3 got its error code and a database check. Criterion 4 got concrete recipients, titles, link and email
dedupe, plus two extra cases (a requester who lost the role; a staff requester commenting on their own request).
Criterion 5 was pinned at T1 ± 1 day. Nothing was loosened: the photo rows of criteria 1–2 were the ticket's own
conditional, decided "no" (D3).

**Plan versus final code:** compared the PR's Plan with the code at `c9afc65`: same files, interfaces, migration
and flow. None.

## 3. How it is implemented

### Overview

- **Model** `backend/app/maintenance/models.py::MaintenanceComment`, in a new table with composite FKs.
- **Query** `backend/app/maintenance/queries.py::visible_maintenance_comments`: the request grant, then the internal narrowing.
- **Service** `backend/app/maintenance/service.py::add_comment` and `::list_comments`.
- **Pagination** `backend/app/core/pagination.py::paginate` gains `descending`.
- **Side effects:** `notify` (two new kinds) and `record_audit` (`maintenance.commented`), in the same
  transaction.

### Walkthrough (variant A): a manager adds a public comment, then the resident lists the thread

1. **HTTP:** `POST /api/buildings/{b}/maintenance-requests/{id}/comments` with `{"body": "A plumber comes
   Tuesday."}` reaches `backend/app/maintenance/router.py::comment`. Its only dependency is
   `require_feature(MAINTENANCE)` (403 `feature_disabled`); there is no role list, because visibility decides.
2. **Tenant context:** `get_tenant_context` (building router). A non-member, pending or suspended caller gets
   404 `building_not_found`; signed out gets 401.
3. **Input:** `backend/app/maintenance/schemas.py::MaintenanceCommentCreate`. `body` reuses `Description`: control characters other than
   tab and newline are refused before the strip, then it is stripped, then held to 1–2000 characters. `internal`
   defaults to `false`. Unknown fields are a 422 (`InputModel`).
4. **Service** `add_comment`:
   1. `_visible` loads the request through `visible_maintenance(ctx)`. A request the caller can't see, a random
      id or another building's id all give the same 404 `maintenance_request_not_found`.
   2. `staff = sees_internal_comments(ctx)`. `internal and not staff` → 403. This runs before any write.
   3. `INSERT … RETURNING` the comment, with `author_is_staff = staff`.
   4. If public, `_notify_comment` runs. The manager is staff, so the recipients are `_requester_who_sees`
      minus the manager, and `notify` writes one notification row and one `email.send` job with dedupe key
      `maintenance.staff_commented:<comment id>:<requester user id>`. The title and body are fixed text plus
      the category name, with no comment text.
   5. `record_audit(maintenance.commented)` on entity `maintenance_request`/id, metadata
      `{comment_id, is_internal}`.
   6. `_comment_outs` builds the answer, then the one `commit()`.
5. **Response:** 201 `MaintenanceCommentOut`.
6. **The resident reads:** `GET …/comments` reaches `backend/app/maintenance/router.py::list_comments`, then `backend/app/maintenance/service.py::list_comments`:
   `_visible` (404 if hidden), then `paginate(..., descending=False)` over this query (compiled from the code,
   resident caller):

```sql
SELECT maintenance_comments.* FROM maintenance_comments
WHERE maintenance_comments.building_id = :building_id
  AND maintenance_comments.request_id IN (
        SELECT maintenance_requests.id FROM maintenance_requests
        WHERE maintenance_requests.building_id = :building_id
          AND (maintenance_requests.requester_membership_id = :membership_id
               OR public.occupancy_window(:membership_id, maintenance_requests.unit_id,
                                          maintenance_requests.submitted_at)))
  AND maintenance_comments.is_internal IS false
  AND maintenance_comments.request_id = :request_id
  [AND maintenance_comments.id > :cursor]
ORDER BY maintenance_comments.id ASC
LIMIT :limit + 1
```

The `is_internal IS false` filter sits inside the query that `LIMIT` applies to. A page therefore holds `limit`
public comments whenever that many exist after the cursor, and an internal comment can't leave a short page
behind. A staff caller's query is the same without that line (the request subquery's grant is `true`).

### Data model changes

Table `maintenance_comments` (migration `27ffbfae7d14`, down `2cb174aca098`, additive):

| Column / constraint | Why it exists |
|---|---|
| `fk_maintenance_comments_building_id_request_id` → `maintenance_requests(building_id, id)` | a comment can't point at another building's request (ADR-0005); the target unique key was added for this in P6-03a |
| `fk_maintenance_comments_building_id_author_membership_id` → `building_memberships(building_id, id)` | the author is a member of the same building |
| `author_is_staff boolean not null` | the label stays what it was when written (D7) |
| `body varchar(2000)`, `ck_…_body_not_blank` (`btrim(body, E' \t\n\r') <> ''`) | the API strips, so `''` would otherwise pass `NOT NULL` (the P5-01 carry) |
| `is_internal boolean default false`, `ck_…_internal_needs_staff` (`NOT is_internal OR author_is_staff`) | a second guard behind the 403: a resident's internal comment can't exist even through a future code path |
| `ix_maintenance_comments_building_id_request_id_id` | the thread read: filter by request, order by id |

## 4. The code

**Files changed** (from `git diff --stat origin/main...HEAD`)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/maintenance/service.py` | `add_comment`, `_notify_comment`, `_requester_who_sees`, `list_comments`, `_comment_outs` | +178/−1 |
| `backend/migrations/versions/27ffbfae7d14_maintenance_comments_p6_03d.py` | the table | +84 |
| `backend/app/maintenance/models.py` | `MaintenanceComment`, `MAINTENANCE_COMMENT_ENTITY_TYPE` | +43 |
| `backend/app/maintenance/router.py` | two routes | +38/−1 |
| `backend/app/maintenance/schemas.py` | `MaintenanceCommentCreate`, `MaintenanceCommentOut` | +28 |
| `backend/app/maintenance/queries.py` | `visible_maintenance_comments`, `sees_internal_comments` | +26/−1 |
| `backend/app/notifications/kinds.py` | two kinds | +12 |
| `backend/app/core/pagination.py` | `descending` keyword | +9/−2 |
| `backend/app/audit/actions.py` | `MAINTENANCE_COMMENTED` | +1 |
| `frontend/src/api/schema.d.ts` | regenerated | +212 |
| tests: `backend/tests/maintenance/test_comments_{api,visibility,notify,schema}.py`, additions to `test_atomicity.py`, `test_concurrency.py`, `conftest.py`; one line each in `backend/tests/notifications/test_notify.py`, `backend/tests/test_world.py`, `frontend/src/api/client.test.ts` | | |

`backend/app/maintenance/queries.py::visible_maintenance_comments`

```python
def visible_maintenance_comments(ctx: TenantContext) -> Select[MaintenanceComment]:
    # ...
    requests = visible_maintenance(ctx).with_only_columns(MaintenanceRequest.id)
    stmt = select(MaintenanceComment).where(
        MaintenanceComment.building_id == ctx.building_id,
        MaintenanceComment.request_id.in_(requests),
    )
    if not sees_internal_comments(ctx):
        stmt = stmt.where(MaintenanceComment.is_internal.is_(False))
    return stmt


def sees_internal_comments(ctx: TenantContext) -> bool:
    # ...
    return ctx.has_any(*_SEE_ALL)
```

- It reads comments only of visible requests, then narrows to public ones for non-staff.
- Why: CLAUDE.md rule 3 ("use the domain's `visible_*` helper"); the flag must never grant (ticket Goal, Must
  explain 2).
- Remove the `if not sees_internal_comments` branch and residents list internal notes: mutation probe m1 fails 3
  tests (PR "Mutation probes").

`backend/app/maintenance/service.py::add_comment`

```python
    request = await _visible(db, ctx, request_id)
    staff = sees_internal_comments(ctx)
    if data.internal and not staff:
        raise InternalCommentForbidden(detail="Only building staff can write internal comments.")
    comment = await db.scalar(
        insert(MaintenanceComment)
        .values(
            building_id=ctx.building_id,
            request_id=request.id,
            author_membership_id=ctx.membership_id,
            author_is_staff=staff,
            body=data.body,
            is_internal=data.internal,
        )
        .returning(MaintenanceComment)
    )
    # ...
    if not data.internal:
        await _notify_comment(db, ctx, request, comment.id, staff=staff)
    await record_audit(
        # ...
        metadata={"comment_id": comment.id, "is_internal": comment.is_internal},
    )
    [out] = await _comment_outs(db, ctx, [_CommentColumns.model_validate(comment)])
    await db.commit()
    return out
```

- The visibility check comes first, then the right to write internal, then one transaction with one commit
  (CLAUDE.md rule 5).
- The 403 is raised rather than quietly dropping the flag, so a staff-intended note typed by a resident never
  becomes public (Must explain 4).
- Without `if not data.internal:` an internal note would notify the requester: probe m5 fails 2 tests.

`backend/app/maintenance/service.py::_notify_comment` and `::_requester_who_sees`

```python
    category = _CATEGORY_NAMES[request.category]
    if staff:
        recipients = await _requester_who_sees(db, request)
        kind, title = "maintenance.staff_commented", "New reply on your maintenance request"
        body = f"Building management replied to your {category} request."
    else:
        recipients = await staff_user_ids(db, ctx.building_id, [Role.PROPERTY_MANAGEMENT])
        kind, title = "maintenance.resident_commented", "New comment on a maintenance request"
        body = f"A resident commented on a {category} request."
    await notify(
        db,
        building_id=ctx.building_id,
        recipient_user_ids=[user_id for user_id in recipients if user_id != ctx.user_id],
        # ...
        link=f"/maintenance/{request.id}",
        # The comment, not the request: each comment's email gets its own dedupe key (P6-03c 6a).
        entity_type=MAINTENANCE_COMMENT_ENTITY_TYPE,
        entity_id=comment_id,
    )
# ...
    user_id = await db.scalar(
        select(BuildingMembership.user_id).where(
            BuildingMembership.id == request.requester_membership_id,
            BuildingMembership.building_id == request.building_id,
            BuildingMembership.status == MembershipStatus.ACTIVE,
            select(MembershipRole.membership_id)
            .where(
                MembershipRole.membership_id == BuildingMembership.id,
                MembershipRole.role.in_([Role.RESIDENT, Role.SECURITY, Role.PROPERTY_MANAGEMENT]),
            )
            .exists(),
        )
    )
```

- The recipient set comes from the author's side (D2). The requester counts only while they could still open the
  request: an active membership with a role that `visible_maintenance` grants their own request to.
- Probes: m2 (entity = request) fails 4 tests, including the two-replies email test; m3 (author not filtered)
  fails 1; m6 (status check dropped) fails 1.

`backend/app/core/pagination.py::paginate` (the change)

```python
    order = id_col.desc() if descending else id_col.asc()
    stmt = stmt.order_by(None).order_by(order).offset(None).limit(params.limit + 1)
    if params.after_id is not None:
        stmt = stmt.where(id_col < params.after_id if descending else id_col > params.after_id)
```

- Oldest first with the same keyset cursor; the default keeps every existing caller unchanged (Codex's full-suite
  run at `c9afc65`: 3,192 passed, PR "Independent review"). Probe m7 (descending) fails 3 tests.

## 5. Edge cases and tests

All tests are in `backend/tests/maintenance/` unless named otherwise; all were run in the reality check.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A resident's page is short because an internal row was cut after `LIMIT` | the filter is in the query; full pages at limits 1, 2, 3 | `backend/tests/maintenance/test_comments_api.py::test_the_resident_lists_public_comments_only_with_no_gap_in_any_page` |
| A staff cursor at an internal comment, reused by a resident | `id > cursor` plus the filter: the next public comment only | `::test_a_cursor_at_an_internal_comment_gives_the_next_public_one_only` |
| A public comment on a request the caller can't see | invisible: the flag never grants | `backend/tests/maintenance/test_comments_visibility.py::test_an_internal_comment_on_a_request_a_resident_cannot_see_stays_hidden` |
| Multi-role caller (resident + security) | union, as `visible_maintenance` | `::test_a_resident_who_is_also_staff_sees_the_internal_comment` |
| Moved-out resident, comments before and after T1 | both seen (D4); the current occupant sees neither | `::test_a_moved_out_resident_sees_comments_on_both_sides_of_their_move` |
| A resident sends `internal: true` (also `multi` in A) | 403, nothing written | `backend/tests/maintenance/test_comments_api.py::test_a_resident_sending_internal_gets_403_and_nothing_is_written`; `multi` in B may: `::test_multi_in_b_as_security_may_write_internal` |
| A future path writes an internal comment by a resident | the database refuses it | `backend/tests/maintenance/test_comments_schema.py::test_an_internal_comment_by_a_non_staff_author_is_refused` |
| Internal comment notifies someone | no row, no job | `backend/tests/maintenance/test_comments_notify.py::test_an_internal_comment_tells_no_one` |
| Second staff reply's email swallowed by dedupe | per-comment key | `::test_two_staff_replies_in_a_row_both_email` |
| Requester lost the role or was suspended | not notified | `::test_a_requester_who_can_no_longer_see_the_request_is_not_told` |
| Author notified of their own comment | filtered | `::test_a_manager_replying_on_their_own_request_is_not_told` |
| Co-occupants told of a staff reply | requester only | `::test_a_staff_reply_does_not_tell_co_occupants` |
| Names leak to residents | staff and the author only | `backend/tests/maintenance/test_comments_api.py::test_authors_names_are_shown_to_staff_and_to_the_author_only` |
| NUL, surrogate, other controls, over-long, blank, unknown field, `photo_file_ids` | 422, nothing written | `::test_bad_input_is_422_and_writes_nothing` (12 cases) |
| Failure after the insert | nothing persists | `backend/tests/maintenance/test_atomicity.py::test_a_failure_after_the_comment_insert_leaves_nothing` |
| Two comments at once | both land, in id order | `backend/tests/maintenance/test_concurrency.py::test_two_comments_at_once_both_land_in_id_order` |
| The new email kind's template fails to render | renders in every locale | `backend/tests/notifications/test_notify.py::test_every_kinds_template_renders` (parametrized over `KINDS`) |

**Acceptance criteria → tests:**

1. `test_comments_api.py` (who comments and lists, the 401/404/403 rows, the council member's own request) and
   `backend/tests/maintenance/test_concurrency.py::test_two_comments_at_once_both_land_in_id_order`. The photo row is n/a (D3).
2. The list tests above. Notifications: `backend/tests/maintenance/test_comments_notify.py::test_an_internal_comment_tells_no_one`.
   Counts and photo are n/a: no comment count in the API, no comment photos.
3. `backend/tests/maintenance/test_comments_api.py::test_a_resident_sending_internal_gets_403_and_nothing_is_written`,
   `::test_multi_in_b_as_security_may_write_internal`, and the schema check.
4. `test_comments_notify.py` (all tests).
5. `backend/tests/maintenance/test_comments_visibility.py::test_a_moved_out_resident_sees_comments_on_both_sides_of_their_move`,
   `backend/tests/maintenance/test_comments_notify.py::test_a_moved_out_requester_is_still_told_and_former_co_occupants_are_not`.
6. `backend/tests/maintenance/test_comments_api.py::test_a_closed_request_takes_comments_from_every_role`.
7. `backend/tests/maintenance/test_comments_api.py::test_bad_input_is_422_and_writes_nothing`,
   `::test_a_body_of_2000_characters_after_the_strip_is_kept`.
8. `backend/tests/maintenance/test_atomicity.py::test_a_failure_after_the_comment_insert_leaves_nothing`,
   `::test_a_comment_is_audited_by_id_and_flag_never_by_body`.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `c9afc65` | `MERGE` | none | Its 4 scratch proof tests (security on closed requests, council-only denial on both routes, internal access after a staff demotion) passed and were deleted |

No finding changed the code. Before review, the implementer's first full-suite run failed 4 tests:

- lists that enumerate the in-app kinds and the world's tables, which this ticket extends;
- the scratch-test checker, which read a nested `comment` coroutine as never run.

Commit `07ac259` added the kind and table to those lists and moved the helper to module level.

## 7. Not verified, accepted risks and follow-ups

- **Browser and live email:** no Playwright run of comments (no UI yet: P6-04c) and no SMTP delivery. The email
  job's payload was checked in tests, not a received message. P6-07b covers the journey end to end.
- **A suspension racing a comment:** visibility is read once, without a lock. A membership suspended between
  `_visible` and the commit can still comment once, the same check-then-act window every tenant write accepts.
  No test.
- **A requester's visibility in `_requester_who_sees`** mirrors `visible_maintenance`'s roles by hand
  (resident, security, property management). If P6-03a's grant changes, this must change with it. Tracked only
  here; `backend/tests/maintenance/test_comments_notify.py::test_a_requester_who_can_no_longer_see_the_request_is_not_told` covers today's
  rule.
- **Counts:** none exist yet. P6-05a's counts must use `visible_maintenance_comments` (follow-up added to
  P6-05a's ticket in the bookkeeping commit).
- **Not built:** comment photos (D3), editing and deleting comments, a rate limit on comments. Tracked in the PR's
  follow-ups. The audit decisions D1, D2, D4 and D7 are in the inbox's "Decisions to audit" (bookkeeping commit).
- **Local runs** used compose's Postgres 18 and S3 emulator. Mutation probes were run by hand, not with
  `scripts/mutation-probe.sh` (its `db-guard` failed at the time; PR "Mutation probes").

## 8. How to change this safely

- **Add a reader of comments** (a count, the dashboard, an export): build it on
  `backend/app/maintenance/queries.py::visible_maintenance_comments` and never filter `is_internal` yourself.
  `test_comments_visibility.py` and the no-gap list test will catch a looser rule.
- **Change who is staff:** edit `_SEE_ALL`/`sees_internal_comments`. Writing, reading and the `author_is_staff`
  stamp all follow, and so must `_requester_who_sees`.
- **Add comment photos:** a `maintenance_comment_photos` table, a second branch in
  `backend/app/maintenance/photos.py::can_view_maintenance_photo` that joins through
  `visible_maintenance_comments`, and an internal-photo test for residents through `GET /files/{id}/download-url`.
- **Change a notification:** keep the entity per comment, or `test_two_staff_replies_in_a_row_both_email` fails.

## 9. Must explain, then quiz

1. **Every path by which an internal comment could reach a resident, and what closes each.**
   - The list, and its pages and cursor: the `is_internal IS false` narrowing in
     `backend/app/maintenance/queries.py::visible_maintenance_comments`, applied before `LIMIT`.
   - A count: none exists; any future one must use the same query.
   - A notification or an email: `backend/app/maintenance/service.py::add_comment` calls `_notify_comment` only `if not data.internal`.
   - Email text even for public comments: fixed words only.
   - The audit row: metadata holds the id and flag, never the body.
   - A photo: comments take none (D3), and the photo hook refuses any `attached_type` but the request's.
   - An error message: a hidden request gives the same 404 body as a random id
     (`test_another_residents_request_is_the_same_404_as_a_random_id`), and the 403 names no comment.
2. **Why the internal filter narrows `visible_maintenance` instead of granting on its own.** A grant of its own
   ("public comments are readable") would expose public comments on requests the caller can't see, such as a
   neighbour's unit. Built as `request_id IN visible_maintenance(ctx)` plus a narrowing, the comment rule can
   only ever be stricter than the request rule, and the occupancy logic stays in one place (CLAUDE.md rule 3).
3. **What a moved-out resident sees, and why.** All public comments on requests they still see, including
   those written after they left (D4): comments follow their request, whose status they already see changing.
   Only a requester is notified, so a former co-occupant gets no notifications. The cost is that the record fence
   can't register comments (no `unit_id`), and that a per-viewer thread would be confusing.
4. **Why a resident's `internal: true` is refused rather than made public.** The author meant it to be private.
   Publishing it silently would leak exactly what they wanted hidden (a lockbox code, a complaint about a
   neighbour). A 403 says so, and nothing is written.

Quiz:

1. A manager writes three replies in a row on one request. How many `email.send` jobs does the requester get,
   and what in the code decides that?
2. Why can the resident's list return a full page even when half the thread is internal?
3. What breaks if `ck_maintenance_comments_internal_needs_staff` and the 403 check in `add_comment` were both
   removed?
4. A council-only member opens `GET …/comments` on any request. What do they get, and why?
5. How would you let residents attach photos to comments without any risk of an internal comment's photo leaking?

<details><summary>Answers</summary>

1. Three. `_notify_comment` passes the comment's id as `entity_id`, so each dedupe key
   `maintenance.staff_commented:<comment id>:<user id>` is distinct. With the request's id there would be one.
2. The `is_internal IS false` condition is part of the SQL that `LIMIT :limit + 1` applies to, so Postgres skips
   internal rows before counting the page. Filtering in Python after fetching would leave short pages.
3. A resident could post `internal: true`. The row would be stored internal and hidden from every resident,
   including its author, and visible to staff. The note would silently vanish from the author's own view, and
   the database would hold an "internal" comment by a non-staff author, which D7's flag exists to forbid.
4. 404 `maintenance_request_not_found`. `visible_maintenance` grants council alone no request (P6-03a D8), and
   `list_comments` starts with `_visible`.
5. A `maintenance_comment_photos` table with composite FKs, claimed in `add_comment`. A branch in
   `can_view_maintenance_photo` for the comment `attached_type` that checks the comment through
   `visible_maintenance_comments(ctx)` (so an internal comment's photo is 404 for residents). Tests that a
   resident gets `file_not_found` for an internal comment's photo and the URL for a public one.

</details>
