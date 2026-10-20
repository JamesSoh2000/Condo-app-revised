# P4-05a — Resident signup and join request (split from P4-05)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-01a, P3-03, P2-04, P2-05 |
| Replaces old | part of [P4-05](./P4-05-resident-join-onboarding-approval.md) |
| Status | in progress |

## Goal

A resident opens the building's join link, creates an account, chooses their unit and relationship, and waits
as pending. They can see their own status; managers are told in-app that a request arrived. Deciding on the
request is [P4-05b](./P4-05b-onboarding-decisions.md).

## Why

The first half of demo journey 3 ([PRODUCT_SCOPE](../PRODUCT_SCOPE.md#onboarding-model-decision)). It creates
the pending memberships and requests that P4-05b approves into occupancies.

## Scope

- In:
  - **`onboarding_requests` table** (the whole table, so P4-05b adds no migration):
    - `building_id`, `membership_id`, `unit_id` (composite FKs, ADR-0005)
    - `relationship` (the existing `OccupancyRelationship` values)
    - `status` (`pending`, `approved`, `denied`)
    - `decided_by_user_id`, `decided_at`, `decision_reason` String(500)
    - partial unique index `(membership_id) WHERE status='pending'`; checks that `decided_at` is set exactly
      when the status isn't `pending`, and `decision_reason` only on a `denied` row
  - **`POST /api/auth/signup`** `{email, full_name, password}` (allowlisted; rate-limited per IP before
    anything else): creates the user and logs them in (session cookie, 201). An existing email in any case
    gives 409 `email_in_use`: an accepted enumeration risk for signup, mitigated by the rate limit, and
    documented on the route. Email verification is a pilot item (`email_verified_at` stays NULL).
  - **`GET /api/join/{join_code}`** (allowlisted, rate-limited per IP): `{building_name, building_id}` of an
    active building, or 404 `join_code_invalid`.
  - **`GET /api/join/{join_code}/units?search=`** (session; rate-limited per IP): `search_unit_options`
    (P4-01a), the building's active units only.
  - **`POST /api/join/{join_code}/requests`** `{unit_id, relationship}` (session):
    - creates the membership (`pending`, role `resident`), or reopens a `denied` one as `pending` with
      exactly the role `resident`
    - creates an onboarding request (`pending`); 201
    - an existing pending request gives 200 with it, unchanged (idempotent)
    - an `active` member gives 409 `already_member`; a `suspended` or `deactivated` one 409
      `membership_not_eligible` (D4)
    - the unit must be active and in that building, read `FOR KEY SHARE` in the same transaction (the
      P4-01a carry); otherwise 404 `unit_not_found`
    - notifies every active property manager of the building (`onboarding.submitted`, in-app only)
    - audit `onboarding.submitted`
  - **Own status:** `GET /api/buildings/{b}/onboarding/me` (uses `get_own_membership`) returns
    `{status, unit_label, relationship, decision_reason}`.
  - The P3-03 `notify` carry and the fitness check that confines `get_own_membership` to onboarding routes.
- Out (P4-05b): the managers' list, approve, deny, the pending count, the approval emails.
- Out: document evidence uploads (pilot); unit-ownership verification beyond manager judgement.

## Interfaces

`auth_signup`, `join_lookup`, `join_units`, `join_request_create`, `onboarding_me`.

## Acceptance criteria

1. **Signup.** **Given** a new email, **when** `POST /api/auth/signup`, **then** 201, a session cookie that
   `GET /api/auth/me` accepts, the user stored with the email lowered and `email_verified_at` NULL, and audit
   events `auth.signed_up` and `auth.logged_in`. **Given** the email exists in any letter case, **then** 409
   `email_in_use` and no user or session is written. A password the policy refuses gives 422
   `password_<reason>`; an email that is non-ASCII, space-padded, empty, longer than 254 characters or not
   one bare address gives 422; a `full_name` with control characters gives 422.
2. **Signup race.** Two concurrent signups for one email (separate sessions): exactly one 201 and one 409
   `email_in_use`, never a 500.
3. **Signup limit.** The 11th signup from one IP within the hour gives 429 `rate_limited` with Retry-After,
   and writes no user.
4. **Join lookup** (ticket criterion 8, sharpened). Without a session, an active building's code gives 200
   `{building_name, building_id}`. An unknown code, a malformed one (characters outside the code alphabet,
   longer than 16), an inactive building's code, all give 404 `join_code_invalid` with one body. The 21st
   lookup from one IP within 10 minutes gives 429 (the ticket's "30 rapid lookups give 429": with the P2-05
   policy of 20, lookups 21–30 are refused).
5. **Join units.** With a session: the building's active units whose label starts with `search`, as
   `{id, tower, label}`, at most 20. An inactive unit and another building's units never appear. Without a
   session 401; a bad code 404 `join_code_invalid`; a `search` over 20 characters or with control characters
   422; over its rate limit 429.
6. **Submit** (ticket criterion 1). **Given** a new user signs up and submits a request for unit 1003,
   **then** 201 with the request; the membership is `pending` with exactly the role `resident`, the request is
   `pending` with that unit and relationship, every active property manager of the building has an
   `onboarding.submitted` notification (security, B's managers and the requester have none), no email job is
   queued, and an `onboarding.submitted` audit event exists.
7. **Idempotent.** **Given** a pending request, **when** the user submits again (even for another unit),
   **then** 200 with the same request unchanged, and no new request, notification or audit event.
8. **States.** An `active` member (any role) gets 409 `already_member`; a `suspended` or `deactivated` member
   409 `membership_not_eligible`; nothing is written. **Given** a `denied` membership with a `denied` request,
   **when** the user submits, **then** 201, the membership is `pending` again with exactly the role
   `resident`, a new `pending` request exists, and the old one stays `denied` (ticket criterion 5's
   resubmission, at the service level; P4-05b proves it after a real deny).
9. **Related IDs** (ticket criterion 6, tenant case 7). A `unit_id` from building B, an inactive unit of A
   or an unknown id: 404 `unit_not_found`, and no membership, request, notification or audit event is
   written. A bad join code: 404 `join_code_invalid`. Without a session 401. An unknown `relationship` or an
   extra field 422.
10. **Pending sees only its own status** (ticket criterion 2, tenant case 6). **Given** a pending user,
    **then** `GET /api/buildings/{A}` (operational) returns 404, while `GET /api/buildings/{A}/onboarding/me`
    returns 200 `{status: "pending", unit_label, relationship, decision_reason: null}`. A denied membership
    shows `denied` and the reason. Building B (no membership): 404. A deactivated membership: 404. Without a
    session: 401.
11. **Concurrency** (tenant case 10). Two concurrent first submissions by one user: one 201 and one 200, and
    exactly one membership and one pending request. A join request that reads the unit while a deactivation
    of it is committing waits for it, and then gets 404 `unit_not_found`.
12. **Fitness.** Routes that depend on `get_own_membership` are an explicit list in
    `tests/test_architecture.py`, and a meta-test shows an unlisted one fails. Signup and the join lookup are
    in `AUTH_ALLOWLIST`; the join units and request routes are not.
13. **`notify` text** (P3-03 carry). `notify` refuses a title, body or link with a lone surrogate with
    `ValueError` before writing, as it does NUL.

## Test plan

- `tests/onboarding/test_signup.py`, `tests/onboarding/test_join.py`, `tests/onboarding/test_me.py`;
  concurrency on separate connections as `tests/units/test_concurrency.py` does.
- `tests/notifications/` for the carry; `tests/test_architecture.py` for criterion 12.
- Commands: `make check`, `make gen-api`.

## Likely files

`backend/app/onboarding/{models,service,router,schemas}.py`, `backend/app/auth/{router,service,schemas,
allowlist}.py`, `backend/app/notifications/{kinds,service}.py`, `backend/app/audit/actions.py`,
`backend/migrations/versions/<new>.py`, `backend/tests/onboarding/*`.

## Must explain (learning checkpoint)

1. Draw the membership and onboarding state machine as far as this part goes. Who makes each transition?
2. How do pending users see their own status without passing the operational tenant check?
3. Signup returns `email_in_use`, while password reset hides account existence. Why is that trade-off
   acceptable here?
4. What stops two submissions by one user from creating two pending requests?

## Carried from P4-05 (framing notes, from P2-01b, P2-03, P2-05, P3-03 and P4-01a)

- Signup is the first schema that writes a user's email (P2-01b carry): reject non-ASCII, check the length
  after lowering, reject empty and space-padded values, look users up with
  `func.lower(User.email) == func.lower(:input)`. P4-02b's `InvitationEmail` already does this; reuse it.
- Add signup and the join lookup to `AUTH_ALLOWLIST` (P2-03 carry); confine `get_own_membership` with an
  explicit route list in fitness test 1.
- `limiter.enforce(ip_key("signup" | "join", ip), …)` before any lookup (P2-05 carry).
- `notify` refuses lone surrogates (P3-03 carry). The dedupe-key order carry doesn't apply here:
  `onboarding.submitted` queues no email.
- The join request reads the unit `FOR KEY SHARE` before writing (P4-01a carry); P4-05b's approval does the
  same before `start_occupancy`.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: signup (1–3: response, audit, email rules, race, limit); join lookup bodies
  and the exact 429 point (4); join units (5); the submit's recipients and no email (6); idempotence returns
  the request unchanged (7); suspended/deactivated/denied states (8); every refused related ID writes
  nothing (9); `/onboarding/me` for denied, deactivated, other building, no session (10); the two races (11);
  fitness list (12); the `notify` carry (13).
- Criteria loosened (with reason; also listed in the inbox): none. The ticket's criteria 3, 4, 5 (deny half),
  7 and 9 moved to P4-05b unchanged.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Split into P4-05a / P4-05b (playbook: estimate ~700 non-test lines). Default.
  - D4: `suspended` and `deactivated` memberships are refused (409 `membership_not_eligible`), not reopened:
    lifting a suspension and reactivating are P4-06's, and a deactivated membership may hold staff roles.
    Autonomous, reversible.
  - A reopened `denied` membership gets exactly the role `resident`. Autonomous: pending grants nothing, but
    P4-05b's approval activates the membership's roles.
  - The join units route gets its own rate-limit bucket (`join_units`), so typing a unit search doesn't use
    up the lookup's 20 per 10 minutes. Autonomous, recorded in the PR.
  - The managers' `onboarding.submitted` notification is in-app only, as the ticket says, with
    `entity_type="onboarding_request"` and no link: the manager screens are P4-08's.
- Split: this is part a of [P4-05](./P4-05-resident-join-onboarding-approval.md); part b is
  [P4-05b](./P4-05b-onboarding-decisions.md).
