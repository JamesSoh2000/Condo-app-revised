# P4-06 — Membership administration

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P2-04, P4-05 |
| Replaces old | M3-T12 (staff administration part) |
| Status | todo |

## Goal

Property managers can list members, change roles, suspend, reactivate, deactivate (move-out) and transfer
residents between units. The building can never be left without an active manager.

## Why

Real buildings constantly change staff and residents. Access must change immediately and safely. The
"last manager" invariant is a good real-world concurrency exercise.

## Scope

- In (building router, property_management):
  - `GET /members?role=&status=&search=&cursor=` returns `{membership_id, user_id, full_name, email, status,
    roles, unit_label?, relationship?}`.
  - `POST /members/{id}/roles` `{add: Role[], remove: Role[]}`.
  - `POST /members/{id}/suspend` `{reason}` and `POST /members/{id}/reactivate`.
  - `POST /members/{id}/deactivate` `{reason}`: move-out. Ends the current occupancy and sets the membership
    `deactivated`. The user's other buildings are unaffected.
  - `POST /members/{id}/transfer` `{unit_id, relationship}` uses `transfer_occupancy` (P1-03).
  - **Last-manager invariant:** any change that would leave **zero active `property_management` members**
    gives 409 `last_manager`. Enforce it under concurrency by taking `SELECT … FOR UPDATE` on the
    `buildings` row at the start of these operations (serializes manager changes per building), then
    counting.
  - Managers cannot suspend or deactivate themselves (409 `cannot_target_self`).
  - Every operation is audited (`membership.roles_changed` with added/removed lists in the metadata,
    `membership.suspended`, `membership.reactivated`, `membership.deactivated`, `occupancy.transferred`).
- Out:
  - the frontend (P4-08 includes the member list actions)
  - data export or deletion for leavers (pilot)

## Interfaces

`members_list`, `members_roles_update`, `members_suspend`, `members_reactivate`, `members_deactivate`,
`members_transfer`.

## Acceptance criteria

1. **Given** `a_resident1` is suspended, **when** they make their next request with an existing session,
   **then** 404 on building-A routes. `/me` shows `suspended`.
2. **Given** `a_resident1` is deactivated, **then** their occupancy has `ended_at` set. A package created
   for unit 101 afterwards is not visible to them (checked once P5 exists; for now, assert the occupancy
   window).
3. **Given** two managers, **when** each concurrently removes the other's `property_management` role,
   **then** exactly one succeeds, and the other gets 409 `last_manager`.
4. **Given** a single manager, **when** they remove their own manager role, **then** 409 `last_manager`.
   Suspending themselves gives 409 `cannot_target_self`.
5. **Given** `transfer` to unit 102, **then** the old occupancy ended, the new one is current, and history is
   preserved.
6. **Given** `a_security`, **then** 403 on all endpoints. A building-B manager gets 404.
7. **Given** role changes, **then** an audit event lists the exact roles added and removed.

## Test plan

- `tests/memberships/test_admin.py`, using separate sessions for criterion 3.
- Commands: `make test`.

## Likely files

`backend/app/memberships/{service,router,schemas}.py`, `backend/app/memberships/occupancy.py`,
`backend/tests/memberships/*`.

## Must explain (learning checkpoint)

1. Why does locking the building row make the last-manager check safe? What race happens without it?
2. Why does suspension apply on the very next request?
3. Why is "deactivate" a move-out that ends occupancy, and not a delete?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
