# P6-03b — Maintenance submit, read and cancel API

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03a, P2-04, P3-03, P3-04b |
| Replaces old | M8-T01 (resident API part), M8-T04 (new-request part) |
| Status | todo |

Split from the P6-03 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); the schema is
[P6-03a](./P6-03a-maintenance-schema-and-visibility.md), the manager's actions
[P6-03c](./P6-03c-maintenance-manager-actions.md), comments [P6-03d](./P6-03d-maintenance-comments.md).

## Goal

A resident submits a maintenance request (category, description, a unit or common-area location, photos) and
can cancel it while it is `submitted`; every member lists and reads the requests `visible_maintenance` lets
them see; an emergency request shows the building's emergency phone.

## Why

The resident's half of journey 6 (`docs/PRODUCT_SCOPE.md`: "A resident submits a request with a photo"), on the
create/read pattern of P5-02a and the action pattern of P5-02b (CLAUDE.md rule 7). It is the first create in the
app where a **resident** names a unit, so the unit check is part of the security boundary: a request filed for
someone else's unit would show up in that household's list.

## Scope

- In (building router, `require_feature(Feature.MAINTENANCE)` on every route):
  - **`POST /maintenance-requests`** (`require_roles(Role.RESIDENT, …)`; whether property management may file
    one is decided in framing) → 201 `MaintenanceRequestOut`, `status = submitted`,
    `requester_membership_id = ctx.membership_id`, `submitted_at` from the database clock; each photo through
    `claim_file(…, FilePurpose.MAINTENANCE_PHOTO, MAINTENANCE_REQUEST_ATTACHED_TYPE, id)` and a photo row
  - **`GET /maintenance-requests?status=&cursor=`**: `visible_maintenance(ctx)`, optional status filter, cursor
    pages, newest first
  - **`GET /maintenance-requests/{id}`**: 404 `maintenance_request_not_found` unless visible
  - **`POST /maintenance-requests/{id}/cancel`**: `submitted → cancelled` by the requester (stub: "cancelled by
    the resident while `submitted`"); who else may cancel is decided in framing
  - the notification on a new request, if framing decides one (see "Open decisions"): its kind in
    `app/notifications/kinds.py`
  - the building's emergency phone, stored where framing decides, and returned with an emergency request
  - audit `maintenance.submitted`, `maintenance.cancelled`, IDs and field names only
  - `make gen-api`
- Out:
  - start, hold, resolve, reopen and their notifications (P6-03c)
  - comments (P6-03d)
  - the frontend (P6-04); the dashboard count (P6-05)
  - an API to edit the emergency phone, unless framing finds no other way to set it (then the bootstrap CLI
    and the seed set it, as for the building's other fields)

## Interfaces

Operation ids `maintenance_create`, `maintenance_list`, `maintenance_get`, `maintenance_cancel` (tag
`maintenance`; the function names are the verbs).

- `MaintenanceRequestCreate(InputModel)`: `location`, `unit_id` (required iff `location = unit`), the
  common-area detail (P6-03a's shape; required iff `common_area`), `category`, `description` (P6-03a's length,
  stripped, printable before the strip with newlines and tabs kept, as `app/notices/schemas.py` does for a
  body), `photo_file_ids: list[UUID]` (0 to P6-03a's limit, no duplicates).
- `MaintenanceRequestOut(APIModel)`: the row's columns, `photo_file_ids` in order (never an S3 key; each is
  downloaded through `GET /files/{id}/download-url`), the unit's label, and `emergency_phone` (only on an
  `emergency` request; null otherwise or if the building has none). Whether a resident sees the requester's name
  when a co-occupant filed it is decided in framing (`app/packages/queries.py::sees_recipient_names` is the
  pattern).
- Errors: 404 `maintenance_request_not_found`; 409 `invalid_transition`; 404 `unit_not_found` for a unit of
  another building or none (rule 2); 422 `unit_inactive` for a deactivated unit (as
  `app/packages/service.py`); 422 for a unit the resident doesn't currently occupy (code decided in framing); `claim_file`'s 404 `file_not_found` / 422 `invalid_file`; 422 for too many or duplicate photos;
  `Idempotency-Key` errors as `app/packages` if framing takes it.

## Acceptance criteria

1. **The 10-case table** holds for every endpoint:
   - row 1: `a_resident1` creates, lists, reads and cancels their own; `a_manager` and `a_security` list and
     read every request of A;
   - row 2: signed out 401 on every route;
   - row 3: `b_manager` 404 `building_not_found` on A's URLs;
   - row 4: `a_security` and `a_manager` (unless framing lets the manager file) get 403 `forbidden_role` on
     create; `a_security` and `a_manager` 403 on cancel (or as framing decides);
   - row 5: `a_resident2` gets 404 `maintenance_request_not_found` on `a_resident1`'s request (`GET` and
     `cancel`), the same body (minus `request_id`) as a random id;
   - row 6: `a_pending` and `a_suspended` 404 `building_not_found` on every route;
   - row 7: a `unit_id` or `photo_file_ids` entry of building B gives 404 (`unit_not_found` /
     `file_not_found`), with no request, photo row, claim, notification or audit row written; a B request id
     on A's URL is 404 `maintenance_request_not_found`;
   - row 8: cancelling a request that isn't `submitted` gives 409 `invalid_transition`;
   - row 9: if framing takes `Idempotency-Key`, a retry with the same key and body returns the original (201,
     same id, no second claim), and the same key with another body 422 `idempotency_key_reused`;
   - row 10: two cancels at once give one 200 and one 409, with one audit row.
2. **Unit check.** **Given** `a_resident1` (tenant in 101), **when** they submit for 101, **then** 201; for 102
   (a unit of A they don't occupy) **then** 422 and nothing written; `a_former` can't file for 101 (a past
   occupancy) but can for 102; a resident with no current occupancy can file only a common-area request (if
   framing allows those for them). The check reads the occupancy in the same transaction as the insert, `FOR KEY
   SHARE`, so a move-out committing meanwhile can't leave a request on a unit its requester just left.
3. **Location shape.** `location = unit` without `unit_id`, or `common_area` with one or without its detail,
   gives 422 from the schema, never a 500 from P6-03a's check constraint.
4. **Photos.** Each photo is claimed and listed in order; more than the limit, a duplicate id, a file of another
   purpose, a pending file, or another user's file (`claim_file` checks the uploader for a resident purpose) gives
   the documented 404/422 and writes nothing; the request's photos download for each persona who sees the
   request (P6-03a criterion 9 holds end to end).
5. **Visibility through the API.** `GET /maintenance-requests` and `GET …/{id}` return exactly what P6-03a's
   criterion 7 and 8 say per persona, including `a_former` after the move and `multi_in_a`; `?status=` takes
   one status; an unknown one is 422; the cursor pages without skipping or repeating a row when two requests
   share a `submitted_at`.
6. **Cancel.** **Given** a `submitted` request, **when** its requester cancels, **then** it is `cancelled` with
   its cancel columns set by the database clock and the caller, and one `maintenance.cancelled` audit row; the
   requester check is in the conditional `UPDATE`'s `WHERE` (SLICE_RECIPE step 4), so a co-occupant who can see
   the request gets the answer framing decides (404 or 403), never a cancel. **Given** a request a manager
   started at the same time, **then** exactly one of start (P6-03c) and cancel wins; here, with a raw `UPDATE` to
   `in_progress` in a second session, the cancel gets 409.
7. **Emergency.** **Given** `category = emergency`, **then** the 201 and every read of that request include the
   building's `emergency_phone`; no other category does. The request is still created and handled like any
   other: the app never claims to have alerted anyone (stub: "never rely on the app"); P6-04 shows the copy.
8. **New-request notification** (as framing decides): the recipients, the kind and whether it emails are each a
   test; the requester is never notified of their own request; the notification's title is fixed and its body
   holds no description text a recipient couldn't see on the request.
9. **Feature off.** **Given** `maintenance` disabled for A, **then** every endpoint gives 403
   `feature_disabled` and writes nothing.
10. **Atomicity.** **Given** a forced failure after the insert and the photo claims and before commit, **then** no
    request, photo row, claim, notification, job or audit row persists, and the files are unattached again.
11. **Input.** NUL, lone surrogates, over-long strings, a blank description, an unknown field, an unknown
    category or location give 422; a description keeps newlines and tabs and refuses every other control
    character.
12. **Audit.** `maintenance.submitted` (metadata: `unit_id`, `category`, `photo_file_ids`),
    `maintenance.cancelled` (`from_status`); actor `ctx.user_id`, entity `maintenance_request`/id; no description
    text in any audit row.

## Test plan

- `backend/tests/maintenance/test_api.py` (1–5, 9, 11), `test_cancel.py` (6), `test_emergency.py` (7),
  `test_notify.py` (8), `test_atomicity.py` (10), `test_concurrency.py` (1 row 10, 2's move-out race, 6's
  start-vs-cancel race; two sessions, as `tests/packages/test_concurrency.py`), `test_idempotency.py` if taken.
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/maintenance -q`; `make gen-api`.

## Likely files

`backend/app/maintenance/{schemas,service,router}.py`, `backend/app/audit/actions.py`,
`backend/app/notifications/kinds.py` (and a template under `app/email/templates/en/` if the kind emails),
`backend/app/main.py`, the emergency phone's home (`app/buildings/models.py` and a migration, or the feature's
`config`), `frontend/src/api/schema.d.ts`, `backend/tests/maintenance/*`. Copy from `app/packages/service.py`
(`create_package`, `_for_transition`, `_transition`) and `app/packages/router.py`.

Estimate: ~400 non-test lines (schemas 110, service 190, router 80, kinds and actions 15, emergency phone 10–40).
If the emergency phone needs a new column with a migration and the create takes `Idempotency-Key`, move cancel to
P6-03c.

## Must explain (learning checkpoint)

1. Trace `POST /maintenance-requests` from HTTP to COMMIT: where is the unit checked, where is each photo
   claimed, and what stops a move-out committing in between from leaving a request on a unit its requester left?
2. Why does cancel put the requester check in the `UPDATE`'s `WHERE` rather than in Python before it?
3. Why can't a resident file for a unit they don't occupy, when the schema's composite FK already keeps the unit
   in the building?
4. What does the API do for an emergency request, and what does it deliberately not promise?

## Open decisions (resolve while framing)

From the stub ("Decide while framing"):
- **Emergency category behaviour.** Stub default: **show the building's emergency phone, and never rely on the
  app.** Left open: where the phone lives (a `buildings.emergency_phone` column set by the bootstrap CLI and the
  seed, or the maintenance feature's `building_features.config`), and whether an emergency request notifies or
  emails managers differently.
- **Security.** Stub default: read and comment only, so security doesn't create or cancel.

From the stub's P5-05 recipe check:
- whether `cancel` is the **requester only** or any occupant who can see the request (and the answer for one who
  can see it but may not cancel: 403 `forbidden_role` or 404)
- who is notified on a **new request** (the building's managers? security?) and whether it emails
- several photos per request: the limit (P6-03a fixes it; this ticket enforces and tests it)

Left open by the stub:
- whether property management may file a request (for a common area, or on a resident's behalf; the
  `maintenance_photo` purpose already lets them upload)
- whether a resident sees a co-occupant requester's name
- the 422 code for a unit the resident doesn't occupy
- `Idempotency-Key` on create (P6-03a's columns)
- the list's order key (`submitted_at` with `id` as tiebreak, or `id DESC` as `paginate` does)

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
