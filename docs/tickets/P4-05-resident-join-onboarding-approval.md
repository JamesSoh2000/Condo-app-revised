# P4-05 — Resident join, onboarding and approval

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-01, P3-03, P2-04, P2-05 |
| Replaces old | M3-T07, M0-T09 (onboarding policy, adopted as default) |
| Status | todo |

## Goal

Residents join through the building's join link: they create an account, choose their unit and relationship,
and wait as pending. Property management approves or denies, and the resident is notified in-app and by email.

## Why

This is demo journey 3, and it creates the occupancy data that every later privacy rule depends on. The flow
matches the existing Base44 UI ([01 §Onboarding](../PRODUCT_SCOPE.md#onboarding-model-decision)).

## Scope

- In:
  - **`onboarding_requests` table:**
    - `building_id`, `membership_id`, `unit_id` (composite FKs)
    - `relationship`
    - `status` (pending, approved, denied)
    - `decided_by_user_id`, `decided_at`, `decision_reason` String(500)
    - partial unique index `(membership_id) WHERE status='pending'`
  - **`POST /api/auth/signup`** `{email, full_name, password}` (allowlisted; rate-limited per IP):
    - creates the user and logs them in
    - an existing email gives 409 `email_in_use`. This is an accepted enumeration risk for signup, mitigated
      by the rate limit; documented.
    - email verification is a pilot item
  - **Public and authenticated join endpoints:**
    - `GET /api/join/{join_code}` (allowlisted, rate-limited) returns `{building_name, building_id}`, or 404.
    - `GET /api/join/{join_code}/units?search=` (authenticated; rate-limited) calls `search_unit_options`
      (P4-01).
    - **`POST /api/join/{join_code}/requests`** `{unit_id, relationship}` (authenticated):
      - creates the membership (status `pending`, role `resident`), or reuses a `denied` one by setting it
        back to `pending`
      - creates an onboarding request (`pending`)
      - an existing pending request gives 200 with it (idempotent)
      - an already-active member gives 409 `already_member`
      - the unit must be active, in that building
      - notifies all property managers (`onboarding.submitted` in-app)
      - audit `onboarding.submitted`
  - **Own status:** `GET /api/buildings/{b}/onboarding/me` (uses `get_own_membership`) returns
    `{status, unit_label, relationship, decision_reason?}`.
  - **Management** (building router, property_management):
    - `GET /onboarding-requests?status=pending&cursor=` returns requester name and email, unit and
      relationship, and `submitted_at`.
    - **`POST /onboarding-requests/{id}/approve`:**
      - a conditional update on `status='pending'` (otherwise 409 `already_decided`)
      - membership becomes `active`, and `start_occupancy`
      - `notify(membership.approved)` with in-app and email
      - audit `onboarding.approved` and `membership.activated`
    - **`POST /onboarding-requests/{id}/deny`** `{reason}` (required, 3–500 chars): membership becomes
      `denied`, `notify(membership.denied)`, audit.
  - **Email templates** `membership_approved` and `membership_denied`.
  - **Notifications summary** for managers gains `pending_onboarding_count` (extend P3-03's summary, or use a
    separate `GET /onboarding-requests/summary`; choose one and document it).
- Out:
  - document evidence uploads (pilot option)
  - unit-ownership verification beyond manager judgement

## Interfaces

`auth_signup`, `join_lookup`, `join_units`, `join_request_create`, `onboarding_me`, `onboarding_list`,
`onboarding_approve`, `onboarding_deny`.

## Acceptance criteria

1. **Given** a new user signs up and submits a request for unit 1003, **then** the membership is `pending`,
   the request is `pending`, managers get an in-app notification, and an audit event exists.
2. **Given** a pending user, **then** `GET /api/buildings/{A}` (operational) returns 404, while
   `/onboarding/me` returns `pending`.
3. **Given** a manager approves, **then** the membership is `active` with role `resident`, a current
   occupancy exists with the chosen relationship, and the resident has an in-app notification and an email
   job. The resident's next `/me` shows `active`.
4. **Given** a second approval or denial of the same request, **then** 409 `already_decided`. Two concurrent
   approvals result in exactly one success.
5. **Given** a deny without a reason, **then** 422. With a reason, the resident's `/onboarding/me` shows it.
   Resubmitting creates a new pending request.
6. **Given** a `unit_id` from building B in a building-A join request, **then** 404/422, and nothing is
   written.
7. **Given** `a_security`, **when** approving, **then** 403. A building-B manager gets 404.
8. **Given** an invalid join code, **then** 404. 30 rapid lookups give 429.
9. **Given** the approval transaction fails after the membership update (simulated), **then** no occupancy,
   notification or email job persists.

## Test plan

- `tests/onboarding/test_join.py`, `tests/onboarding/test_decisions.py`, using separate sessions for the
  concurrency test.
- Commands: `make test`, `make gen-api`.

## Likely files

`backend/app/onboarding/{models,service,router,schemas}.py`, `backend/app/auth/{router,service}.py`
(signup), `backend/app/notifications/kinds.py`, `backend/app/email/templates/en/membership_*`,
`backend/migrations/versions/<new>.py`, `backend/tests/onboarding/*`.

## Must explain (learning checkpoint)

1. Draw the membership and onboarding state machine. Who can make each transition?
2. How do pending users see their own status without passing the operational tenant check?
3. Why does approval need a conditional update? What happens with two managers clicking at once?
4. Signup returns `email_in_use`, while password reset hides account existence. Why is that trade-off
   acceptable here?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
