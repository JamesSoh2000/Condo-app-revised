# P6-03a — Maintenance request schema, state machine and visibility

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P3-04b, P2-03, P1-03 |
| Replaces old | M8-T01 (schema part) |
| Status | done |

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
   `fk_maintenance_requests_building_id_<column>`, and for the photo table
   `fk_maintenance_request_photos_building_id_<column>`), and the same row with A's references is accepted.
3. **Given** `location = 'unit'` without a `unit_id`, or `common_area` with one (or without its common-area
   detail), **then** the location check refuses it.
4. **Given** each status, **when** a row is written with a column belonging to another status, or without its
   own, **then** the matching check constraint (`ck_maintenance_requests_<status>_state`) refuses it — the
   columns per status are fixed in the Frame notes (D3): one case per (status, column) pair, each a column
   set or cleared on an otherwise consistent row; a row consistent with its status is accepted; a
   blank or whitespace-only `description` is refused; an unknown status, location or category value is refused.
5. **Given** a `*_at` before `submitted_at`, **then** the insert fails (one case per `*_at` column); an
   `on_hold_at` or `resolved_at` before `started_at` fails too; each equal to its bound is accepted.
6. **Given** every pair of statuses, **then** `assert_transition` allows exactly `ALLOWED` and raises 409
   `invalid_transition` otherwise (the same status included), and `sources(to)` matches `ALLOWED`.
7. **Given** in A one request per status from `a_resident1` for 101, one from `a_resident2` for 102, one
   common-area request from `a_resident2`, and one request in B, **then** `visible_maintenance` returns: all of
   A's for `a_manager` and `a_security`; for `a_resident1` their own requests only; for `a_resident2` theirs;
   for `multi_in_a` (household in 201) none of these; nothing of B for anyone of A; none of A's for `b_manager`;
   for `a_council` (council + resident in 201) their own requests only (council alone sees none, D8);
   for `a_former` (in 102 since T1) `a_resident2`'s requests for 102 (submitted during their 102 occupancy,
   ADR-0016) but not `a_resident2`'s common-area one nor any for 101 submitted after T1; a council-only
   context (roles `{council}`) sees none.
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
12. The photo limit is a database guarantee: `position` is between 0 and 4 and `(request_id, position)` is the
    primary key, so a sixth photo of one request, a position of -1 or 5, and a second photo at a taken position
    are refused; a file can never be the photo of two requests (`UNIQUE (building_id, file_id)`), in the same or
    another request.
13. **Idempotency key.** **Given** two requests in A with the same `idempotency_key`, **then** the second fails
    on `uq_maintenance_requests_building_id_idempotency_key`; the same key in B is accepted.
14. **Common-area detail.** A blank or whitespace-only `common_area` is refused, as `description` is.

## Test plan

- `backend/tests/maintenance/test_schema.py` (criteria 1–5, 12–14), `test_state.py` (6), `test_visibility.py`
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
  - 2: the photo table's FK names. 4: per (status, column) pair against D3's column sets. 5: one case per
    `*_at`, plus `on_hold_at`/`resolved_at >= started_at` and the equal bound accepted.
  - 7: `a_council` resolved to "own only" (D8); added `a_former`, who as 102's co-occupant since T1 sees
    `a_resident2`'s 102 requests but not their common-area one (the case the ticket missed: a co-occupant of
    the *requester's* unit, not only a later occupant), and a council-only context.
  - 12: the limit is a database guarantee (D5). New 13 (idempotency key unique per building, D9) and 14
    (blank common-area detail refused, D2).
  - 10-case table: the only route touched is `GET /files/{id}/download-url` (criteria 9–10 cover rows 1–6);
    rows 7–10 apply to P6-03b/c endpoints, not to a schema.
- Criteria loosened: none.
- Decisions taken:
  - **D1 Security** sees every request of the building (stub default; ticket). Actions stay with property
    management (P6-03c).
  - **D2 Common area** is free text, `common_area varchar(120)`, not blank, set iff `location = 'common_area'`.
    Alternatives: a table of the building's areas (a new admin surface and migration; the ticket says it would
    push this over the budget), a fixed enum (buildings differ: a gameroom, a speakeasy). Free text is the
    simplest, and reversible: a later areas table can be added and the text kept as a label. Basis: decision
    rule 3. Visible to its **requester only** (the clause is false without a unit; ticket default): a
    building-wide request would be a different kind of record, like a notice. Lasting (table shape): ADR.
  - **D3 Columns per status** (the row holds the *current* state):
    `submitted` — none of the below; `in_progress` — `started_at`, `started_by_membership_id`; `on_hold` —
    started ones and `on_hold_at`, `on_hold_by_membership_id`; `resolved` — started ones and `resolved_at`,
    `resolved_by_membership_id`; `cancelled` — `cancelled_at`, `cancelled_by_membership_id` only. Every other
    status's columns are NULL. `started_*` is the first start and is kept through hold, resolve and reopen.
  - **D4 State machine:** `submitted → in_progress | cancelled`; `in_progress → on_hold | resolved`;
    `on_hold → in_progress` (resume, P6-03c's `/start`) `| resolved`; `resolved → in_progress` (reopen);
    `cancelled` final (no reopen of a cancelled request: the resident withdrew it; they submit a new one).
    Cancel stays `submitted` only (stub): once work started, the manager resolves it. Reopen clears
    `resolved_*` (D3: the row is the current state), and the 14 days count from `resolved_at`, which is on the
    row while it is `resolved`. **History:** since resume and reopen repeat statuses, the row can't carry the
    timeline P6-04c shows; the timeline needs a status-event table, and the audit log can't serve a resident.
    P6-03c adds `maintenance_status_events` with the actions that write it (as P6-03d adds comments with their
    endpoints); submit and cancel are once-only, so `submitted_at` and `cancelled_*` on the row are their
    events. Alternative: keep every `*_at` and never clear (loses repeated holds anyway, and makes the state
    checks depend on order). Lasting: ADR, and the follow-up goes to P6-03c in step 6.
  - **D5 Photos:** the join table (stub default), `maintenance_request_photos (request_id, position)` primary
    key, `building_id`, `file_id`, composite FKs, `UNIQUE (building_id, file_id)`, `CHECK (position BETWEEN 0
    AND 4)`: at most **5** photos, enforced by the database. Five is a phone's worth of angles on one fault and
    is reversible (widen the check). Comments' photos stay P6-03d's decision; this hook refuses every other
    `attached_type`.
  - **D6 Categories:** `plumbing`, `electrical`, `heating_cooling`, `appliance`, `doors_windows`,
    `pest_control`, `other`, `emergency`. Basis: rule 3 (the legacy form had none; common condo trades);
    adding an enum value later is an expand-only migration.
  - **D7 `description`** varchar(2000), not blank (`btrim(description, E' \t\n\r') <> ''`, as a notice body,
    since a description keeps newlines). Between a package's 200 and a notice's 10,000: a fault report, not an
    article; widening is cheap.
  - **D8 Council alone** sees no requests (the packages pattern, `_SEE_ALL`); "maintenance summaries" come
    from P6-05's counts. A council member who is also a resident sees their own.
  - **D9 Idempotency-Key** is taken for P6-03b's create (the recipe's pattern; a photo upload then a slow
    submit is the double-click case): `idempotency_key varchar(80)` and `request_hash varchar(64)` NOT NULL, as
    packages, `UNIQUE (building_id, idempotency_key)`.
  - **D10 Indexes:** `(building_id, status, id DESC)` for the manager's list (`paginate` orders by id, as
    notices), `(requester_membership_id)` (as packages' recipient), `(building_id, unit_id, submitted_at DESC)`.
- Split: none. Estimate ~400 non-test lines (models ~150, migration ~160, state 40, queries 45, hook 35, wiring
  5), inside the budget; the status-event table goes to P6-03c (D4), which keeps it so.
