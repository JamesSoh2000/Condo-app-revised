# P6-08c — Base44 look on the signed-out screens

| Field | Value |
|---|---|
| Phase / lane | P6 / B |
| Risk tier | 2 |
| Depends on | P6-08b |
| Replaces old | — |
| Status | todo |

Last step of the lowest-change Base44-look route (2026-10-29), after
[P6-08b](./P6-08b-base44-look-feature-pages.md): the screens outside the signed-in frame.

## Goal

Login, forgot password, reset password, accept invitation and join use the Base44 look (centred white card on the
zinc background, the shared heading and button style), with unchanged behaviour.

## Why

These screens are the first thing a member sees and sit outside P6-08a's frame, so they keep the plain look until
restyled. They reuse P6-08a's `ui` primitives and P6-08b's shared pieces, so the work is markup only.

## Scope

- In: `features/auth/pages/{LoginPage,ForgotPasswordPage,ResetPasswordPage,AcceptInvitePage}.tsx`,
  `features/onboarding/{JoinPage,JoinCodeForm,JoinRequestForm}.tsx`, the auth `components/` they render (the
  password field keeps its show/hide behaviour): a centred `Card` (`max-w-md`, `border-zinc-200/60`), the app name
  or building name as text above it, `Button` and the `ui` input style for fields, errors in the shared `ErrorState`
  or inline style
- Out: any change to form logic, validation, error mapping, rate-limit messages, CSRF, redirects (`safeNext`), focus
  rules, accessible names or label text; the Base44 logo image; new copy

## Interfaces

None.

## Acceptance criteria

1. **Behaviour unchanged.** **Given** `LoginPage.test.tsx`, `PasswordReset.test.tsx`, `AcceptInvite.test.tsx`,
   `JoinPage.test.tsx` and the onboarding E2E (P4-09), **then** they pass with no change to what they assert.
2. **Errors and focus.** **Given** a failed login, a 429 and a field error, **then** the message and focus behave as
   before (the existing focus tests pass, and in Chromium focus lands where it did).
3. **375 px.** **Given** Chromium at 375 px with a 254-character email and the longest building name, **then** no
   screen scrolls sideways and the card fits the viewport width.
4. **No Base44.** The ratchet does not rise; nothing imports from `src/pages/` or `@/api/base44Client`.
5. **Look.** Screenshots of each screen at 375 and 1280 px (with one error state shown) are in the PR.

## Test plan

- Existing suites unchanged (criteria 1, 2); `make check DB_PORT=55432`; `make e2e`
- Chromium at 375 px (criterion 3) and screenshots (criterion 5) on `make up`, in the PR

## Likely files

`frontend/src/features/auth/{pages,components}/*`, `frontend/src/features/onboarding/*.tsx`.

Estimate: ~150 non-test lines (eight screens' markup).

## Must explain (learning checkpoint)

1. How did the restyle avoid touching any of the auth flow's security behaviour (CSRF, `safeNext`, rate limits)?
2. Where does a signed-out screen get its look, given it has no `AppShell`?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
