# P6-01b — Notice authoring API

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-01a, P2-04, P3-04b |
| Replaces old | M6-T03 (API part), M6-T09 (backend part) |
| Status | in progress |

Split from the P6-01 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); the schema is
[P6-01a](./P6-01a-notice-schema-and-visibility.md), reads and the fan-out
[P6-01c](./P6-01c-notice-reads-and-fan-out.md).

## Goal

Managers create, edit (draft only), publish and archive notices, with an optional attachment; every member
lists and reads the notices `visible_notices` lets them see.

## Why

The manager's half of the notices slice, on the reference transition pattern (P5-02b): action endpoints with
a conditional `UPDATE … WHERE status IN (…) RETURNING` (CLAUDE.md rule 7), audit in the same transaction.

## Scope

- In (building router, `require_feature(Feature.NOTICES)` on every route; writes
  `require_roles(Role.PROPERTY_MANAGEMENT)`):
  - **`POST /notices`** body `{title, body, priority = "normal", expires_at?, attachment_file_id?}` → 201
    `NoticeOut`, `status = draft`, `author_membership_id = ctx.membership_id`; the attachment through
    `claim_file(…, FilePurpose.NOTICE_ATTACHMENT, NOTICE_ATTACHED_TYPE, id)`
  - **`PATCH /notices/{id}`** (draft only) with the same fields, each optional; a non-draft gives 409
  - **`POST /notices/{id}/publish`**: `draft → published`, `published_at` and `published_by_membership_id`
    from the database clock and the caller
  - **`POST /notices/{id}/archive`**: `→ archived` per P6-01a's `ALLOWED`
  - **`GET /notices?status=&cursor=`**: `visible_notices(ctx)`, optional status filter, cursor pages
  - **`GET /notices/{id}`**: 404 `notice_not_found` unless visible
  - audit `notice.created`, `notice.updated`, `notice.published`, `notice.archived`, IDs and field names only
  - `make gen-api`
- Out:
  - the read marker, the unread summary and the `notify` fan-out on publish (P6-01c)
  - the frontend (P6-02)

## Interfaces

Operation ids `notices_create`, `notices_update`, `notices_publish`, `notices_archive`, `notices_list`,
`notices_get`.

- `NoticeCreate(InputModel)`: `title` (1–200, stripped, printable), `body` (P6-01a's length), `priority`,
  `expires_at` (aware datetime, optional), `attachment_file_id` (optional uuid).
- `NoticeUpdate(InputModel)`: the same fields, all optional; which may be cleared with `null` is decided in
  framing.
- `NoticeOut(APIModel)`: the notice's columns (never an S3 key; the attachment is its `file_id`, downloaded
  through `GET /files/{id}/download-url`).
- Errors: 404 `notice_not_found`; 409 `invalid_transition`; 409 for editing a non-draft (code decided in
  framing); `claim_file`'s 404 `file_not_found` / 422 `invalid_file`; 422 for an expiry already past at
  publish (code decided in framing).

## Acceptance criteria

1. **The 10-case table** holds for every endpoint: `a_manager` succeeds on writes; `a_security`,
   `a_resident1` and `a_council` get 403 `forbidden_role` on every write, and `multi` (a resident in A) too;
   unauthenticated 401; `b_manager`, `a_pending`, `a_suspended` 404 `building_not_found` on every route;
   a draft or archived notice is 404 `notice_not_found` on `GET` for non-managers, the same body (minus
   `request_id`) as a random id; a building-B notice reached through A is 404 `notice_not_found` for
   `a_manager` on `GET`, `PATCH`, `publish` and `archive`; a building-B `attachment_file_id` gives 404
   `file_not_found` with no notice, claim or audit row written, on create **and** on edit. *(framing: the
   multi, cross-building-notice and edit rows added)*
2. **Given** a draft, **when** the manager publishes it, **then** it is `published` with `published_at` (the
   database's statement time) and `published_by_membership_id = ctx.membership_id`, and one
   `notice.published` audit row; publishing again gives 409 `invalid_transition`; of two concurrent
   publishes exactly one wins and the other gets 409, with one audit row.
3. **Given** a published notice, **when** the manager edits it, **then** 409 `notice_not_editable` and the
   row is unchanged (stub default: editing after publish is blocked). Of a concurrent edit and publish of
   one draft, either the edit lands before the publish (both succeed, the published row has the edit) or
   the edit gets 409; never an edit of a published row. *(framing: the code and the race added)*
4. **Given** archive, **then** it follows P6-01a's `ALLOWED` (`draft → archived`, `published → archived`,
   with `archived_at` and `archived_by_membership_id` set and the publish columns kept); archiving an
   archived notice is 409 `invalid_transition`; an archived notice can't be published (409
   `invalid_transition`) or edited (409 `notice_not_editable`).
5. **Given** a published notice, **then** `GET /notices` lists it for every active member of A, newest
   first by creation (`id DESC`, the `paginate` order), and drafts and archived ones only for the manager;
   `?status=draft` for a resident is an empty page; `?status=` takes one status; an unknown status is 422;
   the cursor pages. *(framing: order made precise; see D4)*
6. **Given** the `notices` feature disabled for A, **then** every endpoint gives 403 `feature_disabled`
   and writes nothing.
7. **Given** a forced failure after the insert and before commit, **then** no notice, file claim or audit row
   persists; likewise for a failure after an edit's claim, so the old attachment and the new file are as
   before. *(framing: the edit case added)*
8. Input Postgres would refuse never reaches it: NUL, lone surrogates and over-long strings give 422; a
   naive `expires_at` gives 422; a title with a tab, newline or other control character gives 422 (the
   P6-01a carry), and a whitespace-only title or body 422; a body keeps its newlines and tabs but refuses
   every other control character; an unknown field 422; `null` for `title`, `body` or `priority` on edit
   422, and an empty edit body 422. *(framing: the carry and the edit rules added)*
9. *(framing, added)* **Expiry:** create, edit and publish refuse an `expires_at` at or before the database
   clock with 422 `notice_expired`; publish checks it in the writing `UPDATE` itself, after the row lock, so
   a notice that expired while the request waited isn't published (the P4-02b lesson), and the check
   constraint `expires_after_published` is never what refuses it (no 500).
10. *(framing, added)* **Attachment on a draft:** an edit may set, replace or clear `attachment_file_id`.
    The new file is claimed (`claim_file`); sending the current attachment's id again is a no-op, not a
    422. A replaced or cleared file stays attached to the notice in `files` but is no longer the notice's
    `attachment_file_id`, so `can_view_notice_attachment` (both sides must agree) grants it to no one,
    the manager included; a test downloads the old file id and gets 404.
11. *(framing, added)* **Audit:** `notice.created` (metadata `attachment_file_id`), `notice.updated`
    (`fields`: the changed field names, sorted, and `attachment_file_id`), `notice.published`,
    `notice.archived` (`from_status`), actor `ctx.user_id`, entity `notice`/id; no title or body text in
    any audit row.

## Test plan

- `backend/tests/notices/test_api.py`, `test_transitions.py`, `test_concurrency.py` (two sessions, as
  `tests/packages/test_concurrency.py`).
- Commands: `make check DB_PORT=55432`; `make gen-api`.

## Likely files

`backend/app/notices/{schemas,service,router}.py`, `backend/app/audit/actions.py`, `backend/app/main.py`,
`frontend/src/api/schema.d.ts`, `backend/tests/notices/*`.

## Must explain (learning checkpoint)

1. Trace `POST /notices/{id}/publish` from HTTP to COMMIT; which statement decides a race?
2. Why is editing a published notice a 409 rather than a new version?
3. How does a draft's attachment stay invisible to residents until publish?

## Open decisions (resolve while framing)

From the stub: security does not author (default **no**); editing after publish is **blocked** (default).

Left open:
- the 409 code for editing a non-draft (`invalid_transition` or a dedicated one)
- whether an attachment can be replaced or removed on a draft, and what happens to the old file's claim
  (`claim_file` has no release today)
- whether publish refuses an `expires_at` already past, and with which code
- list order (`paginate` orders by `id`; a draft published later sorts by its creation)
- whether `POST /notices` takes an `Idempotency-Key` (the stub doesn't ask for one)

## Carried from P6-01a (do while framing)

From PR #124 (explanation `docs/explanations/P6-01a-notice-schema-and-visibility.md` §7):
- `ck_notices_title_not_blank` and `ck_notices_body_not_blank` trim spaces (the body also tabs and newlines),
  so `NoticeCreate`/`NoticeUpdate` must refuse control characters before the strip
  (`app/units/schemas.py::printable_before_strip`, as the packages schemas do), with a test for a tab-only title.
- `ix_notices_building_id_status_id` matches `paginate`'s `ORDER BY id DESC`; if the feed orders by
  `published_at`, add that index in this ticket's migration.
- An expired notice keeps `status = published` (P6-01a D5): `NoticeOut` or the client shows "expired" from
  `expires_at`, and publish must refuse an `expires_at` already past by the database clock.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (multi, a building-B notice through A on every id route, the edit's
  cross-building file), 2 (statement time, one audit row), 3 (the 409 code, the edit/publish race), 4 (the
  columns, archive twice, edit code), 5 (order, status filter, cursor), 6 (writes nothing), 7 (the edit's
  failure case), 8 (control characters, blank, `null` and empty edits), and new 9 (expiry), 10 (attachment
  on a draft) and 11 (audit metadata). The case the ticket missed: an edit racing a publish (3), and a
  replaced attachment staying downloadable (10).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken:
  - **D1 Security doesn't author** (stub default, ticket): writes are `require_roles(PROPERTY_MANAGEMENT)`.
  - **D2 Editing after publish is blocked** (stub default, P6-01a `ALLOWED` has no `published → draft`).
  - **D3 Editing a non-draft is 409 `notice_not_editable`**, not `invalid_transition` (autonomous): an edit
    isn't a status move, and a client can tell "can't edit now" from "can't publish/archive now".
    Alternative: reuse `invalid_transition` (one code fewer), lost because the same code would then mean two
    things on one resource. Reversible: a code string.
  - **D4 List order is `id DESC`** (creation), as `paginate` and `ix_notices_building_id_status_id` do
    (convention, P6-01a D8). Alternative: order by `published_at` with a new keyset and index; lost on size
    (a second cursor shape and a migration in this ticket) when drafts are normally published soon after
    they are written. Limitation: a draft published days later lists below newer ones; P6-01c/P6-02 may
    revisit (follow-up).
  - **D5 Expiry refused at create, edit and publish, 422 `notice_expired`** (ticket requires publish; create
    and edit added as the same rule earlier, autonomous). Publish takes a row lock (`FOR UPDATE`) first,
    then a conditional `UPDATE … WHERE status IN (…) AND (expires_at IS NULL OR expires_at >
    statement_timestamp())` with `published_at = statement_timestamp()`: one clock value per statement, so
    the WHERE and the SET agree and the check constraint can't fire; read after the lock, so it is fresh.
    Alternatives: `clock_timestamp()` (as packages; evaluated twice, so the SET can pass the WHERE's value
    and trip `expires_after_published` as a 500), `now()` (the transaction start, before the lock wait).
  - **D6 A draft's attachment can be set, replaced or cleared** (autonomous). The old file isn't released
    (`claim_file` has no release, and a release would be a files-module change); it stays attached to the
    notice in `files`, and the hook's both-sides rule (P6-01a) stops granting it. Alternative: attachment
    fixed at create (no replace) — lost because a wrong upload would force archiving the draft; adding a
    `release_file` — lost on scope (files is Tier 1). Limitation: the replaced object stays in S3 until a
    retention job removes unreferenced attachments (follow-up).
  - **D7 No `Idempotency-Key` on `POST /notices`** (the stub doesn't ask; a duplicate draft is harmless and
    the manager archives it). Reversible: a header can be added later.
  - **D8 `NoticeUpdate` clearing:** `expires_at` and `attachment_file_id` may be `null` (cleared); `title`,
    `body`, `priority` may not (422); an empty body is 422 (convention: an action with nothing to do is a
    client error).
  - **D9 Writes lock the notice row first** (`SELECT … FOR UPDATE` through `visible_notices`), then write
    with a conditional `UPDATE … WHERE status IN (…) RETURNING` (CLAUDE.md rule 7). The lock makes the
    second of two writers re-read the committed row and answer 409 from it; the conditional UPDATE still
    guards the status.
- Split: none. Estimate ~380 non-test lines (schemas ~80, service ~200, router ~90, audit actions 4,
  generated `schema.d.ts` not counted).
