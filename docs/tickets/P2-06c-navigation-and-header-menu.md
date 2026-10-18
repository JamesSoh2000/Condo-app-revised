# P2-06c — Navigation, header menu and council "view as"

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 1 |
| Depends on | P2-06b |
| Replaces old | M3-T10 (frontend part) |
| Status | done |

Split from [P2-06b](./P2-06b-building-context-guards-nav.md) while framing it (2026-10-17; size, see its Frame
notes). The parent is [P2-06](./P2-06-frontend-auth-shell.md).

## Goal

The user navigates with a menu built from the page metadata P2-06b added, from a header menu that holds the
building switcher and "Log out". The Base44 `Layout.jsx` is gone.

## Scope

- In:
  - **Navigation** built from `src/app/pages.ts` (role, feature, scope allowlist from P0-03), replacing the
    Base44 nav logic in `Layout.jsx`. Delete `Layout.jsx` once nothing imports it (today only the unused
    `pages.config.js` does), and lower the Base44 baseline.
  - **Header menu** holding P2-06a's "Log out" and P2-06b's building switcher; keyboard accessible.
  - **Council "view as resident/management"**: a **presentation toggle only**, stored per tab; it never
    changes API calls or permissions, and never shows an item the user's real roles don't allow.
  - **P2-06a follow-ups** (carried, decide while framing):
    - The auth queue is per tab (`src/app/authQueue.ts::runAuthCall`): a slow logout in tab A can delete a
      session tab B just created. Decide whether to serialize across tabs with Web Locks
      (`navigator.locks`), with the in-module chain as the jsdom fallback (James chose the per-tab queue in
      inbox B-3).
    - No timeout on login/logout: one hung call holds the queue until the browser times it out. Consider a
      timeout signal on both, showing the generic error.
    - A late logout drops `next`: when it settles while the user is back on `/login?next=…`, it navigates to
      bare `/login`. Skip that navigate on a login path.
    - A signed-in user on `/login` sees the form; consider redirecting to `/`.
    - The Base44 Vite plugin's two dev-only injections and `main.jsx`'s `sandbox:*` `postMessage`s: remove
      when no legacy page needs them.
- Out: notification bell (P3-05), new pages (their slices).

## Acceptance criteria

Sharpened while framing (see the Frame notes). Personas are the seeded accounts or the test fixtures in
`frontend/src/test/renderApp.tsx`; "the nav" is the shell's `<nav aria-label="Main">`.

1. **Navigation from the page table.** The nav lists, in `PAGE_ACCESS` order, exactly the rows that have a
   nav label and that `hasRole` and `hasFeature` allow for the selected building (`GET /api/buildings/{id}`).
   Each item links to its route, and the current page's item has `aria-current="page"`. Tested with a
   hard-coded expected list per persona, not by calling the same helpers:
   - a. **Given** seeded `resident1` (resident in Maple: packages, notices, maintenance), **then** the nav is
     Dashboard, My profile, Contacts, My packages, Maintenance requests, and no staff item (Residents,
     Package log, Daily notices, Maintenance) (the parent's AC1, second half).
   - b. **Given** security in Birch (packages only), **then** Package log is shown and Daily notices is not
     (the feature hides it); property management in Maple sees Residents, Daily notices and Maintenance.
   - c. **Given** the multi user switching Maple (resident) → Birch (security), **then** the nav changes to
     Birch's items (missed case: the nav follows the building, not the first one loaded).
   - d. No nav without a loaded building: on the membership screens, the picker, or after the building
     answers 404 or 401 (also on a refetch, over cached data). Building the nav makes no request of its own:
     the only building call is the one the guards already make.
2. **No Base44.** **Given** `npm run lint`, the ratchet and `shellImports.test.ts`, **then** the files this part
   adds or changes under `src/app` and `src/features` contain no `base44` reference; `Layout.jsx` and the
   unused `pages.config.js` (its only importer) are deleted; the Base44 Vite plugin is gone from
   `vite.config.js` and `package.json` (its `@/` alias moves into the config) and the `sandbox:*`
   `postMessage`s from `main.jsx`; `npm run build` still passes; and `frontend/base44-baseline.txt` equals the
   new count (the parent's AC7, continued).
3. **Council "view as" is presentation only.** **Given** a member with the `council` role in the selected
   building:
   - a. the header menu shows "View as: Management / Resident" (default Management); a member without
     `council` there sees no toggle, and a stored view is ignored for them;
   - b. toggling makes **no request**: the list of requests made before and after toggling (twice) is the same;
   - c. every nav item shown in either view is one the member's real roles and the building's features
     allow: Management view shows the items open to any member plus those for a staff role (security,
     property management, council); Resident view shows the items open to any member plus those for
     `resident`. A council-only member sees no resident item in Resident view; council + resident sees
     My packages in Resident view and Daily notices in Management view;
   - d. the guards don't change: a page the real roles allow opens by URL in either view;
   - e. the view is stored per tab (`sessionStorage`), survives a reload, and is cleared with the building
     choice (logout, 401 reset, login, another user in `/me`);
   - f. if a `/me` or building refetch drops `council`, the toggle disappears and the full nav is shown.
4. **Header menu.** One account button in the header, showing the user's name (accessible name "Account
   menu: <name>", `aria-expanded`, `aria-controls`), opens a panel with the signed-in email, the building
   (its name, or the switcher with two or more active memberships), the view-as toggle (3a) and "Log out". Keyboard: the button opens and closes it with Enter/Space; Escape closes
   it and returns focus to the button; a click outside closes it; switching building closes it. A failed
   logout's error stays visible with the menu closed. It is also shown (with "Log out") on the membership
   screens and the picker.
5. **A default selection is the tab's choice** (carried, item 2), test-first with both scenarios: render, let
   the default settle, change `/me`, invalidate `['me']`, wait, then assert storage and the building shown:
   - a. only Maple active, then `/me` adds Birch: Maple stays selected and stored; no picker;
   - b. stored Maple suspended, Birch selected by default, then Maple reactivated: Birch stays;
   - c. a stored choice that becomes invalid is **forgotten for good**: the tab's state equals what a reload
     would give (stored Maple suspended with Birch and Cedar active shows the picker; Maple reactivated
     still shows the picker).
6. **Regression tests (carried, item 3):** the `key={me?.user.id}` remount (user A *picks* Maple, `/me` then
   answers user B active in Maple and Birch: the picker shows); `BuildingLoaded`'s own 401 branch shows the
   loading screen and none of the building's page without `AuthProvider`'s redirect; `select()` ignores an
   inactive ID (no storage write, no navigation).
7. **P2-06a auth follow-ups:**
   - a. **Across tabs:** `runAuthCall` takes the Web Lock `condo.auth` (`navigator.locks.request`) when the
     browser has it, so a login and a logout in two tabs never overlap; without it (jsdom, old browsers) it
     keeps the per-tab queue. Tested with a fake `navigator.locks`: the call runs inside the lock, the next
     call waits for it, and a failure releases it.
   - b. **Timeout:** login and logout requests abort after 15 s; the login then shows "Could not sign in. Try
     again.", the logout "Could not log out, try again.", and the queue (or lock) is free for the next call.
   - c. **Late logout keeps `next`:** a logout that settles while the tab is on `/login?next=/Packages`
     leaves that URL as it is (other paths still go to `/login`).
   - d. **Signed-in user on `/login`:** the page checks `/me` once when it opens, through the auth queue (so
     after any logout still in flight, and not at all if the form is gone by then). A 200 sends the user to
     `safeNext(next)` (replace); a 401 shows the form and navigates nowhere; another error shows the form.
8. **Lesson first (carried, item 1):** `CLAUDE.md`'s "test the fix on its neighbours" lesson lists, for state
   and concurrency fixes, the other ways to reach the state.

Tenant table (`docs/ENGINEERING_PRACTICES.md` §7): this part adds no endpoint and no request. The rows that
apply to the frontend (a foreign or stale building ID in storage, a building the user lost) are P2-06b's
tests and stay green; 1d and 3b prove the nav and the toggle request nothing new.

## Carried from P2-06b (do while framing; first items first)

1. **Lesson first (playbook step 8; carried from P2-06a, not done in P2-06b).** Extend `CLAUDE.md`'s
   "test the fix on its neighbours" lesson: for state and concurrency fixes the neighbours are the other ways
   to reach the state: a second instance of the action, a remount (Back/Forward), an abandoned caller, a
   failure instead of success, and a server-driven change (a refetch, a `/me` answer) instead of a user action.
   P2-06b hit it twice more (`docs/AGENT_MISTAKES_LOG.md`, P2-06b rows).
2. **Known defect, review round 3 (Codex, Medium, unfixed in PR #64):** in
   `frontend/src/app/BuildingProvider.tsx::UserBuildingProvider` a building selected **by default** (the only
   active membership) is never kept in `stored`, which only `select()` and `reset()` set.
   - Only Maple active, then a `/me` refresh adds Birch: the picker comes back instead of keeping Maple.
   - Stored Maple suspended, Birch selected by default, then Maple reactivated: the tab silently switches back
     to Maple.

   Fix test-first with these two scenarios: render, let the default settle, change `/me`, invalidate
   `['me']`, wait, and assert the storage and the building shown. Keep the default as the tab's choice.
   Decide whether a stored choice that went invalid is forgotten for good.
3. **Untested, review round 3 (Claude L1, L2):**
   - a regression test for the `key={me?.user.id}` remount: user A *picks* Maple, then `/me` answers user B,
     who is active in Maple and Birch; expect the picker;
   - `BuildingLoaded`'s own 401 branch, without `AuthProvider`'s redirect;
   - `select()` ignoring an inactive ID.
4. Move P2-06b's header `BuildingSwitcher` (`frontend/src/app/AppShell.tsx`) into the header menu.

## Must explain (learning checkpoint)

1. Why does council "view as" never change API permissions?
2. How does one metadata table drive both the route guards and the navigation, and what would drift if they
   were separate?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - AC1 names the exact items per persona (the parent's "only resident demo items" made testable), the
    feature filter (1b), the building switch (1c, the missed case) and when no nav shows (1d).
  - AC2 names the files that go and the plugin removal (scope lines made criteria).
  - AC3 splits "same requests, no disallowed item" into who sees the toggle, zero requests, the two views'
    item rules, unchanged guards, per-tab storage and a role lost on refetch.
  - New: AC4 (header menu, keyboard), AC5–AC6 (carried items as criteria), AC7 (the P2-06a follow-ups, each
    decided below), AC8 (lesson).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - **Nav labels live in `PAGE_ACCESS`** (an optional `label`; a row without one is not in the nav: Home,
    which `/` already shows, and the onboarding pages), so one table drives guards and nav. Basis: ticket
    ("built from `src/app/pages.ts`").
  - **The view-as audience is derived from a row's roles**, not a new field: no roles → both views;
    `resident` → Resident view; a staff role → Management view. Default Management (council is a staff role).
    Basis: autonomous; scope "Council view is presentation only".
  - **Header menu is a disclosure** (a button that shows a panel), not an ARIA `menu`: it holds a `<select>`
    and radio buttons, which a `menu` can't contain. No new dependency. Basis: autonomous (WAI-ARIA APG
    disclosure pattern).
  - **Web Locks across tabs (7a): adopted**, with the per-tab queue as fallback. B-3 chose the per-tab queue
    for P2-06a and left this ticket to decide; with the 15 s timeout (7b) a hung call can hold the lock for
    at most 15 s, which was the reason not to share one queue across tabs. Basis: autonomous; listed in the
    inbox's decisions to audit (step 6).
  - **Timeout 15 s (7b)**, a fixed constant. Basis: autonomous (above the API's own slow-request budget,
    below browsers' minutes-long defaults).
  - **Signed-in on `/login` (7d): redirect to `safeNext(next)`**, not always `/`, so a link to
    `/login?next=/Packages` still lands on the page. The check is a fresh `/me` run through the auth queue,
    not the cached `/me`: a cached answer can predate a logout still in flight (P2-06a's Back/Forward case).
    Basis: autonomous; reuses P2-06a's `safeNext` and `runAuthCall`.
  - **An invalid stored choice is forgotten (5c)**, so a tab never switches back on its own and reload and
    no-reload agree. Basis: autonomous (the ticket asked to decide).
  - **Remove the Base44 Vite plugin entirely (AC2)**: no legacy page is routed since P2-06a, so nothing needs
    its two dev-only injections, the `sandbox:*` messages or its `legacySDKImports`; its one useful effect,
    the `@/` alias, moves into `vite.config.js` (the same alias `vitest.config.ts` already has). Basis:
    ticket ("remove when no legacy page needs them").
- Split: none. Estimate ~260 non-test lines added (nav ~45, header menu ~90, view-as ~45, page labels ~15,
  default-selection fix ~5, auth follow-ups ~45, Vite/main cleanup ~10); `Layout.jsx` and `pages.config.js`
  are deletions.
