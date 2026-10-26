# P6-03a — Maintenance request schema, state machine and visibility

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P3-04b, P2-03, P1-03 |
| Replaces old | M8-T01 (schema part) |
| Status | todo |

Drafted from the P6-03 stub in [P6-P7-backlog.md](./P6-P7-backlog.md) and split four ways, as notices were
(P6-01a → b → c). Measured against what the notices slice took (`app/notices/*` 760 lines, its two migrations
207), the stub is about 1,450 non-test lines: this ticket is the request table, its photos, the state machine,
`visible_maintenance` and the photo hook; [P6-03b](./P6-03b-maintenance-submit-and-read-api.md) the resident's
submit, list, read and cancel; [P6-03c](./P6-03c-maintenance-manager-actions.md) the manager's actions and their
notifications; [P6-03d](./P6-03d-maintenance-comments.md) public and internal comments.

## Goal

The `maintenance_requests` table, its photos, its state machine and the one query that says who sees which
request exist and are tested, so P6-03b–d only add endpoints on top.

## Why

Every later maintenance read, count, action, comment and photo download narrows `visible_maintenance(ctx)`
(CLAUDE.md rule 3), and the table's constraints keep each row consistent with its status and its location
(ADR-0005). A unit-addressed request is the second record after packages that uses the occupancy window
(ADR-0016), so it must reuse `occupancy_window_clause`, not a new filter. Follows `docs/SLICE_RECIPE.md`
steps 1–3 and the file hook of step 6.

## Scope

- In:
  - `backend/app/maintenance/` with `enums.py`, `models.py`, `state.py`, `queries.py`, `photos.py`;
    registered in `app/models/registry.py`; one Alembic migration
  - the photo storage the framing picks (see "Open decisions"; the stub asks "a join table, a limit")
  - the `maintenance_photo` purpose's `can_view` hook, registered from `app/main.py` like
    `app.packages.photos` (the purpose already exists in `app/files/purposes.py`: images ≤ 10 MiB, uploaded by
    residents and property management)
  - the `Idempotency-Key` columns, if the framing takes the recipe's create pattern for P6-03b (they belong on
    the row they create, so they land in this migration)
- Out (do **not** do in this ticket):
  - any endpoint, schema, notification, email or audit action (P6-03b, P6-03c, P6-03d)
  - `maintenance_comments` (P6-03d adds it with the comment endpoints, as P6-01c added `notice_reads`)
  - where the building's emergency phone is stored (P6-03b, which exposes it)
  - seed data (P7-05)

## Interfaces

**Enums** (`app/maintenance/enums.py`, `database_enum`, values lowercase):
- `MaintenanceStatus`: `submitted`, `in_progress`, `on_hold`, `resolved`, `cancelled` (the stub's five)
- `MaintenanceLocation`: `unit`, `common_area`
- `MaintenanceCategory`: a fixed list decided in framing; it includes `emergency` (the stub's "Emergency
  category")

**Table `maintenance_requests`** (uuid7 `id`, `created_at`, `updated_at` from the mixins):

| Column | Type | Notes |
|---|---|---|
| `building_id` | uuid FK `buildings.id` RESTRICT | |
| `requester_membership_id` | uuid not null | composite FK to `building_memberships(building_id, id)` |
| `location` | `maintenance_location` not null | |
| `unit_id` | uuid null | composite FK `(building_id, unit_id) → units(building_id, id)`; set iff `location = 'unit'` |
| common-area detail | decided in framing | see "Open decisions"; null iff `location = 'unit'` |
| `category` | `maintenance_category` not null | |
| `description` | varchar (length decided in framing) not null | not blank (`btrim(…) <> ''`, the P6-01a carry) |
| `status` | `maintenance_status` not null | |
| `submitted_at` | timestamptz not null, default `now()` | the time the occupancy window is checked against |
| one `*_at` (and `*_by_membership_id` where a person acts) per status | timestamptz / uuid, null | which ones is decided in framing |
| `idempotency_key`, `request_hash` | varchar(80) / varchar(64) | only if framing takes them; `UNIQUE (building_id, idempotency_key)` |

- Composite FKs copied from `app/packages/models.py::_composite_fk`, RESTRICT; `UNIQUE (building_id, id)` now,
  as the target of the photo table's and P6-03d's comments' composite FKs (P6-01a D7).
- Check constraints: `location` agrees with `unit_id` and the common-area detail; each status has its own
  columns and no later status's (as `app/packages/models.py` and `app/notices/models.py`); every `*_at >=
  submitted_at`.
- Indexes leading with `building_id` for the lists P6-03b asks for: the manager's list by status, newest first;
  a resident's own requests (`requester_membership_id`); a unit's requests by time
  (`(building_id, unit_id, submitted_at DESC)`, for the occupancy clause).
- `MAINTENANCE_REQUEST_ATTACHED_TYPE = "maintenance_request"`.

**Photos.** Several per request (the stub's "photos"). The stub's default shape is a join table:
`maintenance_request_photos (building_id, request_id, file_id, position)` with composite FKs to
`maintenance_requests` and `files`, `UNIQUE (building_id, file_id)` (a file belongs to one request) and
`UNIQUE (request_id, position)`. The limit per request is decided in framing.

**State** (`app/maintenance/state.py`, copied from `app/packages/state.py`): `ALLOWED`, `assert_transition`
raising 409 `invalid_transition`, `sources(to)`. The stub's moves: `submitted → in_progress` (start),
`in_progress → on_hold` (hold), `→ resolved` (resolve), `submitted → cancelled` (cancel), `resolved → ?`
(reopen). The rest (see "Open decisions") is fixed in framing; this ticket only defines the map, P6-03b and
P6-03c use it.

**Visibility** (`app/maintenance/queries.py::visible_maintenance(ctx) -> Select[MaintenanceRequest]`), always on
`MaintenanceRequest.building_id == ctx.building_id`; a multi-role caller gets the union:
- `property_management`: every request of the building
- `security`: every request of the building (stub default: "read and comment only")
- `resident`: requests with `requester_membership_id = ctx.membership_id`, plus unit requests where
  `occupancy_window_clause(ctx.membership_id, MaintenanceRequest.unit_id, MaintenanceRequest.submitted_at)`
  (the stub's "their unit's requests during their occupancy window"; history follows the person, ADR-0016).
  A common-area request has no `unit_id`, so the clause is false for it and only its requester sees it unless
  framing decides otherwise.
- `council` alone: decided in framing (see "Open decisions")

**Photo hook** (`app/maintenance/photos.py`): `register_can_view(FilePurpose.MAINTENANCE_PHOTO, …)` grants a file
when it is attached as `MAINTENANCE_REQUEST_ATTACHED_TYPE` to a request in `visible_maintenance(ctx)` **and** the
request's photo rows list that file (both sides agree, as `app/packages/photos.py::can_view_package_photo`). If
P6-03d gives comments photos, it extends this hook with its own `attached_type`; any other `attached_type` is
refused here.

## Acceptance criteria

1. **Given** the migration, **when** `make migrate` and `alembic check` run, **then** they pass, and a downgrade
   then upgrade round-trips.
2. **Given** a request row, **when** each composite reference (`requester_membership_id`, `unit_id`, every
   `*_by_membership_id`, a photo's `request_id` and `file_id`) names a row of building B on a building-A request,
   **then** the insert fails on that composite FK (one parametrized case per constraint, named
   `fk_maintenance_requests_building_id_<column>`), and the same row with A's references is accepted.
3. **Given** `location = 'unit'` without a `unit_id`, or `common_area` with one (or without its common-area
   detail), **then** the location check refuses it.
4. **Given** each status, **when** a row is written with a column belonging to another status, or without its
   own, **then** the matching check constraint refuses it; a row consistent with its status is accepted; a
   blank or whitespace-only `description` is refused; an unknown status, location or category value is refused.
5. **Given** a `*_at` before `submitted_at`, **then** the insert fails.
6. **Given** every pair of statuses, **then** `assert_transition` allows exactly `ALLOWED` and raises 409
   `invalid_transition` otherwise (the same status included), and `sources(to)` matches `ALLOWED`.
7. **Given** in A one request per status from `a_resident1` for 101, one from `a_resident2` for 102, one
   common-area request from `a_resident2`, and one request in B, **then** `visible_maintenance` returns: all of
   A's for `a_manager` and `a_security`; for `a_resident1` their own requests only; for `a_resident2` theirs;
   for `multi_in_a` (household in 201) none of these; nothing of B for anyone of A; none of A's for `b_manager`;
   for `a_council` (council + resident in 201) what the council decision gives plus their own.
8. **Occupancy window.** **Given** requests for unit 101 submitted before T1, between T1 and T2, and after T2,
   **then** `a_former` sees the first only (including after moving to 102), `a_resident1` the last only, and
   each still sees their own requests whatever the unit; a request submitted exactly at a window's start is in
   it and one at its end is not (`started_at <= T < ended_at`).
9. **Given** a `ready` maintenance photo attached to a request and listed in its photo rows, **then**
   `GET /files/{id}/download-url` gives it to every persona criterion 7 lets see the request, and 404
   `file_not_found` (the same body as a random id) to the others; a file attached to a request but not in its
   photo rows, a photo row whose file is attached elsewhere, and a file of another `attached_type` are refused
   for everyone, the manager included; `b_manager` gets 404 `building_not_found` on A's URL; signed out 401.
10. **Given** `a_pending` or `a_suspended`, **then** the download route answers 404 `building_not_found`
    (`get_tenant_context`), so `visible_maintenance` is never reached for them.
11. The hook is registered by the app itself: a fresh interpreter that imports `app.main` finds
    `can_view_maintenance_photo` for `maintenance_photo` (as
    `tests/packages/test_photos.py::test_importing_the_app_alone_registers_the_package_photo_hook`).
12. The photo limit (decided in framing) is a database guarantee or an explicit service check P6-03b tests; a
    file can never be the photo of two requests (`UNIQUE (building_id, file_id)`).

## Test plan

- `backend/tests/maintenance/test_schema.py` (criteria 1–5, 12), `test_state.py` (6), `test_visibility.py`
  (7, 8, per persona and per window edge), `test_photos.py` (9–11, through `GET /files/{id}/download-url` as
  `tests/packages/test_photos.py` does).
- A `make_maintenance_request` factory (and `make_maintenance_photo`) in `backend/tests/maintenance/conftest.py`
  that flushes, never commits; `submitted_at` set from the database clock or from the world's `T1`/`T2`.
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/maintenance -q`.

## Likely files

`backend/app/maintenance/*`, `backend/app/models/registry.py`, `backend/app/main.py` (import the hook),
`backend/migrations/versions/*_maintenance_p6_03a.py`, `backend/tests/maintenance/*`. Read first:
`app/packages/{models,queries,photos,state}.py`, `app/notices/models.py`, `app/memberships/occupancy.py`,
`app/files/{purposes,service}.py`, `tests/world.py`.

Estimate: ~380 non-test lines (model and photo model 150, migration 150, state 35, queries 45, hook 35, registry
and main 5). If the common-area choice is a table, it pushes this over: move the photo table and hook to P6-03b.

## Must explain (learning checkpoint)

1. Which request does `a_former` see, and which `a_resident1`, for unit 101, and why does the window compare
   against `submitted_at` rather than `now()`?
2. Why is a common-area request invisible to other residents by default, and what would change it?
3. How does the photo hook stop a photo from reaching someone who can't see its request, and why must both the
   file and the photo row agree?
4. Which rows does each check constraint refuse, and why are they constraints and not service checks?

## Open decisions (resolve while framing)

From the stub ("Decide while framing"):
- **Can security see or act on maintenance?** Stub default: **read and comment only**. Here: security sees every
  request of the building; P6-03c's actions stay property management only; P6-03d decides what security sees
  of internal comments.

From the stub's P5-05 recipe check (each answered here because it shapes the table or the query):
- **A "common area" location:** a table of the building's areas, a fixed list, or free text (with its
  `max_length`); and **who sees a common-area request** (requester only, as the clause gives; or every
  resident, which would make it a building-wide record like a notice).
- **Which `*_at` column each status has** (for example `started_at`, `on_hold_at`, `resolved_at` and
  `resolved_by_membership_id`, `cancelled_at`), and what `reopen` leads to (`in_progress`?) and whether it clears
  `resolved_at`. If it does, a request's history is lost from the row: say whether the timeline P6-04 shows needs
  a status-event table, or comes from the audit log through no resident-facing route (it can't).
- **Photos:** a join table (stub default) or one `photo_file_id`; the limit per request; whether comments take
  photos (P6-03d, but the hook's shape is set here).
- **On hold:** whether `on_hold → in_progress` (resume) uses `/start`, and from which statuses `resolve` and
  `cancel` are allowed beyond the stub's.

Left open by the stub (decide with the decision rules):
- the `MaintenanceCategory` values (the legacy form had none; `emergency` is required)
- the `description` length limit (a notice body is 10,000; a package description 200)
- **council alone:** `PRODUCT_SCOPE.md` gives council "maintenance summaries"; the packages pattern is that
  council alone sees no rows (`app/packages/queries.py::_SEE_ALL`), and P6-05's counts give the summary
- whether P6-03b's create takes an `Idempotency-Key` (the recipe's pattern for a create a double-click could
  duplicate; a photo upload then a slow submit is that case)

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
