# P4-08a — Join flow and pending/denied screens (split from P4-08)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-05b, P2-06c, P4-07b |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | in progress |

Split from P4-08 while framing (2026-10-21). Criteria 1–3 and the join half of 6 and 7 are P4-08's,
sharpened; 8–17 are added (see Frame notes).

## Goal

A resident joins a building from its link or code, signing up on the way if needed, and then sees what
they submitted while they wait, or the manager's reason after a denial, with a way to ask again.

## Why

This is the resident half of demo journey 3 in the browser. It replaces the legacy `ResidentSetup`,
`Onboarding` and `PendingApprovalBlock` Base44 code.

## Scope

- In:
  - **`/join/:code`** (public route, like `/invite/:token`):
    - `GET /api/join/{code}` names the building. 404 shows "This join link isn't valid" (one screen,
      whatever the reason); other failures show a retry screen (429 with its wait).
    - A visitor the page doesn't know to be signed in sees the building's name, a sign-up form (full
      name, email, password, confirm) and "Already have an account? Log in", which goes to the login page
      with `next=/join/<code>`. The page treats the tab as signed in when the login page sends it back
      (router state `signedIn`), when another screen of the app sends it (same state), or when `['me']`
      is cached. It never calls `/api/auth/me` itself: a 401 there sends every page to the login page.
    - Sign-up calls `auth_signup` through the auth queue, removes every query but this page's lookup,
      and calls `useNewSession()` (P4-07b's carried item).
    - Signed in: a unit search field (debounced 300 ms, `onboarding_units` with `search`) whose matches are a
      radio group, and the relationship as a radio group with plain-language help text for owner, tenant
      and household member. Submit sends `onboarding_create_request`.
    - After a 200 or 201: invalidate `['me']` and the building's `onboarding/me`. If the user had no active
      membership, go to `/`, where the guard shows the pending screen. Otherwise show a "Request sent"
      screen with the unit and relationship and a link to the app.
  - **Pending screen** (`MembershipStatusScreen`, from the P2-06 guard): for each pending membership, the
    building, the unit and relationship from `GET /api/buildings/{id}/onboarding/me`, and "The building
    manager will review your request". While that loads or if it fails, the building name and the wait
    message still show.
  - **Denied screen:** for each denied membership, the manager's reason from `onboarding/me`, and a
    "Submit again" form that takes the join code or link and goes to `/join/<code>` (signed in, so to the
    unit picker).
  - **No-membership screen:** the same code-or-link form (P2-06b's carried item).
  - Remove `Onboarding` and `ResidentSetup` from `DEMO_PAGES` and `PAGE_ACCESS`; delete
    `pages/Onboarding.jsx`, `pages/ResidentSetup.jsx` and `components/PendingApprovalBlock.jsx` (unused);
    lower the ratchet.
- Out:
  - the manager's screens ([P4-08b](./P4-08b-manager-pending-requests.md),
    [P4-08c](./P4-08c-members-administration.md))
  - a backend change (the denied screen asks for the code because no endpoint gives it to a denied member)
  - document evidence; a proper ARIA combobox (the radio group is the accessible native equivalent)

## Interfaces

Consumes `onboarding_lookup`, `onboarding_units`, `onboarding_create_request`, `auth_signup`, `onboarding_my_status`.
No API change.

## Acceptance criteria

1. **Given** a fresh browser on `/join/MAPLE-2026`, **when** the user signs up, types `100`, picks 1003,
   picks Tenant and submits, **then** they land on `/` and the pending screen shows "Maple Tower" (the
   building), "1003" and "Tenant". (Vitest with mocked API; on the stack, transcript in the PR.)
2. **Given** the pending resident, **when** a manager approves (API call in another session) and the
   resident reloads, **then** `/me` lists the membership active and they see the resident home, not the
   pending screen. (Stack transcript; Vitest: `/me` answering active renders the home.)
3. **Given** a denial with reason "Unit number doesn't match our records", **then** the denied screen
   shows that reason, and entering `MAPLE-2026` in "Submit again" opens the unit picker for that building
   (no sign-up form).
4. **Given** an invalid code (`/join/NOPE`, 404) or `/join/` with no code, **then** the invalid-link screen
   shows and no sign-up form is offered.
5. **Given** sign-up with an email that has an account (409 `email_in_use`), **then** the form says so
   with a "Log in" link carrying `next`; 422 field errors show under their fields; 429 shows the wait.
6. **Given** a double submit of sign-up or of the join request, **then** one request is sent (button
   disabled, in-flight guard ahead of react-hook-form).
7. **Given** mobile width (375 px), **then** the join page's forms and the pending and denied screens fit
   without horizontal scrolling (single column, `max-w-sm`, `px-4`; checked on the stack).
8. **Given** the ratchet, **then** `base44-baseline.txt` drops by the references in the two deleted pages,
   and `/Onboarding` and `/ResidentSetup` are "Page not found".
9. **Given** the join request answers 409 `already_member`, **then** "You're already a member" with a link
   to the app; 409 `membership_not_eligible`: "Your membership here is suspended or has ended; contact the
   building's management"; 404 `unit_not_found`: "That unit is no longer available" and the unit list
   refreshes; 404 `join_code_invalid`: the invalid-link screen.
10. **Given** no unit is picked or no relationship is picked, **then** submit shows which is missing and
    sends nothing.
11. **Given** a search that matches nothing, **then** "No unit starts with …" shows; an empty search lists
    the first units the server returns.
12. **Given** the user typed quickly (`1`, `10`, `100`), **then** only the last value, after 300 ms
    without typing, is requested.
13. **Given** a signed-in user with one active membership elsewhere joins this building, **then** after
    submit the join page shows "Request sent" with the unit, not another building's home.
14. **Given** a signed-in user on the join page whose session expires, **then** the units request's 401
    sends them to the login page with `next=/join/<code>` (AuthProvider), and logging in brings them back
    signed in.
15. **Given** the sign-up finished while another user's signed-in shell was cached in the tab, **then**
    that user's queries are gone and the session epoch moved (`useNewSession`).
16. **Given** Back or another join link while the page is mounted, **then** the screen is keyed per
    history entry, so an answer for the entry left behind changes nothing on the new one (lessons learned).
17. **Given** the code-or-link field, **then** `MAPLE-2026`, ` maple-2026 `, and
    `https://<host>/join/MAPLE-2026` all go to `/join/MAPLE-2026`; an empty or malformed value (characters
    outside `A–Z 0–9 -`, over 16) shows an error and does not navigate.

Tenant table (`ENGINEERING_PRACTICES.md` §7): no new endpoint. The UI only reads `onboarding/me` under
the user's own building ID, from `/me`; the server's own-membership check is P4-05a's and is tested there.

## Test plan

- Vitest: join page stages and errors (1, 3–6, 9–16), the code form (17), status screens (1–3), routes (8).
- Manual on the local stack: the journey (1–3) as a transcript, and 375 px screenshots (7).
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`, `make check`.

## Likely files

`frontend/src/features/onboarding/**` (new), `frontend/src/features/membership/MembershipScreens.tsx`,
`frontend/src/app/{routes.tsx,routeScope.ts,pages.ts,nav.test.tsx}`, legacy
`frontend/src/pages/{ResidentSetup,Onboarding}.jsx` and `frontend/src/components/PendingApprovalBlock.jsx`
(removed), `frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. How does the pending screen get its data without operational building access?
2. Why does the join page never call `/api/auth/me`, and how does it know the tab is signed in?
3. How do you explain "owner vs tenant vs household" to a non-technical resident in the UI?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 names the search and the fields the pending screen shows; 2 says how the
  approval is made and checked; 3 names how "submit again" reaches the unit picker; 6 and 7 are P4-08's
  6/4 for this half, made checkable; 8 adds the 404 for the removed routes; 4, 5, 9–17 are added (the
  error codes the endpoints document, debounce, a signed-in user with another building, session expiry,
  the P4-07b sweep, history entries, code parsing).
- Criteria loosened (with reason; also listed in the inbox): none. One scope line changed: P4-08's denied
  screen "submit again (back to the unit picker)" becomes a code-or-link form that leads to the unit
  picker, because no endpoint gives a denied member the building's join code (`MeMembershipOut`,
  `OnboardingMeOut`). Exposing it is a backend change outside a frontend ticket; it goes to the inbox's
  "Decisions to audit" in step 6.
- Decisions taken (with basis):
  - The join page never calls `/me` (a 401 there would send the visitor to the login page instead of the
    sign-up form): it knows "signed in" from router state or the cache, as `AcceptInvitePage` does
    (P4-07b D1; existing pattern).
  - Unit search as a field plus a native radio group, not an ARIA combobox: keyboard and screen readers
    work without custom key handling, and it fits the line budget (autonomous; reversible).
  - After submit, `/` (the guard's pending screen) for a user with no active membership, the join page's
    own "Request sent" otherwise (criterion 13; the guard shows the status screens only without an active
    membership).
  - Query keys: `['join', code]` for the public lookup, `['join', code, 'units', search]`, and
    `['b', buildingId, 'onboarding', 'me']` (rule 12).
- Split: P4-08 was ~1,100 non-test lines (join flow ~420, pending queue ~300, members ~400). P4-08a is the
  join flow and status screens (~420); [P4-08b](./P4-08b-manager-pending-requests.md) the manager's
  pending tab, decisions and badge; [P4-08c](./P4-08c-members-administration.md) the members tab.
