# P6-01b — Notice authoring API

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-01a, P2-04, P3-04b |
| Replaces old | M6-T03 (API part), M6-T09 (backend part) |
| Status | todo |

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
  through `GET /files/{id}/download`).
- Errors: 404 `notice_not_found`; 409 `invalid_transition`; 409 for editing a non-draft (code decided in
  framing); `claim_file`'s 404 `file_not_found` / 422 `invalid_file`; 422 for an expiry already past at
  publish (code decided in framing).

## Acceptance criteria

1. **The 10-case table** holds for every endpoint: `a_manager` succeeds on writes; `a_security`,
   `a_resident1` and `a_council` get 403 `forbidden_role` on every write; unauthenticated 401; `b_manager`,
   `a_pending`, `a_suspended` 404 `building_not_found`; a draft or archived notice is 404
   `notice_not_found` on `GET` for non-managers, the same body as a random id; a building-B
   `attachment_file_id` gives 404 `file_not_found` with no notice row written.
2. **Given** a draft, **when** the manager publishes it, **then** it is `published` with `published_at` and
   the publisher set; publishing again gives 409 `invalid_transition`; of two concurrent publishes exactly
   one wins and the other gets 409.
3. **Given** a published notice, **when** the manager edits it, **then** 409 and the row is unchanged
   (stub default: editing after publish is blocked).
4. **Given** archive, **then** it follows P6-01a's `ALLOWED`; an archived notice can't be published or
   edited (409).
5. **Given** a published notice, **then** `GET /notices` lists it for every active member of A, newest
   first, and drafts only for the manager; `?status=draft` for a resident is an empty page.
6. **Given** the `notices` feature disabled for A, **then** every endpoint gives 403 `feature_disabled`.
7. **Given** a forced failure after the insert and before commit, **then** no notice, file claim or audit row
   persists.
8. Input Postgres would refuse never reaches it: NUL, lone surrogates and over-long strings give 422; a
   naive `expires_at` gives 422.

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

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
