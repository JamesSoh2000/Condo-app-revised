# P4-02b — Invitation lookup and accept (split from P4-02)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-02a |
| Replaces old | part of [P4-02](./P4-02-staff-invitations.md) |
| Status | todo |

## Goal

The invitee opens the link from [P4-02a](./P4-02a-invitations-management.md)'s email, sees which building
invited them, and accepts through the single-use, expiring token, becoming an active member.

## Why

This is how staff join, and how the first manager joins after bootstrap (P4-03).

## Scope

- In:
  - **Public endpoints** (auth allowlist; rate-limited per IP with a policy of their own, as P2-05 noted):
    - `GET /api/invitations/{token}` returns `{building_name, email_masked, roles}`, or 404
      `invitation_invalid` for unknown, expired, revoked or used tokens (one body for all).
    - **`POST /api/invitations/{token}/accept`** `{full_name?, password?}`. In one transaction:
      - **If no user has that email:** create the user (password required and validated, `full_name`
        required).
      - **If a user exists:** the caller must be logged in **as that user** (session), otherwise 409
        `login_required`. Never set a password on an existing account here.
      - Create or reactivate the membership as `active`, with exactly the invited roles. The client cannot
        change roles.
      - If `unit_id` is set, start an occupancy.
      - Mark the invitation accepted.
      - Audit `invitation.accepted` and `membership.activated`.
      - Create a session (log in) when a new user was created.
- Out: the manager endpoints (P4-02a), resident self-join (P4-05), the frontend (P4-07).

## Interfaces

`invitations_get_public`, `invitations_accept` (public).

## Acceptance criteria

(P4-02's criteria 2, 3, 4, 5, 7 and 8, unchanged; frame them when this ticket is picked.)

1. **Given** a new person accepts with a valid password, **then** the user is created, the membership is
   `active` with role `security`, a session cookie is set, and `/me` shows building A.
2. **Given** the same token is reused, or the token is expired (frozen clock), revoked or replaced by a
   resend, **then** 404 `invitation_invalid` with an identical body.
3. **Given** an existing user's email and no session, **then** 409 `login_required`. When logged in as a
   *different* user, **then** 403 `invitation_email_mismatch`.
4. **Given** an accept request body containing `roles: ["property_management"]`, **then** it is ignored or
   rejected (`extra='forbid'`). The roles equal the invitation's.
5. **Given** an invitation with `unit_id` 102 and `relationship=owner`, **when** accepted, **then** a current
   occupancy exists.
6. **Given** 30 rapid `GET /api/invitations/{random}` requests from one IP, **then** 429.

## Test plan

- `tests/invitations/test_accept.py`. Commands: `make test`.

## Likely files

`backend/app/invitations/{service,router,schemas}.py`, `backend/app/auth/allowlist.py`,
`backend/app/core/config.py` (the rate policy), `backend/tests/invitations/*`.

## Must explain (learning checkpoint)

1. Why one generic error for unknown, expired, used and revoked tokens?
2. Why must an existing account log in before accepting, rather than setting a password through the invite?
3. Where do the roles come from at accept time, and why never from the request?

## Carried from P2-01b (do while framing)

- Password fields must not be stripped: `InputModel` strips strings, so declare them
  `Annotated[str, StringConstraints(strip_whitespace=False, max_length=PASSWORD_MAX_LENGTH)]` as
  `app/auth/schemas.py::LoginIn` does (PR #57 D5), and call `check_password_policy`, mapping
  `WeakPasswordError.reason` to a 422 without echoing the password.
- Look users up with `func.lower(User.email) == func.lower(:input)`. The invitation's email was validated and
  lowercased on write by P4-02a.

## Carried from P2-03 (do while framing)

- Add the lookup and accept routes to `backend/app/auth/allowlist.py::AUTH_ALLOWLIST` as `(method, path)`
  pairs; the fitness test `test_every_api_route_requires_a_session_unless_allowlisted` fails otherwise, and
  the allowlist holds only routes that exist (PR #59 D1).

## Carried from P4-02a

- `membership.activated` is a new audit action; `invitation.accepted` too. The invitation's
  `unit_id` requires `resident` in its roles and was an active unit at creation; check it is still active at
  accept.
- **Fix a stale comment** in `backend/app/invitations/models.py::Invitation`: the `(building_id, email)` index
  serves the pending check of both `create_invitation` and `resend_invitation` (since PR #86 review round 1),
  not create only.
- **First follow-ups (step 8, from `docs/AGENT_MISTAKES_LOG.md`):**
  - Carried from P4-01b and not done in P4-02a: a mutation-probe helper script that refuses to run on a dirty
    tree ("commit before mutation probes", 3 occurrences).
  - P4-02a's two review findings were recurrences of the `CLAUDE.md` lessons "every other way to reach the
    same state" (an invariant enforced on create but not on resend) and "test the fix on its neighbours"
    (the round-1 fix changed resend's error order). Before the first review, list every write path that can
    produce the state an invariant guards (accept here: anything that makes a membership active) and test
    each.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: second part of P4-02 (see the parent ticket).
