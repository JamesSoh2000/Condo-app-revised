# P4-07b — Accept-invitation screen (split from P4-07)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-07a, P4-02b, P2-06c |
| Replaces old | part of [P4-07](./P4-07-frontend-account-screens.md) |
| Status | done (PR #96) |

Split from P4-07 while framing P4-07a (2026-10-20). Framed 2026-10-21: criteria 1–4 are P4-07's, sharpened;
5–14 are added (see Frame notes).

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

1. **Details.** `/invite/:token` (outside `RequireAuth`) sends one `GET /api/invitations/{token}` and shows the
   building name, the masked email as sent and the roles as words ("Resident", "Security", "Property
   management", "Council"), with an "Accept invitation" button. While it loads, a `role="status"` region says
   so. It never calls `/api/auth/me`.
2. **Accept, new email** (sharpens P4-07 criterion 1). "Accept invitation" sends
   `POST /api/invitations/{token}/accept` with `{}`; the server's 422 `validation_error` whose `errors[]` are
   `missing` on `body.full_name` / `body.password` (no account has the email) replaces the button with a
   form: full name, password and confirm (`PasswordField`). Submitting a valid form sends `{full_name,
   password}` (name trimmed, password as typed). On 200 the tab forgets its cached data and choices, selects
   the accepted `building_id` for the tab, and replaces the history entry with `/`: the shell shows the
   navigation of the invited roles (from `/me` and the building's answer).
3. **Accept, existing account, logged out** (sharpens P4-07 criterion 2). The accept's 409 `login_required`
   shows "Log in to accept" with a link to `/login?next=%2Finvite%2F<token>`. After a successful login (or the
   login page finding a session), the login page navigates to `/invite/<token>` with router state
   `{signedIn: true}`, and the invite page sends the accept once by itself when the details have loaded; on
   200 it goes to the shell as in 2. The state is dropped from the history entry, so a reload or Back to it
   doesn't accept again. A link (any `/invite/…?…` URL) can't trigger the automatic accept.
4. **Accept, existing account, logged in.** One click on "Accept invitation" accepts (200) and goes to the
   shell as in 2, in the accepted building even when the user has other active memberships.
5. **Logged in as another account.** 403 `invitation_email_mismatch` shows "You're signed in with another
   account" naming the masked email, and a "Log out" button. Logging out (queued like every logout, 204)
   forgets the tab's cached data and choices and returns to the details on the same page, where "Accept
   invitation" starts again; a failed logout shows an error and keeps the user signed in.
6. **Invalid link** (sharpens P4-07 criterion 3). A 404 `invitation_invalid` from either call, and the paths
   `/invite`, `/invite/` and `/invite/a/b`, show "This invitation is no longer valid" with "Ask your building
   manager to resend it." No code, status or stack trace is shown on any screen of this page.
7. **Other refusals.** 409 `membership_exists` shows "You're already a member of <building>" with a link to
   `/`. 409 `unit_inactive` shows that the invited unit is no longer active and to ask the building manager.
   A 429 from either call shows the wait time (`Retry-After`, else "later"); a 5xx, network error or an
   unplaceable 422 shows a generic message. The details load failure has a "Try again" button that sends the
   GET again.
8. **Form checks.** An empty (after trimming) name, a name over 200 code points, a password under 12 or over
   128 code points, or a confirmation that doesn't match shows the message on its field, focuses the first,
   and sends nothing. A server 422 on `body.full_name` or `body.password` shows this page's own message on
   that field (never the server's `msg`), and the form stays.
9. **Keyboard and screen readers** (sharpens P4-07 criterion 4). Every screen's `<h1>` has focus when it
   appears (load, form, login-required, mismatch, invalid, member, unit). Labels on every input; field errors
   are tied by `aria-invalid`/`aria-describedby`; a form-level error is a focused `role="alert"`. The flow can
   be completed with the keyboard alone (Enter submits).
10. **No double accept, no late navigation.** While an accept or logout is in flight its button is disabled
    and a second submit sends nothing (dropped before react-hook-form). The accept runs through
    `runAuthCall` (it can set the session cookie). An answer that arrives after the user has left the history
    entry (Back, another invite link, which keeps the page mounted) navigates nowhere and changes nothing on
    the screen now shown: the page is keyed per history entry (`useLocation().key`).
11. **`next` stays safe.** The login link's `next` goes through `safeNext` unchanged; the post-login state
    is only added to the navigation `safeNext` already chose.
12. **Carried F6 (P4-07a).** `/login` reached with `state.passwordUpdated` does not auto-redirect when `/me`
    answers (another account still signed in): the banner and the form stay.
13. **Carried F7 (P4-07a).** `/reset-password`, `/reset-password/` and `/reset-password/a/b` show the reset
    page's invalid-link screen with "Request a new link", not "Page not found".
14. **E2E hooks.** The details, form, inputs, buttons, status/alert regions and each result screen carry
    `data-testid` attributes, listed in the PR for P4-09.

Tenant table (`docs/ENGINEERING_PRACTICES.md` §7): no row applies. The page calls no building-scoped endpoint;
the token in the path decides the building on the server (P4-02b's tests cover it).

## Test plan

- Vitest component tests for state handling (`renderApp` with a stubbed `fetch`), one or more per criterion.
- The journey on `make prodlike` (invite created with the operator command or the API, link from Mailpit).
- E2E coverage comes in P4-09.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`; `make check`.

## Likely files

`frontend/src/features/auth/pages/AcceptInvitePage.tsx`, `frontend/src/app/routes.tsx`.

## Carried from P4-07a

- **First: promote a repeated mistake** (playbook step 8). "React keeps a page mounted when only its URL
  changes, so state of the abandoned entry acts on the new one" now appears twice in
  `docs/AGENT_MISTAKES_LOG.md` (P2-06c round 2 M1: Back between two `/login` URLs; P4-07a round 1 F1: Back
  between two reset links). Add a `CLAUDE.md` lesson or a test helper, and key the invite screen per history
  entry as `ResetPasswordPage` does (`key={useLocation().key}`).
- **Open Medium F6 from P4-07a review round 3** (test-first): resetting account A's password while account B is
  signed in on the same browser ends only A's sessions, so `LoginPage`'s `/me` check redirects to B's home and
  the "password updated" banner is never seen. Don't auto-redirect from a login reached with
  `state.passwordUpdated`. This ticket changes the same `next`/redirect flow.
- **Open Medium F7 from P4-07a review round 3** (test-first): `/reset-password`, `/reset-password/` and
  `/reset-password/a/b` show "Page not found" instead of the invalid-link screen with "Request a new link". Add
  a public fallback route next to the invite routes. Codex's proof cases: those three paths.
- Reuse `PasswordField`, `Field`, `PageHeading` and `formErrors.ts::serverFieldErrors`, and drop a duplicate
  submit before react-hook-form's `handleSubmit` (P4-07a round 2, F5).
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

- Criteria added or sharpened: 1–4, 6, 9 sharpen P4-07's four (exact calls, texts, focus). Added: 5 (the
  403 mismatch, which P4-02b's API has and P4-07 didn't mention), 7 (`membership_exists`, `unit_inactive`,
  429, load failure), 8 (form checks), 10 (double submit, Back between two invite links: the carried
  mistake pattern), 11 (`next`), 12–13 (carried F6, F7), 14 (E2E hooks). The missed case: a signed-in user of
  another account (5).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - D1 (autonomous): "Accept invitation" first sends the accept with `{}` and lets the server's answer choose
    the next screen (200 accepted, 409 log in, 403 another account, 422 `missing` → the new-account form).
    The page can't know whether the email has an account (the public GET doesn't say, by design) or whether
    a session exists without calling `/me`, whose 401 `AuthProvider` turns into a redirect to `/login`.
    Alternatives: the form first with a "Log in instead" link (a signed-in invitee would see a form it doesn't
    need, and a new user could follow the link by mistake); `/me` first (the 401 redirect). Cost: one
    extra request against the 20/10 min per-IP limit for a new user.
  - D2 (autonomous): the automatic accept after login is triggered by router state `{signedIn: true}` set by
    the login page on its post-login navigation, not by the URL, as P4-07a's `passwordUpdated` banner (D2
    there): a link can't make the page accept on its own.
  - D3 (ticket + carried): key the page per history entry; promote the mistake to the existing `CLAUDE.md`
    lesson (reworded in place: `CLAUDE.md` is at its 150-line limit).
  - D4 (autonomous): a mismatch's "Log out" stays on the invite page (logout, then the details again) instead
    of `useLogout`, which navigates to `/login` and would lose the invite.
  - D5 (ticket): the header account menu is not touched, so P2-06c's four open Lows stay open; they move to
    P4-08's carried items in step 6.
- Split: this is part b of [P4-07](./P4-07-frontend-account-screens.md); part a is
  [P4-07a](./P4-07a-password-reset-screens.md).
