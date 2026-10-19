# Explanation — P3-05 Frontend notification center with polling

> **PR:** #79 · **Source revision:** `8db132d` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** no. The final review round (4, Codex `gpt-6-astra`, medium) reviewed
> `feecdb9` and said `BLOCK` (2 High). James then chose (inbox B-5, 2026-10-19, in session) to fix those two
> and merge **without a fifth round**. The fix (`a29d345`) and a comment-only commit (`8db132d`) are not
> reviewed by anyone. §6 and §7 say what that leaves unproven.
> **Merge commit:** not known when written; after the merge, `gh pr view 79 --json mergeCommit` gives it.
> Built autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed the code before
> merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and the squash
> merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: once merged, write a new explanation for later changes and do not update this one.
> **Reality check:** re-read at `8db132d` the PR diff (`git diff origin/main...HEAD`, 18 paths), in full
> `frontend/src/features/notifications/api.ts`, `NotificationBell.tsx`, `NotificationPanel.tsx`,
> `frontend/src/app/buildingDenial.ts`, and the changed parts of `AppShell.tsx`, `BuildingProvider.tsx`,
> `guards.tsx`, `MainNav.tsx`, `queryClient.ts`, `renderApp.tsx`; the PR body and comments; the assertions of
> the tests cited. Ran `npx vitest run` (frontend): `Tests 310 passed (310)`; `npm run lint`, `npm run
> typecheck`: clean; `make check DB_PORT=55432` at `a29d345`: exit 0 (backend `1350 passed`); CI green on
> `8db132d`. The stack journey last ran at `feecdb9`, before the round-4 fix. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B (UI interaction).

## 1. What was built and why

The header now has a notification bell. Its accessible name carries the unread count ("Notifications, 3
unread"), a visible badge shows it, and a polite live region announces changes. The count is
`GET …/notifications/summary`, polled every 30 s while the tab is visible and never in a hidden tab
(ADR-0012: polling, no WebSockets). Opening the bell shows a panel: the notifications page by page, "Load more",
"Mark all read", and a click that marks one read and follows its link. The three dead Base44 notification files
are deleted and the Base44 ratchet drops from 339 to 327.

Most of the work went into one property found by four review rounds: **once the tab learns it lost access to a
building, nothing of that building is shown again until the building answers successfully.** That became one
shared denial state (§2 D4), read by the page guard, the nav and the bell. It also fixed an older P2-06b gap.

## 2. Decisions

### D1. Invalidate after a mark-read instead of editing the cache

- **Problem or constraint:** after a mark-read, the badge and the list must agree with the server.
- **Chosen:** each mutation's `onSettled` invalidates `['b', id, 'notifications']`, which covers the summary and
  the list (`frontend/src/features/notifications/api.ts::useInvalidateNotifications`).
- **Alternatives rejected:** decrementing `unread_count` locally, or an optimistic update. Faster, but wrong
  when another tab or a new notification changed the count meanwhile, and it needs rollback code.
- **Tradeoffs:** one extra summary and list request per mutation; the badge changes when the refetch answers.
- **Basis:** ticket scope ("invalidate the summary and the list"), ADR-0012. **Source:** recorded (PR D1).

### D2. The bell renders only once the guards have loaded the building

- **Problem or constraint:** the header renders above `RequireActiveMembership`, so also on the picker, the
  membership screens and the session-only routes (`/403`, onboarding). Nothing under `/api/buildings/` may be
  asked there for a building the guards haven't loaded (P2-06b, P2-06c).
- **Chosen:** `frontend/src/app/AppShell.tsx::LoadedBuildingBell` reads the guards' building query passively
  (`useBuilding({ passive: true })`, which never sends the request) and renders the bell only when it has data
  and the building isn't denied.
- **Alternatives rejected:** rendering as soon as `buildingId !== null` (the original plan). It broke P2-06c's
  "the nav requests nothing on the session-only route" tests. Rendering inside the page area: not the header.
- **Tradeoffs:** entering directly on `/403` shows no bell until a building page has loaded the building.
- **Basis:** existing tests; criterion 8. **Source:** recorded (PR D2, deviation 1).

### D3. A second sweep of the previous user's building queries

- **Problem or constraint:** when `/me` answers for another user (another tab logged in on the shared cookie),
  `AuthProvider` removes every non-`me` query while the previous user's tree is still mounted. The bell's
  summary query, mounting in that same tick, subscribed after the sweep, came back and was fetched. An existing
  P2-06b test caught it before review.
- **Chosen:** `frontend/src/app/BuildingProvider.tsx::BuildingProvider` remembers the user id; in an effect after
  a change it removes `['b', …]` queries that have **no observer** (only the previous user's can be unobserved
  once the new tree has subscribed).
- **Alternatives rejected:** removing every `['b']` query there (it also removed the new user's live queries; a
  test proves it); sweeping in the old provider's unmount cleanup (same flaw); changing the test (it would hide
  a real stale request).
- **Tradeoffs:** the stale summary request in that window can still be **sent** (with the new user's cookie);
  only its cache entry goes. **Source:** recorded (PR D3).

### D4. One shared building denial (inbox B-5, James's option A)

- **Problem or constraint:** rounds 1–4 each found another way for a denied building's private data to show
  again: the building's own 404 (F1), a 5xx after it (R2-F1), a `building_not_found` from the notification
  endpoints and a shell remount (R3-F1, R3-F2), a denial that arrived while the shell was unmounted or behind
  slow refetches (R4-F1, R4-F2). Each component had kept its own idea of "denied". The page guard had the same
  gap for page content.
- **Chosen:**
  - A marker per building, `['b', id, 'denied']` = when access was lost, in the query cache
    (`frontend/src/app/buildingDenial.ts::deniedKey`).
  - `frontend/src/app/buildingDenial.ts::recordBuildingDenial` sets it on a `404 building_not_found` from any
    query or mutation keyed `['b', id, …]`, or any 404 from the building query. It is called from the
    `QueryCache` and `MutationCache` `onError` that `frontend/src/app/queryClient.ts::createQueryClient`
    installs, so it runs for the client's lifetime and, for a mutation, before the mutation's own `onSettled`.
  - `frontend/src/app/BuildingProvider.tsx::useBuildingDenied` answers "denied" while the building's own error
    is a 401/404, or while the marker is newer than the building's last successful answer.
  - `frontend/src/app/guards.tsx::BuildingLoaded` (lost-access screen), `frontend/src/app/MainNav.tsx::BuildingNav` and `LoadedBuildingBell` read
    it; the bell's gate also drops `['b', id, 'notifications']` once denied.
- **Alternatives rejected (recorded):** B-5 option B, a fix inside the notifications feature only (leaves the
  page gap and a fourth copy of the rule); component state in `BuildingProvider` (the catch-all route unmounts
  it, R3-F2); removing the building's queries on a denial (the guard's observer re-creates and refetches the
  query, which answers 404 again, in a loop); `useQuery` to read the marker (it creates a cache entry, which
  broke a P2-06b test that counts Maple's queries); a subscription inside `BuildingProvider` (round 4: it
  missed answers while unmounted, and a mutation's error event only fires after its `onSettled`).
- **Tradeoffs and accepted limitations:** another 404 code (`notification_not_found`) is not a denial. A
  building answer **in flight** when the denial arrives, succeeding after it, ends the denial until the next
  refetch: no test. The marker goes with the building's other queries on a switch, `reset()`, another user and
  a 401, because all of those remove `['b', …]` keys.
- **Basis:** James (B-5 option A; then "fix and merge without a fifth round"). **Source:** recorded (PR D4).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The list is requested only while the panel is open, `staleTime: 0`, never polled | poll the list too | ADR-0012: lists don't poll | ADR-0012 | recorded |
| Client-side `isAppPath` before `navigate(link)` | trust the API's check | defence in depth, one regex | autonomous | recorded |
| Navigate at once; the mark-read runs without being awaited | await the POST | a slow POST would delay navigation | autonomous | recorded |
| Live region is a plain `aria-live="polite"` span | `role="status"` | loading screens already use `role="status"`; two would collide | autonomous | recorded |
| Summary `refetchOnWindowFocus: 'always'` | the client default | a short hide left the answer "fresh" (F2) | review round 1 | recorded |
| Mutations owned by the bell, passed to the panel | `useMutationState` in the panel | simpler; the bell outlives the panel (F4) | review round 1 | recorded |
| Read actions disabled while one is pending | keep every outstanding error | smaller; the cost is one request's wait (R2-F2) | review round 2 | recorded |
| Bell keyed by building id | rely on the switch unmounting it | explicit; **no test distinguishes it** (a probe removing it fails nothing) | autonomous | recorded |
| Keep `EmergencyAlertPopup.jsx` | delete it | P6-02 replaces it | ticket scope | recorded |
| Reviewer: Codex only (`gpt-6.1-sol` high for rounds 1–3, `gpt-6-astra` medium for round 4) | the playbook's Tier 2 Claude reviewer | James's instructions for this run | session | recorded |

**Framing changes:** criteria 1–7 made measurable (request counts, exact names); criteria 8–12 added (no
building means no requests, pagination, unsafe links, errors, empty state). None loosened.

**Plan versus final code:** (1) the bell waits for the loaded building (D2), not just a selection; (2)
`BuildingProvider.tsx` changed for D3 and D4, and `guards.tsx`, `MainNav.tsx`, `queryClient.ts` and the new
`buildingDenial.ts` for D4. None of those were in the plan; all came from tests or review rounds. Non-test lines:
403, at the ~400 guideline.

## 3. How it is implemented

### Overview

- `api.ts`: four hooks (summary, list, mark-read, mark-all-read) on keys `['b', id, 'notifications', …]`, plus
  `isAppPath`.
- `NotificationBell.tsx`: the disclosure button, badge, live region; owns the two mutations.
- `NotificationPanel.tsx`: the list, "Load more", "Mark all read", click handling, error and empty states.
- `frontend/src/app/AppShell.tsx::LoadedBuildingBell`: when the bell may render, and dropping notifications on a denial.
- `buildingDenial.ts` + `queryClient.ts` + `frontend/src/app/BuildingProvider.tsx::useBuildingDenied`: the shared denial (D4).

### Walkthrough (variant B): a resident clicks an unread notification

1. **The control.** The bell (`NotificationBell`) is a `<button aria-expanded aria-controls>`; clicking it sets
   `openAt` to the current location key, so the panel is open only at that location. The panel's list query is
   enabled while it is mounted, so opening it sends `GET /api/buildings/{id}/notifications`
   (`notifications_list`).
2. **The click.** `frontend/src/features/notifications/NotificationPanel.tsx::onOpen`: if the notification is unread, it resets the other mutation's
   error and calls `markRead.mutate(id)` (`POST …/notifications/{id}/read`, `notifications_read`). If `link`
   passes `isAppPath`, it calls `navigate(link)`. Every read action is disabled while either mutation is pending.
3. **Navigation closes the panel.** The location key changes, so `open` is false. The bell stays mounted (it is
   in the header), and so do the mutations, so a failure still shows when the panel is opened again.
4. **Success.** `onSettled` invalidates `['b', id, 'notifications']`: the summary refetches and the badge and
   live region change; the list is inactive (panel closed), so it is only marked stale and refetches when the
   panel next opens (`staleTime: 0`).
5. **Failure.** A 5xx: the panel shows "Could not mark notifications read." (`role="alert"`), and the badge is
   unchanged. A `404 building_not_found`: `MutationCache.onError` records the denial first; `useBuildingDenied`
   turns true; the guard shows "You no longer have access", the nav and the bell disappear, and the bell's gate
   drops the notification queries.
6. **States.** Loading ("Loading…"), empty ("No notifications"), list error ("Could not load notifications."),
   summary error (bell named "Notifications", no count).

### Data model changes

None (frontend only; it consumes P3-03's endpoints).

## 4. The code

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/notifications/api.ts` | new: hooks, `isAppPath` | +95 |
| `frontend/src/features/notifications/NotificationBell.tsx` | new | +67 |
| `frontend/src/features/notifications/NotificationPanel.tsx` | new | +106 |
| `frontend/src/app/buildingDenial.ts` | new: the denial marker (D4) | +28 |
| `frontend/src/app/AppShell.tsx` | bell in the header, `LoadedBuildingBell` | +34 / −2 |
| `frontend/src/app/BuildingProvider.tsx` | second user sweep (D3), `useBuildingDenied` (D4) | +49 / −2 |
| `frontend/src/app/queryClient.ts` | cache `onError` hooks (D4) | +15 / −2 |
| `frontend/src/app/guards.tsx`, `MainNav.tsx` | read the shared denial | +4 / −2, +4 / −5 |
| `frontend/src/components/{NotificationCenter,NotificationHelper,EmergencyListener}.jsx` | deleted | −464 |
| `frontend/base44-baseline.txt` | 339 → 327 | 1 |
| tests: `notifications.test.tsx` (new, 50 tests), `building.test.tsx`, `nav.test.tsx`, `renderApp.tsx` | see §5 | |

`frontend/src/app/buildingDenial.ts::recordBuildingDenial`

```ts
export function recordBuildingDenial(queryClient: QueryClient, key: QueryKey | undefined, error: unknown): void {
  if (key?.[0] !== 'b' || typeof key[1] !== 'string') return;
  if (!(error instanceof ApiError) || error.status !== 404) return;
  if (error.code !== 'building_not_found' && key[2] !== 'building') return;
  // Built with no garbage collection: nothing observes this entry, and a default 5-minute gcTime would end the
  // denial on its own.
  queryClient.getQueryCache().build(queryClient, { queryKey: deniedKey(key[1]), gcTime: Infinity }).setData(Date.now());
}
```

- Only a building-scoped key and the tenancy 404 (or the building's own 404) count. `build(...).setData` makes
  an entry that never expires; `setQueryData` would give it the default 5-minute GC.
- Without the `code` check, a `notification_not_found` would lock the whole building (probe 2 in the PR).

`frontend/src/app/queryClient.ts::createQueryClient`

```ts
  const client: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => recordBuildingDenial(client, query.queryKey, error),
    }),
    mutationCache: new MutationCache({
      onError: (error, _variables, _context, mutation) => {
        const key: QueryKey | undefined = mutation.options.mutationKey;
        recordBuildingDenial(client, key, error);
      },
    }),
    // ...
  });
  return client;
```

- The caches' callbacks belong to the client, not a component, so they hear answers while the shell is unmounted
  (R4-F1). In `@tanstack/query-core`'s `mutation.js`, `mutationCache.config.onError` is awaited before the
  mutation's own `onSettled`, and the `error` event is dispatched only after both. Recording here therefore does
  not wait for the invalidation refetches (R4-F2).

`frontend/src/app/BuildingProvider.tsx::useBuildingDenied`

```ts
export function useBuildingDenied(): boolean {
  const buildingId = useBuildingId();
  const queryClient = useQueryClient();
  const building = useBuilding({ passive: true });
  // Read without observing, so reading creates no cache entry.
  const subscribe = useCallback((onChange: () => void) => queryClient.getQueryCache().subscribe(onChange), [queryClient]);
  const deniedAt = useSyncExternalStore(subscribe, () => queryClient.getQueryData<number>(deniedKey(buildingId)) ?? 0);
  const status = building.error instanceof ApiError ? building.error.status : null;
  return status === 401 || status === 404 || deniedAt > building.dataUpdatedAt;
}
```

- "Sticky": a 5xx after the denial replaces the query's error but not the marker, and `dataUpdatedAt` moves only
  on a success. Removing `deniedAt > building.dataUpdatedAt` fails 7 tests (probe 5).

`frontend/src/app/AppShell.tsx::LoadedBuildingBell`

```tsx
function LoadedBuildingBell() {
  const building = useBuilding({ passive: true });
  const denied = useBuildingDenied();
  const queryClient = useQueryClient();
  const buildingId = building.data?.id;
  useEffect(() => {
    if (denied && buildingId !== undefined) queryClient.removeQueries({ queryKey: ['b', buildingId, 'notifications'] });
  }, [denied, buildingId, queryClient]);

  if (!building.data || denied) return null;
  return <NotificationBell key={building.data.id} />;
}
```

- The removal runs in an effect, after the render that unmounted the bell, so no bell observer re-creates the
  queries. Without it, the cached rows would come back with the next successful answer before the list refetched.

`frontend/src/features/notifications/api.ts::useNotificationSummary`

```ts
  return useQuery({
    queryKey: [...notificationsKey(buildingId), 'summary'],
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/notifications/summary', {
        params: { path: { building_id: buildingId } },
        signal,
      }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  });
```

## 5. Edge cases and tests

All tests below are in `frontend/src/features/notifications/notifications.test.tsx` unless named otherwise.
Each was opened and its assertions read; the suite ran (`310 passed`).

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Badge never updates | 30 s poll | "asks again at 30 s, not before, and shows the new count" (fake timers: none at 29 s, one at 30 s) |
| Polling in a hidden tab | `refetchIntervalInBackground: false` | "makes no summary request while hidden, and asks again as soon as it is visible" (90 s hidden, 0 requests) |
| Stale count after a short hide | `refetchOnWindowFocus: 'always'` | "F2: asks again at once when the tab is visible after only 5 s hidden" |
| Old count shown while the summary fails | count hidden while `isError` | "F3: drops the count while a refresh of the summary fails …", "keeps the bell without a count when the summary fails" |
| Mark-read error lost with the panel | mutations owned by the bell | "F4: keeps a failed mark-read of a linked notification …" |
| Overlapping read actions hide a failure | disabled while pending | "R2-F2: while a mark-read / mark-all-read is pending …" (2 cases) |
| Open redirect via `link` | `isAppPath` | "marks a notification linking to %s read but does not follow the link" (5 links) |
| Another building's notifications | building-scoped keys, removed on a switch | "shows only the new building's notifications and drops the old building's queries" |
| Another user in the tab | AuthProvider sweep + D3 | "drops the previous user's notifications and shows the new user's building"; `building.test.tsx` › "drops the previous user's building data and selection …" |
| Requests without a loaded building | D2 gate | "shows no bell and asks for no notifications on the picker / on a pending membership"; `nav.test.tsx` session-only route tests |
| Access lost: building 404 / 401 | D4 | "F1: hides the bell and its cached notifications when the building refetch answers 404 / 401" |
| Access lost, then a 5xx | sticky denial | "R2-F1: …", "B-5: the page and the nav stay closed when a 5xx follows a building 404 …" |
| Access lost reported by the summary / list / mark-read | marker from any `['b', id]` request | "R3-F1: a summary poll …", "R3-F1: a list refetch …", "R3-F1 neighbour: a mark-read answering building_not_found …" |
| `notification_not_found` | not a denial | "R3-F1 neighbour: notification_not_found on a mark-read is only that notification …" |
| Shell remount forgets the denial | marker in the cache | "R3-F2: leaving the shell and coming back (Back) …" |
| Denial while the shell is unmounted | cache `onError` | "R4-F1: …", "R4 neighbour: a query denied while the shell is unmounted …" |
| Denial behind slow refetches | `MutationCache.onError` first | "R4-F2: a denied mark-read closes the building at once …" |
| Denial wears off | `gcTime: Infinity` | "B-5: a denial does not wear off with time" (6 min, fake timers) |
| Access restored | newer successful answer, or "Choose again" | in the B-5 page test; "R2-F1 neighbour: \"Choose again\" after a 404 …" |
| Another building unaffected | marker per building | "B-5: a denial of one building does not close another" |
| Building answer in flight at the denial | ends the denial early | **No test** |
| Space opens the bell; the `99+` cap | native button; ternary | **No test** |

Acceptance criteria → tests: 1 "asks again at 30 s …" + stack step 2; 2 "makes no summary request while hidden
…" + F2 + stack step 7; 3 "posts once, fetches the summary and the list again …", "is disabled when nothing is
unread"; 4 "marks it read, navigates to its link, closes the panel …", "… without a link …", "sends nothing for a
notification that is already read …"; 5 "a building switch" + "another user" tests; 6 "names the bell with the
count and announces a change politely", "opens as a disclosure; Escape closes it and returns focus …"; 7
`bash scripts/base44-count.sh` (327 = baseline) and `frontend/src/app/shellImports.test.ts`; 8 "no building, no bell";
9 "is requested only while the panel is open, and Load more …", "coverage: the open list does not poll …";
10 the five link cases; 11 the "errors" tests and F3/F4; 12 "shows an empty state".

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high | `8714bf0` | BLOCK | F1 High: cached private notifications after a building 404; F2–F4 Medium: no refetch after a short hide, stale count on failure, mark-read error lost on navigation | fixed in `98048f7`, `8872aaf` |
| 2 | Codex `gpt-6.1-sol`, high (new session) | `8872aaf` | BLOCK | R2-F1 High: a 5xx after the 404 brought the bell and rows back; R2-F2 Medium: overlapping mutations hid a failure | fixed in `74a86f2`, `822f571` (rebased SHAs differ) |
| 3 | Codex `gpt-6.1-sol`, high (new session) | `822f571` | BLOCK | R3-F1 High: a `building_not_found` from the notification endpoints left rows on screen; R3-F2 Medium: a shell remount forgot the denial | **stop rule 4** → blocked (inbox B-5); James chose option A; fixed in `feecdb9` (D4) |
| 4 | Codex `gpt-6-astra`, medium (authorized by James) | `feecdb9` | BLOCK | R4-F1 High: a denial arriving while the shell is unmounted was lost; R4-F2 High: a mutation's denial waited behind slow refetches | James: fix and merge without round 5; fixed in `a29d345`, **not reviewed** |

Each fix started with the reviewer's proof ported as a failing test (red runs: round 1 `5 failed`, round 2
`3 failed`, round 3 `5 failed`, round 4 `3 failed`), and each fix was mutation-probed (the PR lists every
probe and which tests failed). One pre-review defect, D3, was caught by an existing P2-06b test. Codex's round-4
R4-F2 proof was not kept as written: it waited for two hanging refetches to start, which the fix prevents.

## 7. Not verified, accepted risks and follow-ups

- **The round-4 fix (`a29d345`) and `8db132d` were not reviewed** (James's decision, B-5). Only the tests and
  probes above back them.
- **The stack journey** (Playwright against the dev API) last ran at `feecdb9`: it included a real membership
  suspension (lost-access screen after 29.9 s, bell and nav gone) but predates the round-4 fix.
- A building answer in flight when a denial arrives, succeeding after it, ends the denial until the next
  refetch (D4). No test. Tracked only here and in the PR.
- The stale summary request in the user-switch window can still be sent (D3). Tracked only here and in the PR.
- No automated test for Space on the bell, the `99+` cap, or what a real screen reader announces.
- Notification times use the browser's locale and time zone (`toLocaleString()`), not the building's.
- The bell is not shown when entering directly on `/403` or onboarding (D2).
- `EmergencyAlertPopup.jsx` stays, unused, for P6-02.

## 8. How to change this safely

- **A new building-scoped feature** gets denial handling for free if its query and mutation keys start with
  `['b', buildingId, …]` (mutations need an explicit `mutationKey`). A component that shows cached building data
  outside the guarded page area must check `useBuildingDenied()`, like `BuildingNav` and `LoadedBuildingBell`.
  The R3/R4 tests in `notifications.test.tsx` are the template.
- **Changing the poll** (`useNotificationSummary`): criterion 1 and 2 tests and F2 pin the interval, background
  and visibility behaviour.
- **Changing what counts as a denial** (`recordBuildingDenial`): the "notification_not_found … not a denial" test
  fails if it widens; the R3-F1 tests fail if it narrows.
- Any change to the user-switch handling: `building.test.tsx` › "drops the previous user's building data …" and
  "another user in this tab" catch both directions of D3.

## 9. Must explain, then quiz

**1. What do `refetchInterval` and `refetchIntervalInBackground` do, and why pause in hidden tabs?**
`refetchInterval: 30_000` makes React Query refetch the summary every 30 s while it has an observer (the bell).
`refetchIntervalInBackground: false` skips those refetches while the tab is not "focused", which in React Query
v5 means `document.visibilityState` is not `visible` (it listens to `visibilitychange`). A hidden tab costs the
server nothing and nobody is looking at the badge; when the tab is visible again,
`refetchOnWindowFocus: 'always'` asks at once (`frontend/src/features/notifications/api.ts::useNotificationSummary`). ADR-0012 sizes the load at
about 3.3 requests/s for 100 open tabs.

**2. Why invalidate the summary after mark-read instead of decrementing the number locally?**
The server's count is the truth and it moves for reasons the tab doesn't see: another tab marked some read, a
new notification arrived. A local decrement would be right only if nothing else happened, and would need
rollback on failure. Invalidating (`frontend/src/features/notifications/api.ts::useInvalidateNotifications`) costs one cheap request (D1).

**3. When would you switch this to SSE?**
ADR-0012's "revisit when": staleness under 5 s required, live chat selected, or measured polling load becoming
significant. SSE keeps one long-lived connection per tab through Caddy, so it needs deploy and connection
handling the poll doesn't. Postgres `LISTEN/NOTIFY` feeding SSE is the noted path.

**Quiz**

1. A resident's membership is suspended while their panel is open. Which request tells the tab, and what
   happens on screen within about 30 s?
2. Why is the denial marker created with `getQueryCache().build(..., { gcTime: Infinity })` rather than
   `setQueryData`?
3. What would break if `recordBuildingDenial` were called from a `useEffect` subscription in `BuildingProvider`
   instead of the client's cache `onError`?
4. What breaks if you remove `markAllRead.reset()` from `frontend/src/features/notifications/NotificationPanel.tsx::onOpen`?
5. How would you add a "packages" badge with the same lost-access behaviour?

<details><summary>Answers</summary>

1. The next summary poll answers `404 building_not_found`. `QueryCache.onError` records the denial;
   `useBuildingDenied` is true; the guard shows "You no longer have access", the nav and the bell disappear,
   and the notification queries are removed ("R3-F1: a summary poll …"; stack journey step 8, 29.9 s).
2. Nothing observes the marker, so a default 5-minute GC would delete it and end the denial on its own ("B-5: a
   denial does not wear off with time"; probe 4).
3. Answers arriving while the shell is unmounted (the catch-all route) would go unheard (R4-F1), and a
   mutation's error event fires only after its `onSettled` awaits the refetches, so a slow refetch would delay
   hiding private rows (R4-F2).
4. After a failed "Mark all read", a successful single mark-read would leave the old error showing ("F4
   neighbour: a successful mark-read after a failed mark-all-read clears the error" fails).
5. Key its query `['b', id, 'packages', 'summary']` (and any mutation with a `mutationKey` starting `['b', id]`),
   render it behind the same gate as `LoadedBuildingBell` (`!building.data || useBuildingDenied()`), and copy
   the R3-F1 and R4 tests for its endpoint.

</details>
