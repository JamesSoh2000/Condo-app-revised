# P2-06a — Frontend auth core: login, logout, session guard and the new shell

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 1 |
| Depends on | P2-02, P1-07 |
| Replaces old | M4-T02, M3-T10 (frontend part) |
| Status | done |

Split from [P2-06](./P2-06-frontend-auth-shell.md) (see there why). The building context, the membership,
role and feature guards and the navigation are [P2-06b](./P2-06b-building-context-guards-nav.md).

## Goal

The app boots from the new auth API only: a TypeScript shell with login, logout, `/me` and a session guard,
and no Base44 auth call (or any other Base44 call) on the boot path.

## Why

Every migrated page plugs into this shell. Correct cache handling at login, logout and session loss
prevents one user's data showing to the next person at the same browser
([02 §13](../ARCHITECTURE.md#13-frontend-architecture-adr-0011)).

## Scope

- In:
  - **The new shell** in `src/app/` (fenced by ESLint against Base44): `App.tsx` (providers, router) and
    `routes.tsx`. `src/main.jsx` renders it; `src/App.jsx` is deleted.
  - **`src/app/AuthProvider.tsx`:**
    - `useMe()`: query `['me']` on `GET /api/auth/me`, passing React Query's `signal`
    - listens for the `auth:unauthenticated` event: `queryClient.clear()` and redirect to
      `/login?next=<current path and query>`, **except** for the 401 of `POST /api/auth/login` itself
      (a wrong password, P1-07 carry)
  - **`src/features/auth/pages/LoginPage.tsx`:** react-hook-form + zod; a generic error on 401, a 429 message
    using `Retry-After`; labels, `aria-invalid`/`aria-describedby`, focus on the first invalid field or on
    the error summary. On success: clear the query cache, go to `next` (validated) or `/`.
  - **Logout** in the shell header: calls the API, clears the query cache, navigates to `/login`.
  - **`RequireAuth`** in `src/app/guards.tsx`.
  - **Placeholders:** `/` renders a home placeholder; each legacy demo page in `src/app/routeScope.ts`
    (`Packages`, `SecurityPackages`, `Maintenance`, …) renders a "Being migrated" placeholder at its old path,
    so the shell imports no legacy page. Their slices replace the placeholders.
  - **404 page** for `*` (replaces `src/lib/PageNotFound.jsx` in the shell).
  - **Retire from the shell:** `src/lib/AuthContext.jsx` (deleted), the Base44 editor helpers
    (`NavigationTracker`, `VisualEditAgent`), `LanguageProvider` (it calls `base44.auth.me()` on mount),
    `Layout.jsx` and `pages.config.js` (no longer imported; `Layout.jsx` is replaced in P2-06b). Lower the
    Base44 ratchet baseline.
  - **Carried from P1-07:** the login-401 exclusion above; `unwrap` throws `ApiError(http_error)` for an empty
    non-204 2xx; `signal` documented in `src/api/README.md`; the ADR-0015 "Revisit when" decision; `src/api`
    cases in `scripts/check-eslint-fence.sh`.
  - **Carried from P1-08:** the Base44-hosted favicon in `index.html` (blocked by the prod-like CSP) is
    replaced with a local asset, and the page title is the app's.
- Out:
  - building selection, membership/role/feature guards, 403 page, navigation, "view as" (P2-06b)
  - invitation, reset and join screens (P4-07, P4-08); notification bell (P3-05)
  - i18n of the new shell (English only until a slice needs `LanguageProvider` without Base44)

## Interfaces

Consumes `POST /api/auth/login` (204, 401 `invalid_credentials`, 422, 429 `rate_limited` with
`Retry-After`), `POST /api/auth/logout` (always 204) and `GET /api/auth/me` (200 `MeOut`, 401). Routes: `/login`,
`/`, the legacy demo paths (placeholders), `*`. Frontend-only API additions: `ApiError.retryAfter`, and
`onUnauthenticated` listeners receive the failing request's method and path.

## Acceptance criteria

1. **Login and landing (original AC1, first half).** **Given** seeded `resident1@example.test` on `/login`,
   **when** submitting the right password, **then** `POST /api/auth/login` is sent once, and the home
   placeholder at `/` renders with the user's full name from `/me` in the header. **Given**
   `/login?next=/Packages`, **then** the user lands on the `/Packages` "Being migrated" placeholder.
2. **Wrong password (original AC2).** **Given** a wrong password (401 `invalid_credentials`), **then** the
   generic message "Email or password is incorrect." is shown in an error summary (`role="alert"`) that
   receives focus, the password field is emptied, and the query cache is **not** cleared and no redirect
   happens (the `auth:unauthenticated` event of the login call is ignored).
3. **Rate limited (new).** **Given** a 429 `rate_limited` with `Retry-After: N`, **then** the summary says to try
   again in N seconds (rounded up to minutes from 120 s on) and receives focus; without a usable
   `Retry-After`, it says to try again later. `ApiError.retryAfter` is parsed from the header (a
   non-negative integer of seconds; anything else is `null`).
4. **Client-side validation (new).** **Given** an empty email or password, **then** no request is sent, each
   empty field shows its error (linked with `aria-describedby`, `aria-invalid="true"`), and focus moves to
   the first invalid field. Any other server error (5xx, network) shows a generic "could not sign in, try
   again" summary.
5. **Logout and Back (original AC5).** **Given** a signed-in user, **when** pressing "Log out", **then**
   `POST /api/auth/logout` is sent, the query cache is empty, and `/login` is shown. **When** then going back
   in history to a protected page, **then** no authenticated content renders: `RequireAuth` shows only a
   loading state until `/me` answers 401, then redirects to `/login`. **Given** the logout call fails
   (network or 5xx), **then** the user stays signed in and sees "Could not log out, try again" (the server
   session is still live, so pretending otherwise would leave it open on a shared computer).
6. **Session lost (original AC6).** **Given** a signed-in user on `/Packages?tab=2`, **when** any API call
   other than `POST /api/auth/login` returns 401 (for example after logout-all from another tab), **then**
   the query cache is cleared and the user is on `/login?next=%2FPackages%3Ftab%3D2`.
7. **`RequireAuth` states (new).** While `/me` is loading, a loading indicator renders and never the protected
   children. `/me` 401 → `/login?next=…`. `/me` failing otherwise (5xx or network, after the client's
   retries) → an error screen with a "Try again" button, not a redirect to login.
8. **Safe `next` (new, missed case: open redirect).** `next` is followed only if it is a same-origin path: it
   starts with exactly one `/`, contains no `\` and no control characters, and is not `/login`. Otherwise the
   user goes to `/`. Tests cover `//evil.example`, `/\evil.example`, `https://evil.example`,
   `javascript:alert(1)`, `/%2F%2Fevil.example` (stays a path), an empty value and `/login`.
9. **No Base44 in the shell (original AC7).** **Given** `npm run lint` and `scripts/base44-count.sh`, **then**
   `src/app/**` and `src/features/**` contain no Base44 reference (ESLint fence), `src/main.jsx` imports
   only the new shell, the shell's import graph contains no `@base44/*` or legacy `api/*.js` module (a
   Vitest test that walks it from `src/app/App.tsx`), and `frontend/base44-baseline.txt` is lowered to the
   new count in this PR. On the stack, the boot and login network log shows only same-origin requests.
10. **Empty 2xx (P1-07 carry).** `unwrap` (so `api.get/post`) throws `ApiError` with `code: "http_error"` for a
    2xx other than 204 whose body is empty; a 204 still resolves `undefined`.
11. **Superseded queries are aborted (P1-07 carry).** `useMe`'s `queryFn` passes React Query's `signal` to
    the request (a test asserts the `Request` carries it), and `src/api/README.md` shows the pattern.

Tenant table (`ENGINEERING_PRACTICES.md` §7): not applicable. This part adds no building endpoint and makes
no `/api/buildings/...` call; the building-scoped cases are P2-06b's (its AC3 and AC4).

## Test plan

- Vitest + Testing Library (jsdom) with `fetch` stubbed: login (AC1–AC4, AC8), the 401 listener (AC2, AC6),
  logout (AC5), `RequireAuth` (AC5, AC7), the client (AC3 `retryAfter`, AC10, AC11), the import-graph test
  (AC9).
- Stack run on `make up` (and `make prodlike` for the CSP and favicon): log in as `resident1`, wrong password,
  `next`, logout and Back, revoke from another session; the transcript (and the network log) goes in the PR.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`, `bash scripts/base44-count.sh`,
  `bash scripts/check-eslint-fence.sh`, `make check`.

## Likely files

`frontend/src/app/{App,AuthProvider,guards,routes}.tsx`, `frontend/src/app/safeNext.ts`,
`frontend/src/features/auth/**`, `frontend/src/main.jsx`, `frontend/src/App.jsx` (deleted),
`frontend/src/lib/AuthContext.jsx` (deleted), `frontend/src/api/{client,errors}.ts`, `frontend/src/api/README.md`,
`frontend/eslint.config.js`, `frontend/index.html`, `frontend/base44-baseline.txt`,
`scripts/check-eslint-fence.sh`, `docs/adr/0015-*.md`.

## Must explain (learning checkpoint)

1. Why are frontend guards "UX only"? Which server mechanism actually protects the data? (original Q3)
2. Why does a failed login's 401 need different handling from every other 401, and what would go wrong
   without the exception?
3. Why is `next` validated, and which inputs would turn it into an open redirect?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - AC1 is the first half of the original AC1 (login and landing); the resident-only navigation is P2-06b's
    AC1. It adds `next`.
  - AC2 sharpens the original AC2 with the exact message, the emptied password field, and the P1-07 carry
    (the login call's own 401 must not clear the cache or redirect).
  - AC5 sharpens the original AC5: how "no authenticated content" is shown (loading, then redirect), and what
    a failed logout call does.
  - AC6 sharpens the original AC6 with the `next` value it must produce.
  - AC9 sharpens the original AC7: which files are "the shell" (`src/app/**`, `src/features/**`, `main.jsx`),
    and an import-graph test, because the ESLint fence only sees direct imports (`App.tsx` importing a legacy
    page that imports Base44 would pass it).
  - New: AC3 (429), AC4 (client validation, other errors), AC7 (`RequireAuth` states), AC8 (safe `next`,
    the missed case), AC10 and AC11 (the P1-07 carries made testable).
- Criteria loosened: none. The "header menu" of the original scope becomes a plain "Log out" button in the
  shell header here; the menu comes with P2-06b's navigation (not a criterion).
- Decisions taken (with basis):
  - **Split** into P2-06a/P2-06b (size; see the parent). Basis: playbook (~400 lines).
  - **The 401 exclusion is by request, not by page.** The event will carry the request's method and path, and
    the listener ignores `POST /api/auth/login`. Alternative: ignore every 401 while on `/login` (rejected:
    the login page could make other calls later, and a 401 there should still reset). Basis: autonomous; the
    P1-07 carry allows either.
  - **Client-side email check is "non-empty, ≤ 320 characters", not an email format.** The backend
    deliberately takes a plain string so a malformed email is an unknown one (401), not a 422
    (`app/auth/schemas.py::LoginIn`); a stricter client rule could block an address the server accepts.
    Password: non-empty, ≤ 128 (`PASSWORD_MAX_LENGTH`). Basis: existing code.
  - **A failed logout call keeps the user signed in** with an error (AC5). Alternative: clear and redirect
    anyway (rejected: the session cookie and the server session would survive while the UI says "logged
    out"). Basis: autonomous.
  - **`LanguageProvider` leaves the shell.** It calls `base44.auth.me()` and Base44 entities on mount, and no
    page left in the shell uses translations once legacy pages are placeholders. The new shell's text is
    English. Basis: the ticket ("the shell never calls Base44"); reversible when a slice brings i18n back.
  - **The favicon and title in `index.html` are fixed here,** not when the layout is migrated (P1-08 carry
    said "when the layout is migrated"): a request to `base44.com` at boot would break AC9's network log.
    Basis: autonomous.
  - **Empty-2xx guard (P1-07 carry):** done, although `/me` (always JSON) and login (204) can't send one by
    contract, because a proxy or misconfigured stack can, and `useMe` would otherwise resolve `undefined`
    under a non-null type. Basis: the carry, cheap.
  - **ADR-0015 revisit:** decided in this PR, as an update to ADR-0015 with the evidence (see the PR).
- Split: this is the first part of P2-06.
