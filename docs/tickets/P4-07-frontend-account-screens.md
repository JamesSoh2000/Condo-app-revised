# P4-07 — Frontend account screens

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-02, P4-04, P2-06 |
| Replaces old | M4-T07 (without MFA) |
| Status | todo |

## Goal

Users can accept invitations, request a password reset, and set a new password through accessible screens
that handle every invalid-link and error case gracefully.

## Why

These screens complete demo journeys 1, 2 and 7 in the browser.

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
  - **`/forgot-password`:** an email form. It always shows the generic confirmation, and shows 429 with a
    wait time.
  - **`/reset-password/:token`:** new password + confirm. On success, navigate to login with a "password
    updated, please log in" banner. `reset_token_invalid` shows a screen with a link to request a new one.
  - **Password field component:** show/hide toggle, live length hint, server `errors[]` mapped to fields.
  - Add a "Forgot password?" link on the login page.
  - **All screens:** labels, focus on the heading at load, `aria-live` status, mobile layout, and
    `data-testid` attributes for E2E.
- Out:
  - signup and join (P4-08)
  - MFA (pilot)

## Interfaces

Consumes `invitations_get_public`, `invitations_accept`, `auth_password_reset_request` and
`auth_password_reset_confirm`.

## Acceptance criteria

1. **Given** a valid invite link for a new email, **when** the form is completed, **then** the user lands in
   the shell with the invited role's navigation.
2. **Given** an invite for an existing account while logged out, **then** the user is guided through login
   and the invitation is accepted afterwards.
3. **Given** an invalid, expired or used invite token, **then** the friendly invalid screen shows. There are
   no stack traces or raw codes.
4. **Given** forgot-password for any email, **then** the same confirmation text shows.
5. **Given** a valid reset link, **then** the password is updated, and the login page shows the success
   banner. An already-used link shows the invalid screen.
6. **Given** keyboard-only use, **then** every form can be completed. Errors are announced and focused.

## Test plan

- Vitest component tests for state handling (mock the client).
- E2E coverage comes in P4-09.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`.

## Likely files

`frontend/src/features/auth/pages/{AcceptInvitePage,ForgotPasswordPage,ResetPasswordPage}.tsx`,
`frontend/src/features/auth/components/PasswordField.tsx`, `frontend/src/features/auth/api.ts`,
`frontend/src/app/routes.tsx`.

## Carried from P2-06c (do while framing)

The header account menu (`frontend/src/app/AccountMenu.tsx`) left four Lows open after P2-06c's last review
round (PR #65 round 3). Fix them test-first if this ticket touches the menu, or say why not:
- Back to the history entry where the panel was opened shows it again: `open = openAt === key`, and the entry
  keeps its key. Clear `openAt` when the key changes.
- A `/me`-driven change of the selected building (the old one suspended) leaves the panel open with new
  contents. Also close it when `buildingId` changes.
- During a building 401/404 the nav hides but the menu still offers "View as" from the cached roles. Apply the
  same 401/404 check in `BuildingChoices` (or in `useCanViewAs`).
- Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space. Use `pointerdown`.

## Must explain (learning checkpoint)

1. Why does the forgot-password screen never say whether the email exists?
2. How does `next=` work safely? Why must it only allow internal paths (open-redirect risk)?
3. How are server validation errors mapped onto form fields?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
