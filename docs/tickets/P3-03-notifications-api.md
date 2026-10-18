# P3-03 — In-app notifications API

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 2 |
| Depends on | P3-01, P2-03 |
| Replaces old | M5-T01, M5-T02, M5-T03 |
| Status | in progress |

## Goal

Domain code can notify one or many users in a building with one call. That call creates per-recipient in-app
rows and the corresponding email jobs atomically. Users can list notifications, read an unread count, and
mark notifications read.

## Why

Packages, onboarding, notices and maintenance all notify users. One contract avoids four inconsistent
implementations.

## Scope

- In:
  - **`notifications` table:**
    - `building_id`, `recipient_user_id`
    - `kind` String(64), `title` String(200), `body` String(1000), `link` String(300)
    - `entity_type`, `entity_id`
    - `read_at`, `created_at`
    - index `(recipient_user_id, building_id, read_at, id DESC)`
    - FK `building_id`
  - **`app/notifications/kinds.py`:** a registry of kinds, each with a default email template (optional) and
    a description. Start with `membership.approved`, `membership.denied`, `package.arrived` and
    `package.picked_up`. Later tickets add theirs.
  - **`notify(db, *, building_id, recipient_user_ids, kind, title, body, link, entity_type=None, entity_id=None,
    email_context=None)`:**
    - one bulk `INSERT` for all recipients
    - for kinds with an email template, `queue_email` per recipient with
      `dedupe_key=f"{kind}:{entity_id}:{user_id}"`
    - never commits
  - **Recipient helpers:**
    - `staff_user_ids(db, building_id, roles)`
    - `unit_resident_user_ids(db, building_id, unit_id)` (current occupants only)
  - **Endpoints** on the building router (any active role):
    - `GET /notifications?unread_only=&cursor=&limit=`: own notifications in this building, keyset paginated
    - `GET /notifications/summary` returns `{unread_count}`
    - `POST /notifications/{id}/read`: 204, idempotent; another user's notification gives 404
    - `POST /notifications/read-all`: 204, own and this building only
- Out:
  - preferences UI and opt-outs (pilot; in the demo all registered kinds email by default)
  - push notifications

## Interfaces

`notify()`, the kinds registry and the endpoints above (`notifications_list`, `notifications_summary`,
`notifications_read`, `notifications_read_all`).

## Acceptance criteria

1. **Given** `notify` to `[a_resident1, a_resident2]` with kind `package.arrived` and an `entity_id`, **then**
   after the caller's commit there are 2 notification rows (the given building, recipient, kind, title, body,
   link, entity; `read_at` NULL) and 2 `email.send` jobs, one per recipient's address, template
   `notification`, `dedupe_key` `package.arrived:<entity_id>:<user_id>`. **After a rollback instead, there are
   none of either.** `notify` never commits (it is in the fitness test's `NON_COMMITTING_HELPERS`).
   - 1a *(added)*: a second `notify` for the same kind, entity and recipient adds an in-app row but no second
     email job. With `entity_id=None` there is no dedupe key, so two calls give two jobs.
   - 1b *(added)*: a recipient id listed twice gives one row and one job; an empty list writes nothing.
   - 1c *(added)*: an unknown kind, a title/body/link/entity_type over its column length or containing NUL,
     or a `link` that isn't an app path (`/…`, not `//…`) raises `ValueError` and writes nothing. A recipient
     with no membership in the building is refused by the database (composite FK).
   - 1d *(added)*: email goes only to active users (`users.is_active`) with an address `queue_email`
     accepts, in the user's locale when it is supported (else `en`); the others get the in-app row only.
2. **Given** `a_resident1`, **when** listing, **then** only their own rows for building A appear, newest first
   (`id` DESC), with the exact fields. `unread_only=true` leaves out read ones; `limit` and `cursor` page
   through them (`next_cursor`), and a bad cursor is 400 `invalid_cursor`. `multi` sees A's and B's
   notifications separately per building route.
3. **Given** `a_resident2`, **when** marking `a_resident1`'s notification read, **then** 404
   `notification_not_found`, with the same body as a random id, and it stays unread.
4. **Given** mark-read twice, **then** 204 both times, and `read_at` is unchanged after the first (the clock
   advanced in between).
5. **Given** read-all in A, **then** `multi`'s B notifications stay unread, and so do other A users'.
6. **Given** 600 recipients, **then** `notify` inserts the 600 notification rows in one statement (counted),
   and that statement takes < 300 ms locally. `notify` logs its timing (recipients, emails, total ms) on every
   call; the total, which includes 600 `queue_email` calls, is logged but not bounded (see Frame notes).
7. The tenancy fitness test covers all four routes (404 for building B members). The routes' own tests also
   cover: unauthenticated 401, `b_resident1` 404, `a_pending`/`a_suspended` 404 (10-case rows 2, 3, 6).
8. *(added)* `GET /notifications/summary` counts only the caller's unread notifications in this building:
   not another user's, not read ones, not `multi`'s in B.
9. *(added, 10-case row 7)* `multi` marking its **B** notification read through the **A** route gets 404 and
   the notification stays unread.
10. *(added, carried from P1-03)* `unit_resident_user_ids(db, building_id, unit_id)` returns the users with a
    current occupancy of the unit **and an active membership**: unit 201 gives `a_council` and `multi`, not
    `a_suspended`; unit 101 gives `a_resident1`, not `a_former` (ended). A unit of another building gives
    nothing.
11. *(added)* `staff_user_ids(db, building_id, roles)` returns active members of the building holding any of
    `roles`: `{security}` in A gives `a_security`, not `b_manager` (B) or `multi` (security only in B).
12. *(added)* Every registered kind's email template renders (en and fr) with a sample notification.

## Test plan

- `tests/notifications/test_notify.py`, `tests/notifications/test_api.py`, using the world fixture.
- Commands: `make test`, `make gen-api`.

## Likely files

`backend/app/notifications/{models,service,kinds,router,schemas}.py`,
`backend/migrations/versions/<new>.py`, `backend/tests/notifications/*`, `frontend/src/api/schema.d.ts`.

## Must explain (learning checkpoint)

1. Why one row per recipient instead of one row per event plus a read-receipts table?
2. Why is the email dedupe key `kind:entity:user`, and what duplicate does it prevent?
3. Why does the summary endpoint exist separately from the list?

## Carried from P1-03 (decide while framing)

From the P1-03 reviews (PR #45). `current_occupants(db, building_id, unit_id)` returns memberships with a
current occupancy **of any membership status**. Keep only active memberships before notifying people or
accepting one as a package recipient or pickup person, and test it with a suspended occupant.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - 1 now names the job fields and the dedupe key, and says how "none after a rollback" is shown.
  - Added 1a–1d (dedupe, duplicate and empty recipients, input checks, who gets email), 8 (summary scope),
    9 (10-case row 7), 10 (the P1-03 carry: active memberships only, tested with `a_suspended`), 11, 12.
  - 2–5 name the error code, the pagination and the extra "other users'" case; 7 adds the routes' own
    10-case tests.
- Criteria loosened (with reason; also listed in the inbox):
  - **6 is read as "the insert of the rows", not the whole call.** The ticket also requires one
    `queue_email` per recipient, and a probe on the local stack (600 `queue_email` calls in one test
    transaction, 2026-10-18) took 479 ms on their own, so a whole-call bound of 300 ms can't hold with
    that design. The row insert is bounded; the total is logged. Faster broadcasts need a bulk email
    enqueue: a follow-up. Will be added to the inbox's "Decisions to audit" in step 6.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - The recipient references its membership: composite FK `(building_id, recipient_user_id)` →
    `building_memberships (building_id, user_id)`, any status, so a denied applicant can still be told
    (ADR-0005; autonomous for "any status").
  - One generic `notification` email template (title, body, link) for the four starting kinds; a kind can
    name its own template later (autonomous, simplest).
  - Email only to active users with an accepted address, in a supported locale (autonomous).
  - No dedupe key when `entity_id` is None: `kind:None:user` would swallow every later email of that kind
    (autonomous).
  - `link` is an app path; the email makes it absolute with `APP_BASE_URL` (autonomous).
  - Mark-read is one `UPDATE … SET read_at = COALESCE(read_at, now) … RETURNING`: idempotent, 404 when no
    own row in this building (CLAUDE.md rules 1, 7; ADR-0004).
  - The ticket's index `(recipient_user_id, building_id, read_at, id DESC)` is kept as written (ticket).
- Split: none. Estimate ~380 non-test lines (model + migration ~100, kinds ~35, service ~150, router and
  schemas ~70, templates ~20).
