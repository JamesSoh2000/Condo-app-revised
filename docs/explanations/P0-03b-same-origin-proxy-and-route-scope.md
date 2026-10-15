# Explanation — P0-03b Same-origin dev proxy and demo route scope

> Code at the head of PR #7 (2026-10-15), built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it. The branch is rebased onto the latest `main`. Snapshot: if the code changes later, write a new explanation; lasting decisions live in ADRs. Form: full (Tier 2). Walkthrough variant: B (UI interaction: a user opens pages and the Dashboard, and the page calls `/api`).

## 1. What was built and why

In development the browser now calls the API on the page's own origin: Vite forwards `/api` to FastAPI, so there is no CORS, as in production ([ADR-0003](../adr/0003-same-origin-server-side-sessions.md)). Only the 12 Demo-tier pages of the [scope map](../PRODUCT_SCOPE.md#base44-page--scope-map) are routed, linked or offered as Dashboard views; the rest stay in the repo but show the 404 page ([ADR-0011](../adr/0011-frontend-strangler-typescript.md)). The two Base44 editor helpers that post to any parent window no longer ship in production builds.

## 2. Decisions

| Decision | Alternative rejected | Why | Basis |
|---|---|---|---|
| Allowlist `frontend/src/app/routeScope.ts::DEMO_PAGES`, filtered in `frontend/src/App.jsx::AllPages` | Edit `frontend/src/pages.config.js`; a denylist | The Base44 plugin does not regenerate `pages.config.js` (checked in its `dist`), but the ticket says to filter in `App.jsx` anyway. An allowlist means a new Base44 page is hidden by default | ticket |
| Page matching ignores case (`isDemoPage`, `isDemoPath`) | Exact keys | React Router v6 matches paths case-insensitively, and nav paths are mixed case (`/packages`, `/gameroom`). Exact matching would hide `/packages` (a demo page) from navigation | autonomous |
| Navigation filtered once after `getNavItems()` | Edit each role's item list in `frontend/src/Layout.jsx` | One reviewable line; the role lists are legacy code that the P2-06 auth shell replaces | autonomous |
| Dashboard views and cards that open hidden pages are hidden through the same allowlist (`isDemoViewRole`, `InScope`), not deleted | Delete the Finance option and the cards | A slice brings them back by adding a name to `DEMO_PAGES`, with no hunting through JSX. Added in review round 1 | autonomous |
| `VIEW_ROLE_PAGES` is a `Map` | An object literal | The role comes from `?role=` and localStorage. An object returns inherited members (`constructor`, `__proto__`), which crashed the app. Review round 2 | autonomous |
| `NavigationTracker` and `VisualEditAgent` render only when `import.meta.env.DEV` | Delete them; fix the origin check | Deleting breaks the Base44 editor flow some local work still uses; a correct origin check needs the editor's origin, and the helpers have no job in our production. `import.meta.env.DEV` is the constant `false` in a production build, so the bundler drops both modules | ticket ("disable in production builds") + autonomous |
| Proxy key is the regex `^/api(/|\?|$)` | The plain prefix `/api` | A prefix also forwards `/apifoo` and `/api-docs` to FastAPI. Review round 1, L1 | autonomous |
| Target read with `loadEnv(mode, import.meta.dirname, '')`, fallback with `\|\|` | `process.env.VITE_API_PROXY_TARGET ?? …` (the ticket's text) | `process.env` misses `frontend/.env*` files (review round 1, L3). `\|\|` also treats an empty value as unset; this switch is not mentioned in the PR | autonomous |
| A hidden `mainPage` falls back to the first demo page; `/Contacts` is registered only if in scope | Keep both unconditional | Without the fallback `/` would be blank (L2); without the gate `Contacts` would bypass the allowlist (L4) | autonomous |
| Evidence for AC2–AC4 is a Playwright journey run on the dev stack, transcript in the PR, not a committed test; it stubs the Base44 `User/me` and entity calls | Add Vitest/Playwright now; real Base44 credentials | No frontend test runner exists until P4-09; credentials are a human-only resource | autonomous |

**What an interviewer would ask:** why hiding a route is not a security control (the hidden code still ships; see §7), why the "no preflight" check is weak (a plain GET never preflights; see §5), and why a lookup keyed by user input must not use a plain object.

**Framing changes:** sharpened AC2 (URL stays on the page origin, `X-Request-ID` proves FastAPI answered, the override variable) and AC3 (exact hidden and demo page lists, case-insensitivity, navigation for two roles). Added AC4 (editor helpers dev-only, checked by marker strings in `dist/`), AC5 (allowlist equals the scope map; `pages.config.js` untouched) and AC6 (investigation recorded in the PR). Loosened: none.

## 3. How it is implemented

### Overview

- **Dev proxy** (`frontend/vite.config.js::proxy`): Vite's dev server forwards `/api`, `/api/…` and `/api?…` to `VITE_API_PROXY_TARGET` (default `http://localhost:8000`) with the `Host` header unchanged.
- **Scope module** (`frontend/src/app/routeScope.ts`): the allowlist and three predicates: `isDemoPage(name)`, `isDemoPath(path)`, `isDemoViewRole(role)`.
- **Routing** (`frontend/src/App.jsx`): only allowlisted `pages.config.js` entries become `<Route>`s; anything else hits the catch-all `<Route path="*">`, which renders `frontend/src/lib/PageNotFound.jsx::PageNotFound`.
- **Navigation and Dashboard**: `frontend/src/Layout.jsx` filters nav items and the saved view; `frontend/src/components/RoleSwitcher.jsx::ALL_ROLES` is filtered; `frontend/src/pages/Dashboard.jsx::InScope` wraps cards that link to hidden pages.
- **Editor helpers**: rendered only under `import.meta.env.DEV` in `frontend/src/App.jsx::App`.

### Walkthrough (variant B, adapted: no form, query hook or cache is involved)

1. **The user action.** A security user types `/gameroom` in the address bar. React Router compares it with the registered routes, ignoring case. `Gameroom` was filtered out of `Pages` by `isDemoPage`, so no route matches and `<Route path="*">` renders the 404 page, outside `Layout` (no navigation). A demo path such as `/packages` matches the `Packages` route.
2. **Navigation.** On every page, `Layout` builds the role's items with `getNavItems()` and keeps those whose `path` passes `isDemoPath`: it strips the leading `/`, cuts at `/`, `?` or `#`, and checks the first segment case-insensitively. For security this leaves Dashboard, Package Log, Daily Notices and Contacts (journey transcript).
3. **Dashboard view.** A board user opens `/Dashboard?role=financials` or has `boardActiveViewRole=financials` saved. `Dashboard` reads the URL first, then localStorage, into `requestedViewRole`; `isDemoViewRole('financials')` looks up `Financials`, which is not a demo page, so the view falls back to `resident`. The property-management branch (`canAccessFinancials && urlParams.get('role') === 'financials'`) has the same check, and the final `if (role === 'financials' …)` checks once more. `RoleSwitcher` stops offering "Finance", and `Layout` ignores a saved `financials`. Cards that link to `gameroom`, `speakeasy`, `VisitorVerification`, `BoardOverview` and others render only if `InScope` passes.
4. **API call.** No ticket code calls the API yet (the typed client is P1-07). The proxy is proven by a browser `fetch('/api/health')` from the app page. The browser resolves it to `http://localhost:5173/api/health`: same scheme, host and port as the page, so it is a same-origin request and the browser applies no CORS check. Vite's proxy (the `http-proxy` library) opens its own request to `http://localhost:8000/api/health`, a server-to-server call where CORS does not exist, and streams FastAPI's response back.
5. **Response.** `{"status":"ok"}` with FastAPI's `x-request-id` header (Vite's SPA fallback would return `index.html` with no such header). Re-run for this explanation: `curl -i localhost:5173/api/health` returned `200`, `server: uvicorn` and an `x-request-id`; `curl -i localhost:5173/apifoo` returned `Content-Type: text/html` (not forwarded).
6. **States.** A hidden view falls back to the resident dashboard (board) or the user's own role (PM). An unknown role such as `?role=constructor` or `?role=nonsense` counts as in scope, matches no branch of `Dashboard`, and `Dashboard` returns `null`: the navigation shell renders with an empty main area and no crash (journey checks "no uncaught error" and "the app shell still renders"). That empty view for unknown roles predates this ticket.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/app/routeScope.ts` | new: allowlist and predicates | +48 |
| `frontend/vite.config.js` | `/api` proxy, `loadEnv`, config as a function | +28 −12 |
| `frontend/src/pages/Dashboard.jsx` | `InScope`, view-role fallback, Financials guard | +30 −5 |
| `frontend/src/App.jsx` | filtered `Pages`, `mainPage` fallback, `Contacts` gate, dev-only helpers | +11 −5 |
| `frontend/src/Layout.jsx` | nav filter, saved-view check | +5 −2 |
| `frontend/src/components/RoleSwitcher.jsx` | Finance option filtered | +3 −1 |
| `CLAUDE.md`, `docs/AGENT_MISTAKES_LOG.md` | lesson "test the fix on its neighbours" promoted | +4 |
| `docs/tickets/P0-03b-same-origin-proxy-and-route-scope.md` | framing | +31 −6 |

**Key excerpts**

`frontend/vite.config.js::proxy`

```js
export default defineConfig(({ mode }) => {
  // loadEnv reads frontend/.env* (next to this file) as well as the shell, like the Base44 plugin does.
  const env = loadEnv(mode, import.meta.dirname, '');
  return {
    logLevel: 'error', // Suppress warnings, only show errors
    server: {
      // ...
      proxy: {
        '^/api(/|\\?|$)': {
          target: env.VITE_API_PROXY_TARGET || 'http://localhost:8000',
          changeOrigin: false,
        },
      },
    },
    // ...
```

- A key starting with `^` is a regex to Vite; it is tested against the request URL including the query.
- `changeOrigin: false` keeps the browser's `Host: localhost:5173`, so FastAPI sees the same host the browser used, as it will behind Caddy in production. With `true`, Vite would rewrite `Host` to the target.
- Remove the key and `/api/health` gets Vite's `index.html` (the journey's red run: "got Vite's index.html"). Go back to the plain prefix key `/api` and `/apifoo` reaches FastAPI (round-1 red run).

`frontend/src/app/routeScope.ts::isDemoViewRole`

```ts
const demoPages = new Set<string>(DEMO_PAGES.map((name) => name.toLowerCase()));

export function isDemoPage(name: string): boolean {
  return demoPages.has(name.toLowerCase());
}

const VIEW_ROLE_PAGES: ReadonlyMap<string, string> = new Map([['financials', 'Financials']]);

export function isDemoViewRole(role: string): boolean {
  const page = VIEW_ROLE_PAGES.get(role);
  return page === undefined || isDemoPage(page);
}

export function isDemoPath(path: string): boolean {
  const name = path.replace(/^\//, '').split(/[/?#]/)[0];
  return isDemoPage(name);
}
```

- `DEMO_PAGES` (not shown) lists the 12 Demo-tier names `as const`. Both lookups use a `Set` or `Map`, which hold only what was put in.
- A role that is not a known page-view (`resident`, `security`, `board`, `nonsense`) is in scope: the function hides only views that render a hidden page.
- With `{ financials: 'Financials' }` instead of the `Map`, `?role=constructor` returned `Object`'s constructor function, `name.toLowerCase` threw, and board users got a white screen (round 2, M1; 13 red journey checks).

`frontend/src/App.jsx::AllPages`

```jsx
const { Pages: AllPages, Layout, mainPage } = pagesConfig;
// Only demo-scope pages are routed; the rest render the 404 page (src/app/routeScope.ts).
const Pages = Object.fromEntries(Object.entries(AllPages).filter(([name]) => isDemoPage(name)));
// A hidden mainPage falls back to the first demo page instead of a blank "/".
const mainPageKey = mainPage && isDemoPage(mainPage) ? mainPage : Object.keys(Pages)[0];
// ...
      {isDemoPage('Contacts') && <Route path="/Contacts" element={<LayoutWrapper currentPageName="Contacts"><Contacts /></LayoutWrapper>} />}
      <Route path="*" element={<PageNotFound />} />
// ...
          {import.meta.env.DEV && <NavigationTracker />}
          <AuthenticatedApp />
        </Router>
        <Toaster />
        {import.meta.env.DEV && <VisualEditAgent />}
```

- The route-mapping loop below it is unchanged; it simply sees fewer entries.
- `import.meta.env.DEV` is replaced by `false` at build time, so `false && <X />` is dead code and the minifier drops the import. The marker grep on `dist/` proves it (§5).
- Without the filter every Base44 page is routable again; without the `DEV` guard the production bundle again posts every URL to `window.parent` and accepts unchecked edit messages.

`frontend/src/pages/Dashboard.jsx::requestedViewRole`

```jsx
const InScope = ({ page, children }) => (isDemoPage(page) ? children : null);
// ...
  const requestedViewRole = isAdmin ? (urlParams.get('role') || localStorage.getItem('boardActiveViewRole') || 'resident') : null;
  // Views outside the demo scope (financials) fall back to the resident view.
  const activeViewRole = requestedViewRole && !isDemoViewRole(requestedViewRole) ? 'resident' : requestedViewRole;
// ...
    : (canAccessFinancials && urlParams.get('role') === 'financials' && isDemoViewRole('financials') ? 'financials' : rawRole);
// ...
  if (role === 'financials' && isDemoViewRole('financials')) {
    return <Financials key="dashboard-financials" />;
  }
```

- `Financials` is not in `pages.config.js`, so `/Financials` was always a 404; the only way in was this inline view. That is why the round-1 reviewer called the journey's `/Financials` check vacuous.
- `InScope` wraps nine links or cards (`gameroom`, `speakeasy`, `SecurityReport`, `VisitorVerification`, `security-reports`, `SecurityGameroom`, `SecuritySpeakeasy`, `ManagementSpeakeasy`, `BoardOverview`); the Board Oversight block uses `isDemoPage('BoardOverview')` directly.
- Without the `activeViewRole` fallback a board user with a saved `financials` view still sees Financials, even though the switcher hides the option.

`frontend/src/Layout.jsx::getNavItems().filter`

```jsx
          // A saved view outside the demo scope (e.g. financials) falls back to the default.
          setActiveViewRole(saved && isDemoViewRole(saved) ? saved : defaultRole);
// ...
  // Only demo-scope pages appear in navigation (src/app/routeScope.ts).
  const navItems = getNavItems().filter((item) => isDemoPath(item.path));
```

- The one-line nav filter covers every role's list. The `saved` check keeps `Layout`'s view state in line with `Dashboard`'s.

There is no committed test to excerpt: see §5 and §7.

## 5. Edge cases and tests

All "journey" evidence is the uncommitted Playwright script `journey-p0-03b.js`, run by the implementer and by the round-3 Claude reviewer (81/81 PASS); its transcript is in the PR. No CI job runs it.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Hidden page reached by URL, any case or trailing slash (`/Gameroom`, `/gameroom`, `/Gameroom/`) | Not routed, so 404 | Journey: 9 hidden paths render 404 |
| Demo page in lowercase (`/packages`) | `isDemoPage` lowercases; React Router ignores case | Journey: 10 demo paths render |
| Nav item to a hidden page | `isDemoPath` filter | Journey: nav for security and property management |
| Dashboard card to a hidden page | `InScope` | Journey: links on `/Dashboard` for resident, security, PM and 4 board views |
| Finance view via `?role=`, saved view or role switcher | `isDemoViewRole` in `Dashboard`, `Layout`, `RoleSwitcher` | Journey: 9 checks (PM `?role=`, board `?role=`, board saved view) |
| Role named like an `Object.prototype` member | `Map` lookup returns `undefined` | Journey: `constructor`, `toString`, `__proto__`, `hasOwnProperty`, `valueOf`, `nonsense` |
| `?role=Financials` (other case) | `Map.get` is case-sensitive, so it counts as in scope, but every Financials branch compares with `=== 'financials'`, so nothing renders it | Round-3 Claude probe only (not in the journey) |
| `mainPage` set to a hidden page | Falls back to `Dashboard` (the first demo key) | One manual run with a temporary edit (PR, "L2") |
| `/apifoo`, `/api-docs`, `/apix/health` | Not forwarded (regex) | Journey: 7 proxy boundary paths |
| Override from shell or `.env.local` | `loadEnv` reads both | curl transcript in the PR (418 from a stub server on :8001) |
| CORS preflight | Same-origin requests never preflight | Journey: no `OPTIONS` for a GET. Weak, because a plain GET is a "simple request" that never preflights, even cross-origin. Re-run for this explanation with a JSON `POST` carrying `X-Requested-With: fetch` (which would preflight cross-origin): one `POST http://localhost:5173/api/health`, no `OPTIONS`, FastAPI answered 405 with an `x-request-id` |

**Acceptance criteria → evidence**

- AC2: journey (4 checks plus 7 boundary checks) and the curl override transcript. Re-checked here with curl and the POST probe above.
- AC3: journey (hidden and demo paths, nav for 2 roles, Dashboard links, Finance view, prototype keys).
- AC4: marker grep on a production build. Re-run for this explanation (build into a scratch folder): `app_changed_url`, `visual-edit-agent-ready`, `toggle-visual-edit-mode` in 0 files; `log-user-in-app` in 1 (the SDK's endpoint string). Dev part: journey sees both modules load.
- AC5: a one-off script in the PR (12 = 12, all registered, `pages.config.js` unchanged). Not committed.
- AC6: the investigation table in the PR body.

## 6. Review log

| Round | Reviewer | Verdict | Findings | Outcome |
|---|---|---|---|---|
| 1 (`55e7ea4`) | Codex `gpt-6-astra` | MERGE | Medium: Financials still reachable inline (`?role=financials`, Finance switch). Medium: Dashboard cards link to hidden pages | Fixed in `e39a4c4` (`isDemoViewRole`, `InScope`) |
| 1 (`55e7ea4`) | fresh Claude | BLOCK | High: same Financials leak; journey's `/Financials` check vacuous. Medium: AC6 missed the SDK's framed `postMessage` of all API traffic and `app-params` URL overrides. Low: `/api` matched `/apifoo`; `.env` override ignored; hidden `mainPage` gave a blank `/`; `/Contacts` ungated | All fixed in `e39a4c4`; AC6 table corrected, SDK risk moved to a follow-up (P1-08) |
| 2 (`e39a4c4`) | fresh Claude | MERGE | Medium: object-literal lookup crashes on `constructor`/`__proto__` (a regression from round 1). Low: the resident link check ran on the `/ResidentSetup` redirect | Fixed in `e66bad3` (`Map`; journey asserts the URL first, +30 checks) |
| 3 (`e66bad3`) | Codex `gpt-6-astra` | MERGE | none (lint, typecheck, build, 54 inline Node assertions, bundle markers; could not run the browser journey) | — |
| 3 (`e66bad3`) | fresh Claude | MERGE | none; one cosmetic note (stale `?role=financials` plus a saved `security` view shows the resident dashboard while the switcher says Security) | Moved to follow-ups |

## 7. Not verified

- **No committed test.** Every AC2/AC3 check and the AC4 dev check live in an uncommitted journey script and a transcript; the AC4 bundle grep and the AC5 comparison are one-off scripts. CI re-runs none of them, so a new Dashboard card linking to a hidden page, a re-added Finance route or a broken proxy key would merge unnoticed until P4-09 commits the journey. For this explanation I re-ran the bundle grep, curl probes and one browser POST, not the 81-check journey.
- **Hiding is not a security boundary.** Every hidden page (and `Financials`, imported by `Dashboard`) is still in the production bundle; `pages.config.js` imports them all. Anyone can read that code. Data protection must come from the API, which no hidden page uses.
- **The Base44 SDK still ships.** When the app is framed it posts every API request and response to `window.parent` with target `'*'` (`api-request-start` is in 1 file of the build re-run here), it sends analytics where Base44 is configured, and `frontend/src/lib/app-params.js` takes `server_url` and `access_token` from the URL. The mitigation, a `frame-ancestors 'none'` CSP, is P1-08 and has not landed.
- **Dev mode keeps the unchecked handler.** `frontend/src/lib/VisualEditAgent.jsx::handleMessage` still runs under `npm run dev`; a site the developer visits could frame `localhost:5173` and drive it.
- **Other paths to hidden pages** were swept by reviewers but not tested: `frontend/src/components/NotificationCenter.jsx` navigates to `createPageUrl(n.link)` from notification data, which may name a hidden page (it would show the 404 page, not leak). `Layout` still polls Base44 for gameroom notifications and move requests for security users, for nav badges that are now hidden.
- **The PR's AC6 investigation** (what the Base44 vite plugin injects, and when) is the implementer's reading of the plugin's `dist`; this explanation did not re-check it.
- **CORS is still on** in `backend/app/main.py::CORSMiddleware` (curl above shows `access-control-allow-origin`); removing it is a follow-up for lane A.
- `frontend/package.json::"vite"` allows `^6.1.0`, but `import.meta.dirname` in the config relies on the locked 6.3.6 (PR follow-up). The `||` fallback (an empty variable means the default) is undocumented in the PR.

## 8. How to change this safely

- **Bring a page into the demo** (a slice): add its `pages.config.js` key to `frontend/src/app/routeScope.ts::DEMO_PAGES` and move it to the Demo tier in `docs/PRODUCT_SCOPE.md` in the same PR (AC5 says they must stay equal). Its route, nav item and any `InScope` card then appear with no other edit. For Financials, the Finance switcher option and inline view come back too.
- **Add a Dashboard view that renders a page inline:** add `['view', 'Page']` to `VIEW_ROLE_PAGES`; keep it a `Map`.
- **Add a Dashboard card or nav item:** if it targets a non-demo page, wrap it in `InScope` (nav items are filtered automatically).
- **Change the proxy:** keep the anchored regex and `changeOrigin: false`; re-run `curl -i localhost:5173/api/health` (expect `x-request-id`) and `curl -i localhost:5173/apifoo` (expect HTML).
- What tells you that you broke something: today only re-running the journey and `npm run build` plus the marker grep. Lint, typecheck, the fence self-test and the Base44 ratchet in CI do not cover this behaviour.

## 9. Must explain, then quiz

**1. How does the Vite proxy make the API same-origin, and why does that remove CORS?** An origin is scheme + host + port. The page is served from `http://localhost:5173`, and `fetch('/api/health')` resolves to the same origin, so the browser treats it as a same-origin request: CORS rules, which apply only to cross-origin requests, never run, so there is no preflight, no `Access-Control-*` header to send, and cookies count as first-party. The browser also sends `Sec-Fetch-Site: same-origin`, which ADR-0003's CSRF middleware (added in P2-01) will accept. The cross-origin hop (5173 → 8000) happens inside Vite (`frontend/vite.config.js::proxy`), server to server, where CORS does not apply. Production does the same with Caddy in front of both.

**2. Why hide out-of-scope routes instead of deleting the pages?** ADR-0011's strangler migration rewrites the app slice by slice; the hidden pages are the reference for later slices (amenities, moves, visitors, reports are pilot options). Hiding keeps the migration focused and the diff small, and restoring a page is one line in `frontend/src/app/routeScope.ts::DEMO_PAGES`. Deleting would throw away working code and fight Base44's `pages.config.js` convention.

**3. What can a page that frames the app do through an unchecked `postMessage` handler?** `frontend/src/lib/VisualEditAgent.jsx::handleMessage` accepts messages from any window because the `event.origin` check is commented out. An attacker's page that loads the app in an `<iframe>` (with the victim logged in) can send `toggle-visual-edit-mode`, `update-content` (rewrite visible text, such as a phone number or instructions), `update-classes` (hide or restyle elements) and `refresh-page`. The agent posts selected elements' data and positions back to `'*'`, so the framer can also read page text, and `frontend/src/lib/NavigationTracker.jsx::app_changed_url` reports every URL. This ticket stops shipping both in production; the SDK's own framed messages still need P1-08's `frame-ancestors`.

**Quiz**

1. A board user has `boardActiveViewRole=financials` in localStorage and opens `/Profile`. Which code keeps the Finance view out of reach there, and which keeps it out on `/Dashboard`?
2. The journey checks "no `OPTIONS` request" for `fetch('/api/health')`. Why does that check prove little, and what is the real proof of AC2?
3. Why did `?role=constructor` crash the app in round 2 even though `constructor` is not a role anyone uses?
4. What would break if we removed `isDemoViewRole` from `Dashboard`'s `activeViewRole` line but kept it in `RoleSwitcher` and `Layout`?
5. How would you extend this to bring the Gameroom amenity into the demo?

<details><summary>Answers</summary>

1. On `/Profile`, `Layout` ignores the saved value (`isDemoViewRole(saved)` is false, so it uses the default role) and `RoleSwitcher` drops the Finance option. On `/Dashboard`, `Dashboard` reads localStorage itself, so its own `activeViewRole` fallback to `resident` and the guard before `<Financials />` are what stop it.
2. A GET with no custom headers is a "simple request": browsers never preflight it, even cross-origin, so the check would pass either way. The real proof is that the response URL has the page's origin and carries FastAPI's `x-request-id`. A non-simple request (JSON POST with a custom header) also goes through without `OPTIONS`, as re-checked for this explanation.
3. The lookup was an object literal, and `obj['constructor']` returns the inherited `Object` function, not `undefined`. `isDemoPage` then called `.toLowerCase()` on a function and threw during render. A `Map` holds only its own entries.
4. For a board user with a saved `financials` view (or `?role=financials`), `role` would be `financials`. The final guard still checks `isDemoViewRole('financials')`, so Financials would not render, but no other branch matches, so `Dashboard` returns `null`: an empty main area instead of the resident dashboard. The journey would probably not notice: its "Financials does not render" check passes, and its "renders something" check only measures body text, which the navigation alone supplies. Remove the final guard too and Financials renders again.
5. Add `Gameroom`, `SecurityGameroom` (and later `Speakeasy`, `SecuritySpeakeasy`, `ManagementSpeakeasy`) to `DEMO_PAGES` and move them to the Demo tier in `docs/PRODUCT_SCOPE.md`. Routes, nav items (`/gameroom`, "Gameroom Ops") and the `InScope` cards reappear automatically. Update the journey's hidden and demo lists, and re-run it plus the AC5 comparison.

</details>
