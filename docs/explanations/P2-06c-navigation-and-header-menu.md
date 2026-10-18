# Explanation — P2-06c Navigation, header menu and council "view as"

> **PR:** #65 · **Source revision:** `ef40eb1`. This is the pre-merge PR head this explanation was written from and checked against.
> **Reviewed:** the final review round (3) reviewed this commit (Claude and Codex both).
> **Merge commit:** not known when this was written; after the merge, `gh pr view 65 --json mergeCommit` gives it.
>
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it before merge. This describes the PR's changes at the source revision. It does not describe commits after it (bookkeeping) or the squash merge, and a rebase after it gives the same changes new SHAs. It is a snapshot: before the merge it is edited to match the PR head; once merged, later changes get a new explanation and this one is not updated. Lasting decisions live in ADRs.
>
> **Reality check:** at `ef40eb1` I re-read from disk:
> - `git diff origin/main...HEAD` (27 files)
> - in full: `frontend/src/app/{pages.ts,MainNav.tsx,AccountMenu.tsx,BuildingProvider.tsx,buildingStorage.ts,authQueue.ts}`, `frontend/src/features/auth/pages/LoginPage.tsx`; the changed parts of `frontend/src/app/{AppShell.tsx,AuthProvider.tsx,routeScope.ts}`, `frontend/vite.config.js`, `frontend/src/main.jsx`, `frontend/src/test/renderApp.tsx`; `frontend/src/app/guards.tsx::RequirePageAccess` and its use in `frontend/src/app/routes.tsx`
> - the assertions of the tests named in §5 and §9 (the AC1, AC3 and review-round blocks of `nav.test.tsx`, the Web Lock block of `authQueue.test.tsx`, the late-logout and `next` blocks of `shell.test.tsx`)
> - the PR #65 description (Plan, D1–D10, review rounds 1–3) and the ticket's criteria and "Must explain"
>
> Ran `cd frontend && npx vitest run` on the cited files (`nav`, `shell`, `authQueue`, `building`, `LoginPage`, `shellImports`): `Test Files 6 passed (6)`, `Tests 166 passed (166)`. The whole suite at `ef40eb1`: `Tests 260 passed (260)`, after mutations S1–S5 each failed it (§6). `npm run lint` and `npm run typecheck`: clean. `make check DB_PORT=55432` last ran at `42f7de1` (exit 0; `ef40eb1` changes two frontend files and two tests); CI was green on `ef40eb1`. The stack journey (§5) ran at `953d1ea`, before the review fixes.
>
> Differences from the plan: see §2 "Plan versus final code" (the nav and menu read the building passively; view-as needs council in `/me` too; `next` is read through a ref; the menu closes on a route change).
>
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)). Form: full. Tier: 1. Walkthrough variant: B (a council member switches "view as" and follows a nav link).

## 1. What was built and why

The signed-in shell now has a **main navigation** and one **account menu** in the header. The navigation
is built from the same table the route guards read (`frontend/src/app/pages.ts::PAGE_ACCESS`), so a nav item
and the guard on its page can't disagree. The menu holds the user's email, the building name or switcher,
council **"view as"** (Management or Resident, presentation only) and "Log out". The Base44 `Layout.jsx`, the
unused `pages.config.js` and the Base44 Vite plugin are gone (ratchet 354 → 339). The ticket also closed the
P2-06a/P2-06b carry-overs: login and logout are ordered across tabs with a Web Lock, each auth call times out
after 15 s, a late logout keeps `next`, a signed-in user on `/login` is sent on, and a default building
becomes the tab's choice.

## 2. Decisions

### D1. One table drives the guards and the navigation

- **Problem or constraint:** the ticket asks for a nav "built from `frontend/src/app/pages.ts`". A separate list would
  drift from the guards: an item whose page refuses the user, or a page nobody can reach.
- **Chosen:** an optional `label` on each `PAGE_ACCESS` row. `frontend/src/app/pages.ts::navPages` keeps the
  rows with a label whose `roles` and `feature` pass the same `hasRole` and `hasFeature` the guards call,
  against the same `GET /api/buildings/{id}` answer (query key `['b', id, 'building']`).
- **Alternatives rejected:** a separate `NAV_ITEMS` array (two sources); an `audience` field per row for
  "view as" (a third thing to keep in sync with `roles`, and it could put an item in a view its roles don't
  allow).
- **Tradeoffs:** a row whose roles mix `resident` and a staff role would show in both views; none does today.
- **Basis:** ticket; the view derivation is autonomous. **Source:** recorded (PR D1).

### D2. The account menu is a disclosure, not an ARIA `menu`

- **Problem or constraint:** the panel holds a `<select>` and radio buttons; an ARIA `menu` may contain only
  menu items.
- **Chosen:** a button with `aria-expanded` and `aria-controls` that shows a panel (the WAI-ARIA disclosure
  pattern). Enter and Space come from the native button. Escape closes it and returns focus. A mousedown
  outside, a building switch and a route change also close it.
- **Alternatives rejected:** Radix `DropdownMenu` (the wrong role for form controls); controls inline in the
  header (the ticket asks for one menu).
- **Tradeoffs:** no arrow-key navigation (not part of the pattern). See §7 for the open closing cases.
- **Basis:** autonomous. **Source:** recorded (PR D2; route change: review round 2, Claude L4).

### D3. "View as" is per tab, presentation only, and applies only to council members

- **Problem or constraint:** the product scope says the council view "is presentation only and never grants
  permissions".
- **Chosen:** `viewAs` lives in `BuildingProvider`'s context and in `sessionStorage['condo.viewAs']`. Only the
  nav reads it, and only when `frontend/src/app/MainNav.tsx::useCanViewAs` is true. It filters `navPages`'
  output, so it can hide items but never add one. Guards, queries and requests don't read it.
  `frontend/src/app/buildingStorage.ts::clearTabChoices` forgets it at logout, a 401, login and a user change.
- **Alternatives rejected:** `localStorage` (shared across tabs, outlives the session); a view that also
  changes the Dashboard (none is migrated yet).
- **Tradeoffs:** the default is Management, and the toggle changes no page content until a slice migrates
  the Dashboard.
- **Basis:** scope; defaults autonomous. **Source:** recorded (PR D3).

### D4. Login and logout are ordered across tabs with the `condo.auth` Web Lock

- **Problem or constraint (P2-06a follow-up):** tabs share cookies but not the in-module queue, so a slow
  logout in tab A can delete the session tab B just created.
- **Chosen:** `frontend/src/app/authQueue.ts::runAuthCall` keeps the per-tab chain and, inside it, takes
  `navigator.locks.request('condo.auth', …)` when the browser has it. If the lock manager refuses before
  granting (a sandboxed origin), the call runs without it; a call that already ran is not run again.
- **Alternatives rejected:** per-tab only (the race stays); a `BroadcastChannel` protocol (more code, no
  built-in queue).
- **Tradeoffs:** a hung call in one tab delays auth in every tab, bounded by D5. The cross-tab effect is
  proven with a fake lock manager, not two real tabs (§7).
- **Basis:** autonomous; for James to audit. **Source:** recorded (PR D4; refusal fallback: round 1, F4).

### D5. Each auth call times out 15 s after its turn

- **Chosen:** `runAuthCall` hands the call an `AbortSignal` that aborts after `AUTH_TIMEOUT_MS`, timed from
  when the call starts, not from when it was queued, and cleared when it settles.
- **Alternatives rejected:** `AbortSignal.timeout` (test fake timers don't drive it); timing from enqueue (a
  call waiting behind a slow one would time out unsent).
- **Tradeoffs:** a timed-out logout may still have revoked the session; the next 401 sends the user to `/login`.
- **Basis:** autonomous. **Source:** recorded (PR D5).

### D6. A signed-in user on `/login` is sent on after a fresh `/me` through the auth queue

- **Problem or constraint:** the cached `/me` can predate a logout still in flight (Back during a logout).
- **Chosen:** `frontend/src/features/auth/pages/LoginPage.tsx::LoginPage` queues `GET /api/auth/me` with
  `runAuthCall`. On a 200 it seeds `['me']` and replaces the location with `safeNext(next)`. `next` is read
  through a ref when the answer arrives, because Back or Forward between two `/login` URLs keeps the page
  mounted (round 2). The login itself reads the same ref.
- **Alternatives rejected:** redirect on the cached `['me']`; `useQuery(['me'])` on the page (it would not
  wait for a logout).
- **Tradeoffs:** one extra `/me` each time the page opens, and a hung check delays a login submitted at once
  by up to 15 s (round 2, Claude L3).
- **Basis:** autonomous. **Source:** recorded (PR D6; `next` ref: round 2, Codex M1 and Claude L2).

### D7. The effective building is the tab's choice; an invalid choice is forgotten

- **Problem or constraint (P2-06b round 3, Codex Medium):** a default selection was never kept, so a `/me`
  change brought back the picker, or switched back to a reactivated building.
- **Chosen:** an effect in `frontend/src/app/BuildingProvider.tsx::UserBuildingProvider` writes the effective
  `buildingId` into `stored` and storage. The tab now holds what a reload would give.
- **Tradeoffs:** a member suspended and reactivated in their stored building, with several others active,
  gets the picker.
- **Basis:** ticket asked to decide; autonomous. **Source:** recorded (PR D7).

### D8. The Base44 Vite plugin is removed, not only its injections

- **Chosen:** `@base44/vite-plugin` is gone from `frontend/vite.config.js` and `package.json`. Its one needed
  effect, the `@/` alias, moved into `frontend/vite.config.js::alias`. `main.jsx`'s `sandbox:*` `postMessage(…, '*')`
  calls are gone too.
- **Tradeoffs:** ADR-0011 placed the plugin's removal "at pilot readiness"; this is earlier, because no
  legacy page is routed since P2-06a.
- **Basis:** autonomous; for James to audit. **Source:** recorded (PR D8).

### D9. "View as" needs council in both `/me` and the building's answer (review round 1)

- **Problem or constraint:** round 1 (Claude F1 High, Codex M1 Medium): a `/me` refetch that removed
  `council` left the toggle and the council view for up to 30 s, since both read only the building answer.
- **Chosen:** `useCanViewAs` requires `council` in the selected `/me` membership **and** in
  `building.my_roles`. `UserBuildingProvider` also invalidates `['b', id, 'building']` when `/me`'s roles for
  the selected building change, so the nav's and the guards' roles catch up with one request.
- **Alternatives rejected:** filter the nav's roles by `/me` too (a second role source; the nav would
  disagree with the guards until the refetch).
- **Tradeoffs:** between the `/me` answer and the building's, the nav lists what the older roles allow, the
  same pages the guards still let through.
- **Basis:** review finding. **Source:** recorded (PR D9).

### D10. The nav and the menu never load the building themselves (review round 2)

- **Problem or constraint:** round 2 (Codex L1): on `/403`, `/Onboarding` and `/ResidentSetup`, which have
  no building guard, the nav sent `GET /api/buildings/{id}` itself, against AC1d.
- **Chosen:** `useBuilding({ passive: true })` (`enabled: false`) in both. A passive observer sees the
  guards' cached answer and error but never starts a request.
- **Tradeoffs:** with nothing cached on those routes, no nav shows. A `/me` role drop there marks the
  building stale without refetching it (no enabled observer), so the nav keeps the older roles until a
  guarded page mounts (round 2, Claude L1). The API enforces roles either way.
- **Basis:** review finding. **Source:** recorded (PR D10).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Logout reads the location from `CurrentLocation`, a context `AuthProvider` provides | `useLocation` in `useLogout` | the shell has unmounted when a late logout settles on `/login` | autonomous | PR table |
| The panel shows the email; the name is on the button | the name in both | the same text twice confuses queries and screen readers | autonomous | PR table |
| The nav hides on a building 401/404, even over cached data | show cached items | same rule as `BuildingLoaded` (P2-06b round 1) | convention | PR table |
| Labels "My packages", "Package log", "Daily notices", "Maintenance requests" / "Maintenance", "My profile" | Base44's mixed labels | unique per role | autonomous | PR table |
| `clearSelectedBuilding` renamed `clearTabChoices` | a second clear function | one call clears everything a tab chose | autonomous | PR table |
| A switch closes the panel and focuses the account button | focus left on `<body>` | keyboard users lost their place | round 1, F3 | PR table |
| The menu is open only at the location key it was opened at | an effect closing it on a location change | no effect, no extra render | round 2, L4 | PR table |

**Framing changes:** the frame commit `78d679d` sharpened AC1 into per-persona item lists, the feature
filter, the building switch and when no nav shows; AC2 into named deletions, the plugin removal and the
baseline; AC3 into six testable parts (3a–3f). It added AC4 (menu, keyboard), AC5–AC6 (carried items), AC7
(P2-06a follow-ups) and AC8 (lesson). Loosened: none. AC2's "no `base44` reference" is read as code
references (`base44.`, `@base44/`); `frontend/src/app/routeScope.ts` has prose comments naming "Base44" pages
(round 3 nit).

**Plan versus final code:** I compared the PR's Plan with the code at `ef40eb1`.
- The Plan's `MainNav` read the building "from `useBuilding()`"; it now uses `useBuilding({ passive: true })`,
  and so does the menu (D10, round 2). Round 1's `refetchOnMount: false` was replaced.
- The Plan's D3 applied the view when "`my_roles` include `council`"; the final code also needs `council` in
  `/me` (D9, round 1). `useCanViewAs` is exported, and the menu uses it too.
- `LoginPage` reads `next` through a ref in both the session check and the login (round 2).
- The menu also closes on a route change and after a building switch (round 1 F3, round 2 L4).

## 3. How it is implemented

### Overview

- `frontend/src/app/pages.ts::PAGE_ACCESS`: one row per demo page (roles, feature, onboarding, label).
  `RequirePageAccess` turns a row into guards; `navPages` turns the rows into the nav's list.
- `frontend/src/app/MainNav.tsx::MainNav`: `<nav aria-label="Main">` of `NavLink`s, from the cached building
  answer and the tab's view.
- `frontend/src/app/AccountMenu.tsx::AccountMenu`: the disclosure button and panel.
- `frontend/src/app/BuildingProvider.tsx::UserBuildingProvider`: the tab's building, `viewAs`, and the
  "`/me` roles changed → ask the building again" effect.
- `frontend/src/app/authQueue.ts::runAuthCall`: the per-tab queue, the Web Lock and the timeout, used by
  login, logout and the `/login` session check.

### Walkthrough (variant B): a council + resident member switches to "Resident" and opens "My packages"

1. **The page loads.** `/` sits under `RequireActiveMembership`, whose `BuildingLoaded` loads
   `GET /api/buildings/{id}` (P2-06b). `AppShell` renders `AccountMenu` and `MainNav`. `BuildingNav` calls
   `useBuilding({ passive: true })`, so it shows the guards' answer without a request of its own.
2. **The nav list.** `useCanViewAs(building)` is true (council in `/me` and in `my_roles`), and
   `effectiveView` returns the stored view, `management` by default. `navPages` keeps the rows with a label
   that `hasRole` and `hasFeature` allow, then those for a staff role or for everyone: Dashboard, My profile,
   Contacts, Daily notices, Maintenance.
3. **The user opens the menu.** The button sets `openAt` to the current location key. `BuildingChoices` reads
   the building passively (no request) and shows two radio buttons.
4. **The user picks "Resident".** `setViewAs('resident')` writes `sessionStorage['condo.viewAs']` and updates
   the context. `BuildingNav` renders again: `navPages(building, 'resident')` keeps the rows open to everyone
   or to `resident`: Dashboard, My profile, Contacts, My packages, Maintenance requests. No request is sent;
   test `› changes only the nav, making no request (3b, 3c)` asserts the request list is unchanged.
5. **The user follows "My packages".** The location key changes, so `open` is false and the panel closes.
   `/Packages` is guarded by `RequirePageAccess(PAGE_ACCESS.Packages)`: `RequireRole(['resident'])` and
   `RequireFeature('packages')`, on the same cached answer. The view plays no part: in the Resident view the
   member can still open `/ManagementNotices` by URL (test 3d).
6. **States.** No nav shows without a selected building, before the building answer is cached, or when a
   refetch answers 401 or 404. The menu is in the header on the membership screens too (test `› is there with
   Log out on the membership screens`). At phone width the nav's `<ul>` wraps (`flex-wrap`); this was not
   checked in a browser at that width.

### Data model changes

None. The frontend adds `sessionStorage['condo.viewAs']` (`management` | `resident`); any other value reads as
`management` (`frontend/src/app/buildingStorage.ts::readViewAs`).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/app/MainNav.tsx` | new: the nav, `useCanViewAs` | +65 |
| `frontend/src/app/AccountMenu.tsx` | new: the account menu | +131 |
| `frontend/src/app/pages.ts` | `label`, `navPages` | +30 / −11 |
| `frontend/src/app/BuildingProvider.tsx` | stored = effective; `viewAs`; role-change invalidation; `passive` | +35 / −6 |
| `frontend/src/app/buildingStorage.ts` | `condo.viewAs`; `clearTabChoices` | +27 / −13 |
| `frontend/src/app/authQueue.ts` | Web Lock, refusal fallback, timeout | +44 / −4 |
| `frontend/src/app/AuthProvider.tsx` | logout signal, keeps `next`, `CurrentLocation` | +16 / −10 |
| `frontend/src/app/AppShell.tsx` | header = menu; nav below | +6 / −35 |
| `frontend/src/features/auth/pages/LoginPage.tsx` | session check; `next` ref; signals | +22 / −5 |
| `frontend/vite.config.js`, `package.json`, `package-lock.json`, `frontend/src/main.jsx` | plugin and `sandbox:*` gone; `@` alias | +18 / −34 |
| frontend/src/Layout.jsx, frontend/src/pages.config.js | deleted | −892 |
| `frontend/base44-baseline.txt`, `frontend/eslint.config.js` | 354 → 339; dead glob entry | +1 / −2 |
| tests: `nav.test.tsx` (new), `authQueue`, `building`, `shell`, `LoginPage`, `renderApp.tsx` | | +1187 / −32 |
| `CLAUDE.md`, `docs/PILOT_READINESS.md`, the ticket | lesson; stale names; frame | +114 / −14 |

`frontend/src/app/pages.ts::navPages`

```ts
export function navPages(building: Building, view: ViewAs | null): DemoPage[] {
  return (Object.keys(PAGE_ACCESS) as DemoPage[]).filter((page) => {
    const { label, roles, feature } = PAGE_ACCESS[page];
    if (!label || !hasRole(building, roles) || !hasFeature(building, feature)) return false;
    if (view === null || !roles) return true;
    return view === 'resident' ? roles.includes('resident') : roles.some((role) => role !== 'resident');
  });
}
```

- The first test is the guards' own rule (D1); the second only narrows it, which is why "view as" can hide
  but never add (D3).
- Turning the view line off (mutation M4) fails 4 view tests (3b, 3c, 3e, 3f).

`frontend/src/app/MainNav.tsx::useCanViewAs` and `BuildingNav`

```tsx
export function useCanViewAs(building: Building | undefined): boolean {
  const { buildingId, active } = useBuildingContext();
  const membership = active.find((m) => m.building.id === buildingId);
  return !!building && building.my_roles.includes('council') && !!membership?.roles.includes('council');
}
// ...
function BuildingNav() {
  // Passive: on a page without a building guard (/403, onboarding) nothing loads the building, and the nav
  // must not be the one to (review round 2). It shows once the guards' answer is cached.
  const building = useBuilding({ passive: true });
  const { viewAs } = useBuildingContext();
  const canViewAs = useCanViewAs(building.data);
  // Like BuildingLoaded: a 401 or 404 on a refetch means the cached building must not be shown any more.
  const status = building.error instanceof ApiError ? building.error.status : null;
  if (!building.data || status === 401 || status === 404) return null;
```

- Both sources must say council (D9); either dropping it removes the toggle at once.
- `passive` is D10: removing it (mutation S1) makes the nav request the building on `/403`.
- The 401/404 line hides a nav built from a building the user may no longer see (mutation M2).

`frontend/src/app/AccountMenu.tsx::AccountMenu` (open state)

```tsx
  const { key } = useLocation();
  const [openAt, setOpenAt] = useState<string | null>(null);
  const open = openAt === key;
  const setOpen = (value: boolean) => setOpenAt(value ? key : null);
```

- The panel is open only at the location it was opened at, so following a link closes it with no effect
  (round 2, L4; mutation S5). Its known gap: Back to that same history entry restores the key, so the panel
  shows again (round 3, §7).

`frontend/src/app/BuildingProvider.tsx::UserBuildingProvider` (role change) and `useBuilding`

```tsx
  const roles = active.find((m) => m.building.id === buildingId)?.roles.join(',');
  const seen = useRef({ buildingId, roles });
  useEffect(() => {
    const last = seen.current;
    seen.current = { buildingId, roles };
    if (buildingId !== null && last.buildingId === buildingId && last.roles !== roles) {
      void queryClient.invalidateQueries({ queryKey: ['b', buildingId, 'building'] });
    }
  }, [buildingId, roles, queryClient]);
// ...
export function useBuilding({ passive = false }: { passive?: boolean } = {}) {
  const buildingId = useBuildingId();
  return useQuery({
    queryKey: ['b', buildingId, 'building'],
    enabled: !passive,
```

- Only a change of roles in the same building invalidates; a switch is handled by the removal effect above
  it, and an unchanged `/me` refetch sends nothing (test `› does not refetch the building on a /me refetch
  whose roles did not change`). Mutation R2 fails the 3f-via-`/me` test.

`frontend/src/app/authQueue.ts::runAuthCall` (the lock)

```ts
  const locked = async () => {
    let started = false;
    try {
      // ...
      return await (locks!.request(LOCK, () => {
        started = true;
        return timed();
      }) as Promise<T>);
    } catch (error) {
      // A lock manager that refuses (a sandboxed or opaque origin) must not stop every login and logout:
      // run the call without it, as without navigator.locks (review round 1, F4). A call that ran fails as is.
      if (started) throw error;
      return timed();
    }
  };
  const result = tail.then(() => (locks ? locked() : timed()));
  tail = result.catch(() => undefined);
  return result;
```

- `tail` keeps the per-tab order whatever the previous call's outcome; the lock extends it to every tab (D4).
- `started` separates "the lock was refused" from "the call failed": without it, a failed login would be
  sent twice (mutation R6).

`frontend/src/features/auth/pages/LoginPage.tsx::LoginPage` (session check)

```tsx
  const next = useRef<string | null>(null);
  next.current = params.get('next');
  useEffect(() => {
    runAuthCall(async (signal) => {
      if (!mounted.current) return;
      const me = await api.get('/api/auth/me', { signal });
      if (!mounted.current) return;
      queryClient.setQueryData(['me'], me);
      navigate(safeNext(next.current), { replace: true });
    }).catch(() => undefined);
  }, [navigate, queryClient]);
```

- Queued, so a logout still in flight answers first (D6). The two `mounted` checks skip a form that is gone
  (mutations M5, R7). `next.current` is the URL's value when `/me` answers (mutation S3); `onSubmit` ends with
  the same `navigate(safeNext(next.current), …)` (mutation S4). A 401 here goes to `AuthProvider`.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A resident sees staff items | `navPages` uses the guards' `hasRole`/`hasFeature` | `nav.test.tsx › shows a resident only the resident items, each linking to its page (1a)` and the persona `it.each` |
| The nav sends its own building request | passive observer | `› makes no request of its own …(1d)`; `› the nav requests nothing on the session-only route %s (1d)` ×3 |
| Nav built from a building the user lost | hidden on a 401/404 refetch | `› hides the nav when a building refetch answers 404 over cached data (1d)`, `› … 401 by itself …` |
| Switching building leaves the old items | nav follows `buildingId` | `› follows a building switch: Maple resident items, then Birch security items (1c)` |
| "View as" grants a page | guards ignore it | `› keeps the guards: a page the real roles allow opens by URL in either view (3d)` |
| "View as" shows an item the roles don't allow | view only narrows | `› never shows a council-only member an item their roles do not allow (3c)` |
| A stored view applies to a non-council member | `useCanViewAs` false → no view | `› shows no toggle to a member without council, and ignores a stored view for them (3a)` |
| The view outlives the user | `clearTabChoices` | `› forgets the view at logout (3e)`, `› … at login`, `› … on a 401 reset`, `› … when /me answers for another user (3e)` |
| `/me` drops council, the building answer still has it | both sources required; building invalidated | `› drops the toggle and shows the full nav when only a /me refetch removes council (3f)` |
| A building refetch drops council | same | `› drops the toggle and shows the full nav when a refetch removes council (3f)` |
| Menu keyboard and closing | Escape + focus; outside; switch; route change | `› opens a panel …closes on Escape with focus back`, `› closes on a click outside …`, `› closes after switching building`, `› closes when the route changes …` |
| Another tab's logout deletes this login | Web Lock | `authQueue.test.tsx › runs each call inside the lock, waits for another tab holding it, and a failure releases it` (fake lock manager) |
| A refusing lock manager blocks all logins | fallback when not started | `› still runs the call when navigator.locks.request rejects before granting the lock`, `› does not run the call twice …` |
| A hung auth call holds the queue | 15 s abort | `› gives up a hung logout …`, `› gives up a hung login …` |
| A late logout drops `next` | no navigate on a login path | `shell.test.tsx › leaves /login?next=… as it is when the logout settles there` |
| A signed-in user sees the login form | session check | `shell.test.tsx › a signed-in user on /login` (7 tests) |
| Back during the check or the login uses the old `next` | ref read at answer time | `› uses the next of the URL when /me answers …`, `› goes to the next of the URL when the login answers …` |
| A default building is lost on a `/me` change | stored = effective | `building.test.tsx › keeps the only active building when /me then adds another (5a)`, 5b, 5c |
| Back reopens the menu; a `/me`-driven switch leaves it open | not handled | **No test** (open Lows, §7) |
| Space opens the menu | native `<button>` | **No automated test**; Enter was checked in the stack run |

Acceptance criteria → tests:
- AC1: `nav.test.tsx › navigation from the page table (criterion 1)` (11 tests) and `› review round 2 (Codex L1)`.
- AC2: `npm run lint` and the ESLint fence, `shellImports.test.ts`, `Base44 references under frontend/src: 339 (baseline: 339)`, build.
- AC3: `› council "view as" (criterion 3)` (9 tests) and `› review round 1`.
- AC4: `› header account menu (criterion 4)` (6 tests).
- AC5: `building.test.tsx › a default selection is the tab’s choice …` (3 tests).
- AC6: `› regression tests carried from P2-06b review round 3` (3 tests).
- AC7a/b: `authQueue.test.tsx › across tabs …`, `› login and logout time out`, `› a lock manager that refuses`.
- AC7c/d: `shell.test.tsx › a late logout keeps next`, `› a signed-in user on /login` and the two `next` blocks.
- AC8: `CLAUDE.md` "Lessons learned", first bullet.

**Stack journey** (at `953d1ea`, before the review fixes; Playwright against the dev API, on Vite dev and on
`vite build` + `vite preview`, both on `:5173`, the backend's trusted origin): resident1, council and multi
logged in; the nav matched each persona; council's toggle sent no request and survived a reload; the menu
opened with Enter and closed with Escape; logout cleared the view. All passed. It was not re-run on the
review fixes.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Claude (Sonnet 5.5, high, security pass) | `953d1ea` | BLOCK | F1 High: `/me` dropping council kept the toggle; F2–F6 Low | all fixed in `0c86b96` |
| 1 | Codex (gpt-6.1-sol, high) | `953d1ea` | MERGE | M1 Medium (= F1); L1 Low: menu requested a stale building | fixed in `0c86b96` |
| 2 | Codex | `0c86b96` | MERGE | M1 Medium: session check used the old `next`; L1 Low: nav requested the building on session-only routes | fixed in `42f7de1` |
| 2 | Claude | `42f7de1` | MERGE | L1 Low: stale roles on session-only routes; L2 Low: login used the old `next`; L3 Low: hung check delays login; L4 Low: menu stayed open after a route change; L5: stale PR text | L2, L4 fixed in `ef40eb1`; L1, L3 accepted; L5 fixed in the PR |
| 3 | Claude | `ef40eb1` | MERGE | 4 Low: Back reopens the menu; `/me`-driven switch leaves it open; view-as shown during a 401/404; `mousedown` only | open (§7) |
| 3 | Codex | `ef40eb1` | MERGE | 2 Low: the first two above | open (§7) |

The findings that changed the code:
- **F1 / Codex M1 (round 1):** a council + resident member in the Management view; a `/me` refetch removes
  council; two radio buttons stayed and the nav kept "Daily notices" and "Maintenance" until the building
  went stale (30 s). Fixed by D9. Codex's proof, ported as `› drops the toggle and shows the full nav when only
  a /me refetch removes council (3f)`, failed and now passes.
- **F2 / Codex L1 (round 1) and Codex L1 (round 2):** opening the menu on a stale building answer sent a
  request; then the nav itself requested the building on `/403`. Fixed by D10. Tests `› opening the menu on a
  stale building answer makes no request` and the three session-only-route tests failed, now pass.
- **F3:** after a building switch, focus fell to `<body>`. The switch now focuses the account button
  (`› returns focus to the account button after switching building`).
- **F4:** a lock manager that rejects (`SecurityError`) made every login fail. Fixed in D4's fallback
  (`› a lock manager that refuses`, 2 tests).
- **Codex M1 (round 2) and Claude L2:** open `/login?next=/Maintenance`, go Back to `/login?next=/Packages`
  while `/me` (or the login) is pending: the answer landed on Maintenance. Fixed by the `next` ref (D6).
- **Claude L4 (round 2):** following a nav link with the keyboard left the panel open on the new page. Fixed
  by keying the open state to the location.

Mutation probes, each applied to committed code with the whole suite run and the file restored with
`git checkout`. M1–M8 on the feature, R1–R7 on round 1's fixes, S1–S5 on round 2's: every one failed at
least one test (the full table is in the PR body).

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **Two real tabs racing on the Web Lock.** The test uses a fake lock manager with first-in-first-out
  ordering; the stack run only showed that Chromium exposes `navigator.locks` (D4).
- **Space opening the menu** has no automated test; Enter was checked in the stack run.
- **`make prodlike` (Caddy, CSP)** was not run locally; CI's prod-like smoke job passed on `ef40eb1`.
- **The stack journey** ran at `953d1ea`, before the review fixes.
- **Phone width** was not checked in a browser.

Open Lows from review round 3 (left after the last round, as the playbook says):
- Back to the history entry where the menu was opened shows the panel again: the entry's key equals `openAt`.
- A `/me`-driven change of the selected building (the old one suspended) leaves the panel open with new
  contents.
- During a building 401/404 the nav hides, but the menu still offers "View as" from the cached roles
  (presentation only).
- Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space (`pointerdown`
  would cover it).

Accepted risks:
- On a session-only route, a `/me` role drop leaves the nav on the older building roles until a guarded page
  mounts (D10). The API enforces roles.
- A hung `/login` session check delays a login submitted at once by up to 15 s (D5, D6).
- "View as" changes only the nav until a slice migrates the Dashboard (D3).

Tracking: the round-3 Lows, the real two-tab Web Lock test, the Space-key test and the prod-like run will be
added to the ticket index as follow-ups, and D4, D6, D7, D8, D9, D10 and the nav labels and view derivation
to `docs/HUMAN_INBOX.md` "Decisions to audit", in the bookkeeping commit. Until then they are tracked in the
PR body's Follow-ups and here.

## 8. How to change this safely

- **Add a page to the nav:** add a `label` to its `PAGE_ACCESS` row (and the page to `DEMO_PAGES`). Its
  roles and feature already guard it; `nav.test.tsx`'s persona `it.each` lists will fail until you add the
  item where it belongs, which is the point.
- **Change who may open a page:** change its row's `roles`. The guard and the nav change together. Check the
  view derivation still puts it in the right view (`navPages`' last line).
- **Make "view as" change a page's content:** read `useBuildingContext().viewAs` together with
  `useCanViewAs(building)` in that page. Never send it to the API or use it in a guard: test 3d must stay green.
- **Add another auth call:** route it through `runAuthCall` and pass its `signal` to the request, or it will
  neither wait for a logout nor time out.
- **Touch the menu's open state:** the four round-3 Lows above are its known gaps; their failing proofs are
  described in the PR's round-3 table.

## 9. Must explain, then quiz

**1. Why does council "view as" never change API permissions?**
Because nothing that talks to the API reads it. `viewAs` reaches only `frontend/src/app/MainNav.tsx::BuildingNav`,
through `effectiveView`, and there it only narrows the list `navPages` already filtered by the user's real
roles. The guards (`frontend/src/app/guards.tsx::RequirePageAccess`) read `PAGE_ACCESS` and the building's
`my_roles`, never `viewAs`. The requests go through `frontend/src/api/client.ts` with no view parameter, and the
server decides permissions from the session and the membership's roles (P2-03's tenant context). So the
toggle can hide a link, but the user can still open any page their roles allow by URL, and can't open one
they don't hold (`nav.test.tsx › keeps the guards: a page the real roles allow opens by URL in either view (3d)`).
Even a hand-edited `sessionStorage['condo.viewAs']` is only a preference: `readViewAs` accepts two values,
and it applies only when `useCanViewAs` sees council in both `/me` and the building's answer.

**2. How does one metadata table drive both the route guards and the navigation, and what would drift if
they were separate?**
`frontend/src/app/routes.tsx` creates one route per building page and wraps it in
`RequirePageAccess access={PAGE_ACCESS[page]}`, which becomes `RequireRole` and `RequireFeature` calling
`hasRole` and `hasFeature`. `navPages` walks the same `PAGE_ACCESS` rows and calls the same two functions on
the same cached `GET /api/buildings/{id}` answer, keeping only rows with a `label`. A separate nav list would
drift in two ways: a link the guard refuses (the user clicks and lands on `/403`), or a page that opens but
no link reaches. A role change in one place and not the other is exactly the change a slice ticket makes
("each slice may change its own row"), so the drift would come with the first slice.

**Quiz**

1. A council + resident member is in the Resident view and types `/ManagementNotices` in the address bar.
   What happens, and which code decides?
2. Why does the nav call `useBuilding({ passive: true })` rather than `useBuilding()`, and what does a
   resident see on `/403` straight after signing in?
3. What would break if `runAuthCall` dropped the `started` flag and always fell back to `timed()` in its
   `catch`?
4. What would break if `LoginPage` read `params.get('next')` inside the session check's callback instead of
   `next.current`?
5. How would you extend "view as" so the Dashboard shows resident widgets in the Resident view, without
   letting it grant anything?

<details><summary>Answers</summary>

1. The page opens. `RequirePageAccess` checks `PAGE_ACCESS.ManagementNotices` (staff roles, `notices`
   feature) against `my_roles`, which include `council`. The view only hides the nav link (test 3d).
2. So the nav never sends the request itself; the guards load the building (D10, AC1d). On `/403` with
   nothing cached, there is no nav, because no guard loaded the building there; if the building was already
   loaded, the nav shows (`› still shows the nav on /403 when the building is already loaded`).
3. A call that failed inside the lock (say a login answered 401) would be sent a second time without the
   lock (`› does not run the call twice when it fails inside the lock`; mutation R6). Inferred: a repeated
   login would also count twice against the login rate limit.
4. Back or Forward between two `/login` URLs keeps the page mounted, so the callback would keep the `params`
   of the render that started it and redirect to the old `next` (mutation S3 fails
   `› uses the next of the URL when /me answers …`).
5. In the Dashboard, read `viewAs` from `useBuildingContext()` and apply it only when
   `useCanViewAs(building)` is true, choosing which widgets to render. Each widget still fetches through its
   own guarded, role-checked endpoint; the view must not be sent to the API or used in a guard, and test 3d
   stays as the check.

</details>
