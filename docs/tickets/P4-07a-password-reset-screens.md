# P4-07a — Password reset screens and password field (split from P4-07)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-04, P2-06c |
| Replaces old | part of [P4-07](./P4-07-frontend-account-screens.md) |
| Status | in progress |

## Goal

Users can request a password reset and set a new password through accessible screens that handle every
invalid-link and error case gracefully. The password field built here is reused by P4-07b's invite screen.

## Why

These screens complete demo journey 7 in the browser.

## Scope

- In:
  - **`/forgot-password`:** an email form. It always shows the server's generic confirmation, and shows 429
    with a wait time.
  - **`/reset-password/:token`:** new password + confirm. On success, navigate to login with a "password
    updated, please log in" banner. `reset_token_invalid` shows a screen with a link to request a new one.
  - **Password field component:** show/hide toggle, live length hint, server `errors[]` mapped to fields.
  - A "Forgot password?" link on the login page.
  - `Referrer-Policy: same-origin` on the pages whose URL can carry a token (`/reset-password/*`,
    `/invite/*`, and `/login`, whose `next` will carry an invite path in P4-07b).
  - **All screens:** labels, focus on the heading at load, `aria-live` status, mobile layout, and
    `data-testid` attributes for E2E.
- Out:
  - `/invite/:token` (P4-07b)
  - signup and join (P4-08), MFA (pilot)

## Interfaces

Consumes `auth_password_reset_request` and `auth_password_reset_confirm` (PR #90). No API change.

## Acceptance criteria

1. **Forgot password, any email.** Submitting a non-empty email sends one
   `POST /api/auth/password-reset/request {email}` (trimmed). On 202 the form is replaced by the response's
   `detail`, shown as is in a `role="status"` region: the same text whatever the email, since the server
   answers alike. An empty email shows "Enter your email." on the field and sends nothing.
2. **Forgot password, refused.** 429 shows "Too many requests. Try again in N seconds" (or minutes, from
   `Retry-After`; without it "Try again later"); any other failure (5xx, network, 422) shows a generic
   "Could not send the link. Try again." The form stays, and nothing shows a raw code, status or stack trace.
3. **Reset, success.** With a new password of 12–128 characters (code points, as the server counts) and a
   matching confirmation, the page sends one `POST /api/auth/password-reset/confirm {token, new_password}`
   with the token from the URL path. On 204 it clears the query cache and the tab's building choices (the
   server has logged out every session) and replaces the history entry with `/login`, which shows
   "Your password was updated. Sign in with your new password." in a `role="status"` banner.
4. **The banner can't be forged.** It is carried in router state, not in the URL: `/login?…` with any query
   never shows it, and it is gone after a reload of the login page.
5. **Reset, invalid link.** 400 `reset_token_invalid` (unknown, used, replaced or expired token, including a
   path of the wrong shape) replaces the form with "This reset link is no longer valid" and a link to
   `/forgot-password`. No code or status is shown.
6. **Reset, refused password.** 422 `validation_error` whose `errors[]` has `loc: ["body","new_password"]`
   shows the type's message on the "New password" field (`password_too_common` → "This password is too
   common. Choose another.", `password_too_short`/`string_too_short`, `password_too_long`/`string_too_long`,
   `password_invalid_characters`) and focuses it; the form stays, so the same link can be used again. An
   error the page can't place on a field shows a generic message in the form's alert.
7. **Reset, client checks.** A password under 12 or over 128 code points, or a confirmation that doesn't
   match, shows the message on its field, focuses it, and sends nothing. 429 shows the wait time as in 2;
   other failures a generic message.
8. **No double submit, no late navigation.** While a request is in flight the submit button is disabled; a
   second click sends nothing. A reset that answers after the user has left the page (Back) navigates
   nowhere.
9. **Password field.** The input is `type="password"` until the "Show password" toggle (a button with
   `aria-pressed`) is pressed, then `text`, and back. A hint under it, tied by `aria-describedby`, reads
   "At least 12 characters" and then the count so far ("7 of at least 12 characters"); the hint is not a live
   region, so it isn't announced on every keystroke. The toggle doesn't submit the form.
10. **Login link.** The login page has a "Forgot password?" link to `/forgot-password`.
11. **Keyboard and screen readers.** Every form can be completed and submitted with the keyboard alone. On
    load, each screen's `<h1>` has focus. Field errors are tied to their input (`aria-invalid`,
    `aria-describedby`); after a failed submit focus moves to the first invalid field, or to the form's
    `role="alert"` summary for a form-level error.
12. **Referrer.** The prod-like stack answers `/reset-password/<x>`, `/invite/<x>` and `/login` with
    `Referrer-Policy: same-origin` (no `Referer` to any other origin), and every other page with the existing
    `strict-origin-when-cross-origin`; `scripts/smoke.sh` checks both. A login or reset POST from those pages
    still passes the CSRF origin check.
13. **E2E hooks.** The forms, inputs, submit buttons, status/banner regions and the invalid-link screen carry
    `data-testid` attributes, listed in the PR for P4-09.

Tenant table (`docs/ENGINEERING_PRACTICES.md` §7): no row applies. These screens call no building-scoped
endpoint and need no session.

## Test plan

- Vitest component tests for state handling (`renderApp` with a stubbed `fetch`), one per criterion.
- The journey on `make prodlike` (curl for the headers, the reset link from Mailpit).
- E2E coverage comes in P4-09.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`; `make check`, `make prodlike-smoke`.

## Likely files

`frontend/src/features/auth/pages/{ForgotPasswordPage,ResetPasswordPage}.tsx`,
`frontend/src/features/auth/components/PasswordField.tsx`, `frontend/src/features/auth/` helpers,
`frontend/src/features/auth/pages/LoginPage.tsx`, `frontend/src/app/routes.tsx`, `deploy/Caddyfile`,
`scripts/smoke.sh`.

## Carried from P4-04

- The reset email links to `${APP_BASE_URL}/reset-password/<token>` (43 URL-safe characters).
- `POST /api/auth/password-reset/request {email}` always answers 202 `{detail}` (show it as is; it never says
  whether the account exists), 422 for a malformed body, 429 with `Retry-After`.
  `POST /api/auth/password-reset/confirm {token, new_password}` answers 204 and logs out every session (send
  the user to login), 400 `reset_token_invalid` (one body for every bad token: offer to request a new link),
  422 `validation_error` with `errors[].type` `password_<reason>` on `new_password` (the token stays usable),
  429.

## Must explain (learning checkpoint)

1. Why does the forgot-password screen never say whether the email exists?
2. How are server validation errors mapped onto form fields?
3. Why is the "password updated" banner in router state and not in the URL?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: the original criteria 4 and 5 became 1–8 (exact requests, every response
  status, the 422 field mapping, the client checks, double submit and late navigation); 9 makes the
  password field's toggle and hint testable; 4 (forged banner) and 8 (late navigation) are the missed cases;
  11 is the original 6 for these screens, made testable; 12 makes the Referrer-Policy carry testable.
- Criteria loosened (with reason; also listed in the inbox): none. The original criteria 1–3, and 6 for the
  invite screen, moved to P4-07b unchanged.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Split into P4-07a / P4-07b (playbook: estimate ~560 non-test lines). Default.
  - `same-origin`, not `no-referrer`: under `no-referrer` the Fetch standard sends `Origin: null` on a
    same-origin POST, which `app/core/csrf.py` refuses, so login and reset would fail on those pages.
    `same-origin` sends no `Referer` to another origin and keeps the real `Origin`. Basis: ticket (either is
    allowed), CSRF middleware.
  - The Referrer-Policy is set by Caddy per path, not by a `<meta>` tag: it applies before
    any script runs and on the first load from the email, which is how these pages are reached. `/login` is
    included because P4-07b sends `next=/invite/<token>` there. Under `make up` (Vite) there is no header;
    the browser default `strict-origin-when-cross-origin` already drops the path cross-origin. Autonomous,
    reversible.
  - The banner travels in router state (criterion 4). Autonomous.
  - Length counts code points, as the server's `len()` does, like the login form. Convention (LoginPage).
  - The `AccountMenu` Lows carried from P2-06c are not touched here (this ticket doesn't change the menu);
    they move to P4-07b's ticket text unchanged.
- Split: this is part a of [P4-07](./P4-07-frontend-account-screens.md); part b is
  [P4-07b](./P4-07b-frontend-accept-invite.md).
