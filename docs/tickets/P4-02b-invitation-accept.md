# P4-02b — Invitation lookup and accept (split from P4-02)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P4-02a |
| Replaces old | part of [P4-02](./P4-02-staff-invitations.md) |
| Status | in progress |

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

P4-02's criteria 2, 3, 4, 5, 7 and 8 are criteria 1-6 below, sharpened in framing (none loosened); 7-16
are new. "Nothing written" means no user, membership, role, occupancy, session or audit row, and the
invitation still pending.

1. **Given** a pending invitation of `guard@example.test` as `security` in building A and no account with
   that email, **when** `POST /api/invitations/{token}/accept` with `full_name` and a policy-valid
   `password`, **then** 200 `{building_id, membership_id, roles: ["security"]}`; one user exists with that
   email, the password verifies and `email_verified_at` is set; the membership is `active` with exactly
   the role `security`; a session cookie is set and its session has the staff idle window (12 h);
   `GET /api/auth/me` with that cookie lists building A with status `active`; the invitation has
   `accepted_at` and `accepted_user_id`; audit rows `invitation.accepted`, `membership.activated` and
   `auth.logged_in` exist.
2. **Given** a token that is unknown, malformed (not 43 URL-safe characters, or with characters that are
   not valid UTF-8), already accepted, expired (frozen clock at and after `expires_at`), revoked, or
   replaced by a resend, or whose building is inactive, **then** both `GET /api/invitations/{token}` and the
   accept answer 404 `invitation_invalid` with bodies identical apart from `request_id`, and nothing is
   written.
3. **Given** the invitation's email belongs to an existing account and the request has no live session
   (no cookie, or a revoked/expired one), **then** 409 `login_required` and nothing is written, even when
   the body carries a password (no password is set on an existing account). **Given** a session of a
   *different* user, **then** 403 `invitation_email_mismatch`, also when no account has the invited email.
   **Given** a session of the invited user, **then** the accept succeeds without changing the user's
   password and without a new session or cookie.
4. **Given** an accept body with `roles: ["property_management"]` (or any other unknown field), **then**
   422 `validation_error` (`extra='forbid'`) and nothing is written; the membership's roles always equal
   the invitation's.
5. **Given** an invitation with unit A-102 and `relationship=owner` (roles `resident`), **when** accepted,
   **then** the membership has a current occupancy of A-102 as owner. **Given** the unit was deactivated
   after the invitation was created, **then** 409 `unit_inactive` and nothing is written.
6. **Given** 30 rapid `GET /api/invitations/{random}` requests from one IP, **then** the 21st and later
   answer 429 `rate_limited` with `Retry-After` (policy `RATE_LIMIT_INVITATION_IP`, 20 per 10 minutes);
   accept requests count against the same per-IP counter; another IP is not limited.
7. **Lookup body.** `GET /api/invitations/{token}` for a pending invitation answers 200
   `{building_name, email_masked, roles}`; `email_masked` keeps the first character of the local part
   and the whole domain (`g***@example.test`); the body never holds the token, its hash, ids or the full
   email. The lookup writes nothing but the rate-limit count.
8. **New-account input.** A new account without `full_name` or without `password` gets 422
   `validation_error` with `errors[]` naming the field; a password the policy refuses gets 422 with
   `errors[].type` = `password_<reason>` and the password never appears in the body; `full_name` with a
   control character gets 422; the password is not stripped. Nothing is written in each case.
9. **Existing memberships (every write path that makes a membership active).** For an existing account
   logged in as itself: no membership → created `active`; a `pending`, `denied` or `deactivated`
   membership → `active` with exactly the invited roles (old roles removed); an `active` or `suspended`
   one → 409 `membership_exists` and nothing is written. On reactivation, a leftover current occupancy is
   ended when the invited roles lack `resident`, and moved to the invited unit when the invitation has one.
10. **Single use under concurrency.** Two accepts of one token: exactly one succeeds; the other gets 404
    `invitation_invalid`. Two invitations (two buildings) for one new email accepted one after the other:
    the second gets 409 `login_required` (the account now exists); the database unique index is the last
    line (`ON CONFLICT DO NOTHING`, no 500).
11. **Tokens never logged.** The request log records `/api/invitations/{token}` for these routes, never
    the raw token.
12. **Allowlist.** Both routes are in `AUTH_ALLOWLIST` and the fitness test passes; the accept goes
    through the CSRF check (no exemption).

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

- Criteria added or sharpened: all six original criteria made exact (status codes, bodies, what is
  written). Added: malformed-token and inactive-building cases (2), wrong-session-with-no-account (3),
  logged-in-as-invitee path (3), inactive unit at accept (5, carried from P4-02a), the IP policy's numbers
  and the shared counter (6), the lookup body and masking (7), new-account input validation (8, carried
  from P2-01b), existing-membership states (9, the P4-02a mistake-log follow-up: every write path that
  makes a membership active), concurrency (10, tenant table rows 9-10), token redaction in the request log
  (11, CLAUDE.md rule 10: the token is in the URL path, which `RequestLoggingMiddleware` logs), allowlist
  and CSRF (12).
- Criteria loosened (with reason; also listed in the inbox): none. Criterion 4 picks "rejected" of the
  ticket's "ignored or rejected", since `InputModel` forbids extras.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - An `active` or `suspended` membership is not changed by an invitation: 409 `membership_exists`.
    Changing an active member's roles or lifting a suspension is membership administration (P4-06); the
    ticket says "create or reactivate". (autonomous; in the inbox in step 6)
  - A session of another user is a 403 mismatch even when no account has the email, so an accept never
    silently swaps the browser's session to a new account. (autonomous)
  - One per-IP policy `rate_limit_invitation_ip` = 20 per 10 minutes for both routes, keyed
    `invitation:ip:...` (criterion 6 needs a limit below 30). (ticket + autonomous)
  - The accept answers 200 `{building_id, membership_id, roles}` so the SPA can route into the building.
    (autonomous)
  - A session started by the accept is audited `auth.logged_in`, as every login is. (convention)
  - The new user's `email_verified_at` is set: the emailed token proves the address. (autonomous)
  - `status_changed_by_user_id` on activation is the inviting manager (the person who authorised it).
    (autonomous)
- Split: second part of P4-02 (see the parent ticket). Estimate ~300 non-test lines: no further split.
