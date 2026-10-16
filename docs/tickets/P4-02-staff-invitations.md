# P4-02 — Staff invitations

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P3-02, P2-04, P2-03, P2-05 |
| Replaces old | M3-T06 (invitation part), M3-T12 (staff invite part), M3-T13 (invite delivery) |
| Status | todo |

## Goal

Property managers invite people by email with preassigned roles (and optionally a unit). The invitee
accepts through a single-use, expiring link and becomes an active member.

## Why

This is how staff join, and how the first manager joins after bootstrap (P4-03). Token handling is a classic
security interview topic.

## Scope

- In:
  - **`invitations` table:**
    - `building_id`, `email` (lowercased)
    - `roles` (array of Role values; check that it is non-empty)
    - `unit_id` and `relationship` (nullable, for pre-approved residents), with a composite FK on the unit
    - `token_hash` unique, `expires_at` (7 days)
    - `accepted_at`, `accepted_user_id`, `revoked_at`, `created_by_user_id`
  - **Building-router endpoints** (property_management):
    - `POST /invitations` `{email, roles[], unit_id?, relationship?}`:
      - creates the row and queues the `invitation` email with the link `${APP_BASE_URL}/invite/{token}`
      - returns 201 with `{id, email, roles, expires_at}`, never the token
    - `GET /invitations?status=pending` lists them.
    - `POST /invitations/{id}/revoke`.
    - `POST /invitations/{id}/resend`: a new token (the old one becomes invalid), new expiry, re-queues the
      email.
  - **Public endpoints** (auth allowlist; rate-limited per IP):
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
  - **Email template `invitation`** (en; fr placeholder).
  - **Audit:** `invitation.created`, `invitation.revoked`, `invitation.resent`.
- Out:
  - resident self-join (P4-05)
  - the frontend (P4-07)

## Interfaces

`invitations_create`, `invitations_list`, `invitations_revoke`, `invitations_resend` (building router);
`invitations_get_public`, `invitations_accept` (public).

## Acceptance criteria

1. **Given** `a_manager` invites `guard@example.test` as `security`, **then** the DB stores only the token
   hash, and Mailpit (after the worker runs) shows the link.
2. **Given** a new person accepts with a valid password, **then** the user is created, the membership is
   `active` with role `security`, a session cookie is set, and `/me` shows building A.
3. **Given** the same token is reused, or the token is expired (frozen clock), revoked or replaced by a
   resend, **then** 404 `invitation_invalid` with an identical body.
4. **Given** an existing user's email and no session, **then** 409 `login_required`. When logged in as a
   *different* user, **then** 403 `invitation_email_mismatch`.
5. **Given** an accept request body containing `roles: ["property_management"]`, **then** it is ignored or
   rejected (`extra='forbid'`). The roles equal the invitation's.
6. **Given** `a_security`, **when** creating an invitation, **then** 403. A building-B manager revoking an A
   invitation gets 404.
7. **Given** an invitation with `unit_id` 102 and `relationship=owner`, **when** accepted, **then** a current
   occupancy exists.
8. **Given** 30 rapid `GET /api/invitations/{random}` requests from one IP, **then** 429.

## Test plan

- `tests/invitations/test_invitations.py`. Run the worker's `run_once` in the test and check the rendered
  email via the job payload or a captured SMTP mock.
- Commands: `make test`.

## Likely files

`backend/app/invitations/{models,service,router,schemas}.py`, `backend/app/email/templates/en/invitation.*`,
`backend/app/auth/allowlist.py`, `backend/migrations/versions/<new>.py`, `backend/tests/invitations/*`.

## Must explain (learning checkpoint)

1. Why store only a hash of the invitation token?
2. Why one generic error for unknown, expired, used and revoked tokens?
3. Why must an existing account log in before accepting, rather than setting a password through the invite?
4. Where do the roles come from at accept time, and why never from the request?

## Carried from P2-01b (do while framing)

- Password fields must not be stripped: `InputModel` strips strings, so declare them
  `Annotated[str, StringConstraints(strip_whitespace=False, max_length=PASSWORD_MAX_LENGTH)]` as
  `app/auth/schemas.py::LoginIn` does (PR #57 D5), and call `check_password_policy`, mapping
  `WeakPasswordError.reason` to a 422 without echoing the password.
- The P1-02 email items (see `P2-01b-sessions-login-logout.md` "Carried from P1-02"): login only *reads*
  emails, so the first schemas that *write* them do these: reject non-ASCII (or normalise once, the same way
  on write and lookup); check the length after lowering; reject empty and space-padded values; look users up
  with `func.lower(User.email) == func.lower(:input)`; send mail only to the stored address. `EmailStr` adds
  `email-validator` as a dependency.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
