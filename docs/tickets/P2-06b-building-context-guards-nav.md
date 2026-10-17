# P2-06b — Building context and membership guards

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 1 |
| Depends on | P2-06a |
| Replaces old | M4-T05, M3-T10 (frontend part) |
| Status | in progress |

Split from [P2-06](./P2-06-frontend-auth-shell.md) (see there why). Login, logout, `/me`, `RequireAuth`, the
new shell and the placeholders are [P2-06a](./P2-06a-frontend-auth-core.md). Split again while framing
(2026-10-17): the navigation, the header menu, council "view as", deleting `Layout.jsx` and the P2-06a auth
follow-ups moved to [P2-06c](./P2-06c-navigation-and-header-menu.md) (Frame notes below).

## Goal

Inside the P2-06a shell, the user works in one building per tab, and sees only the screens their
membership, roles and the building's features allow.

## Why

Correct cache scoping here prevents a whole class of cross-building data-leak bugs in the UI
([02 §13](../ARCHITECTURE.md#13-frontend-architecture-adr-0011)).

## Scope

- In:
  - **`src/app/BuildingProvider.tsx`:**
    - the selected building ID is stored in `sessionStorage` (per tab)
    - default: the only active membership, or a picker when there are several
    - switching removes `['b', oldId]` queries
    - every building hook reads the ID from here
  - **Guards** (`src/app/guards.tsx`, next to P2-06a's `RequireAuth`):
    - `RequireActiveMembership`, which renders `NoMembershipScreen`, `PendingScreen` (status from `/me`),
      `DeniedScreen` (with reason after P4-05) or `SuspendedScreen`
    - `RequireRole roles=[…]`
    - `RequireFeature feature=…` (from `GET /api/buildings/{id}`)
  - **403 page** (route `/403`).
  - **Page metadata** (`src/app/pages.ts`): each demo page's roles and feature, used by the routes' guards
    here and by P2-06c's navigation.
  - **A building switcher** in the shell header for users with several active memberships (a plain
    control; P2-06c moves it into the header menu).
  - **Seed:** a multi-building user (active in Maple and Birch) for AC2.
- Out:
  - navigation, header menu, council "view as", deleting `Layout.jsx` (P2-06c)
  - the join-code entry on `NoMembershipScreen` (P4-08, with the join flow; Frame notes)
  - invitation, reset and join screens (P4-07, P4-08)
  - notification bell (P3-05)

## Interfaces

Consumes `GET /api/auth/me` (through P2-06a's `useMe`) and `GET /api/buildings/{id}`. Routes: `/403`.
Exports `useBuildingId()`, `useBuilding()`, `useSelectBuilding()` and the page metadata. Seed: one new user,
`multi@example.test`.

## Acceptance criteria

Numbers in brackets are the parent ticket's. Tenant-table rows ([§7](../ENGINEERING_PRACTICES.md#7-testing-standards))
are named where they apply; rows 7 (related IDs in a body) and 8–9 (transitions, retries) have no frontend
counterpart here.

1. **Membership screens, no building calls [AC3; rows 6].** **Given** a user whose memberships (from `/me`)
   include no active one, **when** they open any page inside the shell, **then** they see, with the header
   and "Log out" still available:
   - `PendingScreen` naming the building(s) when one is `pending` (seeded `pending@example.test`: "Maple
     Tower"),
   - otherwise `SuspendedScreen` when one is `suspended`,
   - otherwise `DeniedScreen` when one is `denied`,
   - otherwise (no membership at all) `NoMembershipScreen`,

   **and** the network log shows **no** request whose path starts with `/api/buildings/` (Vitest for all
   four; Playwright on the stack for `pending@example.test`).
2. **One building per tab [AC4].** **Given** the seeded multi-building user, **when** tab 1 picks Maple and
   tab 2 picks Birch, **then** each tab shows its own building after a reload of either, both tabs stay
   signed in (one cookie), and each tab's building requests go only to its own building's
   `/api/buildings/{id}` (Vitest with two storages; Playwright with two pages of one browser context).
3. **Data never mixes [AC4; row 10].** **Given** a switch from building A to B while A's
   `GET /api/buildings/{A}` is still in flight, **then** A's request is aborted, no `['b', A, …]` query
   remains in the cache, and the shell shows B's name, also when A's response would arrive afterwards.
4. **Default selection.** **Given** exactly one active membership, **then** it is selected without a picker
   and stored. **Given** several, **then** a picker lists exactly the active ones (not pending, suspended or
   denied ones) and nothing building-scoped is requested until one is picked.
5. **A stored selection is checked [rows 3, 6].** **Given** `sessionStorage` holds a building ID that is not
   one of the user's active memberships (another building, a building where the user is now pending, a
   non-UUID string), **then** it is discarded as if absent (criterion 4), and no request goes to
   `/api/buildings/<that value>`.
6. **Role guard [rows 1, 4].** **Given** the page metadata, **when** a member opens a page whose roles they
   don't hold in the selected building (seeded `resident1` on `/SecurityPackages`), **then** they are sent to
   `/403`; with the role (seeded `security`), the page renders. Roles come from
   `GET /api/buildings/{id}`'s `my_roles`, so a role held in another building doesn't count (the `multi`
   case).
7. **Feature guard.** **Given** a page whose feature the selected building has not enabled (the multi user,
   security in Birch, on `/ManagementMaintenance`; Birch has only packages), **then** `/403`; the same user in
   Maple, where they are a resident, opens a page needing that feature (`/Maintenance`) and sees it.
8. **Lost access mid-session [rows 2, 3].** **Given** `/me` lists an active membership but
   `GET /api/buildings/{id}` answers 404 (removed since `/me` was loaded), on the first load or on a later
   refetch of a building already shown, **then** the shell shows "You no longer have access to this
   building" with no data from it, and a button that reloads `/me` and goes back
   to the selection; a 401 there goes to the login page (P2-06a's listener).
9. **No selection survives the user (missed case).** **Given** a signed-in user with a stored selection,
   **when** they log out, or a 401 resets the session, **then** the stored selection is gone, so the next
   user in the tab starts from criterion 4 and never from the previous user's building.
10. **Seed.** `make seed` creates `multi@example.test` (Kim Laurent), active resident of Maple unit 201
    (owner) and active security in Birch; the seed stays idempotent, and the README's account table lists it.
11. **Building queries.** Every building query in this part has a key starting `['b', buildingId]` and
    passes React Query's `signal`; a page reads the building ID only from `useBuildingId()`.
12. **No Base44 [AC7, continued].** The files this part adds or changes contain no `base44` reference, the
    shell's import-graph test (`src/app/shellImports.test.ts`) still passes, and `npm run lint` and the
    ratchet are green.

## Test plan

- Vitest + Testing Library for the guards (stubbed `fetch`, `src/test/renderApp.tsx`) and building switching
  (cache removal, aborted signal).
- Backend: `tests/test_cli_seed.py` for the new seed user.
- Stack run on `make up` with the seeded users, and the shell on `make prodlike` in a browser (Playwright on
  the host's cached Chromium); transcript in the PR.
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`, `make check DB_PORT=55432`.

## Likely files

`frontend/src/app/{BuildingProvider,guards,routes,pages,AppShell,AuthProvider}.tsx`,
`frontend/src/features/membership/**`, `frontend/src/test/renderApp.tsx`, `backend/app/seed.py`,
`backend/tests/test_cli_seed.py`, `README.md`.

## Must explain (learning checkpoint)

1. Why is the selected building stored in `sessionStorage` rather than `localStorage` or on the server?
2. Show how a slow response from building A could appear in building B's view without building-scoped query
   keys, and how the keys prevent it.
3. Why are the frontend guards "UX only", and what would a user who bypassed one actually get?

(The parent's question on council "view as" moved to P2-06c with the toggle.)

## Notes from the P2-06a frame (2026-10-17)

- No seeded user has memberships in two buildings today (`backend/app/seed.py::MEMBERS`): AC2 needs one.
- P2-06a removed `LanguageProvider` from the shell (it calls Base44 on mount). The nav labels are English
  until a slice brings i18n back without Base44.

## Carried from P2-06a (do while framing)

- **Run the shell on `make prodlike`** in a browser (favicon, CSP, login/logout): done in this ticket's stack
  run.
- Building hooks: pass React Query's `signal` (`src/api/README.md`) and rely on P2-06a's cache clears at login,
  logout and 401: criterion 11.
- Moved to [P2-06c](./P2-06c-navigation-and-header-menu.md): the per-tab auth queue (Web Locks), login/logout
  timeouts, a late logout dropping `next`, a signed-in user on `/login`, the header menu and deleting
  `Layout.jsx`, the Base44 Vite plugin's dev-only injections.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - AC1 sharpens the parent's AC3: which screen wins when there are several non-active memberships
    (pending, then suspended, then denied, then none), all four screens tested, and the header stays.
  - AC2 sharpens the parent's AC4 ("each tab keeps its own selection after reload"): one shared cookie, and
    each tab's requests go only to its own building.
  - AC3 makes "data never mixes" testable: the aborted request and the removed queries.
  - AC7's positive case (review round 1, Codex): it first said the multi user "in Maple sees the page"
    (`/ManagementMaintenance`), but that user is a resident in Maple and the page is for staff, so the role
    guard would rightly refuse it. It now names `/Maintenance`, the resident page with the same feature; the
    feature check is still proven both ways.
  - AC8 covers a 404 after the building loaded as well as on the first load (review round 1).
  - New: AC4 (default and picker), AC5 (a stored ID is checked against `/me`: tenant rows 3 and 6), AC6 and
    AC7 (role and feature guards, which the parent had in scope but no criterion), AC8 (lost access), AC9
    (the missed case: a second user in the same tab), AC10 (seed), AC11 (keys and `signal`), AC12 (the
    Base44 check for this part).
- Criteria loosened (with reason; also listed in the inbox):
  - The parent's AC1 (resident navigation) and AC7's "lower the baseline if `Layout.jsx` goes" are not
    loosened but moved, whole, to P2-06c with the navigation (split).
  - `NoMembershipScreen`'s "enter join link or code" (a scope line, not a criterion) moves to P4-08: the
    join flow, its route and its lookup endpoint (P4-05) don't exist yet, so a code field here would lead
    nowhere. The screen says to use the join link from the building. Will be added to the inbox in step 6.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Picker when several active memberships** (ticket), not ARCHITECTURE §13's "defaults to the first
    active membership": the ticket is the more specific and later text; ARCHITECTURE §13 gets the ticket's
    wording in this PR.
  - **Roles and features for the guards come from `GET /api/buildings/{id}`** (`my_roles`, `features`), not
    from `/me`'s roles: features exist only there, and one source keeps a role and a feature check from
    disagreeing. `/me` decides only which memberships are active. Basis: autonomous; reversible.
  - **A failed role or feature check redirects to `/403`** (ticket route), replacing the history entry.
  - **Switching building goes to `/`**, because the current page may be off in the new building. Basis:
    autonomous.
  - **Onboarding pages (`/Onboarding`, `/ResidentSetup`) stay outside `RequireActiveMembership`**: they are
    for users without an active membership. P4-08 replaces them. Basis: autonomous.
  - **Page roles** follow the tickets that own the pages where they say (P5-03: security and
    property_management; P5-04: resident) and `PRODUCT_SCOPE.md` otherwise; each owning slice may change
    its row. Basis: tickets, scope.
- Split: into P2-06b (this) and P2-06c. Estimate for the whole: ~550 non-test lines (building provider and
  picker ~110, guards and four screens ~150, page metadata and routes ~60, switcher ~25, seed ~10;
  navigation and header menu ~110, view-as ~40, auth follow-ups ~40), over the ~400 limit. P2-06b ~355.
  P3-06 still needs only P2-06b; P3-05 (bell in the header), P4-07 and P4-08 (new nav entries) now need
  P2-06c.
