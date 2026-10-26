# P6-03d — Maintenance comments: public and internal

| Field | Value |
|---|---|
| Phase / lane | P6 / A |
| Risk tier | 2 |
| Depends on | P6-03b, P3-03 |
| Replaces old | M8-T01 (notes part), M8-T04 (note-added part) |
| Status | todo |

Split from the P6-03 stub ([P6-P7-backlog.md](./P6-P7-backlog.md)); the schema is
[P6-03a](./P6-03a-maintenance-schema-and-visibility.md), submit and read
[P6-03b](./P6-03b-maintenance-submit-and-read-api.md), the manager's actions
[P6-03c](./P6-03c-maintenance-manager-actions.md). It needs P6-03b only, so it may run before or alongside
P6-03c (both touch `app/maintenance/service.py` and `router.py`: one agent at a time, CLAUDE.md "hot files").

## Goal

Members who can see a request comment on it; staff can mark a comment **internal**, and an internal comment
never reaches a resident by any path: a list, a count, a notification, an email or a photo.

## Why

The privacy check of journey 6 ("The resident sees the status changes and the public comment, never the internal
note"), which P6-07's E2E tests through the real stack. The recipe (step 3) makes the internal filter a second
narrowing on top of `visible_maintenance`, never a looser grant, and makes the same filter decide who is notified
and what the photo hook grants.

## Scope

- In (building router, `require_feature(Feature.MAINTENANCE)`):
  - table **`maintenance_comments`** and one migration
  - **`visible_maintenance_comments(ctx) -> Select[MaintenanceComment]`** in `app/maintenance/queries.py`
  - **`POST /maintenance-requests/{id}/comments`** → 201 `MaintenanceCommentOut`
  - **`GET /maintenance-requests/{id}/comments?cursor=`**: oldest first, cursor pages
  - notifications on **public** comments (stub: "notify on … public comments"); never on internal ones to a
    resident
  - photos on comments, if framing decides comments take them (the hook is extended, P6-03a)
  - audit `maintenance.commented`
  - `make gen-api`
- Out:
  - editing or deleting a comment (not in the stub; a follow-up if P6-04 needs it)
  - the frontend's "internal" toggle (P6-04)
  - the timeline that merges comments with status changes (P6-04 composes it from the two reads)

## Interfaces

Operation ids `maintenance_comment`, `maintenance_list_comments` (decided while building; `<tag>_<function>`).

**Table `maintenance_comments`** (uuid7 `id`, `created_at`, `updated_at`):

| Column | Type | Notes |
|---|---|---|
| `building_id` | uuid FK `buildings.id` RESTRICT | |
| `request_id` | uuid not null | composite FK `(building_id, request_id) → maintenance_requests(building_id, id)` |
| `author_membership_id` | uuid not null | composite FK to `building_memberships(building_id, id)` |
| `body` | varchar (length decided in framing) not null | not blank |
| `is_internal` | boolean not null, default false | |

- Index `(building_id, request_id, id)` for the thread; a partial index on public comments if the resident's
  read needs one.
- `MAINTENANCE_COMMENT_ATTACHED_TYPE = "maintenance_comment"` and a `maintenance_comment_photos` table if comments
  take photos.

**Visibility.** `visible_maintenance_comments(ctx)` joins `visible_maintenance(ctx)` (a comment is seen only
with its request) and, unless the caller holds a staff role framing names (property management; security by
the stub's default if framing lets security read internal notes), adds `is_internal = false`. Never its own
grant: a comment on a request the caller can't see is invisible whatever its flag.

- `MaintenanceCommentCreate(InputModel)`: `body` (stripped, printable before the strip, newlines and tabs kept),
  `internal: bool = False`, and `photo_file_ids` if decided.
- `MaintenanceCommentOut(APIModel)`: `id`, `request_id`, `body`, `is_internal`, `created_at`, the author's
  display name and role label (what a resident sees of a staff author is decided in framing), photos if any.
- Errors: 404 `maintenance_request_not_found` (a request the caller can't see, the same body as a random id);
  403 or 422 for a resident sending `internal: true` (decided in framing; never silently public); 409 for a
  comment on a closed request if framing closes them (code decided in framing); `claim_file`'s errors for photos.

## Acceptance criteria

1. **The 10-case table** for both endpoints: the requester, a co-occupant who sees the request, `a_manager` and
   `a_security` (stub default "read and comment") comment and list; signed out 401; `b_manager`, `a_pending`,
   `a_suspended` 404 `building_not_found`; `a_resident2` gets 404 `maintenance_request_not_found` on
   `a_resident1`'s request for both, the same body as a random id; a B request on A's URL 404; council alone as
   P6-03a decides; `maintenance` off 403 `feature_disabled`; a comment photo of building B 404 with nothing
   written; two comments at once both land, in `id` order.
2. **Internal comments never reach a resident.** **Given** a request with one public and one internal comment,
   **then**: the resident's `GET …/comments` lists the public one only, on every page, with no gap in the cursor
   that reveals a hidden row's existence (a page of residents' comments is full when more public ones exist);
   `a_manager` (and security, as decided) list both; any count of comments a resident can read excludes it; an
   internal comment's photo is 404 `file_not_found` for the resident through `GET /files/{id}/download-url`; no
   notification row or email job for an internal comment names a resident recipient.
3. **Who may write internal.** A resident sending `internal: true` gets the decided error and no row; a
   multi-role caller who holds a staff role in this building may (`multi` is security in B only, so in A they
   may not).
4. **Public comment notifications.** As framing decides (the stub's "who is notified for each kind"): a staff
   public comment notifies the requester (and the co-occupants who can see the request, if decided); a resident's
   comment notifies the building's managers (if decided); the author is never notified; nobody who can't see the
   request is; title fixed, body holds no comment text beyond what the recipient can see, link to the request.
   Two public comments in a row both email when the kind emails (P6-03c's criterion 6a: the job dedupe key).
5. **A moved-out resident.** **Given** `a_former`, who sees a request from their occupancy of 101 (P6-03a),
   **then** they see comments written after they moved out, or only those before their window's end, as framing
   decides, and are notified accordingly; the test pins both sides of the boundary.
6. **Closed requests.** Commenting on a `resolved` or `cancelled` request is allowed or refused as framing
   decides; the decision holds for every role.
7. **Input.** NUL, lone surrogates, over-long or blank bodies, unknown fields give 422; a body keeps newlines and
   tabs and refuses other control characters.
8. **Atomicity and audit.** A forced failure before commit leaves no comment, photo claim, notification, job or
   audit row; `maintenance.commented` carries `comment_id` and `is_internal`, never the body.

## Test plan

- `backend/tests/maintenance/test_comments_schema.py` (the table's FKs and checks, as P6-03a criterion 2),
  `test_comments_visibility.py` (the query per persona, 2, 5), `test_comments_api.py` (1, 3, 6, 7),
  `test_comments_notify.py` (2's notification half, 4), `test_photos.py` extended (2's photo half),
  `test_atomicity.py` (8).
- A `make_maintenance_comment` factory that flushes, never commits.
- Commands: `make check DB_PORT=55432`; `uv run pytest tests/maintenance -q`; `make gen-api`.

## Likely files

`backend/app/maintenance/{models,queries,photos,schemas,service,router}.py`, `backend/app/notifications/kinds.py`,
`backend/app/email/templates/en/*` (if a kind emails), `backend/app/audit/actions.py`,
`backend/migrations/versions/*_maintenance_comments_p6_03d.py`, `frontend/src/api/schema.d.ts`,
`backend/tests/maintenance/*`.

Estimate: ~350 non-test lines (model 40, migration 50, query 20, schemas 60, service 110, router 50, kinds and
actions 15), plus ~60 if comments take photos.

## Must explain (learning checkpoint)

1. Name every path by which an internal comment could reach a resident (list, count, notification, email, photo,
   an error message) and the line that closes each.
2. Why is the internal filter a narrowing of `visible_maintenance` and not a grant of its own?
3. What does a moved-out resident see of a request's later comments, and why?
4. Why must a resident's `internal: true` be refused rather than quietly made public?

## Open decisions (resolve while framing)

From the stub ("Decide while framing"):
- **Can security see or act on maintenance?** Stub default: **read and comment only.** Left open: whether
  security reads and writes **internal** comments (staff, so the default suggests yes; the stub doesn't say).

From the stub's P5-05 recipe check:
- who is notified for each comment kind (requester, occupants, managers on a resident's comment) and which emails
- whether comments take photos
- whether a moved-out resident still sees later comments on a request from their occupancy

Left open by the stub:
- the `body` length
- the error for a resident's `internal: true`
- whether a closed (`resolved`, `cancelled`) request takes comments
- what a resident sees of a staff author (name, or "Building management")

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
