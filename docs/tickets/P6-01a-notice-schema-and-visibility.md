# P6-01a — Notice schema, state machine and visibility

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P3-04b, P2-03 |
| Replaces old | M6-T03 (schema part) |
| Status | done |

Drafted from the P6-01 stub in [P6-P7-backlog.md](./P6-P7-backlog.md) and split three ways, as packages were
(P5-01 → P5-02a → P5-02b), because the stub measures about 950 non-test lines: this ticket is the schema,
the state machine, `visible_notices` and the attachment hook; [P6-01b](./P6-01b-notice-authoring-api.md) the
manager's API; [P6-01c](./P6-01c-notice-reads-and-fan-out.md) reads, the unread summary and the publish
fan-out.

## Goal

The `notices` table, its state machine and the one query that says who sees which notice exist, tested, so
P6-01b and P6-01c only add endpoints on top.

## Why

Every later notice read, count, action and file download narrows `visible_notices(ctx)` (CLAUDE.md rule 3),
and the table's constraints keep each row consistent with its status (ADR-0005), so the API tickets can't
get them wrong. Follows `docs/SLICE_RECIPE.md` steps 1–3 and the file hook of step 6.

## Scope

- In:
  - `backend/app/notices/` with `enums.py`, `models.py`, `state.py`, `queries.py`, `attachments.py`;
    registered in `app/models/registry.py`; one Alembic migration
  - the `notice_attachment` file purpose's `can_view` hook, registered from `app/main.py` like
    `app.packages.photos`
- Out (do **not** do in this ticket):
  - any endpoint, schema, notification, email or audit action (P6-01b, P6-01c)
  - `notice_reads` (P6-01c adds it with the read endpoint)
  - seed data (P7-05's demo seed, or P6-01b if framing decides)

## Interfaces

**Enums** (`app/notices/enums.py`, `database_enum`, values lowercase):
- `NoticePriority`: `normal`, `urgent`
- `NoticeStatus`: `draft`, `published`, `archived`

**Table `notices`** (uuid7 `id`, `created_at`, `updated_at` from the mixins):

| Column | Type | Notes |
|---|---|---|
| `building_id` | uuid FK `buildings.id` RESTRICT | |
| `title` | varchar(200) not null | |
| `body` | varchar (length decided in framing) not null | Markdown text; P6-02 renders it without raw HTML |
| `priority` | `notice_priority` not null | |
| `status` | `notice_status` not null | |
| `expires_at` | timestamptz null | optional expiry |
| `attachment_file_id` | uuid null | composite FK `(building_id, attachment_file_id) → files(building_id, id)` |
| `author_membership_id` | uuid not null | composite FK to `building_memberships(building_id, id)` |
| `published_at`, `published_by_membership_id` | timestamptz / uuid, null | set by publish (P6-01b) |
| `archived_at`, `archived_by_membership_id` | timestamptz / uuid, null | set by archive (P6-01b) |

- Composite FKs copied from `app/packages/models.py::_composite_fk`, RESTRICT.
- Check constraints tying the columns to the status (a `draft` has no publish or archive columns, a
  `published` row has `published_at` and its publisher and no archive columns, an `archived` row has
  `archived_at` and its archiver), and `expires_at > published_at` where both are set.
- Indexes for the lists P6-01b and P6-01c ask for, leading with `building_id` (the members' feed of
  published notices newest first; the manager's list by status).
- `NOTICE_ATTACHED_TYPE = "notice"` (the `attached_type` the attachment is claimed with).

**State** (`app/notices/state.py`, copied from `app/packages/state.py`): `ALLOWED`, `assert_transition`
raising 409 `invalid_transition`, `sources(to)`. Moves: `draft → published` and `published → archived`;
whether `draft → archived` is allowed is decided in framing.

**Visibility** (`app/notices/queries.py::visible_notices(ctx) -> Select[Notice]`), always on
`Notice.building_id == ctx.building_id`:
- `property_management`: every notice of the building, any status
- every other active member (resident, security, council): `published` notices only; whether an expired
  notice stays visible is decided in framing
- a multi-role caller gets the union

Notices are building-wide, not unit-addressed, so the occupancy window (CLAUDE.md rule 3, ADR-0016) does not
apply: a resident who moved in later sees notices published before they arrived.

**Attachment hook** (`app/notices/attachments.py`): `register_can_view(FilePurpose.NOTICE_ATTACHMENT, …)`
grants a file when it is attached as `NOTICE_ATTACHED_TYPE` to a notice in `visible_notices(ctx)` whose
`attachment_file_id` is that file (both sides agree, as `app/packages/photos.py::can_view_package_photo`).

**File purpose:** the stub asks for "an optional PDF or image attachment", so the `notice_attachment`
purpose must accept both. Today `app/files/purposes.py::PURPOSES[NOTICE_ATTACHMENT]` accepts `application/pdf`
only (one 20 MiB cap, property management uploads). This ticket widens it to `IMAGE_TYPES` as well, keeping
ADR-0007's limits per type (images ≤ 10 MiB, PDF ≤ 20 MiB); how the rule expresses a per-type limit is decided
in framing.

## Acceptance criteria

1. **Given** the migration, **when** `make migrate` and `alembic check` run, **then** they pass, and a
   downgrade then upgrade round-trips.
2. **Given** a notice row, **when** a `building_id` of B is paired with an attachment file or membership of
   A (or the reverse), **then** the insert fails on the composite FK.
3. **Given** each status, **when** a row is written with a column that belongs to another status (a `draft`
   with `published_at`, a `published` row without `published_by_membership_id`, an `archived` row without
   `archived_at`), **then** the matching check constraint refuses it; a row consistent with its status is
   accepted.
4. **Given** `expires_at` at or before `published_at`, **then** the insert fails.
5. **Given** every pair of statuses, **then** `assert_transition` allows exactly `ALLOWED` and raises 409
   `invalid_transition` otherwise, and `sources(to)` matches `ALLOWED`.
6. **Given** one notice per status in A and a published notice in B, **then** `visible_notices` returns:
   for `a_manager` all of A's; for `a_security`, `a_resident1`, `a_council` and `multi_in_a` only A's
   published one; nothing of B for anyone of A; and `b_manager` none of A's.
7. **Given** a resident who joined after a notice was published (`a_former`'s second occupancy, or a
   later-created membership), **then** they see it: no occupancy filter applies.
8. **Given** a manager, **when** they start a `notice_attachment` upload (`POST /files`) of a JPEG, PNG,
   WebP or HEIC image up to 10 MiB or a PDF up to 20 MiB, **then** it is accepted (201); an image over 10 MiB
   gives 422 `file_too_large`, and any other type 422 as today.
9. **Given** a `ready` notice attachment claimed by a published notice, **then** the file's download is
   allowed for every role that sees the notice, refused (404) for a draft's attachment to non-managers, for a
   file whose notice points at another file, and for another building's member.

Added or sharpened in framing (step 1):

1a. `database_enum` stores the enums as varchar with a check constraint (`native_enum=False`), so an unknown
    `priority` or `status` value is refused by `ck_notices_notice_priority` / `ck_notices_notice_status`; the
    downgrade drops the table and a second upgrade recreates it.
2a. Criterion 2 covers every composite reference: `attachment_file_id`, `author_membership_id`,
    `published_by_membership_id`, `archived_by_membership_id` (one parametrized case each, named by its
    constraint `fk_notices_building_id_<column>`), and the same row with A's references is accepted.
3a. The state checks, exactly: `draft` has none of `published_at`, `published_by_membership_id`,
    `archived_at`, `archived_by_membership_id`; `published` has `published_at` and
    `published_by_membership_id` and neither archive column; `archived` has `archived_at` and
    `archived_by_membership_id`, and its publish columns are both set or both null (an archived draft was
    never published). Also `archived_at >= published_at`, and `title` and `body` are not blank
    (`btrim(…) <> ''`; P6-01b's schemas strip, so `''` would pass a NOT NULL alone, the P5-01 carry).
4a. `expires_at` is optional on a draft without a `published_at`; once published, `expires_at > published_at`.
5a. `ALLOWED` is exactly `draft → published`, `draft → archived`, `published → archived` (D4); every other
    pair, the same status included, is 409 `invalid_transition`; `archived` is final.
6a. Expiry (D5): a published notice whose `expires_at` is at or before the database's `now()` is invisible to
    every non-manager, in the list and the attachment hook alike; the manager still sees it. One with
    `expires_at` in the future, or none, is visible.
6b. `a_pending` and `a_suspended` hold the resident role but get nothing: `visible_notices` is only reached
    through `get_tenant_context`, which 404s them; criterion 9 checks it on the download route
    (`building_not_found`), and unauthenticated gets 401 there.
8a. Criterion 8 also: a manager's notice image at exactly 10 MiB is accepted and 10 MiB + 1 refused; a PDF
    at exactly 20 MiB accepted; the other purposes' limits are unchanged (package and maintenance photos,
    images only, 10 MiB); security, council and residents still get 403 `forbidden_role` for a
    `notice_attachment` (D1).
9a. Criterion 9 per persona: `a_manager` gets a download for a draft's, a published one's, an expired one's
    and an archived one's attachment; `a_security`, `a_resident1`, `a_council`, `a_former` and `multi_in_a`
    only the published, unexpired one's; each refusal is 404 `file_not_found` with the same body as a random
    id; `b_manager` gets 404 `building_not_found` on A's URL. A file attached as another `attached_type`, or
    to a notice whose `attachment_file_id` names another file, is refused.
10. (A case the draft missed.) The hook must be registered by the app itself: a fresh interpreter that
    imports `app.main` finds `can_view_notice_attachment` for `notice_attachment` (as
    `tests/packages/test_photos.py::test_importing_the_app_alone_registers_the_package_photo_hook`).

## Test plan

- `backend/tests/notices/test_schema.py` (criteria 1–4), `test_state.py` (5), `test_visibility.py` (6–7),
  `backend/tests/files/test_create.py` (8), `test_attachments.py` (9, through `GET /files/{id}/download-url` as
  `tests/packages/test_photos.py` does).
- A `make_notice` factory in `backend/tests/notices/conftest.py` that flushes, never commits.
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/notices -q`.

## Likely files

`backend/app/notices/*`, `backend/app/models/registry.py`, `backend/app/main.py` (import the hook),
`backend/app/files/{purposes,service}.py`, `backend/migrations/versions/*_notices.py`,
`backend/tests/notices/*`.

## Must explain (learning checkpoint)

1. Which rows does each check constraint refuse, and why are they constraints and not service checks?
2. Why does `visible_notices` not use the occupancy window, when `visible_packages` does?
3. How does the attachment hook stop a manager's draft attachment from reaching a resident?
4. Why must both sides (the file's `attached_id` and the notice's `attachment_file_id`) agree?

## Open decisions (resolve while framing)

From the stub ("Decide while framing"):
- **Can security author notices?** Stub default: **no** (the purpose's uploader roles and P6-01b's routes
  stay property management only).
- **Editing after publish:** stub default: **blocked; archive and republish instead** (this ticket's state
  machine has no `published → draft` move).

Left open by the stub (decide with the decision rules):
- the `body` length limit
- whether `draft → archived` is allowed (discarding a draft), and whether `archived` is final
- whether an expired published notice stays in `visible_notices` for non-managers, or is filtered there
  (by the database clock) so every read and count agrees
- how the purpose rule holds a per-type size limit (images 10 MiB, PDF 20 MiB) for `notice_attachment`

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1a, 2a, 3a, 4a, 5a, 6a, 6b, 8a, 9a, 10 above. Code read: `app/packages/{models,
  queries,photos,state}.py`, `app/files/{purposes,service,router}.py`, `app/notifications/service.py`,
  `tests/packages/*`, `tests/files/test_create.py`.
- Criteria loosened: none. One existing test row changes because the ticket's scope requires it:
  `tests/files/test_create.py::test_create_refuses_a_type_the_purpose_does_not_allow` has
  `("notice_attachment", "image/png")`, which the stub's "PDF or image" now allows. It becomes
  `("notice_attachment", "image/gif")` (still a refusal of a type the purpose doesn't allow), and criterion 8
  adds the positive cases. Listed in the inbox's "Decisions to audit".
- Decisions taken:
  - **D1 Security can't author notices** (stub default, rule 2): the purpose's uploader roles stay
    `property_management` only; P6-01b's write routes likewise.
  - **D2 Editing after publish is blocked** (stub default, rule 2): no `published → draft` move; to correct a
    notice, archive it and publish a new one.
  - **D3 `body` varchar(10000)** (autonomous, rule 3): a notice is Markdown, longer than a notification's 1,000;
    10,000 characters is about four pages. Alternatives: `text` unbounded (rejected: CLAUDE.md asks for
    `max_length` on every string, and the column should agree with the schema), 5,000 (no basis to prefer it).
    Reversible: widening a varchar is an expand-only migration.
  - **D4 A draft may be archived, and `archived` is final** (autonomous, rule 3): there is no delete, so
    archiving is how a manager discards a draft; reopening an archived notice is not in the stub. Alternative:
    published → archived only (rejected: drafts would pile up in the manager's list forever). Reversible
    (remove the move).
  - **D5 Expiry hides a notice in `visible_notices` for non-managers, by the database clock** (autonomous,
    rule 3, the SLICE_RECIPE "time limits by `now()`"): every read, count and the file hook then agree with no
    job flipping a status. Alternatives: an `expired` status set by a scheduled job (rejected: a new job and a
    window where the status lags), filtering only the list (rejected: the summary and the attachment would
    disagree with it). `now()` is the transaction's start; a notice expiring mid-request is decided by that
    instant.
  - **D6 Per-type size limits** (ADR-0007 "Limits", rule 1): `PurposeRule` holds a limit per content type
    (`limits: Mapping[str, int]`, its `content_types` derived from the keys), so `notice_attachment` takes
    images ≤ 10 MiB and PDF ≤ 20 MiB, and `create_file` checks the limit of the requested type. Alternative:
    one 20 MiB cap for both (rejected: contradicts ADR-0007's 10 MiB for images).
  - **D7 `UNIQUE (building_id, id)` on `notices` now** (convention, ADR-0005): P6-01c's `notice_reads` needs it
    as its composite FK target; adding it with the table avoids a second migration on `notices`.
  - **D8 One list index `(building_id, status, id DESC)`** (convention): it matches `paginate`'s `ORDER BY id
    DESC` under a status filter. If P6-01b orders the feed by `published_at`, it adds its index there.
  - Not in this ticket: seed data (out of scope, as drafted).
- Split: none. Estimate ~310 non-test lines (model 95, migration 90, state 35, queries 35, hook 30, purposes and
  files service 20, registry and main 5).

## Follow-ups (from PR #124)

- Carried to [P6-01b](./P6-01b-notice-authoring-api.md): `ck_notices_title_not_blank` trims spaces only, so the
  API schema must refuse control characters (a tab-only title would pass the database); the feed index if it
  orders by `published_at` (D8); attachment replacement on a draft.
