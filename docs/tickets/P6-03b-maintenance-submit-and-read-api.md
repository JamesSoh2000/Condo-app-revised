# P6-03b — Maintenance submit and read API

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03a, P2-04, P3-03, P3-04b |
| Replaces old | M8-T01 (resident API part), M8-T04 (new-request part) |
| Status | in progress |

Split from the P6-03 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); the schema is
[P6-03a](./P6-03a-maintenance-schema-and-visibility.md), the manager's actions
[P6-03c](./P6-03c-maintenance-manager-actions.md), comments [P6-03d](./P6-03d-maintenance-comments.md).
Split again while building (Frame notes, "Split"): cancel and the emergency phone are [P6-03e](./P6-03e-maintenance-cancel-and-emergency-phone.md).

## Goal

A resident submits a maintenance request (category, description, a unit or common-area location, photos);
every member lists and reads the requests `visible_maintenance` lets them see; the managers are told. (Cancel
and the emergency phone: P6-03e.)

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
  - ~~**`POST /maintenance-requests/{id}/cancel`**~~: moved to [P6-03e](./P6-03e-maintenance-cancel-and-emergency-phone.md)
  - the notification on a new request, if framing decides one (see "Open decisions"): its kind in
    `app/notifications/kinds.py`
  - ~~the building's emergency phone~~: moved to [P6-03e](./P6-03e-maintenance-cancel-and-emergency-phone.md)
  - audit `maintenance.submitted` (`maintenance.cancelled`: P6-03e), IDs and field names only
  - `make gen-api`
- Out:
  - start, hold, resolve, reopen and their notifications (P6-03c)
  - comments (P6-03d)
  - the frontend (P6-04); the dashboard count (P6-05)
  - an API to edit the emergency phone, unless framing finds no other way to set it (then the bootstrap CLI
    and the seed set it, as for the building's other fields)

## Interfaces

Operation ids `maintenance_create`, `maintenance_list`, `maintenance_get` (tag `maintenance`; the function
names are the verbs); `maintenance_cancel` is P6-03e's.

- `MaintenanceRequestCreate(InputModel)`: `location`, `unit_id` (required iff `location = unit`), the
  common-area detail (P6-03a's shape; required iff `common_area`), `category`, `description` (P6-03a's length,
  stripped, printable before the strip with newlines and tabs kept, as `app/notices/schemas.py` does for a
  body), `photo_file_ids: list[UUID]` (0 to P6-03a's limit, no duplicates).
- `MaintenanceRequestOut(APIModel)`: the row's columns, `photo_file_ids` in order (never an S3 key; each is
  downloaded through `GET /files/{id}/download-url`), the unit's label (`emergency_phone` is added by P6-03e).
  Whether a resident sees the requester's name
  when a co-occupant filed it is decided in framing (`app/packages/queries.py::sees_recipient_names` is the
  pattern).
- Errors: 404 `maintenance_request_not_found`; 409 `invalid_transition`; 404 `unit_not_found` for a unit of
  another building or none (rule 2); 422 `unit_inactive` for a deactivated unit (as
  `app/packages/service.py`); 422 for a unit the resident doesn't currently occupy (code decided in framing); `claim_file`'s 404 `file_not_found` / 422 `invalid_file`; 422 for too many or duplicate photos;
  `Idempotency-Key` errors as `app/packages` if framing takes it.

## Acceptance criteria

1. **The 10-case table** holds for every endpoint:
   - row 1: `a_resident1` creates, lists and reads their own (cancel: P6-03e); `a_manager` and `a_security` list and
     read every request of A;
   - row 2: signed out 401 on every route;
   - row 3: `b_manager` 404 `building_not_found` on A's URLs;
   - row 4: `a_security` and `a_manager` get 403 `forbidden_role` on create (only residents file, D2; cancel:
     P6-03e), and `a_council` (council + resident) is let through as a resident; council alone
     lists an empty page;
   - row 5: `a_resident2` gets 404 `maintenance_request_not_found` on `a_resident1`'s request (`GET`; `cancel`:
     P6-03e), the same body (minus `request_id`) as a random id;
   - row 6: `a_pending` and `a_suspended` 404 `building_not_found` on every route;
   - row 7: a `unit_id` or `photo_file_ids` entry of building B gives 404 (`unit_not_found` /
     `file_not_found`), with no request, photo row, claim, notification or audit row written; a B request id
     on A's URL is 404 `maintenance_request_not_found`;
   - row 8: moved to [P6-03e](./P6-03e-maintenance-cancel-and-emergency-phone.md) with cancel (create and reads have no transition);
   - row 9: `Idempotency-Key` is required (D7): a retry with the same key and body returns the original (201,
     same id, `Idempotent-Replayed: true`, no second claim, photo row, notification or audit row), and the same
     key with another body 409 `idempotency_key_reused` (as `app/packages`, D7; the draft said 422); a missing
     key 400 `idempotency_key_required`, a malformed one 400 `invalid_idempotency_key`; **another resident's
     key** (the key is unique per building, not per requester) gives 409 `idempotency_key_reused`, never their
     request and never a 500;
   - row 10: two creates at once with one key give one request (one `created`, one replay) and one set of
     notifications; with two bodies, one `created` and one 409 (two cancels at once: P6-03e).
2. **Unit check.** **Given** `a_resident1` (tenant in 101), **when** they submit for 101, **then** 201; for 102
   (a unit of A they don't occupy) **then** 422 `unit_not_occupied` and nothing written; `a_former` can't file
   for 101 (a past occupancy) but can for 102; `a_council` (resident in 201) can file for 201; `multi_in_a`
   (household in A-201) can file for A-201, from A's context; a resident with no current occupancy can file
   only a common-area request (any resident may, D4); a deactivated unit gives 409 `unit_inactive` (as
   `app/packages`, whose `UnitInactive` is a 409; the draft said 422). The check runs in the same transaction as
   the insert, after locking the caller's membership row `FOR SHARE`: every occupancy write first locks that
   row `FOR NO KEY UPDATE` (`app/memberships/occupancy.py::_prepare`), which `FOR SHARE` blocks and the
   draft's `FOR KEY SHARE` would not, so a move-out committing meanwhile waits for the insert's commit (or the
   check reads the ended occupancy) and can't leave a request on a unit its requester just left. A test holds a
   move-out open in a second session and shows the create waits, then answers 422. `submitted_at` is the
   transaction's `now()`, the clock occupancy writes use (ADR-0016): a move-out or transfer that began during
   the create and waited on its lock ends the occupancy after the request, so the incoming household never
   sees it; an occupancy that started after the create's `now()` gives 409 `occupancy_changed` (retry), so a
   request is never stamped in the unit's previous occupancy. (Review round 1, F1: framing first said
   `clock_timestamp()` after the lock, which put the request after a waiting transfer's end.)
3. **Location shape.** `location = unit` without `unit_id`, or `common_area` with one or without its detail,
   gives 422 from the schema, never a 500 from P6-03a's check constraint.
4. **Photos.** Each photo is claimed and listed in order; more than the limit, a duplicate id, a file of another
   purpose, a pending file, or another user's file (`claim_file` checks the uploader for a resident purpose) gives
   the documented 404/422 and writes nothing; the request's photos download for each persona who sees the
   request (P6-03a criterion 9 holds end to end).
5. **Visibility through the API.** `GET /maintenance-requests` and `GET …/{id}` return exactly what P6-03a's
   criterion 7 and 8 say per persona, including `a_former` after the move and `multi_in_a`; `?status=` takes
   one status; an unknown one is 422; the cursor pages without skipping or repeating a row when two requests
   share a `submitted_at` (the order is `id DESC`, D6, so a shared time can't tie); `requester_name` is the
   requester's current full name for `a_manager` and `a_security`, and null for every resident, a co-occupant's
   request included (D8).
6. **Cancel.** Moved to [P6-03e](./P6-03e-maintenance-cancel-and-emergency-phone.md) (criterion 1 there), unchanged.
7. **Emergency.** Moved to [P6-03e](./P6-03e-maintenance-cancel-and-emergency-phone.md) (criterion 2 there), unchanged. The emergency *notification* (criterion 8) stays
   here: it needs no phone.
8. **New-request notification** (D5): every active `property_management` member of A gets one, kind
   `maintenance.submitted` (in-app only), or `maintenance.submitted_emergency` for an emergency (in-app and an
   `email.send` job each, template `notification`); security, council and residents get none; the requester is
   never notified of their own request (a resident who is also the manager); the title is fixed ("New
   maintenance request" / "Emergency maintenance request") and the body holds only the category and the unit's
   name, or "a common area", never the description or the common-area text; a retry (row 9) notifies no one.
   Each of these is a test.
9. **Feature off.** **Given** `maintenance` disabled for A, **then** every endpoint gives 403
   `feature_disabled` and writes nothing.
10. **Atomicity.** **Given** a forced failure after the insert and the photo claims and before commit, **then** no
    request, photo row, claim, notification, job or audit row persists, and the files are unattached again.
11. **Input.** NUL, lone surrogates, over-long strings, a blank description, an unknown field, an unknown
    category or location give 422; a description keeps newlines and tabs and refuses every other control
    character.
12. **Audit.** `maintenance.submitted` (metadata: `unit_id`, `category`, `photo_file_ids`; `maintenance.cancelled`
    is P6-03e's); actor `ctx.user_id`, entity `maintenance_request`/id; no description
    text in any audit row.

## Test plan

- `backend/tests/maintenance/test_api.py` (1–5, 9, 11, 12), `test_notify.py` (8), `test_atomicity.py` (10),
  `test_concurrency.py` (1 rows 9–10, 2's move-out race; two sessions, as `tests/packages/test_concurrency.py`),
  `test_idempotency.py` (1 row 9).
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
2. (Moved to P6-03e: why cancel puts the requester check in the `UPDATE`'s `WHERE`.) Why does a retry with
   another resident's `Idempotency-Key` answer 409 instead of their request?
3. Why can't a resident file for a unit they don't occupy, when the schema's composite FK already keeps the unit
   in the building?
4. Who hears of a new request, by which channel, and what text may the notification carry?

## Open decisions (resolve while framing)

Carried from P6-03a (PR #137): the schema does not tie a `maintenance_request_photos` row to a `maintenance_photo`
file, and does not force positions to be dense. The create must claim each photo with
`FilePurpose.MAINTENANCE_PHOTO` (a `package_photo` or `notice_attachment` file id gives `claim_file`'s 422, with a
test) and write positions 0..n-1 in the order given. The `Idempotency-Key` columns are NOT NULL, so the create
requires the header.

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
  - 1 row 4 (who files and cancels, D2/D3); row 9 (required key, its 400s, and the case the draft missed:
    **another resident's key** — the key is unique per building, so a lookup through `visible_maintenance`
    would miss the other's row and the `ON CONFLICT DO NOTHING` path would find nothing, a 500; the create
    answers 409 `idempotency_key_reused`).
  - 2: the code `unit_not_occupied`; `a_council` and `multi_in_a` cases; common-area for any resident (D4);
    the lock mode corrected from `FOR KEY SHARE` to `FOR SHARE` on the caller's membership (the stronger lock:
    `FOR KEY SHARE` does not conflict with the occupancy writes' `FOR NO KEY UPDATE`, so it would not stop the
    race the criterion names), with a two-session test; `submitted_at` on the transaction's `now()` (ADR-0016)
    with 409 `occupancy_changed` for a later move-in (review round 1 replaced the framed `clock_timestamp()`).
  - 5: `requester_name` (D8); order `id DESC` (D6). 6: the co-occupant case is `a_former` on `a_resident2`'s 102
    request, 403 `not_requester` (D3). 7: where the phone lives and how it is set (D1). 8: recipients, kinds,
    email, fixed text (D5).
- Criteria changed, not loosened (also added to the inbox's "Decisions to audit" in step 6):
  - 1 row 9: `idempotency_key_reused` is 409, not 422, and 2: `unit_inactive` is 409, not 422. The draft's
    Interfaces say both work "as `app/packages`", whose classes are `Conflict`s (`IdempotencyKeyReused`,
    `UnitInactive` in `app/packages/service.py`); the code is the truth for what exists, and one code with two
    statuses across the API would confuse every client. Each is still refused, with the same code and nothing
    written.
- Decisions taken:
  - **D1 Emergency phone** (moved to P6-03e with the phone; kept here as the record) lives in the `maintenance` row of `building_features.config`, key
    `emergency_phone` (a string, at most 32 characters, printable), read by the maintenance service; set by the
    seed (Maple) and `bootstrap-building --emergency-phone`; no API edits it (scope "Out"). Alternatives: a
    `buildings.emergency_phone` column (a migration, and by the ticket's own rule it would move cancel to
    P6-03c; it is a maintenance setting, and `config` exists for per-feature settings and holds nothing yet).
    Tradeoff: JSONB has no column type, so the service reads it defensively (a non-string or blank value reads
    as none). Reversible: a later column can be backfilled from it. Basis: decision rule 3 (simplest,
    reversible, uses the existing `config`). Lasting (first use of `config`, a convention): its ADR (drafted
    as 0021 on `p6-03e-start`) and inbox line come with P6-03e. Emergency requests email the managers (D5); they are otherwise handled like any
    other (stub default: never rely on the app).
  - **D2 Who files:** residents only (`require_roles(Role.RESIDENT)`). Property management filing for a common
    area or on a resident's behalf is left out: on-behalf filing needs a "for whom" field and changes who sees
    the request (`visible_maintenance` grants by requester), a decision for a later ticket. Security doesn't
    file (stub default). Basis: rule 2 (stub default for security), rule 3 (smallest reversible scope for
    property management). Follow-up in step 6.
  - **D3 Who cancels** (moved to P6-03e with cancel): the requester only (stub: "cancelled by the resident"), `require_roles(Role.RESIDENT)`
    then `requester_membership_id = ctx.membership_id` in the `UPDATE`'s `WHERE`. A co-occupant who sees the
    request gets **403 `not_requester`**, not 404 (they can `GET` it, so "not found" would contradict the read)
    and not `forbidden_role` (they hold the right role; the reason is ownership, and a distinct code lets the
    client explain it). A non-visible request stays 404. Basis: rule 3.
  - **D4 Common-area requests:** any resident may file one, with or without a current occupancy (a former
    owner still in the building, a household member between units). Basis: rule 3 (the location check is a
    schema check; no rule says otherwise).
  - **D5 New-request notification:** the building's active `property_management` members, minus the caller's
    own user; `maintenance.submitted` in-app only; `maintenance.submitted_emergency` also emails (the existing
    `notification` template), two kinds as `notice.published(_urgent)` (P6-01c D2: the kind fixes the email).
    Security isn't notified (they see requests, but don't run maintenance: PRODUCT_SCOPE roles). Body: the
    category and the unit's name or "a common area", so no resident free text reaches an email. Basis: rule 3,
    following the notices convention.
  - **D6 List order:** `paginate` on `id DESC` (uuid7: creation order; the existing
    `ix_maintenance_requests_building_id_status_id` index serves the status filter). `submitted_at` ties can't
    skip or repeat a row. Basis: convention (`paginate`, P6-03a's index comment).
  - **D7 `Idempotency-Key`** required on create (P6-03a's NOT NULL columns), with `app/packages`'
    `check_idempotency_key`, errors and replay header reused. The replay looks the key up in the building
    (not through `visible_maintenance`) and replays only the caller's own request with the same body hash.
  - **D8 Requester name:** staff only (`sees_requester_names`, the `sees_recipient_names` pattern). A resident
    sees a co-occupant's request but not who filed it; that matches packages, and nothing in the scope asks
    for more. Basis: convention.
  - **D9** 422 `unit_not_occupied` for a unit of A the resident doesn't currently live in; 404
    `unit_not_found` for another building's or none (rule 2). Photos: `photo_file_ids` 0–5 (P6-03a's
    `MAX_PHOTOS`), distinct, positions 0..n-1 in order.
- Estimate (framing): ~455, over ~400 by the idempotency path the draft didn't cost; not split then.
- Split (while implementing, 2026-10-26): built as framed, the non-test diff was 705 added lines (~540 without
  comments and blank lines), not ~455: the idempotency lookup, the unit/occupancy check with its lock, and the
  photo, unit and name reads cost what `app/packages/service.py` costs. Per the playbook ("over the limit means
  split"), **cancel and the emergency phone moved to [P6-03e](./P6-03e-maintenance-cancel-and-emergency-phone.md)**, with criteria 6 and 7, row 8, row 10's cancel race,
  the cancel parts of rows 1, 4, 5, 9 (feature off) and 12, decisions **D1** (phone in `config`, the drafted ADR-0021) and
  **D3** (requester only, 403 `not_requester`), unchanged; no criterion was loosened. The draft's own fallback
  named cancel. Its code and tests, as built and passing here, are kept on the local branch `p6-03e-start`
  (unreviewed) as P6-03e's starting point. What stays here: create, list, get, photos, idempotency, the
  move-out race, the managers' notification (emergency e-mail included) — 547 non-test lines (~422 without
  comments and blank lines), the size P5-02a merged at (506 / ~390), recorded as a deviation in the PR.
