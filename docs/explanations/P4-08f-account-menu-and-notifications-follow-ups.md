# Explanation — P4-08f Account menu and notifications panel follow-ups

> **PR:** #108 · **Source revision:** `d4a4234`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 108 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `d4a4234` the diff of every code file (`git diff origin/main...HEAD` for
> `frontend/src/app/AccountMenu.tsx`, `MainNav.tsx`, `frontend/src/features/notifications/NotificationBell.tsx`,
> `NotificationPanel.tsx`, `api.ts`), the whole of `frontend/src/test/queryFreshness.test.ts`, the PR body (no comments
> or reviews on the PR; the three Codex reports in `.reviews/`) and the assertions of every test named below; ran
> `npx vitest run src/app/nav.test.tsx src/features/notifications/notifications.test.tsx src/test/queryFreshness.test.ts`:
> 3 files, 121 passed. The Chromium stack run was not re-run for this text (its transcript is in the PR, run on
> `6f0db77`; the review rounds after it changed only `queryFreshness.test.ts` and added tests). Differences from the
> plan: one, see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Six small fixes to the header, all carried over from earlier reviews, plus a new fitness test:

- The account menu and the notification bell no longer **reopen when you go Back** to the page where you opened them,
  and the menu **closes when `/me` moves the tab to another building**.
- The menu no longer offers council **"View as" while the building is denied** (a 401/404): it reads the same denial
  state the nav already used.
- Both close on a **tap outside** (`pointerdown`), not only a mouse click (`mousedown`).
- The panel's **"Load more"** can no longer cancel the list's refresh after a mark-read, or hide a failed refresh: it
  is disabled while any fetch is out, and after a failed refresh only "Try again" is offered.
- The bell's **unread count is asked for again each time the bell mounts**.
- `frontend/src/test/queryFreshness.test.ts` fails when a building query can serve a cached answer on remount without
  saying why: the "cached answer reused on remount" mistake had happened three times despite a `CLAUDE.md` lesson.

The decision that matters most is D4/D5: the fitness test reads the source with the TypeScript parser, fails closed,
and needs a written reason for each exemption. Two of the three review rounds tightened it.

## 2. Decisions

### D1. Where the open state is reset (menu and bell)

- **Problem or constraint:** the menu stored the history key it was opened at (`open = openAt === key`). Going Back to
  that entry made the key match again, and the menu reappeared (Low 1). Nothing closed it when `/me` changed the tab's
  building (Low 2).
- **Chosen:** the menu stores `` `${key} ${buildingId}` `` at open; it is open only while that matches the current
  value. When it no longer matches, the stored value is cleared **during render**, so a later Back can't match it
  again. The bell does the same with the key alone (it is keyed by building already: `AppShell.tsx::LoadedBuildingBell`).
- **Alternatives rejected:** only an effect that clears the state, with `open = openAt !== null`: one render would show
  the old panel at the new location. Keying the whole menu by location: it remounts the button and loses focus on
  every navigation.
- **Tradeoffs and accepted limitations:** none recorded.
- **Basis:** ticket (Lows 1, 2); autonomous for the shape.
- **Source:** recorded (PR decision D1 and the deviation note below the PR's Plan).

### D2. The denial check lives in `useCanViewAs`

- **Problem or constraint:** during a building 401/404 the nav hides, but the menu still offered "View as" from the
  cached roles (Low 3).
- **Chosen:** `frontend/src/app/MainNav.tsx::useCanViewAs` also returns false while `useBuildingDenied()`. The nav and
  the menu share it.
- **Alternatives rejected:** the check in `BuildingChoices` only: a second copy of the rule, which a later caller of
  `useCanViewAs` would miss.
- **Tradeoffs and accepted limitations:** the building switcher stays in the menu during a denial; it is a way out.
- **Basis:** the ticket offered both places; autonomous (one place).
- **Source:** recorded (PR D2).

### D3. A refresh-failed message in the panel

- **Problem or constraint:** hiding "Load more" after a failed refresh (criterion 7) would leave a stale list with a
  read notification shown as unread, no message, and no way to retry but closing the panel.
- **Chosen:** as `frontend/src/features/residents/PendingRequests.tsx::PendingRequests`: "Could not refresh
  notifications." with "Try again" (`refetch()`), and no "Load more" until a refresh succeeds.
- **Alternatives rejected:** keeping "Load more" disabled with no message: the user doesn't know why.
- **Basis:** existing convention (P4-08d criterion 8). **Source:** recorded (PR D3).

### D4. The freshness fitness test reads source, fail-closed, with named exemptions

- **Problem or constraint:** the "cached answer reused on remount" pattern reached 3 (PR #98 R3 M1, P4-08d R1 F2,
  P4-08e R1 F2) despite a `CLAUDE.md` lesson; the ticket's follow-up asked for a test that enforces it.
- **Chosen:** a vitest file that lists every React Query hook call in non-test files under `src/app` and
  `src/features`. A *building query* (one whose key isn't an array literal starting with a string other than `'b'`)
  passes only with `refetchOnMount: 'always'`, `gcTime: 0` or `staleTime: 0`, or with an entry in `EXEMPT` that gives a
  reason. A stale exemption fails too.
- **Alternatives rejected:** a runtime test that renders screens and inspects the cache: it only sees the screens a test
  renders, so a new page's query would slip by. A custom ESLint rule: more code for one check.
- **Tradeoffs and accepted limitations:** see D5 and §7 (aliases and namespace calls aren't found).
- **Basis:** ticket follow-up; autonomous. **Source:** recorded (PR D4).

### D5. The guard parses with TypeScript (review rounds 1 and 2)

- **Problem or constraint:** the first version matched text. It missed `useQuery<Row[]>(…)` and accepted `staleTime: 0`
  anywhere in the options, even inside `queryFn`'s returned object (round 1, R1-F1). The AST version then skipped
  method members, so a computed method written after `staleTime: 0` still read as fresh (round 2, R2-F1).
- **Chosen:** the TypeScript compiler API (already a devDependency). Any call to an identifier matching
  `use(Suspense)?(Infinite)?Quer(y|ies)` counts, whatever its type arguments. Only the options object's own members
  count, the last one with a name winning as at runtime. A shorthand or method maps to its name, which is never a
  freshness literal. An accessor, a spread or a computed name makes the whole call unreadable: building, not fresh.
- **Alternatives rejected:** patching the regex: nested generics, strings and comments keep breaking it. ESLint rule:
  as in D4.
- **Tradeoffs and accepted limitations:** a call through an alias or a namespace (`useQuery as q`, `RQ.useQuery`), or
  through a wrapper hook, isn't found (round 3, R3-F1, open; §7).
- **Basis:** review findings (rounds 1, 2). **Source:** recorded (PR D5, "Independent review").

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Fix the bell's Back too (criterion 5) | Another ticket | Same shape and fix as Low 1 | CLAUDE.md neighbours lesson | Recorded (Frame notes, PR table) |
| `refetchOnMount: 'always'` on the unread summary (criterion 8) | Exempt it | Its data changes in other tabs and the bell remounts; same as the pending badge | CLAUDE.md lesson; P4-08d R1 F2 | Recorded (PR table) |
| `useBuilding` exempt from the guard | Ask on every mount | Every guard mounts it, so it would ask on every navigation; the API enforces roles | Autonomous | Recorded (the `EXEMPT` reason) |
| `PrivateImageFor` exempt | Ask on every mount | Its `staleTime` follows the presigned URL's expiry | Autonomous | Recorded (the `EXEMPT` reason) |
| Two existing click-outside tests send `pointerDown` instead of `mouseDown` | Listen to both events | The listener changed; assertions unchanged, and a real click sends `pointerdown` first | Autonomous | Recorded (PR "Gate changes") |

**Framing changes:** criteria 1–4 written as given/then (1 adds Forward; 3 adds the denial ending; 4 adds the inside
case and the bell). Added 5 (the bell's Back), 8 (the count on remount), 9 (the fitness test). The stub's "Show more"
item became 6–7, with PR #99's neighbours; the button is labelled "Load more". Nothing loosened.

**Plan versus final code:** one deliberate deviation. The Plan (and D1) said an effect clears the stored open state; the
code clears it during render instead (`if (openAt !== null && openAt !== at) setOpenAt(null)`). Recorded below the
PR's Plan, with the reason: same behaviour, no effect, so no extra commit and no `setState` inside an effect. The guard
was reworked in review (D5), which the plan didn't foresee.

## 3. How it is implemented

### Overview

- `AccountMenu` and `NotificationBell` keep "where I was opened" in state and compare it on every render.
- `useCanViewAs` reads `useBuildingDenied()` (`frontend/src/app/BuildingProvider.tsx::useBuildingDenied`), the same
  state the guard, the nav and the bell use.
- `NotificationPanel` gates "Load more" on `isFetching` and `isRefetchError`, and shows a retry message.
- `useNotificationSummary` refetches on mount.
- `queryFreshness.test.ts` parses `src/app` and `src/features` and checks each query hook call.

### Walkthrough (variant B): mark a notification read, then "Load more"

1. The user opens the bell (`NotificationBell.tsx::NotificationBell`); the panel mounts and `useNotifications` asks for
   the first page (key `['b', id, 'notifications', 'list']`, `staleTime: 0`).
2. They click an unread notification. `NotificationPanel.tsx::NotificationPanel`'s `onOpen` calls `markRead.mutate(id)`.
3. `api.ts::useMarkRead` posts `/notifications/{id}/read`; its `onSettled` invalidates `['b', id, 'notifications']`,
   so the summary and the list refetch.
4. While that refetch is out, `list.isFetching` is true and "Load more" is disabled. If it were clicked anyway, it calls
   `fetchNextPage({ cancelRefetch: false })`, which does not cancel the running refresh (React Query's default is to
   cancel it and append the next page to the old pages, leaving the read notification shown as unread).
5. The refetch answers: the notification shows as read, "Load more" is enabled again.
6. If the refetch fails (a 500 after retries), `list.isRefetchError` is true with the old rows still in `data`: the panel
   shows "Could not refresh notifications." with "Try again", and no "Load more". "Try again" calls `refetch()`.
7. On a phone, a tap outside the panel fires `pointerdown` on the document, and the bell closes.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/app/AccountMenu.tsx` | Open state by location and building; `pointerdown` | +11/−7 |
| `frontend/src/app/MainNav.tsx` | `useCanViewAs` reads the denial | +4/−2 |
| `frontend/src/features/notifications/NotificationBell.tsx` | Open state forgotten on key change; `pointerdown` | +8/−5 |
| `frontend/src/features/notifications/NotificationPanel.tsx` | Refresh-failed message; "Load more" gating | +14/−3 |
| `frontend/src/features/notifications/api.ts` | `refetchOnMount: 'always'` on the summary | +4/−1 |
| `frontend/src/test/queryFreshness.test.ts` | New fitness test | +212 |
| `frontend/src/app/nav.test.tsx`, `frontend/src/features/notifications/notifications.test.tsx` | Criteria tests, review coverage | +347/−2 |
| `docs/tickets/…P4-08f…md`, `docs/tickets/README.md` | Frame, status | +61/−7 |

**Key excerpts**

`frontend/src/app/AccountMenu.tsx::AccountMenu`

```tsx
  const { buildingId } = useBuildingContext();
  const { key } = useLocation();
  const at = `${key} ${buildingId ?? ''}`;
  const [openAt, setOpenAt] = useState<string | null>(null);
  if (openAt !== null && openAt !== at) setOpenAt(null);
  const open = openAt === at;
  const setOpen = (value: boolean) => setOpenAt(value ? at : null);
  // ...
  useEffect(() => {
    if (!open) return;
    // `pointerdown`, not `mousedown`: iOS Safari may send no mouse event for a tap on empty space (P4-08f criterion 4).
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpenAt(null);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]);
```

- `open` compares in the same render, so a new location or building never shows the old panel; the reset line forgets
  it, so Back to the old key finds `null` (D1).
- Without the reset line, criterion 1's test fails: after Back, `aria-expanded` is `'true'` (the red run at `b05c2ea`).
- `NotificationBell` has the same two lines with `key` alone.

`frontend/src/app/MainNav.tsx::useCanViewAs`

```tsx
export function useCanViewAs(building: Building | undefined): boolean {
  const { buildingId, active } = useBuildingContext();
  const denied = useBuildingDenied();
  const membership = active.find((m) => m.building.id === buildingId);
  return !denied && !!building && building.my_roles.includes('council') && !!membership?.roles.includes('council');
}
```

- Both callers (`BuildingNav`, the menu's `BuildingChoices`) render only with a selected building, which
  `useBuildingDenied` needs (it calls `useBuildingId`, which throws without one).

`frontend/src/features/notifications/NotificationPanel.tsx::NotificationPanel`

```tsx
      {list.isRefetchError && items.length > 0 && (
        <p role="alert" className="text-sm text-red-800">
          Could not refresh notifications.{' '}
          <button type="button" className="underline" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      )}
      // ...
      {list.hasNextPage && !list.isRefetchError && (
        // ...
        <button
          type="button"
          className="rounded border px-2 py-1 text-sm disabled:opacity-50"
          disabled={list.isFetching}
          onClick={() => void list.fetchNextPage({ cancelRefetch: false })}
        >
          Load more
        </button>
      )}
```

- `isFetching` covers every fetch (a refresh after a mark-read, a focus refetch, the next page itself); the old
  `isFetchingNextPage` covered only the last one.
- `!isRefetchError`: a next page would succeed, clear the error and keep the stale first page (PR #99 round 3 F1).
- With no rows and a failed refresh, the existing "Could not load notifications." branch still shows.

`frontend/src/test/queryFreshness.test.ts::topLevel` and `classify`

```ts
function topLevel(options: ts.ObjectLiteralExpression): Map<string, ts.Node> | null {
  const properties = new Map<string, ts.Node>();
  for (const property of options.properties) {
    const plain = ts.isPropertyAssignment(property) || ts.isShorthandPropertyAssignment(property) || ts.isMethodDeclaration(property);
    if (!plain || !(ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))) return null;
    properties.set(property.name.text, ts.isPropertyAssignment(property) ? property.initializer : property.name);
  }
  return properties;
}

function classify(options: ts.Expression | undefined): Omit<Call, 'id'> {
  const properties = options && ts.isObjectLiteralExpression(options) ? topLevel(options) : null;
  if (properties === null) return { building: true, fresh: false };
  const key = properties.get('queryKey');
  const first = key && ts.isArrayLiteralExpression(key) ? key.elements[0] : undefined;
  const building = !(first && ts.isStringLiteral(first) && first.text !== 'b');
  const fresh = Object.entries(FRESH).some(([name, value]) => properties.get(name)?.getText() === value);
  return { building, fresh };
}
```

- `FRESH` maps each option to the exact literal text it needs (`'always'`, `0`), so `0x0` or `0_000` don't count.
- `Map.set` overwrites, so the last member of a name wins, as in JavaScript; a shorthand or method stores its name node,
  whose text is never a freshness literal (R2-F1).
- Anything unreadable returns `{ building: true, fresh: false }`: the guard fails closed. `inspect` walks every call
  expression whose callee is a plain identifier matching `QUERY_HOOK`.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Back (or Forward then Back) to where the menu was opened | Stays closed | `nav.test.tsx` "criterion 1: Back to where it was opened, and Forward then Back, leave it closed" |
| `/me` suspends Maple, selection moves to Birch | Menu closed at the same location | "criterion 2: closes when a /me refresh moves the tab to another building, at the same location" |
| Building's own 404, then "Choose again" | No radios during the denial; back after | "criterion 3: offers no \"View as\" while the building is denied, and offers it again once it answers" |
| `building_not_found` from the notification summary | No radios | "criterion 3: a building_not_found from another of its requests hides \"View as\" too" |
| Denial ended by a plain successful refetch | Radios back | "a building refetch that succeeds after a 404 brings \"View as\" back (no Choose again)" |
| Building 401 | Goes to `/login`; no radios, no nav | "a building 401 leaves no \"View as\" anywhere (the session is gone)" |
| Touch outside / inside (menu, bell) | Outside closes, inside keeps | "criterion 4: a touch outside (pointerdown, no mousedown)…" in both files |
| Bell: Back to where it was opened | Stays closed | `notifications.test.tsx` "criterion 5: Back to where the panel was opened leaves it closed" |
| Mark-read refresh in flight, "Load more" clicked | Disabled; refresh not aborted, not left invalidated; row read | "criterion 6: after a mark-read, Load more waits for the refresh, which then shows it read" |
| Refetch on focus (test call / real visibility event) | Disabled until it answers | "criterion 6: Load more is disabled during any list refetch (a focus refetch too)"; "criterion 6 (review round 1, Codex): disabled during a refetch the tab becoming visible starts" |
| Mark-read while "Load more" loads | Ends with the server's list | "criterion 6: a mark-read while Load more is loading ends with the server's list (it read)" (passed before the change too) |
| Refresh fails with rows listed | Message + Try again, no "Load more"; recovers | "criterion 7: a failed refresh offers only Try again, which shows it read and brings Load more back" |
| Count changed while the bell was unmounted | Asked again on mount | "criterion 8: a count changed while the bell was gone is asked for again when it comes back" (asserts one more summary request) |
| A new building query without a freshness option | Guard fails, naming it | `queryFreshness.test.ts` "every building query refetches on mount, keeps nothing, or is exempt with a reason" (mutation probes in the PR) |
| Generic calls, nested or commented options, later members, spreads, accessors | Read correctly or fail closed | "R1-F1: …" ×7, "R1-F1 neighbours…", "R2-F1: …" ×5, "R2-F1 neighbours…" |
| Aliased or namespaced hook import | **Not found** | No test (R3-F1, §7) |

Acceptance criteria → tests: 1–5 and 6–8 as in the table above; 9: `queryFreshness.test.ts` (red at `b05c2ea` on exactly
`useNotificationSummary`, mutation probes on `useMembers` and the summary in the PR).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high (fresh; chosen by James for this run, no Claude reviewer) | `6f0db77` | MERGE | Medium R1-F1: guard missed generic calls and accepted a freshness option anywhere in the text. Coverage notes on criteria 3 (401, plain refetch) and 6 (real visibility event) | Fixed in `5191e25` (D5); coverage tests added (they passed on `6f0db77`) |
| 2 | Codex `gpt-6.1-sol`, high (new) | `5191e25` | MERGE | Medium R2-F1: method members skipped, so a later computed method overriding `staleTime: 0` read as fresh | Fixed in `d4a4234` |
| 3 | Codex `gpt-6.1-sol`, high (new) | `d4a4234` | MERGE | Medium R3-F1: aliased or namespaced imports escape the guard | Not fixed: round 3 is the last; open follow-up (§7) |

- **R1-F1.** Input: `function useRows() { return useQuery<Row[]>({ queryKey: ['b', id, 'rows'], queryFn }); }` → the
  regex `useQuery\(` didn't match, so the call wasn't listed and the guard passed. And
  `queryFn: async () => ({ staleTime: 0, rows: [] }), staleTime: 30_000` read as fresh. Evidence: Codex's proof (3 failed),
  then the "R1-F1" tests red at `004070c`, green at `5191e25`.
- **R2-F1.** Input: `staleTime: 0, [optionName]() { return 30_000; }` → fresh by the guard; Codex's hook proof showed a
  remount serving the old value with one request. Evidence: "R2-F1" tests (3 red: computed method, method and shorthand
  of that name), green at `d4a4234`.
- **R3-F1.** Input: `import { useQuery as useBuildingQuery }` or `RQ.useInfiniteQuery({...})` with a building key →
  `inspect()` returns `[]`. Confirmed by Codex's proofs; not fixed.

## 7. Not verified, accepted risks and follow-ups

- **R3-F1 (Medium, open at merge):** `queryFreshness.test.ts::inspect` matches hooks by their identifier name only. An
  aliased named import, a namespace call or a wrapper hook escapes it. No call in `src/app` or `src/features` uses those
  forms today (checked by the round 3 reviewer). Fix: resolve the file's imports from `@tanstack/react-query`, test-first
  with Codex's two cases. Tracked: PR follow-ups; added to a ticket's follow-ups in the bookkeeping commit.
- **iOS Safari** (Low 4's reason) was not tested on a real device: only jsdom `pointerDown` events and Chromium touch
  emulation (Pixel 7) in the stack run.
- **Phone layout:** on the stack at 412 px, the bell's panel is cut off past the left edge of the screen, and both open
  panels cover the nav links (so the bell's Back step ran on Desktop Chrome only). Outside this ticket's scope; tracked
  in the PR's follow-ups and the bookkeeping commit.
- **`useBuilding` is exempt:** a guard's remount may use a ≤30 s old answer for roles and features. The API enforces
  roles; recorded in `EXEMPT`.
- The Chromium stack run was on `6f0db77`; later commits changed only the fitness test and tests.

## 8. How to change this safely

- **Adding a building query:** give it `staleTime: 0`, `gcTime: 0` or `refetchOnMount: 'always'`, or add an `EXEMPT`
  entry (`<path under src>::<function>`) with the reason. `queryFreshness.test.ts` names the call if you forget. Don't
  pass the options through a variable or a spread: the guard treats that as unreadable and fails.
- **Another disclosure in the header:** copy the two lines from `AccountMenu` (store where it was opened, reset when it
  differs) and the `pointerdown` listener; the criterion 1 and 4 tests show how to test it.
- **Another paged list:** gate "show more" on `isFetching` and `!isRefetchError`, call `fetchNextPage({ cancelRefetch:
  false })`, and offer "Try again" after a failed refresh; copy the criterion 6–7 tests.

## 9. Must explain, then quiz

The ticket has no "Must explain" questions.

1. Why does the menu compare `openAt === at` in render *and* reset `openAt`, rather than doing only one?
2. Why is "Load more" disabled on `isFetching` rather than `isFetchingNextPage`?
3. What does the guard do with `useQuery({ ...base, staleTime: 0 })`, and why?
4. What would break if `refetchOnMount: 'always'` were removed from `useNotificationSummary`?
5. How would you extend the guard to catch `import { useQuery as useQ }`?

<details><summary>Answers</summary>

1. The comparison closes it in the same render the location or building changes, so the old panel never flashes at the
   new place. The reset forgets the old value, so Back to the old key doesn't match it again. Without the reset,
   criterion 1's test fails; with only a reset (in an effect) and `open = openAt !== null`, one render would show the
   old panel.
2. A refresh after a mark-read (or on focus) is a different fetch from the next page. While it is out, a next page with
   the default `cancelRefetch: true` would cancel it and append to the old pages, leaving the read notification shown
   as unread.
3. It returns `{ building: true, fresh: false }`: a spread makes the members unreadable (the spread could set
   `staleTime` after, or before, the literal), so it fails closed, and the call needs a reason in `EXEMPT` or a rewrite.
4. The guard's main test fails, naming `features/notifications/api.ts::useNotificationSummary` (the PR's mutation
   probe), and criterion 8's test fails: after Back from a page outside the shell, the bell shows the old count from the
   30 s cache.
5. While walking the file, record `ImportDeclaration`s from `@tanstack/react-query`: map each named import's local name
   to its imported name, and keep namespace import names. Then treat a call as a query hook when its callee is a mapped
   local name whose imported name matches `QUERY_HOOK`, or a property access `ns.useQuery` on a recorded namespace.
   Test first with Codex's R3 cases.

</details>
