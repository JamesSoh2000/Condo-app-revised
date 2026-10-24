# P6-01a — Notice schema, state machine and visibility

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P3-04b, P2-03 |
| Replaces old | M6-T03 (schema part) |
| Status | todo |

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

**File purpose:** the stub asks for "an optional PDF or image attachment". Today
`app/files/purposes.py::PURPOSES[NOTICE_ATTACHMENT]` accepts `application/pdf` only (20 MB, property
management uploads). Whether this ticket widens it to `IMAGE_TYPES` too is decided in framing.

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
8. **Given** a `ready` notice attachment claimed by a published notice, **then** the file's download is
   allowed for every role that sees the notice, refused (404) for a draft's attachment to non-managers, for a
   file whose notice points at another file, and for another building's member.

Framing adds the remaining 10-case rows that apply to a schema ticket (none of rows 1–4 and 9–10 have an
endpoint yet; rows 5–7 are criteria 6–8).

## Test plan

- `backend/tests/notices/test_schema.py` (criteria 1–4), `test_state.py` (5), `test_visibility.py` (6–7),
  `test_attachments.py` (8, through `GET /files/{id}/download` as `tests/packages/test_photos.py` does).
- A `make_notice` factory in `backend/tests/notices/conftest.py` that flushes, never commits.
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/notices -q`.

## Likely files

`backend/app/notices/*`, `backend/app/models/registry.py`, `backend/app/main.py` (import the hook),
`backend/app/files/purposes.py` (if widened), `backend/migrations/versions/*_notices.py`,
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
- whether the `notice_attachment` purpose accepts images as well as PDF (the stub says "PDF or image")

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
