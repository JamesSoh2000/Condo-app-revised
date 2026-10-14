# P3-03 — In-app notifications API

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 2 |
| Depends on | P3-01, P2-03 |
| Replaces old | M5-T01, M5-T02, M5-T03 |
| Status | todo |

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

1. **Given** `notify` to `[a_resident1, a_resident2]` with kind `package.arrived`, **then** 2 notification rows
   and 2 `email.send` jobs exist after commit, and none after a rollback.
2. **Given** `a_resident1`, **when** listing, **then** only their own rows for building A appear, newest first.
   `multi` sees A's and B's notifications separately per building route.
3. **Given** `a_resident2`, **when** marking `a_resident1`'s notification read, **then** 404.
4. **Given** mark-read twice, **then** 204 both times, and `read_at` is unchanged after the first.
5. **Given** read-all in A, **then** `multi`'s B notifications stay unread.
6. **Given** 600 recipients, **then** `notify` inserts the rows in one statement, in < 300 ms locally (log the
   timing).
7. The tenancy fitness test covers all four routes (404 for building B members).

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

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
