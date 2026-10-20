# P4-02a — Invitations: table and manager endpoints (split from P4-02)

| Field | Value |
|---|---|
| Phase / lane | P4 / A |
| Risk tier | 1 |
| Depends on | P3-02, P2-04, P2-03, P2-05 |
| Replaces old | M3-T06 (invitation part), M3-T12 (staff invite part), M3-T13 (invite delivery); part of [P4-02](./P4-02-staff-invitations.md) |
| Status | in progress |

## Goal

Property managers invite people by email with preassigned roles (and optionally a unit), see the
invitations they sent, revoke them and resend them. The invitee gets an email with a single-use, expiring
link. Accepting it is [P4-02b](./P4-02b-invitation-accept.md).

## Why

This is how staff join, and how the first manager joins after bootstrap (P4-03). Token handling is a classic
security interview topic.

## Scope

- In:
  - **`invitations` table:**
    - `building_id`, `email` (lowercased)
    - `roles` (array of Role values; check that it is non-empty and holds only Role values)
    - `unit_id` and `relationship` (nullable, for pre-approved residents, both or neither), with a composite
      FK `(building_id, unit_id)` on the unit
    - `token_hash` unique, `expires_at` (7 days)
    - `accepted_at`, `accepted_user_id`, `revoked_at`, `created_by_user_id`
  - **Building-router endpoints** (property_management):
    - `POST /invitations` `{email, roles[], unit_id?, relationship?}`:
      - creates the row and queues the `invitation` email with the link `${APP_BASE_URL}/invite/{token}`
      - returns 201 with the invitation (`id, email, roles, unit_id, relationship, status, expires_at,
        created_at`), never the token or its hash
    - `GET /invitations?status=pending|accepted|revoked|expired` lists them, newest first, paginated.
    - `POST /invitations/{id}/revoke`.
    - `POST /invitations/{id}/resend`: a new token (the old one becomes invalid), new expiry, re-queues the
      email.
  - **Email template `invitation`** (en; fr falls back to en, P3-02).
  - **Audit:** `invitation.created`, `invitation.revoked`, `invitation.resent`.
- Out:
  - the public lookup and accept endpoints, their rate limit and allowlist entries (P4-02b)
  - resident self-join (P4-05), the frontend (P4-07)

## Interfaces

`invitations_create`, `invitations_list`, `invitations_revoke`, `invitations_resend` (building router).

## Acceptance criteria

1. **Given** `a_manager` invites `guard@example.test` as `security`, **then** the response is 201 with the
   invitation and no token; the row's `token_hash` is the sha256 of the token in the emailed link and no
   column holds the token; after the worker runs (`Worker.run_once` against the fake SMTP server), the
   message sent to `guard@example.test` contains `${APP_BASE_URL}/invite/<token>` in its text and HTML
   parts, and the job's stored payload no longer holds the link. `invitation.created` is audited.
2. **Given** an email with upper-case letters (`Guard@Example.TEST`), **then** it is stored lowercased.
   **Given** an email that is empty, space-padded, non-ASCII, malformed (not one address, as `queue_email`
   checks it) or longer than 254 characters, **then** 422 and no row.
3. **Given** `roles: []`, an unknown role, `relationship` without `unit_id` or the reverse, or `unit_id`
   with roles that don't include `resident`, **then** 422 and no row. Duplicate roles are stored once.
4. **Given** `unit_id` of `b_101` in a building-A invitation (tenant row 7) or an id that doesn't exist,
   **then** 404 `unit_not_found` and no row; **given** a deactivated unit of A, **then** 409
   `unit_inactive` and no row. **Given** unit 102 with `relationship=owner`, **then** 201 and the row holds
   both.
5. **Given** a pending (not accepted, not revoked, not expired) invitation for that email in the building,
   **when** another is created for the same email in any case, **then** 409 `invitation_pending` and no
   new row (tenant row 9); an expired, revoked or accepted one doesn't block a new one; the same email in
   building B is independent.
6. **Given** `a_security` (or a resident), **when** creating, listing, revoking or resending, **then** 403
   `forbidden_role`. **Given** `b_manager`, **when** revoking or resending an A invitation through
   building B's URL, **then** 404 `invitation_not_found`, the same body as a random id, and the invitation
   is unchanged. `b_manager` on A's URLs, `a_pending`, `a_suspended`: 404 `building_not_found`; no
   session: 401.
7. **Given** invitations in A (pending, accepted, revoked, expired by a frozen clock) and one in B, **when**
   `a_manager` lists with `status=pending`, **then** only A's pending one; each other status filter
   returns its own; no filter returns all of A's, newest first; the body never holds a token or hash.
8. **Given** a pending invitation, **when** revoked, **then** 204, `revoked_at` is set and
   `invitation.revoked` is audited; revoking it again, or revoking an accepted one, is 409
   `invalid_transition` (tenant row 8).
9. **Given** a pending (or expired, not accepted or revoked) invitation, **when** resent, **then** 200 with
   the new `expires_at` (now + 7 days), `token_hash` changes (the old token's hash matches no row), a
   second `email.send` job is queued with the new link, and `invitation.resent` is audited. Resending a
   revoked or accepted invitation is 409 `invalid_transition` and queues nothing.
10. **Given** two `revoke`/`resend` requests on one invitation, **then** each is a conditional
    `UPDATE … WHERE accepted_at IS NULL AND revoked_at IS NULL RETURNING`: a revoke after a resend still
    revokes, a resend after a revoke is 409 (tenant row 10, sequential form; the single conditional
    statement is the concurrency guard).

## Test plan

- `tests/invitations/test_invitations.py` (API), using the world and the email tests' fake SMTP server
  with a real `Worker.run_once`.
- Commands: `make test`, `make check`; the journey (create → Mailpit shows the link → resend → revoke) on
  `make up`.

## Likely files

`backend/app/invitations/{models,service,router,schemas}.py`, `backend/app/email/templates/en/invitation.*`,
`backend/app/audit/actions.py`, `backend/app/main.py`, `backend/app/models/registry.py`,
`backend/migrations/versions/<new>.py`, `backend/tests/invitations/*`.

## Must explain (learning checkpoint)

1. Why store only a hash of the invitation token, and where else could the raw token live (the job
   payload, logs)?
2. Why does resend issue a new token instead of re-sending the old one?
3. Why are revoke and resend single conditional updates instead of read-then-write?

## Carried from P2-01b (P1-02 email items)

- Login only *reads* emails; this is the first schema that *writes* one: reject non-ASCII; check the length
  after lowering; reject empty and space-padded values; look users up (P4-02b) with
  `func.lower(User.email) == func.lower(:input)`; send mail only to the stored address. `EmailStr` adds
  `email-validator` as a dependency (decided below: not added).
- The password items move to P4-02b with accept.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - Split from P4-02 (see "Split"). Criteria 1 and 6 come from P4-02's 1 and 6. Criterion 1 sharpened:
    the token appears only in the email; the job payload's `context` is scrubbed after sending (the worker
    already does this for the handler's `sensitive_keys`), so after delivery the database holds only the
    hash. Criterion 6 sharpened with the full tenant table (rows 2, 3, 4, 6).
  - Added: 2 (email write rules, the P1-02 carry), 3 (role and unit validation), 4 (tenant row 7 and the
    unit's state), 5 (duplicate pending invitation, a case P4-02 missed), 7 (list filters and isolation),
    8 and 9 (revoke and resend, with tenant row 8), 10 (conditional updates, tenant row 10).
- Criteria loosened (with reason; also listed in the inbox): none. P4-02's criteria 2, 3, 4, 5, 7 and 8 move
  unchanged to P4-02b.
- Decisions taken (with basis):
  - **Split** (playbook step 1.4): the estimate for P4-02 was ~550 non-test lines (table and migration ~110,
    manager endpoints and email ~250, public lookup and accept ~200). Basis: playbook; P4-01 precedent.
  - **Package `app/invitations/`** as the ticket's "Likely files" say, not `app/memberships/` as
    ARCHITECTURE.md's tree sketches it: package by feature, like `units/`. Basis: ticket.
  - **No `email-validator`:** the address must be one that `queue_email` accepts, so the schema reuses
    `app/core/config.py::is_email_address` (P3-02) plus an ASCII check; no new dependency. Basis: autonomous
    (simplest, matches the existing code).
  - **One pending invitation per (building, email)** (criterion 5), checked under a `FOR NO KEY UPDATE`
    lock on the building row so two concurrent creates serialise. A partial unique index can't express
    "not expired" (`now()` isn't immutable). Basis: autonomous.
  - **`unit_id` requires the `resident` role and an active unit** of the building (criteria 3, 4): an
    occupancy belongs to a resident membership (ADR-0010), and P4-01a's deactivate refuses units with
    occupants, so a new occupant mustn't be invited into an inactive one. Basis: ADR-0010, P4-01a.
  - **Roles stored as `varchar[]` with check constraints** (non-empty, each a Role value): the app's enums
    are non-native (`database_enum`), so there is no Postgres enum type to make an array of. Basis:
    existing convention.
  - **Resend works on an expired invitation** (criterion 9): that is what resend is for. Revoke works on an
    expired one too (it closes it). Basis: autonomous.
  - **The email's locale is the building's** (fallback `en`): the invitee may have no account yet. Basis:
    autonomous.
- Split: P4-02 → P4-02a (this ticket) and [P4-02b](./P4-02b-invitation-accept.md) (lookup and accept).
