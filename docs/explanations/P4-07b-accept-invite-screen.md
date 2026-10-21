# Explanation — P4-07b Accept-invitation screen

> **PR:** #96 · **Source revision:** `22b170cf18c87129532d612029047fd66cfb390b`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (4, a verification
> round) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 96 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. James chose the round-3 fix (inbox B-7, option A) and the reviewer (Codex `gpt-6.1-sol`, high,
> with no Claude reviewer) in session. This describes the PR's changes at the source revision. Commits after it
> (bookkeeping) and the squash merge are not described here, and a rebase after it gives the same changes new
> SHAs. This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `22b170c` the whole of `AcceptInvitePage.tsx`, the diffs of `AuthProvider.tsx`,
> `routes.tsx`, `LoginPage.tsx`, `ResetPasswordPage.tsx`, `formErrors.ts` and `CLAUDE.md`, the assertions of the
> tests named below, and PR #96's description (plan, deviations, D1–D6, four review rounds). Ran
> `npx vitest run src/features/auth --reporter=verbose`: the 79 P4-07b tests cited here pass; `npx vitest run`:
> 500 passed. `make check DB_PORT=55432` (exit 0) and the browser journey (§5) were run on `22b170c` too, per the
> PR. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

An invitee opens `/invite/<token>` from their email, sees the building, the masked email and the roles, and
clicks "Accept invitation". A new email creates its account on the same page; an existing account is sent
through login and accepted automatically on return; someone signed in as another account can log out without
leaving the page; every bad link shows one friendly screen. This completes demo journeys 1 and 2 in the browser.
The ticket also fixes two items carried from P4-07a (F6: the login page redirected away from the "password
updated" banner; F7: `/reset-password` without one token segment was "Page not found").

The decisions that matter most: the page lets **the accept's own answer pick the next screen** (D1), because it
can't know beforehand whether the email has an account or whether the browser has a session; and, after three
review rounds about one bug family, an accept **rebuilds the signed-in part of the app** through a session
epoch in `AuthProvider` (D5, D6), because emptying the query cache doesn't change what mounted components show.

## 2. Decisions

### D1. The accept's answer picks the screen

- **Problem or constraint:** four starting states (new email; existing account logged out; the same account
  logged in; another account logged in). The public `GET /api/invitations/{token}` deliberately doesn't say
  whether the email has an account, and the page must not call `/me` while logged out: `AuthProvider` turns any
  401 into a redirect to `/login` (ticket, "Carried from P4-07a").
- **Chosen:** "Accept invitation" sends `POST /api/invitations/{token}/accept` with `{}`. 200 → accepted;
  409 `login_required` → "Log in to accept"; 403 `invitation_email_mismatch` → another account; 422 whose
  errors are all `missing` on `full_name`/`password` → the new-account form, whose submit sends the accept again
  with the fields.
- **Alternatives rejected:** the form first with a "Log in instead" link (a signed-in invitee would see a form
  it doesn't need); `/me` first (its 401 redirect).
- **Tradeoffs and accepted limitations:** a new user sends one extra request, counted against the per-IP limit
  (20 per 10 minutes), and clicks once more.
- **Basis:** autonomous; the server checks session and account before anything it writes
  (`backend/app/invitations/service.py::accept_invitation`). **Source:** recorded (PR D1, ticket Frame notes).

### D2. The automatic accept after login comes from router state

- **Problem or constraint:** after logging in, the invite page must accept by itself (ticket), but a link must
  not make a signed-in user accept without a click.
- **Chosen:** the login page navigates to `safeNext(next)` with router state `{signedIn: true}`
  (`frontend/src/features/auth/pages/LoginPage.tsx::SIGNED_IN`); the invite page reads it once, replaces it in
  the history entry, and sends `{}` when the details have loaded.
- **Alternatives rejected:** `?accept=1` in `next` (anyone can write a URL); a sessionStorage marker (state that
  outlives the navigation it belongs to).
- **Tradeoffs:** every post-login navigation carries the state; only this page reads it.
- **Basis:** P4-07a's `passwordUpdated` banner uses router state for the same reason. **Source:** recorded (PR D2).

### D5/D6. Forget the previous user and rebuild the signed-in tree (review rounds 2–3, inbox B-7)

- **Problem or constraint:** after an accept the tab must open the accepted building. But `AuthProvider` clears
  the tab's choices when `/me` names a different user than the one it last saw (P2-06c), and a component that
  stays mounted keeps rendering its last result after its query is removed from the cache.
- **Chosen:** `AuthProvider` keeps the last user in a ref and a session **epoch** in state.
  `useNewSession()` forgets the last user and bumps the epoch; `useSessionEpoch()` reads it; `AppRoutes` keys
  `RequireAuth` (everything signed-in) by it. After a successful accept, and after the mismatch "Log out", the
  page removes the user's queries itself and calls `newSession()`. It never asks `/me` itself.
- **Alternatives rejected:** fetching `/me` in the page before selecting the building (round 1's fix: an identity
  request outside the auth queue that round 2 showed could overwrite a later login, High); resetting the last
  user whenever `['me']` leaves the cache (also fires on garbage collection while the old user's other data is
  cached); `resetQueries` (refetches the old user's building queries in place with the new cookie); inbox
  option C (no sweep once the page is gone: the old user's data stays cached).
- **Tradeoffs and accepted limitations:** a new session rebuilds the whole signed-in tree (one loading screen).
  `useNewSession` would weaken `AuthProvider`'s check if called by code that keeps the old user's data; its doc
  comment limits it. The `key={epoch}` itself is not separately pinned by a test (§7).
- **Basis:** review findings (rounds 1–3); James's answer to B-7 (option A). **Source:** recorded (PR D5, D6).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Keyed per history entry; the state replace keeps the entry's first key (`EntryState`) | `key={location.key}` alone | the replace that drops `signedIn` gives a new key and remounted the page, losing the state it had just read | test result | recorded (PR deviation) |
| Mismatch "Log out" stays on the page | `useLogout` | it navigates to `/login`, losing the invite | autonomous | recorded (PR D4) |
| Select the accepted building for the tab | let `BuildingProvider` choose | a user with other memberships would land on the picker | autonomous | recorded (PR) |
| Roles shown as words (`ROLE_LABELS`) | the enum | no raw codes on screen | ticket | recorded (PR) |
| Name checked for control characters before the trim | after | the P4-05a mistake (`"Nadia\t"` trimmed, not refused) | mistakes log | recorded (PR) |
| `serverFieldErrors` takes per-field messages | a second helper | `string_too_long` on `full_name` would read as the password limit | autonomous | recorded (PR) |
| Promote "a URL change keeps the page mounted" by rewording the `CLAUDE.md` lesson | a new line | `CLAUDE.md` is at its 150-line limit | ticket, playbook | recorded (PR D3) |
| P2-06c's account-menu Lows not fixed | fix them | the menu isn't touched; carried to P4-08 | ticket | recorded (PR) |

**Framing changes:** criteria 1–4, 6 and 9 sharpened P4-07's four; 5, 7, 8 and 10–14 added (the missed case: a
signed-in user of another account). None loosened.

**Plan versus final code:** the plan's success path was `queryClient.clear()`, then select and navigate. Rounds
1–3 replaced it with: remove user queries only, handle the used token's query (R3-2), `newSession()`
(R3-1), clear choices, select, navigate (§6). `AuthProvider` and `AppRoutes` changes were not in the plan; they
come from rounds 2–3. Dropping `signedIn` replaces the state with `{entry}` rather than `null` (deviation
recorded in the PR). Size: 433 added code lines (+60 comment, +28 blank), over the ~400 guide; recorded in the
PR, not split.

## 3. How it is implemented

### Overview

- `frontend/src/features/auth/pages/AcceptInvitePage.tsx::AcceptInvitePage` keys one screen per history entry.
- `frontend/src/features/auth/pages/AcceptInvitePage.tsx::AcceptInviteScreen` loads the details (`useQuery(['invitation', token])`) and holds a
  `stage` (`details`, `form`, `login`, `mismatch`, `member`, `unit`, `invalid`); `accept` and `logout` change it.
- `frontend/src/app/AuthProvider.tsx::useNewSession` and `frontend/src/app/routes.tsx::AppRoutes` rebuild the
  signed-in tree after the page sweeps a user.
- `LoginPage.tsx` adds the post-login state; `routes.tsx` adds `/invite/*` and `/reset-password/*`.

### Walkthrough (variant B): an existing account, logged out

1. **Details.** `/invite/<token>` renders outside `RequireAuth`. The query sends
   `GET /api/invitations/{token}` (operation `invitations_get_public`); a `role="status"` "Loading the
   invitation…" shows until it answers. A 404 renders `InviteInvalid`; another failure the load-error screen with
   "Try again"; success the details with the `<h1>` focused (`PageHeading`).
2. **Accept.** The button's form submit goes through `guarded` (drops a submit while one is in flight, before
   react-hook-form) to `accept({})`, which runs the POST (`invitations_accept`) inside `runAuthCall`, the
   app's one-at-a-time queue for calls that can set or delete the session cookie.
3. **409 `login_required`.** `stageFor` maps it to `login`: "Log in to accept" and a link built by `loginPath`,
   `/login?next=%2Finvite%2F<token>`.
4. **Login.** The login page logs in and navigates to `safeNext(next)` with `{signedIn: true}`.
5. **Return.** A new `AcceptInviteScreen` reads `signedIn` in its `useState` initializer, replaces the entry's
   state with `{entry: <its key>}` (so the keyed page doesn't remount), and the effect guarded by `autoSent`
   sends `accept({})` once the details are loaded.
6. **200.** The page removes every query except invitation details (`userData`), removes or marks stale the
   used token's query, calls `newSession()`, clears the tab's choices, stores `building_id` as the tab's
   building, and replaces the entry with `/`. The shell asks `/me`, starts the new user without the sweep, and
   opens the accepted building's navigation.

The new-email path differs at step 3: a 422 `missing` opens the form (`AccountForm`, zod `schema`); a server 422
on a field is placed by `serverFieldErrors` with this page's messages (`SERVER_MESSAGES`); the submit sends
`{full_name, password}` (the name trimmed, the password as typed, never `confirm`).

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/auth/pages/AcceptInvitePage.tsx` | new page | +436 |
| `frontend/src/features/auth/pages/AcceptInvite.test.tsx` | new tests (72 cases) | +1184 |
| `frontend/src/app/AuthProvider.tsx` | session epoch, `useNewSession`, `useSessionEpoch` | +34 −5 |
| `frontend/src/app/routes.tsx` | invite and fallback routes; `RequireAuth` keyed by the epoch | +11 −3 |
| `frontend/src/features/auth/pages/LoginPage.tsx` | `SignedInState`; F6 | +12 −3 |
| `frontend/src/features/auth/pages/ResetPasswordPage.tsx` | `ResetLinkInvalid` for F7 | +16 −13 |
| `frontend/src/features/auth/formErrors.ts` | per-field messages | +10 −5 |
| `LoginPage.test.tsx`, `PasswordReset.test.tsx` | F6, state, F7 tests (4 + 3) | +46, +18 |
| `CLAUDE.md` | lesson reworded in place | +2 −2 |
| `docs/tickets/P4-07b-frontend-accept-invite.md` | frame | +83 −13 |

**Key excerpts**

`frontend/src/features/auth/pages/AcceptInvitePage.tsx::AcceptInvitePage`

```tsx
export function AcceptInvitePage() {
  const { token = '' } = useParams();
  const location = useLocation();
  return <AcceptInviteScreen key={(location.state as EntryState | null)?.entry ?? location.key} token={token} />;
}
```

- One screen per history entry: Back, or another invite link, keeps a route's component mounted when only the
  URL changes, so without the key an answer for the abandoned entry would act on the new one.
- `entry` covers the page's own `replace` (dropping `signedIn`), which would otherwise remount it. Without
  `entry`, criterion 3's automatic accept never fires (the tests failed that way before it existed).

`frontend/src/features/auth/pages/AcceptInvitePage.tsx::stageFor` and `needsAccount`

```tsx
function stageFor(error: unknown): Stage | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status === 404) return 'invalid';
  if (error.status === 403 && error.code === 'invitation_email_mismatch') return 'mismatch';
  if (error.status !== 409) return null;
  if (error.code === 'login_required') return 'login';
  if (error.code === 'membership_exists') return 'member';
  if (error.code === 'unit_inactive') return 'unit';
  return null;
}

function needsAccount(error: unknown): boolean {
  if (!(error instanceof ApiError) || error.status !== 422 || !error.errors?.length) return false;
  return error.errors.every(
    ({ loc, type }) => type === 'missing' && loc.length === 2 && loc[0] === 'body' && ['full_name', 'password'].includes(String(loc[1])),
  );
}
```

- D1 in code: branches on status and code, never the server's text. `needsAccount` is strict, so any other 422
  to `{}` is a generic error rather than an empty form (test "opens the form only for missing fields").

`frontend/src/features/auth/pages/AcceptInvitePage.tsx::AcceptInviteScreen` (the success path of `accept`)

```tsx
    if (accepted === null) return;
    // ...
    queryClient.removeQueries({ predicate: userData });
    // ...
    const used = { queryKey: ['invitation', token], exact: true };
    const watchers = (queryClient.getQueryCache().find(used)?.getObserversCount() ?? 0) - (mounted.current ? 1 : 0);
    if (watchers > 0) void queryClient.invalidateQueries({ ...used, refetchType: 'none' });
    else queryClient.removeQueries(used);
    // ...
    newSession();
    clearTabChoices();
    // The tab opens the accepted building even when the user has others.
    writeSelectedBuilding(accepted.building_id);
    if (mounted.current) navigate('/', { replace: true });
```

- `accepted === null` means the queued call never ran because the page was already gone.
- `userData` keeps invitation details, so an accept that answers after Back doesn't empty the invitation now
  shown (round 1 F2). The used token is removed, unless another entry still shows it, which then keeps its
  details and answer (R3-2) and only revalidates on its next mount.
- `newSession()` before `writeSelectedBuilding`: it makes the next `/me` a fresh user, so `AuthProvider` doesn't
  clear the selection just written (round 1 F1), and it rebuilds any shell the user went back to (R3-1).
- Without `newSession()`, five tests fail (§6 mutations); without the `watchers` branch, R3-2's fails.

`frontend/src/app/AuthProvider.tsx::useNewSession` and `frontend/src/app/routes.tsx::AppRoutes`

```tsx
  const [epoch, setEpoch] = useState(0);
  const newSession = useCallback(() => {
    lastUser.current = undefined;
    setEpoch((n) => n + 1);
  }, []);
  const session = useMemo(() => ({ epoch, newSession }), [epoch, newSession]);
```

```tsx
export function AppRoutes() {
  // A new user in the tab rebuilds the signed-in tree (P4-07b review round 3).
  const epoch = useSessionEpoch();
  return (
    <Routes>
      {/* ... */}
      <Route
        element={
          <RequireAuth key={epoch}>
```

- `lastUser` is what the user-change sweep compares `/me` with; forgetting it means "the caller has already
  swept". The epoch makes `AppRoutes` render again, and the key remounts everything signed-in.
- If `AppRoutes` didn't read the epoch, the three R3-1 tests fail: a mounted shell keeps rendering the old
  user's notification and name.

`frontend/src/features/auth/pages/LoginPage.tsx::LoginPage` (the session check, F6 and D2)

```tsx
      queryClient.setQueryData(['me'], me);
      // After a reset, the session found can be another account's (its own sessions all ended): the banner and
      // the form stay (P4-07a review round 3, F6).
      if (passwordUpdated) return;
      navigate(safeNext(next.current), { replace: true, state: SIGNED_IN });
```

## 5. Edge cases and tests

All tests below are in `AcceptInvite.test.tsx` unless named, and were run at `22b170c`.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A link forges the automatic accept | only router state triggers it | `› a link cannot trigger the automatic accept` (2 URLs) |
| A reload after a failed automatic accept accepts again | the state is replaced on read | `› drops the state after the automatic accept fails…` |
| The details refetch during the automatic accept | `autoSent` ref | `› sends the automatic accept once even if the details load again` |
| Double click / double submit | `inFlight` checked in `guarded`, before react-hook-form | `› sends once on a double click…`, `› sends once on a double submit of the form…` |
| An accept answers after Back | keyed page, `mounted` checks | `› Back to another invite link…`, `› Back to the same link in another history entry…` |
| A previous user's `/me` cached; the invitee lands on the picker | `newSession()` | round 1 `› F1…`, `› F1 neighbour…` (3), round 2 `› F1 reopened` (2) |
| The page's own `/me` overwrites a later login | the page sends no `/me` | round 2 `› F3, F4 (High)…` |
| A mounted shell keeps showing the previous user | epoch rebuild | round 3 `› R3-1 (High)…`, `› R3-1: an abandoned one-click accept…`, `› R3-1 neighbour: a mismatch logout…` |
| Another entry of the used token loses its answer | stale, not removed, while watched | `› R3-2 (Medium)…`; `› R3-2 neighbour…` |
| Back to the used invitation shows its old details | removed when unwatched | `› stack journey after round 2 › Back to the accepted invitation…` |
| Another tab logs in as someone else | `AuthProvider` sweep unchanged | round 2 `› neighbour: another tab logging in…` |
| Unsafe `next` | `safeNext` unchanged | `› next stays safe (criterion 11)` (3) |
| A name with a control character | refused before trimming | `› a name with a tab is refused…` |

Acceptance criteria → tests:
1. `› details (criterion 1) › shows the building, masked email and roles as words, without asking /me`
2. `› new email (criterion 2) ›` 3 tests (lands with "Package log", sends `{}` then the fields, replaced entry)
3. `› existing account, logged out (criterion 3) ›` 6 tests; `LoginPage.test.tsx › post-login state…` (2)
4. `› existing account, logged in (criterion 4) › accepts with one click and opens the accepted building…`
5. `› another account signed in (criterion 5) ›` 3 tests
6. `› invalid link (criterion 6) ›` 6 tests
7. `› other refusals (criterion 7) ›` 11 tests
8. `› form checks (criterion 8) ›` 13 tests
9. `› keyboard (criterion 9) ›` 2 tests, plus a focus assertion in each stage's test
10. `› no double accept, no late navigation (criterion 10) ›` 5 tests, plus the round 1–3 tests above
11. `› next stays safe (criterion 11) ›` 3 tests
12. `LoginPage.test.tsx › after a reset with another account signed in (P4-07b criterion 12, carried F6) ›` 2 tests
13. `PasswordReset.test.tsx › reset paths without a token (P4-07b criterion 13, carried F7) ›` 3 tests
14. test IDs used throughout; the list is in the PR

**Stack evidence (from the PR, run at `22b170c`):** `make check DB_PORT=55432` exit 0 (2121 backend, 500 frontend
tests); a Playwright script drove Chromium at 390×844 against `make up` and Vite, with invitations created
through the API and links read from Mailpit: new email → shell with "Package log"; existing account → login →
automatic accept → shell, and Back → "no longer valid"; another account → Log out → details → form; five
invalid paths → their invalid screens.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high) | `1ab2105` | MERGE | F1 (M): invitee lands on the picker; F2 (M): an abandoned accept evicts the invitation shown | fixed `de2a71d`; both reopened in round 2 |
| 2 | Codex `gpt-6.1-sol` (high) | `de2a71d` | BLOCK | F4 (H): the page's `/me` could overwrite a later login (with F3: a late 401 redirects); F1, F2 reopened (M) | fixed `330950b` |
| — | implementer (stack journey) | `330950b` | — | L: Back to a used invitation showed its details | fixed `2d595e5` |
| 3 | Codex `gpt-6.1-sol` (high) | `2d595e5` | BLOCK | R3-1 (H): a mounted shell keeps the previous user's data; R3-2 (M): the same token's other entry refetches | ticket blocked (stop rule 4, inbox B-7, PR #97); James chose option A; fixed `5381db8`, `22b170c` |
| 4 | Codex `gpt-6.1-sol` (high), verification only | `22b170c` | MERGE | none | — |

(SHAs are after the rebase onto #97; the PR maps the earlier ones.)

- **F1.** A's `/me` cached → mismatch → Log out → login as B → accept → B has two memberships → the shell's `/me`
  for B triggers `AuthProvider`'s sweep, which clears the building just stored → "Choose a building". Round 1
  fetched `/me` first; round 2 showed that fetch was itself unsafe (F4); the final fix is `newSession()`.
  Tests: round 1 F1 and its neighbours, failing at the test commit, passing at the fix.
- **F2.** Accept on A, go to invite B and accept there; A's success emptied the whole cache, B refetched its
  details, a 429 replaced B's answer. Fix: remove user queries only (`userData`). Test: round 1 `› F2…`.
- **F4.** A's post-accept `/me` (outside the auth queue, no signal) stalls; the user logs in as B; A's answer
  replaces B's identity. Fix: no `/me` from the page. Test: round 2 `› F3, F4 (High)…` (Codex's exact proof
  could not be replayed: the login page's own check now queues behind the accept; PR round 2).
- **R3-1.** A's shell data cached, session expired; the invitee starts the account form, goes to `/` and opens
  A's notifications before the accept answers; on success the cache is emptied but the mounted shell keeps
  rendering A's notification and name while B is signed in. Fix: D5/D6. Tests: round 3 `› R3-1…` (3).
- **R3-2.** Removing the used token's query made another entry of that token refetch; a 429 replaced its answer.
  Fix: mark it stale without refetch while another entry watches it. Test: round 3 `› R3-2…`.

Mutations run (PR): no `newSession()` on accept → 5 fail; none on logout → 1 fails; always remove the used
token → 1 fails; `AppRoutes` not reading the epoch → 3 fail; `RequireAuth` without the key (epoch still read)
→ 0 fail.

## 7. Not verified, accepted risks and follow-ups

- **The `key={epoch}` on `RequireAuth` is not tested by itself.** Today the epoch re-render alone fixes R3-1:
  `RequireAuth`'s `/me` observer finds its query removed and shows the loading screen, which unmounts the
  shell. The key keeps the rebuild working if `RequireAuth` ever renders children without `/me` data; no test
  shows that (PR, round-3 mutations).
- **R3-1 and the round 2/3 races are proven by component tests with a stubbed `fetch`**, not in a browser:
  Codex's round 4 noted that mocked tests don't verify real cookies and networking. The browser journey ran the
  normal flows, not the abandoned-accept races (their timing depends on a slow accept).
- Codex round 4 wrote three extra checks (the old user's data stays gone while the new `/me` stalls or fails);
  they passed and were not added to the suite.
- A new user sends one extra accept against the per-IP limit (D1); tracked only here.
- P2-06c's four account-menu Lows stay open: carried to P4-08 in the bookkeeping commit.
- Non-test size 433 code lines, over the ~400 guide (PR).
- E2E coverage (keyboard and screen-reader behaviour in a real browser) comes in P4-09.

## 8. How to change this safely

- **A new accept outcome** (a new error code): add it to `stageFor` and a stage branch with its own `Screen` key
  and test ID; add a test in `› other refusals`.
- **Another place that sweeps one user's data while the signed-in tree may be mounted:** remove the queries,
  then call `useNewSession()`; the round 3 tests show the pattern. Never call it while keeping the old user's
  data.
- **Changing `RequireAuth` or `AppRoutes`:** run `AcceptInvite.test.tsx` (round 3 tests) and `shell.test.tsx`.
- **The post-login state** is read only here; another page that wants it must not trust the URL.

## 9. Must explain, then quiz

**1. How does `next=` work safely? Why must it only allow internal paths (open-redirect risk)?**
`next` is in the URL, so anyone can write a link with any value. If the login page followed it blindly,
`/login?next=//evil.example` would send a user who just typed their password to another site (an open
redirect, useful for phishing). `frontend/src/app/safeNext.ts::safeNext` follows only a path on this origin:
it must start with one `/`, contain no backslash or control character (browsers read `/\evil` and `/\t/evil` as
hosts), resolve to the same origin, and not be the login page; anything else goes to `/`. This ticket builds the
link with `frontend/src/app/safeNext.ts::loginPath` and adds only router state to the navigation `safeNext`
chose, so it adds no new way to leave the origin (tests `› next stays safe (criterion 11)`).

Quiz:

1. Why does "Accept invitation" send `{}` first instead of showing the account form?
2. Why does dropping `signedIn` replace the state with `{entry}` and not `null`?
3. Why is the used token's query sometimes only marked stale instead of removed?
4. What would break if `accept` didn't call `newSession()`?
5. How would you extend this page to accept a join-code invitation (P4-08) without duplicating the session
   handling?

<details><summary>Answers</summary>

1. The page can't know whether the email has an account (the public GET doesn't say) or whether the browser has
   a session (asking `/me` while logged out redirects to `/login`). The server answers `{}` with 200, 409, 403 or
   a `missing` 422, which picks the screen (D1).
2. A `replace` gives the entry a new `location.key`. The page is keyed by it, so it would remount and lose the
   `signedIn` it just read; `{entry}` keeps the first key, so the same screen stays.
3. Another history entry of the same token may still show it. Removing it would make that entry fetch again,
   and a 429 would replace its answer (R3-2). Unwatched, it's removed so a later visit asks again and shows
   "no longer valid".
4. A previous user's `/me` still remembered by `AuthProvider` would make the shell's next `/me` look like a user
   change and clear the building just selected (F1), and a shell the user went back to would keep showing the
   previous user's data (R3-1). Five tests fail.
5. Reuse the same pieces: `runAuthCall` for the call that sets the cookie, then remove user queries,
   `useNewSession()`, `clearTabChoices()` and `writeSelectedBuilding()`. Extract that success sequence into a
   shared helper, with this page's tests and new ones for the join page.

</details>
