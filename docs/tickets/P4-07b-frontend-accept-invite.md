# P4-07b — Accept-invitation screen (split from P4-07)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-07a, P4-02b, P2-06c |
| Replaces old | part of [P4-07](./P4-07-frontend-account-screens.md) |
| Status | todo |

Split from P4-07 while framing P4-07a (2026-10-20). Not framed yet: the scope and criteria below are P4-07's
invite parts as written; this ticket's own framing sharpens them.

## Goal

Users can accept invitations through an accessible screen that handles every invalid-link and error case
gracefully.

## Why

This screen completes demo journeys 1 and 2 in the browser.

## Scope

- In:
  - **`/invite/:token`:**
    - fetches `GET /api/invitations/{token}`
    - shows the building name, masked email and roles
    - new account: a form for full name, password and confirm, then accept, then redirect into the shell
    - existing account (the accept call returns 409 `login_required`): show "Log in to accept", go to login
      with `next=/invite/:token`, then auto-accept
    - an invalid token shows a friendly screen ("This invitation is no longer valid; ask your building
      manager to resend it")
  - Reuses P4-07a's password field and server-error mapping.
  - Labels, focus on the heading at load, `aria-live` status, mobile layout, and `data-testid` attributes
    for E2E.
- Out: signup and join (P4-08), MFA (pilot).

## Interfaces

Consumes `invitations_get_public` and `invitations_accept`.

## Acceptance criteria

1. **Given** a valid invite link for a new email, **when** the form is completed, **then** the user lands in
   the shell with the invited role's navigation.
2. **Given** an invite for an existing account while logged out, **then** the user is guided through login
   and the invitation is accepted afterwards.
3. **Given** an invalid, expired or used invite token, **then** the friendly invalid screen shows. There are
   no stack traces or raw codes.
4. **Given** keyboard-only use, **then** the form can be completed. Errors are announced and focused.

## Test plan

- Vitest component tests for state handling (mock the client).
- E2E coverage comes in P4-09.

## Likely files

`frontend/src/features/auth/pages/AcceptInvitePage.tsx`, `frontend/src/app/routes.tsx`.

## Carried from P4-07a

- `Referrer-Policy: same-origin` is already set by Caddy on `/invite/*` and `/login` (P4-07a criterion 12).
- `/invite/:token` is outside `RequireAuth`. `AuthProvider` sends any 401 except the login call's to
  `/login`, so the page must not call `/me` while logged out, or handle that redirect.

## Carried from P2-06c

The header account menu (`frontend/src/app/AccountMenu.tsx`) left four Lows open after P2-06c's last review
round (PR #65 round 3). Fix them test-first if this ticket touches the menu, or say why not:
- Back to the history entry where the panel was opened shows it again: `open = openAt === key`, and the entry
  keeps its key. Clear `openAt` when the key changes.
- A `/me`-driven change of the selected building (the old one suspended) leaves the panel open with new
  contents. Also close it when `buildingId` changes.
- During a building 401/404 the nav hides but the menu still offers "View as" from the cached roles. Apply the
  same 401/404 check in `BuildingChoices` (or in `useCanViewAs`).
- Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space. Use `pointerdown`.

## Carried from P4-02b

- The API it consumes (PR #87): 404 `invitation_invalid` (one body for every bad token), 409 `login_required`,
  403 `invitation_email_mismatch` (logged in as someone else: ask them to log out), 409 `membership_exists`,
  409 `unit_inactive`, 422 `validation_error` with `errors[].type` `missing` or `password_<reason>`, 429 with
  `Retry-After`. The accept answers `{building_id, membership_id, roles}`.

## Must explain (learning checkpoint)

1. How does `next=` work safely? Why must it only allow internal paths (open-redirect risk)?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: this is part b of [P4-07](./P4-07-frontend-account-screens.md); part a is
  [P4-07a](./P4-07a-password-reset-screens.md).
