# Explanation — P4-05a Resident signup and join request

> **PR:** #91 · **Source revision:** `2064b0cd421be8d286923af75209141c48e2d723`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2) reviewed this
> commit. **Merge commit:** not known when written; after the merge, `gh pr view 91 --json mergeCommit`
> gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `2064b0c` the diff (`git diff --stat origin/main...HEAD`: 33 files),
> `backend/app/onboarding/{models,service,router,schemas}.py`, `backend/app/auth/{router,service,schemas,allowlist}.py`,
> `backend/app/notifications/{kinds,service}.py`, the migration, the PR body (Plan, decisions, both review
> rounds), and the assertions of every test cited below; ran `pt.sh tests/onboarding tests/test_architecture.py
> tests/notifications/test_notify.py tests/invitations/test_accept.py`: `270 passed in 24.15s`. Differences from
> the plan: see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 1. Walkthrough variant: A.

## 1. What was built and why

A resident can now join a building without an invitation. They open the building's join link (its join code),
create an account (`POST /api/auth/signup`), pick their unit and relationship from the building's active
units, and submit a request. The request and their membership wait as `pending`; every active property
manager gets an in-app notification. While pending, the resident can read only their own status
(`GET /api/buildings/{b}/onboarding/me`); every operational route still answers 404.

P4-05 was split while framing (~700 non-test lines estimated): this part stores requests; approving or denying
them is [P4-05b](../tickets/P4-05b-onboarding-decisions.md). The decisions that matter most: a resubmission is
idempotent and safe under concurrency (one membership row lock, `ON CONFLICT`), and the narrower
`get_own_membership` guard is confined by a fitness check to the one onboarding route.

## 2. Decisions

### D1. Split P4-05 into P4-05a (signup, join, own status) and P4-05b (decisions)

- **Problem or constraint:** the estimate was ~700 non-test lines against the playbook's ~400.
- **Chosen:** P4-05a holds the whole `onboarding_requests` table (so P4-05b adds no migration), signup, the
  join routes and `/onboarding/me`; P4-05b the managers' list, approve, deny, the pending count and emails.
- **Alternatives rejected:** splitting signup out alone (the join half stayed over the limit with the
  decisions); putting the table in P4-05b (P4-05a would store nothing).
- **Tradeoffs and accepted limitations:** between the merges a pending request can't be decided through the
  API. The PR came to 862 non-test lines when opened and 886 at the source revision (the migration 146,
  mostly generated; the rest largely docstrings and comments); the round 1 Claude reviewer accepted it (M1)
  and the round 2 reviewers agreed.
- **Basis:** playbook step 1.4. **Source:** recorded (PR D1, ticket Frame notes).

### D2. Signup reads the email before argon2, then inserts with `ON CONFLICT`

- **Problem or constraint:** an existing email must be 409 `email_in_use` (ticket), a race must not be a 500,
  and argon2 must not run while a connection is held (the `login` and `accept_invitation` pattern).
- **Chosen:** password policy; a read by `lower(email)` (409 if found); `db.rollback()` to end the read; hash
  off the event loop; `INSERT … ON CONFLICT (lower(email)) DO NOTHING RETURNING`, 409 if nothing came back;
  audit `auth.signed_up` and start the session (`auth.logged_in`); one commit.
- **Alternatives rejected:** only `ON CONFLICT` with no read (an argon2 hash for every taken email); catching
  `IntegrityError` (mixes the race with any other constraint).
- **Tradeoffs and accepted limitations:** the 409 says an account exists. The ticket accepts this, bounded by
  the per-IP signup limit (10/hour), which counts every attempt (see the round 1 fix in §6).
- **Basis:** ticket; existing convention (`backend/app/invitations/service.py::accept_invitation`).
  **Source:** recorded (PR D2).

### D3. The join units route has its own rate-limit bucket, counted before the session

- **Problem or constraint:** the ticket rate-limits the unit search but names only the lookup's policy
  (20 per 10 minutes); a unit picker searches as the user types.
- **Chosen:** key `join_units`, `settings.rate_limit_join_units_ip` = 120 per 10 minutes per IP, enforced by the
  route dependency `backend/app/onboarding/router.py::join_units_limit`, which runs before `get_current_user`.
- **Alternatives rejected:** sharing the lookup's bucket (a few keystrokes lock the user out of both); a
  per-user key (a new key helper); enforcing in the service after the session (found while implementing: the
  count was written inside the request's transaction, so in the test harness the 121st search still got 200,
  and a 401 flood would not count).
- **Tradeoffs and accepted limitations:** a signed-in user holding the join code can list a building's unit
  labels at 120 searches per 10 minutes; labels only, never occupants (`UnitOption`). Reviewer Claude L5
  accepted it.
- **Basis:** autonomous (bucket), test result (placement). **Source:** recorded (PR D3 and decision table).

### D4. `suspended`/`deactivated` memberships are refused; `denied` and `pending` get exactly `resident`

- **Problem or constraint:** the ticket covers new, pending, denied and active memberships only, and P4-05b's
  approval will activate whatever roles a pending membership holds.
- **Chosen:** `active` → 409 `already_member`; `suspended`/`deactivated` → 409 `membership_not_eligible`;
  `denied` → conditional UPDATE to `pending`; before any new request (denied reopened, or pending without a
  request) the roles are replaced by exactly `resident`.
- **Alternatives rejected:** reopening a deactivated membership (its old, maybe staff, roles would reach
  approval, or need P4-06's clean-up); letting a suspended member resubmit (they could lift their own
  suspension through an approval).
- **Tradeoffs and accepted limitations:** a former resident with a deactivated membership rejoins only by a
  manager's invitation.
- **Basis:** autonomous; the "pending without a request" half is review round 1, Claude L4.
  **Source:** recorded (PR D4, review log).

### D5. A resubmission returns the pending request before anything else is checked

- **Problem or constraint:** criterion 7: a second submission gives 200 with the pending request, unchanged.
  The first version checked the unit first, so a retry after the unit's deactivation was 404 (round 1, Codex F1).
- **Chosen:** in `submit_request` the membership step runs first (insert, or lock and inspect the existing
  one); a pending request is returned at once; only a new request reads the unit.
- **Alternatives rejected:** none recorded beyond the original order.
- **Tradeoffs and accepted limitations:** a new membership row is written before the unit is checked; a
  refused unit raises, and the request's session rolls it back (tests below prove nothing is kept).
- **Basis:** review finding (round 1). **Source:** recorded (PR review log).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Join codes match exactly after a shape check `[A-Za-z0-9-]{1,16}` | Upper-casing the input | Codes come from the link; NUL or over-long input must not reach Postgres | autonomous | PR table |
| `onboarding.submitted` has no `link`, only `entity_type="onboarding_request"` | `/onboarding-requests` | The manager screens are P4-08's | autonomous | PR table |
| Signup returns 201 `MeUserOut` | 204 as login | The client learns its user id | autonomous | PR table |
| `/onboarding/me` returns the membership's status with the latest request's unit, relationship and reason | The request's status | An approved, later suspended membership must not read `approved` | autonomous | PR table |
| `EmailAddress` moved to `backend/app/core/schemas.py`; `password_not_too_long` and `FullName` live in `backend/app/auth/schemas.py` | Importing them from invitations | Auth must not depend on invitations | convention | PR table |
| The signup limit is a route dependency (`signup_limit`) | In the service | Body validation runs first, so refused bodies were free (round 1, Codex F2) | review finding | PR table |
| `full_name` refuses control characters before stripping (`FullName`) | `AfterValidator(printable)` after the strip | `"Rosa\n"` was stored as `"Rosa"` (round 1, Codex F3) | review finding | PR review log |

**Framing changes:** the split; criteria 1–13 of P4-05a sharpened from the ticket's 1, 2, 6, 8 and the
resubmission half of 5 (the ticket's "30 rapid lookups give 429" became "the 21st gives 429", which the P2-05
policy of 20 implies). Nothing loosened; criteria 3, 4, 5 (deny half), 7 and 9 moved to P4-05b unchanged.

**Plan versus final code:** (also noted below the PR's Plan)
- The Plan's submit order was building → unit → membership; round 1 (Codex F1) made it building → membership
  → unit (D5).
- The Plan put the signup limit in the service; round 1 (Codex F2) moved it to `signup_limit`.
- The units limit was planned in the service and moved to `join_units_limit` while implementing (D3).
- Size: 886 non-test lines at the source revision (862 when opened) against ~400 (D1).

## 3. How it is implemented

### Overview

- `backend/app/auth/router.py::signup` → `backend/app/auth/service.py::signup`: the account and its session.
- `backend/app/onboarding/router.py::public_router` (`/api/join/{join_code}`, `/units`, `/requests`): the join
  code in the path names the building, so these routes sit outside the building prefix.
- `backend/app/onboarding/router.py::own_router`: the one building-prefixed route, guarded by
  `get_own_membership` instead of `get_tenant_context` (ADR-0004).
- `backend/app/onboarding/service.py::submit_request`: the transaction that writes membership, roles, request,
  notifications and audit.
- `backend/tests/test_architecture.py::routes_using_own_membership`: fitness check 1b.

### Walkthrough (variant A): `POST /api/join/{join_code}/requests`

1. **HTTP:** `POST /api/join/MAPLE-2026/requests` `{"unit_id": "…", "relationship": "tenant"}` with the session
   cookie and the CSRF headers → `backend/app/onboarding/router.py::create_request`. `JoinRequestCreate` is an
   `InputModel`: an extra `role` or `status` field is a 422.
2. **Dependencies:** `CurrentUser` (`get_current_user`): 401 `not_authenticated` without a live session. No
   tenant guard: the caller isn't a member yet.
3. **Service** `submit_request`:
   - `_find_building(…, lock=True)`: shape check, then `SELECT id, name FROM buildings WHERE join_code = :code
     AND is_active FOR SHARE` (a building deactivation waits for this transaction). Otherwise 404
     `join_code_invalid`, one body for every reason.
   - `INSERT INTO building_memberships (…, status='pending') ON CONFLICT (building_id, user_id) DO NOTHING
     RETURNING id`. A concurrent first submission's uncommitted row makes this wait, then return nothing.
   - New membership: insert the `resident` role. Existing: `_reopen_or_refuse` locks the row (`FOR NO KEY
     UPDATE`), then by status refuses, returns the pending request (→ 200, nothing written), or reopens
     (`denied` → `pending`) and resets the roles to exactly `resident`.
   - The unit: `SELECT label, tower FROM units WHERE id = :unit AND building_id = :b AND is_active FOR KEY
     SHARE`. A deactivation holding `FOR UPDATE` makes this wait; Postgres then re-checks the WHERE on the
     committed row. No row → 404 `unit_not_found` (another building's, inactive or unknown), and the raise
     discards the membership written above.
4. **Writes, same transaction:** the `onboarding_requests` row (`pending`); `notify(kind="onboarding.submitted")`
   to `staff_user_ids(…, [PROPERTY_MANAGEMENT])` (active memberships only; the kind has no email template, so
   no job); `record_audit(action="onboarding.submitted", metadata={membership_id, unit_id})`; one commit.
5. **Response:** 201 `OnboardingRequestOut` `{id, building_id, status, unit_id, unit_label, tower,
   relationship, submitted_at}`; the router sets 200 when `Submitted.created` is false.

Signup follows the same shape: `signup_limit` (route dependency, before the body is parsed) → `SignupIn`
(`EmailAddress`, `FullName`, password length) → policy check → read → rollback → argon2 → `ON CONFLICT`
insert → audit and session → 201 with the cookie.

### Data model changes

`onboarding_requests` (migration `c0a262b1f7d1`, revises `de8f8dbe23fb`; a new table only):

| Column / constraint | Why |
|---|---|
| `building_id` → buildings; composite FKs `(building_id, membership_id)` and `(building_id, unit_id)` | A request can't name another building's membership or unit (ADR-0005) |
| `relationship`, `status` (non-native enums with checks) | The existing occupancy values; `pending`/`approved`/`denied` |
| `decided_by_user_id`, `decided_at`, `decision_reason` varchar(500) | Filled by P4-05b |
| `ck_…_decided_when_not_pending`: `(status = 'pending') = (decided_at IS NULL)` | A decided row always has its time; a pending one never does |
| `ck_…_reason_only_when_denied` | A reason belongs to a denial only |
| `uq_onboarding_requests_pending_membership` (partial unique, `WHERE status = 'pending'`) | At most one pending request per membership: the database backstop under the idempotence |
| `ix_…_membership_id_id`, `ix_…_building_id_status_id` | `/onboarding/me`'s latest request; P4-05b's list |

## 4. The code

**Files changed** (non-test; tests are listed in §5)

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/onboarding/service.py` | new: lookup, unit options, submit, own status | +316 |
| `backend/app/onboarding/router.py` | new: public join router, own-status router, units limit | +88 |
| `backend/app/onboarding/models.py`, `schemas.py` | new: `OnboardingRequest`, `OnboardingStatus`, schemas | +89, +43 |
| `backend/migrations/versions/c0a262b1f7d1_onboarding_requests_p4_05a.py` | new table | +146 |
| `backend/app/auth/{router,service,schemas,allowlist}.py` | signup, `signup_limit`, `FullName`, allowlist | +156, −13 |
| `backend/app/core/schemas.py`, `backend/app/invitations/schemas.py` | `EmailAddress` moved; invitations reuse it and `FullName` | +23 −1, +7 −36 |
| `backend/app/notifications/{kinds,service}.py` | kind `onboarding.submitted`; lone-surrogate check | +3, +6 |
| `backend/app/{audit/actions,core/config,main,models/registry}.py` | actions, `rate_limit_join_units_ip`, routers, model | small |
| `frontend/src/api/schema.d.ts` | regenerated | generated |

**Key excerpts**

`backend/app/onboarding/service.py::submit_request` (trimmed)

```python
    building = await _find_building(db, join_code, lock=True)
    membership_id = await db.scalar(
        pg_insert(BuildingMembership)
        .values(
            building_id=building.id,
            user_id=user_id,
            status=MembershipStatus.PENDING,
            status_changed_by_user_id=user_id,
        )
        # A concurrent first submission's uncommitted row makes this wait, then do nothing.
        .on_conflict_do_nothing(index_elements=["building_id", "user_id"])
        .returning(BuildingMembership.id)
    )
    if membership_id is None:
        # Before the unit is checked: a retry returns the pending request even if its unit was
        # deactivated since, or the retry names another unit (criterion 7; review round 1, F1).
        existing = await _reopen_or_refuse(db, building.id, user_id)
        if isinstance(existing, OnboardingRequestOut):
            return Submitted(existing, created=False)
        membership_id = existing
    # ...
    unit = (
        await db.execute(
            select(Unit.label, Unit.tower)
            .where(Unit.id == data.unit_id, Unit.building_id == building.id, Unit.is_active)
            .with_for_update(read=True, key_share=True)
        )
    ).one_or_none()
    if unit is None:
        # One body for another building's, an inactive and an unknown unit (ADR-0004). Raising
        # rolls back the membership written above: nothing is kept.
        raise UnitNotFound(detail="Unit not found.")
```

- Membership first, then the unit (D5). `ON CONFLICT DO NOTHING` turns a duplicate first submission into
  "wait, then go to `_reopen_or_refuse`" instead of a unique-violation 500.
- Without `Unit.building_id == building.id`, B's unit id passes the read and the composite FK fails at
  insert (a 500): mutation M2 in the PR showed the test failing. Without the `FOR KEY SHARE` lock, a
  deactivation committing concurrently is not waited for (mutation M1).

`backend/app/onboarding/service.py::_reopen_or_refuse` (trimmed)

```python
    row = (
        await db.execute(
            select(BuildingMembership.id, BuildingMembership.status)
            .where(
                BuildingMembership.building_id == building_id,
                BuildingMembership.user_id == user_id,
            )
            .with_for_update(key_share=True)
        )
    ).one()
    membership_id: UUID = row.id
    match row.status:
        case MembershipStatus.ACTIVE:
            raise AlreadyMember(detail="You are already a member of this building.")
        case MembershipStatus.SUSPENDED | MembershipStatus.DEACTIVATED:
            raise MembershipNotEligible(...)
        case MembershipStatus.PENDING:
            pending = ...  # its pending request joined to the unit
            if pending is not None:
                return _request_out(*pending)
        case MembershipStatus.DENIED:
            # Conditional (CLAUDE.md rule 7); the row lock above makes it match.
            await db.execute(update(BuildingMembership).where(..., status == DENIED).values(status=PENDING, ...))
    # A new request is coming, from a pending or a reopened membership: exactly the role
    # `resident`. ...
    await db.execute(delete(MembershipRole).where(...))
    await db.execute(insert(MembershipRole).values(..., role=Role.RESIDENT))
    return membership_id
```

- The row lock (`FOR NO KEY UPDATE`, which `key_share=True` renders) makes submissions for one membership run
  one at a time: the second sees the first's committed request (READ COMMITTED, a fresh snapshot per
  statement) and returns it. Removing the pending-request return made two tests fail (mutation M3).

`backend/app/auth/router.py::signup_limit`

```python
async def signup_limit(request: Request, limiter: Limiter) -> None:
    """Count every signup attempt against the IP, as a route dependency: it runs before the body is
    validated, so a refused body (422) counts too (P4-05a review round 1, F2)."""
    await limiter.enforce(ip_key("signup", client_ip(request)), settings.rate_limit_signup_ip)
```

- A route-level dependency is resolved before the body's validation errors are raised, so every attempt counts.
  The limiter commits on its own session, so the count survives the request's rollback. A body that isn't
  JSON at all is refused by FastAPI before dependencies run and is not counted (§7).

`backend/app/auth/schemas.py::FullName`

```python
FullName = Annotated[
    str,
    BeforeValidator(_printable_before_strip),
    StringConstraints(strip_whitespace=True, min_length=1, max_length=200),
]
```

- The control-character check runs on the raw string, before the strip; invitation accept uses the same
  type (`backend/app/invitations/schemas.py::InvitationAccept`).

`backend/tests/test_architecture.py::routes_using_own_membership`

```python
OWN_MEMBERSHIP_ROUTES = frozenset({("GET", f"{BUILDING_PREFIX}/onboarding/me")})


def routes_using_own_membership(application: FastAPI) -> list[str]:
    """Fitness test 1b: every route that depends on `get_own_membership` is in
    `OWN_MEMBERSHIP_ROUTES`."""
    return [
        f"{method} {route.path}"
        for route in _api_routes(application)
        if get_own_membership in set(dependency_calls(route.dependant))
        for method in _methods(route)
        if (method, route.path) not in OWN_MEMBERSHIP_ROUTES
    ]
```

- `get_own_membership` lets pending, denied and suspended members through. Fitness check 1 only asks that a
  building route has *a* guard, so an operational route using this one would pass it; 1b catches that
  (`test_meta_unlisted_route_using_get_own_membership_fails_check_1b`).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Signup with a taken email, any case | 409 `email_in_use`, no user or session written | `backend/tests/onboarding/test_signup.py::test_signup_with_an_existing_email_in_any_case_is_409` |
| Two signups for one email at once | One account; the other 409, never 500 | `backend/tests/onboarding/test_concurrency.py::test_signup_waits_for_a_concurrent_signup_of_the_same_email` (commits / rolls back), `::test_two_concurrent_signups_give_one_account` |
| Malformed emails (non-ASCII, padded, empty, too long, two addresses, NUL, lone surrogate) | 422, nothing written | `backend/tests/onboarding/test_signup.py::test_signup_refuses_malformed_emails` |
| Control characters in `full_name`, at either end too | 422 | `backend/tests/onboarding/test_signup.py::test_signup_refuses_a_bad_full_name`; `backend/tests/invitations/test_accept.py::test_bad_full_name_is_refused` |
| Refused signups used to probe for free | Every attempt counts; the 11th is 429 | `backend/tests/onboarding/test_signup.py::test_the_11th_signup_from_one_ip_is_429`, `::test_refused_signups_count_against_the_ip_limit`, `::test_a_taken_email_still_counts_against_the_limit` |
| Signup from another site | 403 (CSRF middleware) | `backend/tests/onboarding/test_signup.py::test_signup_without_csrf_headers_is_refused` |
| Unknown, malformed, inactive join code | 404 `join_code_invalid`, one body | `backend/tests/onboarding/test_join.py::test_join_lookup_of_a_bad_code_is_404`, `::test_join_lookup_bodies_do_not_tell_bad_codes_apart`, `::test_submit_to_a_bad_code_is_404` |
| Join code guessing | 21st lookup per IP in 10 minutes is 429 | `backend/tests/onboarding/test_join.py::test_the_21st_join_lookup_from_one_ip_is_429` |
| Unit options leak inactive or another building's units | Only active units of the code's building | `backend/tests/onboarding/test_join.py::test_join_units_lists_the_buildings_active_units_by_prefix` |
| Unit search exhausts the lookup's limit | Own bucket; the lookup still answers | `backend/tests/onboarding/test_join.py::test_join_units_is_rate_limited_in_a_bucket_of_its_own` |
| Another building's / inactive / unknown unit in the request | 404 `unit_not_found`, nothing written | `backend/tests/onboarding/test_join.py::test_unit_from_another_building_is_404_and_writes_nothing` |
| Retry while pending (same or other unit, unit since deactivated) | 200 with the request unchanged, nothing written | `backend/tests/onboarding/test_join.py::test_a_second_submission_returns_the_pending_request`, `::test_a_retry_returns_the_pending_request_whatever_its_unit` |
| Two first submissions at once | One 201, one 200; one membership, one request | `backend/tests/onboarding/test_concurrency.py::test_a_first_submission_waits_for_a_concurrent_one`, `::test_two_first_submissions_by_one_user_give_one_request` |
| A unit deactivated while the request reads it | The request waits; then 404 (commit) or 201 (rollback) | `backend/tests/onboarding/test_concurrency.py::test_submission_waits_for_a_unit_deactivation` |
| Active / suspended / deactivated member submits | 409 `already_member` / `membership_not_eligible`, nothing written | `backend/tests/onboarding/test_join.py::test_active_member_gets_409_already_member`, `::test_suspended_or_deactivated_member_gets_409_membership_not_eligible` |
| Denied, or pending without a request, keeps staff roles | Roles reset to exactly `resident`; the old denied request kept | `backend/tests/onboarding/test_join.py::test_denied_membership_is_reopened_with_only_the_resident_role`, `::test_a_pending_membership_without_a_request_gets_only_the_resident_role` |
| A role or status smuggled in the body | 422 | `backend/tests/onboarding/test_join.py::test_submit_refuses_a_bad_body` |
| Pending user on operational routes | 404, while `/onboarding/me` is 200 | `backend/tests/onboarding/test_me.py::test_pending_user_sees_their_status_but_not_the_building` |
| Another member's request through `/onboarding/me` | Never shown | `backend/tests/onboarding/test_me.py::test_another_members_request_never_shows` |
| An operational route using `get_own_membership` | Fitness 1b fails | `backend/tests/test_architecture.py::test_only_onboarding_routes_use_get_own_membership`, `::test_meta_unlisted_route_using_get_own_membership_fails_check_1b` |
| A lone surrogate reaching `notify` | `ValueError`, nothing written | `backend/tests/notifications/test_notify.py::test_notify_refuses_bad_input` (4 surrogate cases) |
| Two join requests for one unit block each other | `FOR KEY SHARE` locks don't conflict | No test (§7) |

**Acceptance criteria → tests**
1. Signup: `test_signup_creates_a_logged_in_user`, `…_any_case_is_409`, `…_weak_password`, `…_malformed_emails`, `…_bad_full_name`.
2. Signup race: `test_signup_waits_for_a_concurrent_signup_of_the_same_email`, `test_two_concurrent_signups_give_one_account`.
3. Signup limit: `test_the_11th_signup_from_one_ip_is_429`, `test_refused_signups_count_against_the_ip_limit`.
4. Join lookup: `test_join_lookup_without_a_session_names_the_building`, `…_of_a_bad_code_is_404`, `…_do_not_tell_bad_codes_apart`, `test_the_21st_join_lookup_from_one_ip_is_429`.
5. Join units: the five `test_join_units_*` tests.
6. Submit: `test_new_user_signs_up_and_submits_a_request`, `test_every_active_manager_is_notified_and_nobody_else`; the PR's stack transcript.
7. Idempotent: `test_a_second_submission_returns_the_pending_request`, `test_a_retry_returns_the_pending_request_whatever_its_unit`.
8. States: `test_active_member_gets_409_already_member`, `test_suspended_or_deactivated_member_…`, `test_denied_membership_is_reopened_…`.
9. Related IDs: `test_unit_from_another_building_is_404_and_writes_nothing`, `test_submit_to_a_bad_code_is_404`, `test_submit_needs_a_session`, `test_submit_refuses_a_bad_body`.
10. Own status: the 8 tests in `backend/tests/onboarding/test_me.py`.
11. Concurrency: the three submission tests in `backend/tests/onboarding/test_concurrency.py`.
12. Fitness: the three `get_own_membership` tests in `backend/tests/test_architecture.py`.
13. `notify` text: `test_notify_refuses_bad_input`.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Claude (Sonnet 5.5, high, security pass) | `9790e69` | MERGE | M1 size; L2 lock mode; L3 no submit limit; L4 pending roles; L5 labels visible | M1 accepted; L2, L4 fixed `2064b0c`; L3 follow-up (P4-05b); L5 accepted (D3) |
| 1 | Codex (`gpt-6.1-sol`, high, security pass) | `9790e69` | MERGE | F1 Medium retry idempotence; F2 Low refused signups free; F3 Low control whitespace stripped | F1 fixed `2064b0c`; F2 fixed `4e30c55`; F3 fixed `4852816` |
| 2 | Claude (Sonnet 5.5, high, security pass) | `2064b0c` | MERGE | L1 join code in request logs; residual: invitation accept vs a pending request; residual: shared-IP throttling | L1 follow-up; residual → P4-05b; accepted |
| 2 | Codex (`gpt-6.1-sol`, high, security pass) | `2064b0c` | MERGE | none new | — |

- **F1:** submit for unit X → X deactivated → the same submit → 404 `unit_not_found`, although the request
  existed (criterion 7). Now 200 unchanged; `test_a_retry_returns_the_pending_request_whatever_its_unit`
  (4 cases) failed with 404 first. Produced D5.
- **F2:** ten 422 signups (invalid email) then a valid one → 201, not 429: the limiter ran in the service,
  after body validation. Now `signup_limit`; `test_refused_signups_count_against_the_ip_limit` failed for 3 of
  4 bodies first (the weak-password case already counted).
- **F3:** `full_name="Rosa\n"` → 201, stored `"Rosa"`: the strip ran before `printable`. Now `FullName`; the
  signup and invitation-accept tests failed for `Rosa\n`, `\tRosa`, `\r\nRosa`, `Rosa\x0b`, `Gina\n`, `\tGina` first.
- **L2:** `with_for_update(key_share=True)` renders `FOR NO KEY UPDATE`; now `read=True, key_share=True`
  (`FOR KEY SHARE`). Behaviour against a deactivation is the same, so no test distinguishes them (§7).
- **L4:** a pending membership without a request kept its roles; now reset. The new test failed with
  `[security]` first.

## 7. Not verified, accepted risks and follow-ups

- **No test distinguishes `FOR KEY SHARE` from `FOR NO KEY UPDATE`** on the unit read: both conflict with the
  deactivation's `FOR UPDATE`, so the race test passes either way. Only the code and the reviewer's compiled SQL
  check show which is used.
- **A body that isn't JSON** is refused before `signup_limit` runs and is not counted. Such a request can't
  create an account or test an email. Tracked only here and in the PR.
- **The join code appears verbatim in request logs** (`path`), round 2 Claude L1; `backend/app/logging_config.py`
  redacts only invitation tokens. Low: the code is a shared link and every request needs approval. PR
  follow-up; not yet in a ticket.
- **No rate limit on `POST /api/join/{code}/requests`** (round 1, Claude L3): after P4-05b's denials, a
  resident could resubmit and notify managers repeatedly. Goes to the P4-05b ticket.
- **An invitation accept can activate a `pending`/`denied` membership while its request stays `pending`**
  (round 2 residual): P4-05b's approval must update only from `pending`. Goes to the P4-05b ticket.
- **A pending request whose unit is later deactivated stays pending**; P4-05b's approval re-checks the unit.
- **Unverified emails:** anyone can sign up with someone else's address (verification is a pilot item). The
  round 1 and 2 reviewers found no takeover path: an invitation for an existing account needs that
  account's session, and password reset revokes every session.
- **Per-IP limits** (10 signups/hour, 20 lookups/10 min) may throttle several residents on one lobby Wi-Fi;
  the ticket sets them.
- **Signup while logged in** replaces the browser's cookie; the old session stays live, as with login.
- **Denied concurrent resubmissions** have no real-connection test (the round 2 reviewer proved it by hand).

## 8. How to change this safely

- **Another onboarding route under `/api/buildings/{building_id}`** that pending members may call: depend on
  `get_own_membership` and add `(method, path)` to `backend/tests/test_architecture.py::OWN_MEMBERSHIP_ROUTES`;
  fitness 1b fails otherwise. Never use it on an operational route.
- **Another public join route:** add it to `backend/app/auth/allowlist.py::AUTH_ALLOWLIST`, and count it against
  the IP in a route dependency (as `join_units_limit`), not in the service.
- **Changing the submit order:** `backend/tests/onboarding/test_concurrency.py` and the retry/idempotence tests in
  `backend/tests/onboarding/test_join.py` are the ones that break.
- **P4-05b's approval:** `UPDATE onboarding_requests … WHERE status = 'pending'`, re-read the unit `FOR KEY
  SHARE` before `start_occupancy`, and update the membership only from `pending`.

## 9. Must explain, then quiz

**1. The membership and onboarding state machine, as far as this part goes.**
Membership: (none) → `pending` (submit, by the user); `denied` → `pending` (resubmit, by the user); `active`,
`suspended`, `deactivated` are refused by the join flow
(`backend/app/onboarding/service.py::_reopen_or_refuse`). Request: (none) → `pending` (submit). `pending` →
`approved`/`denied` is P4-05b's (a property manager). Invitations (P4-02b) can also make a membership `active`.

**2. How pending users see their own status without passing the operational tenant check.**
`/onboarding/me` sits on `backend/app/onboarding/router.py::own_router`, a plain router with the building
prefix whose route depends on `backend/app/tenancy/deps.py::get_own_membership` (any status but `deactivated`,
in an active building) instead of `get_tenant_context` (active only). It returns only the caller's own status;
fitness check 1b keeps that guard off every other route.

**3. Why signup can return `email_in_use` while password reset hides account existence.**
Signup can't succeed without telling the caller something: an account either was created or wasn't. The
ticket accepts this enumeration risk and bounds it with `signup_limit` (10 per hour per IP, every attempt
counted). Password reset has an answer that needs no disclosure ("if an account exists…"), so it gives none
(P4-04).

**4. What stops two submissions by one user from creating two pending requests?**
The first `INSERT … ON CONFLICT DO NOTHING` on `(building_id, user_id)` makes a concurrent second one wait,
then take `_reopen_or_refuse`, whose `FOR NO KEY UPDATE` lock serialises submissions per membership and then
finds the first's committed request. Underneath, the partial unique index
`uq_onboarding_requests_pending_membership` refuses a second pending row.

**Quiz**

1. A resident's unit is deactivated after they submit. They press "Submit" again. What do they get, and why
   didn't they get that before round 1?
2. Why does `join_units_limit` run as a route dependency instead of inside `unit_options`?
3. Which constraint makes `onboarding_requests` refuse a request whose unit belongs to another building, even
   if the service's filter were removed?
4. What would break if `_reopen_or_refuse` stopped resetting roles for a `denied` membership?
5. How would you add a per-membership limit on resubmissions (round 1, L3)?

<details><summary>Answers</summary>

1. 200 with their pending request, unchanged. `submit_request` now handles the existing membership (and
   returns its pending request) before reading the unit; before round 1 the unit was read first, so the
   inactive unit gave 404.
2. A route-level dependency runs before `get_current_user` opens the request's transaction, so a 401 also
   counts and the count is not made inside that transaction (where, in the test harness, it was rolled back).
3. The composite FK `fk_onboarding_requests_building_id_unit_id` on `(building_id, unit_id)`: the insert fails
   (as a 500, which is why the service filters first and answers 404).
4. A denied membership holding a staff role would come back `pending` with it, and P4-05b's approval would
   activate that role; `test_denied_membership_is_reopened_with_only_the_resident_role` would fail.
5. A route dependency like `signup_limit`, keyed per user (a new key helper, e.g. `join_request:user:<id>`) with
   a new `RatePolicy` setting, before the session-dependent work, plus a test that the (N+1)th resubmission is
   429 and writes nothing.

</details>
