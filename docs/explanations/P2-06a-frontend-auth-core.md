# Explanation — P2-06a Frontend auth core: login, logout, session guard and the new shell

> **PR:** #62 · **Source revision:** `ac2699f`. This is the pre-merge PR head this explanation was written from and checked against.
> **Reviewed:** the final review round (4) reviewed this commit.
> **Merge commit:** not known when this was written; after the merge, `gh pr view 62 --json mergeCommit` gives it.
>
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it before merge. Round 4 was allowed by James after a block (inbox B-3). This describes the PR's changes at the source revision. It does not describe commits after it (bookkeeping) or the squash merge, and a rebase after it gives the same changes new SHAs. It is a snapshot: before the merge it is edited to match the PR head; once merged, later changes get a new explanation and this one is not updated. Lasting decisions live in ADRs.
>
> **Reality check:** at `ac2699f` I re-read from disk:
> - `git diff origin/main...HEAD` (39 files)
> - in full: `frontend/src/app/{authQueue.ts,AuthProvider.tsx,guards.tsx,safeNext.ts,AppShell.tsx,routes.tsx,App.tsx}`, `frontend/src/features/auth/pages/LoginPage.tsx`, the changed parts of `frontend/src/api/{client,errors}.ts`
> - the assertions of the tests named in §5, including all of `frontend/src/app/authQueue.test.tsx`
> - the PR #62 description, with review rounds 1–4 and the decision on inbox B-3
>
> Ran `cd frontend && npx vitest run`: `Test Files 8 passed (8)`, `Tests 157 passed (157)`. Ran `npm run lint`, `npm run typecheck`, `bash scripts/check-eslint-fence.sh` and `bash scripts/base44-count.sh` (354/354): all clean. Not run at this revision: `make check`'s backend half and any stack run (Docker unavailable since the session began its review rounds). The backend is unchanged on this branch, and CI ran it green on `ac2699f`. The browser journey in §3 ran at `12d5c86`, before the review rounds.
>
> Differences from the plan: the auth queue (`authQueue.ts`) was not in the plan; review rounds 2–4 added it (§2 D9). The plan's Base44 helper deletions grew by five files (§2).
>
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)). Form: full. Tier: 1. Walkthrough variant: B (a user signs in).

## 1. What was built and why

The SPA now boots from a new TypeScript shell, `frontend/src/app/App.tsx::App`, that talks only to the new auth API. It has a login page, a "Log out" button, a `RequireAuth` guard that waits for `GET /api/auth/me`, and a listener that turns any 401 into "clear everything and go to login". The legacy demo pages render a "Being migrated" placeholder, so the production bundle contains no Base44 code at all, and the Base44 ratchet drops from 361 to 354.

P2-06 was split while framing (size). The building picker, the membership/role/feature guards, the 403 page and the navigation are P2-06b.

Two decisions matter most:
- **Every login and logout call runs through one queue** (D9). Without it, a late response could leave the browser signed in as nobody, or as the wrong person. This took three review rounds to get right.
- **The login call's own 401 is not a lost session** (D1).

## 2. Decisions

Source for all blocks below: recorded in the PR #62 description ("Decisions and alternatives", D1–D9), unless marked otherwise.

### D1. The 401 exclusion is by request, not by page

- **Problem or constraint:** the client fires `auth:unauthenticated` on every 401 (P1-07), and a wrong password is a 401 `invalid_credentials` (P2-01b). Treating that as a lost session would clear the cache and redirect on every typo.
- **Chosen:** the event now carries the failing request's `{ method, path }`. `AuthProvider` ignores `POST /api/auth/login`. On a login path it clears the cache but doesn't navigate, so `?next=` survives.
- **Alternatives rejected:**
  - Ignore every 401 while on `/login`. The page could make other calls later, and those 401s should still reset.
  - Have the login page unsubscribe the listener. That couples the page to the provider.
- **Tradeoffs and accepted limitations:** the match is the exact path string, so a second login endpoint would need adding.
- **Basis:** P1-07 carry (either approach allowed); autonomous.

### D2. `next` is followed only if it is a same-origin path, and never a login path

- **Problem or constraint:** `next` comes from the URL, so a crafted link could send someone who just signed in to another site (an open redirect).
- **Chosen:** `frontend/src/app/safeNext.ts::safeNext` accepts only a value that:
  - starts with exactly one `/`;
  - contains no `\` and no control characters;
  - resolves to the same origin with `new URL`;
  - and whose path isn't a login path, per `frontend/src/app/safeNext.ts::isLoginPath` (any case, percent-encoded, trailing slashes; undecodable counts as login).

  Anything else goes to `/`.
- **Alternatives rejected:**
  - A route-name allowlist. It would change with every new route.
  - The `URL` origin check alone. The string checks spell out the browser quirks: `\` read as `/`, tabs and newlines dropped.
- **Tradeoffs:** a path that doesn't exist is still followed, and shows the 404 page.
- **Basis:** autonomous (AC8, the missed case added while framing). Review round 1 extended the login check from `=== '/login'` to `isLoginPath` (§6).

### D3. A failed logout call keeps the user signed in

- **Problem or constraint:** if `POST /api/auth/logout` fails (network or 5xx), the server session and the cookie are still live.
- **Chosen:** stay on the page and show "Could not log out, try again." The cache is cleared and the user sent to `/login` only after a successful response.
- **Alternatives rejected:** clear and redirect anyway. The UI would say "logged out" while the session stays open, which is wrong on a shared computer.
- **Tradeoffs:** a user who is offline can't "log out" locally.
- **Basis:** autonomous.

### D4. A successful login clears the whole query cache

- **Problem or constraint:** a previous user's, or a lost session's, data could still be cached in the tab.
- **Chosen:** `queryClient.clear()` before navigating.
- **Alternatives rejected:** remove only the `['b', …]` keys. A future key could hold user data outside that prefix.
- **Basis:** autonomous.

### D5. `LanguageProvider`, the Base44 editor helpers and `Layout.jsx` leave the shell

- **Problem or constraint:** the shell must never call Base44 (ticket).
  - `LanguageProvider` calls `base44.auth.me()` and Base44 entities on mount.
  - `NavigationTracker` and `VisualEditAgent` post to Base44's editor.
  - `Layout.jsx` loads the user from Base44.
- **Chosen:** the shell imports none of them, and its text is English. `Layout.jsx`, `pages.config.js` and `LanguageContext.jsx` stay in the repo, unimported. P2-06b replaces the nav and deletes `Layout.jsx`.
- **Alternatives rejected:** rewrite `LanguageProvider` without Base44 now. No page in the shell uses translations while the legacy pages are placeholders.
- **Basis:** ticket.

### D6. ADR-0015 revisit: type-aware lint rules and `exhaustive-deps`

- **Problem or constraint:** ADR-0015's "Revisit when" fired (P1-07's `src/api`, and the first `src/app` code).
- **Chosen:**
  - `recommendedTypeChecked` replaces `recommended` for `src/**/*.{ts,tsx}`, and `react-hooks/exhaustive-deps` is an error.
  - `projectService.allowDefaultProject` lists only the virtual stdin files the fence self-test pipes in.
  - The self-test now proves that both new rules fire, and covers `src/api`.
- **Alternatives rejected:**
  - Only `exhaustive-deps`: the async-handler rules matter for TanStack Query code.
  - A separate type-aware lint run: two configs to keep in step.
- **Tradeoffs:** lint needs type information (about 4 s here); a real file at an `allowDefaultProject` path fails loudly as "found in both".
- **Basis:** experiment on the branch: 3 errors found and fixed. ADR-0015 was updated in this PR.

### D7. An empty 2xx other than 204 throws

- **Problem or constraint:** openapi-fetch returns `data: undefined` for an empty 2xx, which `api.get` would hand back under a non-nullable type.
- **Chosen:** `frontend/src/api/client.ts::unwrap` throws `ApiError` with code `http_error` and title "Empty response". The raw `client` is unchanged.
- **Basis:** P1-07 carry.

### D8. The PR was kept whole, over the ~400-line guideline

At the plan it was about 440 lines of added app code; the review fixes (the queue, `isLoginPath`, code-point limits) took it to 500 at `ac2699f` (`git diff --numstat`, tests, docs and README excluded). The login page and the shell can't merge separately without a shell that has no way in. Basis: autonomous.

### D9. One per-tab queue for login and logout; a queued login whose form is gone is dropped

- **Problem or constraint:** a logout response deletes the session cookie, and a login response sets one. The server revokes a session *before* its logout response arrives, so a `/me` refetch can send the user to login while that response is still on its way. Overlapping calls then go wrong in two ways:
  - **Round 2:** the old logout's response deletes the new login's cookie, leaving the browser signed in as nobody.
  - **Round 3:** a form abandoned while waiting still sends its credentials later, leaving the browser signed in as the wrong account.
- **Chosen:**
  - `frontend/src/app/authQueue.ts::runAuthCall` chains every login and logout call, in order, whatever the previous one's outcome.
  - When its turn comes, a queued login checks a `mounted` ref and sends nothing if its form is gone.
  - A login whose form went away mid-request still clears the cache but doesn't navigate.
  - Logout's navigate and cache clear run inside its queued call, so a login queued behind it runs after them.
- **Alternatives rejected:**
  - Track only the latest logout's promise (round 2's `whenLogoutSettled`). A second logout overwrote it, and it didn't stop an abandoned form (round 3).
  - Ignore stale callbacks only. The browser still applies the cookie from a late response (Codex, round 2).
  - Web Locks (`navigator.locks`), which would also serialize across tabs. This was inbox B-3 option B; James chose option A.
- **Tradeoffs and accepted limitations:**
  - It works per tab only, and tabs share cookies.
  - One hung call holds the queue until the browser times it out.
  - A logout that settles while the user is back on `/login?next=…` replaces that entry with bare `/login`.
- **Basis:** review findings (rounds 2–3) and James's decision on inbox B-3 (option A, 2026-10-17).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Email limit "non-empty, ≤ 320 code points", with no format check; password ≤ 128 code points | zod `.email()`; JavaScript `.max()` | The backend takes a plain string on purpose (malformed = unknown, so 401), and Python counts code points (round 1) | `backend/app/auth/schemas.py::LoginIn` | PR, review round 1 |
| 429 message: seconds below 120 s, else whole minutes rounded up. A missing, junk or 0 `Retry-After` gives "Try again later." | always seconds | "900 seconds" is hard to read | autonomous | PR |
| Logout and session loss navigate with `replace` | push | Back would land on a page that redirects again | autonomous | PR |
| "Log out" is a header button, not a menu | dropdown | the menu comes with P2-06b's navigation | frame notes | ticket |
| Local `/favicon.svg`, title "Condo Management", dead `/manifest.json` link removed | leave them for P2-06b | a request to `base44.com` at boot would break AC9 | P1-08 carry | PR |
| Test helper `frontend/src/test/renderApp.tsx::renderApp` uses a `MemoryRouter` | render `App` (BrowserRouter) | tests need a history they control, for Back | convention | PR |

**Framing changes:**
- P2-06 was split into P2-06a/P2-06b. The parent ticket maps every original criterion to a part.
- P2-06a sharpens original AC1 (its first half), AC2, AC5, AC6 and AC7.
- It adds AC3 (429), AC4 (client validation), AC7 (`RequireAuth` states), AC8 (a safe `next`, the missed case), AC10 and AC11 (the P1-07 carries).
- Nothing was loosened.

**Plan versus final code:**
- (1) `authQueue.ts` and the `mounted` check in `LoginPage` are not in the plan. Review rounds 2–4 added them (D9).
- (2) The plan deleted only `App.jsx` and `AuthContext.jsx`. The code also deletes five files: two imported the deleted `AuthContext`, and three were used only by the old `App.jsx`. This is noted below the Plan in the PR.
- (3) `isLoginPath` and the code-point limits came from review round 1.

## 3. How it is implemented

### Overview

- `frontend/src/main.jsx` renders `App`. That is `QueryClientProvider` → `BrowserRouter` → `AuthProvider` → `AppRoutes`.
- `frontend/src/app/routes.tsx::AppRoutes`:
  - `/login` → `LoginPage`;
  - a layout route wrapping `RequireAuth` + `AppShell`, with `/` (home placeholder) and one "Being migrated" route per `DEMO_PAGES` entry;
  - `*` → 404.
- `frontend/src/app/AuthProvider.tsx::useMe` is the `['me']` query. `AuthProvider` installs the 401 listener. `useLogout` logs out through the queue.
- `frontend/src/app/authQueue.ts::runAuthCall` runs login and logout calls one at a time.

### Walkthrough (variant B): a signed-out user opens `/Packages?tab=2` and signs in

1. **Guard.** `RequireAuth` calls `useMe()`, which sends `GET /api/auth/me` with React Query's `signal`. While that is pending, it renders only `LoadingScreen`. The answer is 401 (`ApiError`, status 401), so it renders `<Navigate to="/login?next=%2FPackages%3Ftab%3D2" replace />` via `loginPath`. The same 401 also reaches the listener, which clears the cache; the user is already heading to login.
2. **Form and validation.** `LoginPage` uses react-hook-form with the zod schema.
   - The email is trimmed, must be non-empty and at most 320 code points. The password is untrimmed, non-empty and at most 128 code points.
   - An invalid field gets `aria-invalid` and an `aria-describedby` error, and receives focus; no request is sent.
   - The server alone checks whether the credentials are right.
3. **Queue.** `onSubmit` calls `runAuthCall`. If a logout is still in flight, the login waits behind it. When its turn comes, it returns `false` without a request if the form has unmounted.
4. **API call.** It sends `api.post('/api/auth/login', { body })` (operation `auth_login`) with `X-Requested-With: fetch` from the client middleware. The answer is 204 with the session cookie.
5. **Response handling.**
   - On success: `queryClient.clear()`, then `navigate(safeNext(next), { replace: true })`. Here that is `/Packages?tab=2`.
   - 401: "Email or password is incorrect." The listener ignores this 401 (D1).
   - 429: a message built from `ApiError.retryAfter`.
   - Anything else: "Could not sign in. Try again."
   - Each failure empties the password field, and the summary (`role="alert"`) receives focus.
6. **Cache.** The cache is now empty, so `RequireAuth` fetches `/me` again. It gets 200 and renders `AppShell` (the header shows `me.user.full_name`) with the `BeingMigrated` placeholder.
7. **Later states.**
   - Another call answers 401 (for example after logout-all elsewhere): the listener clears the cache and goes to `/login?next=…`.
   - "Log out": the logout runs through the queue. After a 204 it goes to `/login` and clears; on failure it shows an alert and stays.

The browser journey from the PR (Playwright on the dev stack at `12d5c86`, before the review rounds; run as `resident2` because three earlier runs had used up `resident1`'s per-email login limit) shows steps 1–7 against the real API:

```text
## 1. Signed out, open /Packages?tab=2       url: /login?next=%2FPackages%3Ftab%3D2   api: GET /api/auth/me -> 401
## 2. Wrong password                         alert: "Email or password is incorrect.", focused: true, password field: ""
## 3. Right password (resident2)             url: /Packages?tab=2   api: POST /api/auth/login -> 204 | GET /api/auth/me -> 200
## 5. Browser Back after logout              after Back: /Packages?tab=2, "Jordan Patel" visible: false → /login?next=…
## 7. After logout-all from another session  api: GET /api/auth/me -> 401 → url: /login?next=%2FPackages%3Ftab%3D2
## 9. Too many attempts                      alert: "Too many sign-in attempts. Try again in 6 minutes.", focused: true
## Whole run: 132 requests; none cross-origin; 0 /api/buildings/ calls
```

### Data model changes

None.

## 4. The code

**Files changed** (`git diff --stat origin/main...HEAD`; tickets, ADR and README omitted)

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/auth/pages/LoginPage.tsx` | new: login form, queue, messages | +153 |
| `frontend/src/app/AuthProvider.tsx` | new: `useMe`, `useLogout`, the 401 listener | +70 |
| `frontend/src/app/screens.tsx` | new: loading, 404, placeholders | +50 |
| `frontend/src/app/safeNext.ts` | new: `isLoginPath`, `safeNext`, `loginPath` | +33 |
| `frontend/src/app/{App,AppShell,guards,routes}.tsx` | new: providers, header, `RequireAuth`, routes | +122 |
| `frontend/src/app/authQueue.ts` | new: `runAuthCall` | +13 |
| `frontend/src/api/{client,errors}.ts` | event detail, empty-2xx guard, `retryAfter` | +44 / −8 |
| `frontend/eslint.config.js`, `scripts/check-eslint-fence.sh` | type-aware rules, new self-test cases | +29 / −7 |
| `frontend/index.html`, `frontend/public/favicon.svg`, `frontend/base44-baseline.txt` | local favicon, ratchet 361 → 354 | +4 / −4 |
| deleted under `frontend/src/`: App.jsx, App.css, lib/AuthContext.jsx, lib/NavigationTracker.jsx, lib/VisualEditAgent.jsx, lib/PageNotFound.jsx, components/ProtectedRoute.jsx, components/UserNotRegisteredError.jsx | deleted | −1093 |
| tests: `authQueue`, `shell`, `LoginPage`, `safeNext`, `shellImports`, `client`, `frontend/src/test/renderApp.tsx` | new or extended | +1066 |

`frontend/src/app/authQueue.ts::runAuthCall`

```ts
let tail: Promise<unknown> = Promise.resolve();

export function runAuthCall<T>(call: () => Promise<T>): Promise<T> {
  const result = tail.then(call);
  tail = result.catch(() => undefined);
  return result;
}
```

- **What it does:** each call starts only after the previous one has settled. `tail` swallows failures, so one failed call doesn't stop the next.
- **Why:** D9.
- **What breaks without it:** mutation Q1 (calling `call()` directly) failed 5 tests (run before the fourth `authQueue.test.tsx` test existed).

`frontend/src/features/auth/pages/LoginPage.tsx::LoginPage` (the submit path)

```tsx
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  // ...
  const onSubmit = async (body: LoginForm) => {
    setFailure(null);
    let sent: boolean;
    try {
      // Queued behind any logout still in flight, whose response would delete this login's cookie.
      sent = await runAuthCall(async () => {
        if (!mounted.current) return false;
        await api.post('/api/auth/login', { body });
        return true;
      });
    } catch (error) {
      if (!mounted.current) return;
      resetField('password');
      setFailure({ message: loginErrorMessage(error) });
      return;
    }
    if (!sent) return;
    // Nothing cached before this login (another user's data, a lost session's) may show after it.
    queryClient.clear();
    if (mounted.current) navigate(safeNext(params.get('next')), { replace: true });
  };
```

- **What it does:** queues the login, skips it if the form is gone when its turn comes, and on success clears the cache and follows a safe `next`.
- **Why:** D4, D9, D2.
- **What breaks without each line:**
  - Without the `mounted` check (Q4), an abandoned form's credentials are sent later (2 tests fail).
  - Without the `mounted` guard on `navigate` (Q5), a user who left the page is pulled back to `next` (1 test fails).
  - Without `queryClient.clear()` (M9), data cached before the login survives (1 test fails).

`frontend/src/app/AuthProvider.tsx::AuthProvider` (the 401 listener) and `useLogout`

```tsx
  useEffect(
    () =>
      onUnauthenticated(({ method, path }) => {
        if (method === 'POST' && path === '/api/auth/login') return;
        queryClient.clear();
        const current = locationRef.current;
        if (!isLoginPath(current.pathname)) navigate(loginPath(current), { replace: true });
      }),
    [queryClient, navigate],
  );
  // ... useLogout:
    mutationFn: () =>
      runAuthCall(async () => {
        await api.post('/api/auth/logout');
        navigate('/login', { replace: true });
        queryClient.clear();
      }),
    onMutate: () => setError(false),
    onError: () => setError(true),
```

- **What it does:** any non-login 401 empties the cache and goes to login with `next`. A logout goes through the queue and only clears and navigates after the server answered.
- **Why:** D1, D3, D9.
- **What breaks without each part:**
  - Dropping the login exclusion (M3) clears the cache on a wrong password (2 tests fail).
  - Dropping the listener's `clear()` (M5) leaves building data cached after a session loss (1 test fails).

`frontend/src/app/guards.tsx::RequireAuth`

```tsx
  if (me.data) return children;
  if (me.isPending) return <LoadingScreen />;
  if (me.error instanceof ApiError && me.error.status === 401) {
    return <Navigate to={loginPath(location)} replace />;
  }
  return ( /* "Something went wrong" + Try again → me.refetch() */ );
```

- **What it does:** children render only with `/me` data. Pending shows a loading state, 401 redirects, and other errors show a retry screen.
- **Why:** AC7. A 5xx is not "signed out", and sending the user to login for it would hide an outage.
- **What breaks without each part:**
  - Rendering children while pending (M6) shows protected content before the session is known (5 tests fail).
  - Redirecting on any error (M12) sends users to login during an outage (2 tests fail).

<details><summary>Deeper: <code>safeNext</code> and <code>isLoginPath</code></summary>

`frontend/src/app/safeNext.ts::safeNext`

```ts
export function isLoginPath(pathname: string): boolean {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return decoded.toLowerCase().replace(/\/+$/, '') === '/login';
}

export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//')) return '/';
  if (/[\\\u0000-\u001f\u007f]/.test(next)) return '/';
  const url = new URL(next, 'http://app.invalid');
  if (url.origin !== 'http://app.invalid' || isLoginPath(url.pathname)) return '/';
  return next;
}
```

`new URL` normalises dot segments before the login check, so `/x/../login` is caught. The round-2 reviewer fuzzed 300,000 strings and found no accepted value that left the origin.

</details>

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A wrong password is treated as a lost session | ignored by method and path | `shell.test.tsx` "ignores the 401 of the login call itself (criterion 2)"; `LoginPage.test.tsx` "shows the generic message for a wrong password, focuses it, empties the password and stays" |
| Same message twice doesn't move focus | the state is a new object each time | `LoginPage.test.tsx` "moves focus to the summary again on a second failure" |
| `next=//evil.example` and friends | falls back to `/` | `safeNext.test.ts` "falls back to / for …" (27 inputs); `LoginPage.test.tsx` "ignores an unsafe next (criterion 8)" |
| `next=/login/` or `/%6cogin` | `/` | `LoginPage.test.tsx` "lands on home for a login alias in next=…" |
| Session lost on `/?tab=2` | `next=%2F%3Ftab%3D2` | `shell.test.tsx` "keeps the home page query in next (review round 1)" |
| Back after logout | loading, then `/me` 401, then login | `shell.test.tsx` "calls the API, empties the cache and shows /login; Back renders no authenticated content" |
| Logout fails | stays signed in, alert | `shell.test.tsx` "keeps the user signed in with an error when the call fails with a 500" (and "…network error") |
| `/me` 5xx or network error | retry screen, not login | `shell.test.tsx` "shows an error screen with Try again for a 500, not the login page" |
| Late logout response after a new login | the login waits for the logout | `shell.test.tsx` "sends the login only after the old logout settles, and the old logout does not undo it"; "also waits for a logout that fails, then logs in" |
| Second logout after Back/Forward | waits for the first; login waits for both | `authQueue.test.tsx` "waits for every outstanding logout after Back/Forward remounts the shell" |
| Abandoned form while queued | no credentials sent | `authQueue.test.tsx` "does not submit credentials from an unmounted login form when logout settles"; "keeps the latest account when a remounted login form replaces a waiting one" |
| Form gone during the request | signed in, no navigation | `authQueue.test.tsx` "does not pull the user back to next when the form went away while its login was in flight" |
| Emoji password within the server limit | sent | `LoginPage.test.tsx` "sends a password of 128 code points that is longer in UTF-16 (review round 1)" |
| `Retry-After` junk or HTTP-date | `retryAfter: null`, "Try again later." | `client.test.ts` "is null for Retry-After …" (8 cases) |
| A shell file imports Base44 through a legacy file | the import-graph test fails | `shellImports.test.ts` (mutation M1: importing `Layout.jsx` fails 3) |
| A user on an undecodable path gets a 401 | `isLoginPath` counts it as login, so the listener clears but doesn't navigate | No test. Inferred to be harmless: such a path is outside `RequireAuth` (the 404 page) |
| A hung login or logout call | holds the queue | No test (round 4 L1, §7) |

**Acceptance criteria → tests:**
- AC1: `LoginPage.test.tsx` "logs in once and lands on the home placeholder with the user name", "follows a safe next".
- AC2: the wrong-password test above, plus `client.test.ts` "passes the method and path of the request that got the 401".
- AC3: `LoginPage.test.tsx` "says when to retry for a 429 with Retry-After …" (9 cases); `client.test.ts` "ApiError.retryAfter".
- AC4: `LoginPage.test.tsx` "sends nothing and focuses the first invalid field…" and "shows a generic retry message for …".
- AC5: the `shell.test.tsx` "logout" block.
- AC6: `shell.test.tsx` "clears the cache and goes to /login with next when another call answers 401".
- AC7: the `shell.test.tsx` "RequireAuth" block.
- AC8: `safeNext.test.ts`.
- AC9: `shellImports.test.ts`, the ESLint fence, the ratchet and the journey's network log.
- AC10: `client.test.ts` "an empty 2xx other than 204".
- AC11: `shell.test.tsx` "passes React Query’s signal to the /me request (criterion 11)".

Mutation evidence is in the PR: M1–M12 and Q1–Q5, each caught.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Claude (Sonnet 5.5, high, security pass) | `12d5c86` | MERGE | L1 `/login/` passes `safeNext`; L2 UTF-16 password limit | fixed in `ed740ac` (now `d250158` after the rebase) |
| 1 | Codex (`gpt-6.1-sol`, high) | `12d5c86` | MERGE | M1 Unicode passwords refused; M2 login aliases in `next`; L3 home query lost | fixed in the same commit |
| 2 | Claude (new) | `ed740ac` | MERGE | 3 Lows (location ref after paint, signed-in `/login`, double JSON read) | not fixed (§7) |
| 2 | Codex | `ed740ac` | MERGE | M1 a late logout response undoes a newer login | fixed in `8b95c6d` (`whenLogoutSettled`), then replaced in round 4 |
| 3 | Claude (new) | `8b95c6d` | MERGE | M1 a second logout hides the first; L1 a queued login runs after its form is gone; L2 `next` dropped | see below |
| 3 | Codex | `8b95c6d` | **BLOCK** | **High:** an abandoned login replaces a newer session; M: a second logout hides the first | ticket blocked (stop rule 4, inbox B-3) |
| 4 | Claude (new; James: Sonnet only) | `ac2699f` | MERGE | 4 Lows: no timeout, `next` dropped by a late logout, signed-in `/login`, per-tab queue | not fixed (§7) |

**The failures behind the fixes:**

- **Round 1.**
  - `safeNext('/login/')` returned `/login/`, so a correct password led back to the sign-in form. `isLoginPath` now covers case, percent-encoding and trailing slashes; 14 new tests were red before the fix.
  - A 65-emoji password (130 UTF-16 units, 65 code points) passes the backend, but the form refused it. The limits now count code points, and the email limit too (its neighbour).
  - A 401 on `/?tab=2` produced bare `/login`.
- **Round 2.** Logout revokes session A at once, but its response is slow. A `/me` refetch 401s, and the user signs in again as session B. Then A's response arrives: its `Set-Cookie` deletes B's cookie. Codex reproduced this in Chromium. The fix made login wait for the latest logout.
- **Round 3.** Two other ways reached the same state:
  - Back/Forward remounted the shell with the button enabled, and a second logout overwrote the tracked promise.
  - While a logout was pending, form A submitted, then Back, then form B: both logins went out, and A's landing last left the browser signed in as A. Codex reproduced this in Chromium with real HttpOnly cookies.

  The reviewers disagreed on severity (Claude L1, Codex High), so the ticket was blocked. James chose option A with a Sonnet-only round 4.
- **Round 4.** Codex's three proofs became `authQueue.test.tsx`.
  - Test 1 now asserts that the second logout *waits*. Codex's version expected its request to go out while the first was pending, which the queue rightly prevents.
  - Test 3 now asserts that only the newest form's login is sent. It was written to show the bug.
  - A fourth test covers a form gone mid-request; it was added after mutation Q5 survived.
  - These became D9.

## 7. Not verified, accepted risks and follow-ups

Not verified:
- **No `make prodlike` browser run.** Docker became unreachable during the session. CI's "Prod-like stack smoke" builds the SPA behind Caddy and passes, but doesn't render it under the CSP. A static check found that `img-src 'self'` covers `/favicon.svg` and that the shell uses no inline styles.
- **No stack run since `12d5c86`.** The queue, `isLoginPath` and the code-point limits are proven by Vitest only, against stubbed `fetch`. Real HttpOnly cookie ordering was shown only by Codex's Chromium proofs in rounds 2–3 (fake API).
- **The production `baseUrl: ''` path** (`new URL(request.url).pathname` in the 401 event) has no committed test; the journey showed it working.
- **AC9's "only same-origin requests"** rests on the journey and on the built bundle having no `base44` string, not on a committed test.
- **No browser test of focus on the first invalid field** (jsdom only).

Accepted risks and follow-ups (all will be noted in P2-06b's ticket or the inbox in the bookkeeping commit):
- The auth queue is per tab. A slow logout in tab A can delete a session that tab B just created. Fix: Web Locks (inbox B-3 option B, not chosen).
- A hung login or logout holds the queue until the browser times the request out (round 4 L1).
- A logout that settles while the user is back on `/login?next=…` drops `next` (rounds 3 and 4, L2).
- A signed-in user who opens `/login` sees the form.
- The round 2 Lows: the location ref is updated after paint (worst case: a validated `next` naming the previous page), and `assertJsonBody` reads each JSON body twice.
- The Base44 Vite plugin's two dev-only injections and `main.jsx`'s `sandbox:*` messages to `window.parent`. They make no requests and aren't in the production build.
- `Layout.jsx`, `pages.config.js` and `LanguageContext.jsx` are unimported (P2-06b deletes `Layout.jsx`). The shell has no i18n.

## 8. How to change this safely

- **A new login-like endpoint** (for example invitation accept in P4-02): run it through `runAuthCall` if it sets or deletes the session cookie, and add its path to the listener's exclusion if its 401 means "wrong input". `authQueue.test.tsx` and `shell.test.tsx` "session lost" will show breakage.
- **A new route with a `next` round trip:** use `loginPath`/`safeNext`, never build `?next=` by hand. `safeNext.test.ts` covers the inputs.
- **A building-scoped hook (P2-06b):** pass `signal`, key it `['b', buildingId, …]`, and rely on the clears here at login, logout and 401.
- **Anything imported from `App.tsx`:** `shellImports.test.ts` fails if it reaches Base44 through any file.

## 9. Must explain, then quiz

**1. Why are frontend guards "UX only"? Which server mechanism actually protects the data?**
`RequireAuth` runs in the user's browser, and anyone can change or skip that code. It only decides what to *show*. The data is protected on the server: every request carries the session cookie, `get_current_session` (P2-01b) resolves it, or the request gets 401. Building data also goes through `get_tenant_context` (P2-03), which returns 404 for a non-member. A user who bypassed `RequireAuth` would get only 401s. Its job is to avoid flashing protected content (`frontend/src/app/guards.tsx::RequireAuth` renders nothing but `LoadingScreen` until `/me` answers) and to send the user to login.

**2. Why does a failed login's 401 need different handling from every other 401, and what would go wrong without the exception?**
Every other 401 means "your session is gone": the listener in `frontend/src/app/AuthProvider.tsx::AuthProvider` clears the cache and navigates to `/login?next=…`. A login 401 means "wrong password" while the user is already on the login page. Without the exception (mutation M3, 2 tests fail), every typo would clear the whole query cache. And if a login call were ever made from a page that isn't a login path, it would also redirect to `/login`, which is what `shell.test.tsx` "ignores the 401 of the login call itself" checks from `/Packages`. The login page shows its own generic message instead.

**3. Why is `next` validated, and which inputs would turn it into an open redirect?**
Anyone can send a link like `https://our-app/login?next=…`. If the app followed `next` blindly after a real login, the attacker would get a trusted page to bounce users to a look-alike site ("your session expired, sign in again"). Dangerous inputs:
- `//evil.example` (protocol-relative);
- `/\evil.example` (browsers read `\` as `/`);
- `/\t/evil.example` (tabs and newlines are dropped);
- `https://evil.example` and `javascript:…`.

`frontend/src/app/safeNext.ts::safeNext` blocks each one and also refuses login paths, to avoid a dead end.

**Quiz**

1. A user's logout request is slow. Before it answers, they see the login page and sign in again. What exactly would the old logout's response do to the new session without `runAuthCall`, and why can't the frontend just ignore that response?
2. Why does `RequireAuth` render children when `me.data` exists, even if the latest refetch failed?
3. What would break if `useLogout` called `queryClient.clear()` before awaiting `POST /api/auth/logout`?
4. What would break if the `mounted` check were removed from the queued login in `frontend/src/features/auth/pages/LoginPage.tsx::onSubmit`?
5. How would you extend the queue so that two tabs of the same browser can't interleave a logout and a login?

<details><summary>Answers</summary>

1. Its `Set-Cookie` (`max_age=0`) deletes the session cookie, which is now the new session's, and its success handler navigates to `/login` and clears the cache. The browser applies `Set-Cookie` when the response arrives, whatever JavaScript does with it afterwards, so the only fix is not to send the new login until the old logout has settled (D9).
2. React Query keeps the last good data on a failed refetch. A background 5xx shouldn't blank the page. A 401 during a refetch is handled separately by `AuthProvider`'s listener, which clears the cache (so `me.data` disappears) and navigates.
3. If the call then failed, the user would see an empty, broken shell while still signed in (D3). It would also cause a refetch of `/me` that races the logout. Today the clear happens only after a successful response, inside the queued call.
4. A form abandoned while a logout was pending (Back, another page) would still send its credentials once the logout settled. If someone else then signed in on a fresh form, the older login could land last and leave the browser signed in as the first person (round 3 High; mutation Q4 fails 2 tests).
5. Run `runAuthCall`'s body under `navigator.locks.request('auth', () => call())` (Web Locks are shared by all same-origin tabs), keeping the in-module chain as the fallback where `navigator.locks` is missing (jsdom). Test the fallback in Vitest, and the cross-tab case with Playwright in two pages of one browser context.

</details>
