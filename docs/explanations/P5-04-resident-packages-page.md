# Explanation — P5-04 Resident packages page

> **PR:** #120 · **Source revision:** `d232363` (pre-merge PR head this explanation was written from and checked
> against). **Reviewed:** the final review round (3) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 120 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: once merged, write a new explanation for later changes and do not update this one.
> **Reality check:** re-read at `d232363` the diff (`git diff origin/main...HEAD`, 25 paths), every file cited
> below in full (`MyPackagesPage.tsx`, `MyPackageList.tsx`, `PackageDetailDialog.tsx`, `PackagesNavLabel.tsx`, the
> new part of `api.ts`, `routes.tsx`, `MainNav.tsx`, `pages.ts`, the backend router and service hunks), the test
> names and assertions cited in §5, and the PR's description (Plan, D1–D4, the three review rounds). Ran
> `pytest tests/packages/test_api.py -k "statuses or filters"`: 2 passed; `npx vitest run src/features/packages
> src/app src/features/residents/badge.test.tsx src/features/notifications src/features/auth/pages/LoginPage.test.tsx`:
> 15 files, 480 passed. No mutation probe was run; the red-then-green runs are in the PR. Differences from the plan:
> see §2 "Plan versus final code".
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Residents now have their own packages page at `/packages`, which replaces the Base44 `Packages.jsx` (deleted; the
Base44 ratchet goes from 281 to 270). It shows "Waiting for you" as cards (photo, carrier, description, arrival time
in the building's timezone, "Pick up at the front desk") and a paged "History" of picked-up and returned packages.
`/packages/<id>` opens one package in a dialog over the lists; it is the link the `package.arrived` notification
already carries. The nav's "My packages" item shows the waiting count, polled every 30 s like the bell.

Four decisions carry the ticket:
- the list endpoint's `status` filter may now repeat, so History is one paged query (D1);
- one optional-segment route serves both the list and a package, and the legacy `/Packages` needs no redirect (D2);
- the badge polls like the bell, and the page asks its lists again when the polled count changes (D3);
- after review round 2, the lists also wait until a count exists, so no list is older than the count it is compared
  with (D4).

## 2. Decisions

### D1. History reads two statuses through a repeatable `status`

- **Problem or constraint:** History is `picked_up` and `returned` packages, newest first and paged, but
  `packages_list` took one `status`.
- **Chosen:** `status` is a repeatable query parameter (`?status=picked_up&status=returned`), filtered with `IN` on
  `visible_packages(ctx)` (`backend/app/packages/service.py::list_packages`). One value behaves as before.
- **Alternatives rejected:** (a) list without a status and drop `received` in the browser: a page made only of waiting
  packages would show as an empty "Load more" step; (b) two History lists, one per status: the ticket asks for one,
  and their order wouldn't interleave.
- **Tradeoffs and accepted limitations:** an API change in a lane-B (frontend) ticket; it is additive, and the types
  were regenerated.
- **Basis:** autonomous (decision rule 3).
- **Source:** recorded (PR #120 D1; ticket Frame notes).

### D2. One route `/packages/:packageId?`, no redirect for `/Packages`

- **Problem or constraint:** the page moves to `/packages`; the legacy page was `/Packages`. React Router v6 matches
  paths case-insensitively, so the P5-03b pattern (a `LegacyRedirect` from `/<Name>` to the page's own path) would
  redirect `/Packages` to a path the same route matches, which loops. The P5-03b explanation had predicted that
  "setting `path` alone" would be enough here; that is wrong for this one page.
- **Chosen:** `PAGE_ACCESS.Packages.path = '/packages'` and a single route with an optional segment, so the list and a
  package are one mounted page. The legacy loop skips a page whose own path equals its legacy path ignoring case
  (`frontend/src/app/routes.tsx::sameLegacyPath`).
- **Alternatives rejected:** two routes (`/packages` and `/packages/:id`): one route avoids any remount between the
  list and the dialog on Back/Forward; a redirect for `/Packages` loops.
- **Tradeoffs and accepted limitations:** `/Packages` stays in the address bar as typed, rather than being normalised.
- **Basis:** autonomous.
- **Source:** recorded (PR D2; Frame notes).

### D3. The badge polls like the bell, and the lists follow it

- **Problem or constraint:** the badge must show a new package within 30 s on a visible tab (criterion 2), without
  WebSockets; ADR-0012 says lists don't poll.
- **Chosen:** `frontend/src/features/packages/api.ts::usePackageSummary` copies the bell's options (30 s interval,
  never in the background, always on focus and on mount). While the page is open, a change in the polled count
  cancels and then invalidates the two lists (criterion 9).
- **Alternatives rejected:** polling the lists themselves (against ADR-0012); leaving the lists stale until focus
  (the badge and the cards would disagree).
- **Tradeoffs and accepted limitations:** a package logged and picked up within one 30 s interval changes no count,
  so an open page doesn't follow it until focus or remount.
- **Basis:** ADR-0012 and ticket criterion 2; criterion 9 is autonomous. The cancel-first part came from review round 1
  (F1).
- **Source:** recorded (PR D3, review round 1).

### D4. The lists wait for a waiting count (review round 2)

- **Problem or constraint:** criterion 9 compares each polled count with the one before it. On a cold load the lists
  could be read before the count's first answer, so a package logged in between showed in the badge (3) but not the
  cards (2), and nothing later counted as a change.
- **Chosen:** the lists' first request waits until a count exists: either cached by the nav (the usual case, since the
  nav mounts first) or this mount's first answer. A failed count lets the lists start, and its first answer later asks
  them again.
- **Alternatives rejected:** always re-asking the lists on the count's first answer (Codex's suggestion), which doubles
  the list requests on every visit; comparing the waiting list's length with the count, which breaks once the list
  has a next page and needs a loop guard.
- **Tradeoffs and accepted limitations:** on a cold load the lists start one summary request later.
- **Basis:** review finding (round 2).
- **Source:** recorded (PR D4).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Detail is a dialog over the page (residents `Modal`) | a separate page | the ticket allows either; the lists and Back stay natural | ticket; autonomous | PR table |
| Building time via `Intl.DateTimeFormat(locale, { timeZone })` in `frontend/src/features/packages/time.ts::buildingTime` | a src/lib/time.ts helper | `src/lib` is legacy JS | convention | PR table, deviation note |
| A non-UUID `/packages/<x>` shows "Package not found" without a request | sending it (FastAPI answers 422) | the user should see the generic not-found state | autonomous | PR table |
| No "picked up by" or return reason in History | adding them to `PackageOut` | not in the ticket; `PackageOut` doesn't carry them | ticket scope | PR table |
| Close goes `navigate(-1)` when opened from the list (`state.fromList`), else replaces with `/packages` | always pushing `/packages` | Back would reopen the dialog | autonomous | PR table (added at step 6, what was known when deciding); tests `closes a deep link opened from elsewhere…` and the Escape test |

**Framing changes:** criteria 1–5 were sharpened: the lists' statuses and paging, the badge's accessible name, the
polling rules, which ids count as "not found", the exact Toronto rendering, and the 375 px check with the longest
values and alt text. Criteria 6–10 were added: the detail dialog and Back/Forward, access (tenant rows 1, 2, 4), the
lists' states, the lists following the badge (the missed case), and the multi-status API (tenant rows 1, 3, 5).
None was loosened.

**Plan versus final code** (also below the Plan in the PR):
- Size: 447 non-test lines added against ~380 estimated (the limit is ~400); not split.
- `useMyPackages` uses `staleTime: 0` without `gcTime: 0`: the page has no filters, so there is no per-filter cache to
  drop.
- `buildingTime` is a shared 3-line helper; `WaitingList` keeps its own inline copy.
- `frontend/src/test/renderApp.tsx` answers the packages summary by default, since every resident's nav now asks for it.
- From review: the cancel before invalidating (round 1 F1), the failed-request branch in the dialog (round 1 F2), and
  the `enabled` gate on the lists (round 2 F1, D4). The Plan named none of these.

## 3. How it is implemented

### Overview

- **API:** `GET /api/buildings/{id}/packages?status=…&status=…` (D1); `packages_get` and `packages_summary` are
  unchanged from P5-02a. `visible_packages` decides what a resident sees.
- **Hooks** (`frontend/src/features/packages/api.ts`): `useMyPackages` (one infinite list per `MyList`),
  `usePackage` (the dialog) and `usePackageSummary` (the badge). All keys sit under `packagesKey(buildingId)`; the two
  lists are under `myPackagesKey`.
- **Page:** `frontend/src/features/packages/pages/MyPackagesPage.tsx::MyPackagesPage` keys the inner `Packages` by
  building, owns the "lists follow the count" effect and the focus return, and renders two `MyPackageList`s plus the
  dialog when `:packageId` is set.
- **Nav:** `frontend/src/app/MainNav.tsx::NavLabel` renders `PackagesNavLabel` for the `Packages` row.
- **Routes:** one route `/packages/:packageId?` under `RequirePageAccess` (resident, `packages` feature).

### Walkthrough (variant B): a resident opens the notification for a new package

1. **The action.** The resident is on `/` and the bell shows a `package.arrived` notification whose `link` is
   `/packages/<id>` (set by P5-02a's `create_package`). Opening it navigates there; the bell code is unchanged.
2. **Route and guard.** The route `${PAGE_ACCESS.Packages.path}/:packageId?` matches, and `RequirePageAccess` checks
   the resident role and the `packages` feature. Security, property management and council-only members get `/403`
   before any packages request.
3. **The page mounts.** `Packages` reads `packageId` from the route. `usePackageSummary` usually already has an answer
   cached by the nav, so `ready` is true and both `MyPackageList`s start their first request at once. `refetchOnMount:
   'always'` also asks the summary again. On a cold load, `ready` waits for that first answer (D4).
4. **API calls.** Waiting asks `status=received` and History asks `status=picked_up&status=returned`; openapi-fetch
   writes an array as repeated parameters. `usePackage` asks `packages_get` for `<id>`, unless the id isn't a UUID.
5. **Response handling.** A 404 `package_not_found` (another resident's package, another building's, or none) and a
   non-UUID id both show the "Package not found" dialog, with the lists behind it. The 404 doesn't mark the building
   denied: `recordBuildingDenial` only reacts to `building_not_found`. Any other failure shows "Could not load the
   package." with Try again, and hides a cached answer (round 1 F2).
6. **Cache.** When a later poll's count differs from the last one seen, the page cancels and invalidates
   `myPackagesKey(buildingId)`. That covers both lists, including a request already out (round 1 F1). The desk's
   mutations invalidate `packagesKey`, which includes the summary.
7. **Closing.** Close or Escape: if the dialog was opened from a Details link (`state.fromList`), it goes Back;
   otherwise (this case, from the bell) it replaces the URL with `/packages`. Focus returns to the Details link that
   opened it, or to the `h1`.
8. **States and mobile.** Each list has loading, empty, failed-with-Try-again and failed-Load-more states. At 375 px,
   with a 50-character carrier and a 200-character unbroken description, nothing passes the viewport
   (`[overflow-wrap:anywhere]` on each item, `min-w-0` on the text column; stack run in the PR).

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/app/packages/router.py`, `backend/app/packages/service.py` | `status` repeatable, `IN` filter | +10/−4 |
| `backend/tests/packages/test_api.py` | multi-status test | +45 |
| `frontend/src/api/schema.d.ts` | regenerated | +2/−1 |
| `frontend/src/features/packages/api.ts` | `useMyPackages`, `usePackage`, `usePackageSummary`; desk list sends `['received']` | +63/−1 |
| `frontend/src/features/packages/pages/MyPackagesPage.tsx` | the page | +83 |
| `frontend/src/features/packages/MyPackageList.tsx` | one list with its states | +139 |
| `frontend/src/features/packages/PackageDetailDialog.tsx` | the dialog | +108 |
| `frontend/src/features/packages/PackagesNavLabel.tsx` | nav badge | +23 |
| `frontend/src/features/packages/time.ts` | `buildingTime` | +5 |
| `frontend/src/app/routes.tsx`, `frontend/src/app/MainNav.tsx`, `frontend/src/app/pages.ts` | route, `sameLegacyPath`, `NavLabel`, path | +33/−6 |
| frontend/src/pages/Packages.jsx (deleted), `frontend/base44-baseline.txt` | deleted; 281 → 270 | −590 |
| `frontend/src/features/packages/myPackages.test.tsx` | 44 tests | +735 |
| other tests (`building`, `nav`, `shell`, `LoginPage`, `notifications`, `badge`, `renderApp`) | `/Packages` stand-in → `/Maintenance`; request lists include the badge | +58/−33 |

**Key excerpts**

`backend/app/packages/service.py::list_packages`

```python
    stmt = visible_packages(ctx)
    if status:
        stmt = stmt.where(Package.status.in_(status))
```

- It narrows `visible_packages` (CLAUDE.md rule 3), so a resident still sees only their own packages, now in any of
  the requested statuses. `if status:` treats an empty list like no filter.
- Without `in_`, the router's `list[PackageStatus]` couldn't be applied, and History would need two queries (D1).

`frontend/src/features/packages/pages/MyPackagesPage.tsx::Packages` (the count effect)

```tsx
  const summary = usePackageSummary(buildingId);
  const waiting = summary.data?.waiting;
  const ready = waiting !== undefined || summary.isError;
  const blind = useRef(false);
  const seen = useRef(waiting);
  useEffect(() => {
    if (waiting === undefined) {
      blind.current ||= ready;
      return;
    }
    if (seen.current === undefined ? blind.current : seen.current !== waiting) {
      const filters = { queryKey: myPackagesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    }
    seen.current = waiting;
  }, [waiting, ready, buildingId, queryClient]);
```

- `ready` gates the lists (D4). `blind` records that the lists started without a count (the count had failed), so its
  first answer counts as a change. `seen` is the last count; a different one re-asks both lists.
- Without `cancelQueries`, an in-flight first request is reused by `invalidateQueries`, and its older answer sticks
  (round 1 F1). Without `ready`, a cold load can show badge 3 and cards 2 indefinitely (round 2 F1).

`frontend/src/features/packages/PackageDetailDialog.tsx::PackageDetailDialog` (which body shows)

```tsx
  const notFound = !valid || (query.error instanceof ApiError && query.error.status === 404);
  // A failed request hides an answer cached from before, so an old status never reads as current (review round 1,
  // Codex F2).
  const item = notFound || query.isError ? undefined : query.data;
  const title = notFound ? 'Package not found' : item ? `${item.carrier} package` : 'Package';
```

- Not found wins over everything; a failure hides cached data. While a refetch is running, the cached answer shows
  (no failure yet).
- Without `query.isError` in `item`, reopening a package whose request fails showed the old status (round 1 F2).

`frontend/src/app/routes.tsx::sameLegacyPath`

```tsx
function sameLegacyPath(page: DemoPage): boolean {
  return pagePath(page).toLowerCase() === `/${page}`.toLowerCase() && pagePath(page) !== `/${page}`;
}
```

- It is true only for a migrated page whose path differs from its legacy path in case alone (`Packages` today). An
  unmigrated page has `pagePath === '/<Name>'` exactly and keeps its placeholder route.
- Without it, `/Packages` and `/packages` would be two routes the router ranks equally, and the legacy one would
  redirect to itself (D2).

`frontend/src/features/packages/api.ts::usePackageSummary`

```ts
    queryKey: [...packagesKey(buildingId), 'summary'],
    refetchOnMount: 'always',
    // ...
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
```

- These are the same options as `useNotificationSummary` (ADR-0012). React Query restarts the interval after each
  answer, so polls come 30 s after the previous answer. The stack run measured 30.0 s on a monotonic clock (PR,
  "Timing note").

## 5. Edge cases and tests

All in `frontend/src/features/packages/myPackages.test.tsx` unless stated otherwise.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| History needs two statuses | repeatable `status`, `IN` | backend `test_the_list_filters_by_several_statuses` (staff 3, resident1 only their 2, a single value as before, `lost` → 422) |
| Another resident's or building's package by URL | 404 → "Package not found" dialog, lists behind it | `shows the not-found dialog for %s, with the lists behind it` |
| `/packages/not-a-package` | no request, same dialog | `shows the same dialog for an id that is not a UUID, without asking the API` |
| A package 404 hiding the whole building | not treated as a building denial | `does not mark the building denied on a package 404` |
| Device timezone used | the building's `timezone` and `locale` | `shows 23:30 UTC as 7:30 PM in an America/Toronto building, on cards, history and the dialog` |
| Back/Forward refetching or remounting | one route keeps the page mounted | `opens and closes with Back and Forward without asking for the lists again` |
| Close from a deep link leaving the dialog under Back | replaces the URL with `/packages` | `closes a deep link opened from elsewhere to /packages, replacing it` |
| Polling in a hidden tab | `refetchIntervalInBackground: false`; asks on becoming visible | `does not ask while the tab is hidden, and asks as soon as it is visible` |
| A stale count after a failed poll | no count shown | `drops the count when a refresh of the summary fails` |
| Count change while a list's first request is out | cancel, then invalidate | `F1: a count change during the list’s first request still shows the new list` |
| A package logged before the first count | lists wait for a count | `F1: a package logged before the first summary answers still reaches the cards` |
| The first count fails | lists start; the first answer re-asks them | `F1 neighbour: a failed first summary still loads the lists, and its first answer refreshes them` |
| A failed reopen showing old data | error with Try again, data hidden | `F2: reopening a cached package whose request fails…`, `F2 neighbour: a focus refetch that fails while the dialog is open shows the failure` |
| A refetch answering 404 after the package showed | not found | `F2 neighbour: a refetch answering 404 after the package showed turns into not found` |
| Staff or council opening `/packages` | `/403`, no packages request | `sends %s to /403 without asking for packages` |
| Legacy `/Packages` | same route (case-insensitive) | `opens the page at the legacy /Packages path` |
| The lists' loading message | `Loading packages…` while pending | No test (round 3 coverage gap) |
| Load more succeeding after it failed | button stays (not a refetch error) | No test (round 3 coverage gap) |
| 375 px with the longest values | wraps, no overflow | No Vitest test (jsdom has no layout); Chromium stack run in the PR |

Acceptance criteria → tests:
1. `shows 2 waiting cards, 3 history rows and a badge of 2`, `says how each history package ended`,
   `loads more history with the cursor`; stack C1.
2. `asks again at 30 s, not before, and shows the new count`, the hidden-tab test,
   `opens the package from the bell’s package.arrived notification`; stack C2 (badge 3 after 30.0 s, notification →
   `/packages/<id>`).
3. The three not-found tests above; stack C3.
4. The Toronto test; stack C4 (shown time = Toronto time of `received_at`).
5. `gives each photo "Package photo: <carrier>" as alt…`; stack C5 at 375 and 768 px.
6. The detail dialog tests (Details link, focus to the dialog and back to the link, Escape, history, Back/Forward,
   failure).
7. The access tests, plus `shows the page in the navigation for a resident, linking to /packages` and
   `starts over in another building`.
8. `shows each list’s empty message`, `shows a failed list with Try again, leaving the other list alone`,
   `says so when Load more fails, keeping the rows`.
9. `asks for both lists again when the polled count changes, and not when it stays`, and the round 1–2 tests.
10. Backend `test_the_list_filters_by_several_statuses`.

## 6. Review log

Reviewer setup (James, in-session instruction for this run): each round was a fresh Codex `gpt-6.1-sol` at high
effort, run with `.claude/commands/review-ticket.md`, and no fresh Claude reviewer (Tier 2 otherwise uses one Claude
reviewer).

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex gpt-6.1-sol (high) | `1cfbe0e` | BLOCK | F1 (H): the lists could stay stale after a count change during their first request. F2 (M): a failed detail request showed the cached package | both fixed in `ac131de` (lint follow-up `1697e41`) |
| 2 | Codex gpt-6.1-sol (high), fresh | `1697e41` | BLOCK | R2 F1 (H): a package logged before the first count never reached the cards | fixed in `d232363` (D4) |
| 3 | Codex gpt-6.1-sol (high), fresh | `d232363` | MERGE | none; coverage gaps named (§7) | — |

- **Round 1 F1.** The first list request reads 2; the count moves to 3 while it is still out. `invalidateQueries`
  reuses a pending first fetch (it only cancels a refetch of a query that has data), so the 2-package answer shows,
  and later polls at 3 change nothing. Fixed by cancelling before invalidating. Evidence: the F1 test failed
  (2 cards) and now passes, and Codex's proof passes.
- **Round 1 F2.** Open a package, close it, then reopen while `packages_get` answers 500: the 5-minute cached answer
  rendered and hid Try again. Fixed by hiding the cached data on failure. Evidence: the F2 test failed and now
  passes, plus the focus-refetch neighbour.
- **Round 2 F1.** Cold `/packages`: the lists answer 2 before the summary's first answer of 3. With no earlier count,
  that first answer wasn't treated as a change. Fixed by D4. Evidence: the test failed (2) and now passes. Codex's
  proof now fails at its premise (it expects the list before the count, which no longer happens); its end state is
  the test above.

## 7. Not verified, accepted risks and follow-ups

- **Round 3 coverage gaps (no defect found):** no test of a pickup time's own conversion or of a non-English building
  locale (AC4); none of the lists' loading messages or of Load more succeeding after a failure (AC8). Tracked in the
  PR's follow-ups and P5-05's ticket (bookkeeping).
- **Photos on the stack:** the seed has no package photos, so the Chromium run shows "No photo" boxes; alt text is
  proven in Vitest only.
- **Multi-role members:** a member who is a resident and also security or property management sees every package of
  the building on this page and in the badge (`visible_packages` grants the union). Accepted; tracked in the inbox
  and P5-05 (bookkeeping).
- **Same count, different packages:** a package logged and picked up within one 30 s interval leaves the count
  unchanged, so an open page's lists don't follow it until focus or remount (D3).
- **Worst-case badge delay** is one interval plus the request time (30.0 s measured), not strictly under 30 s.
- **Size:** 447 non-test lines against a ~400 guideline; not split (PR deviation note).
- No mutation probe was run; the red-then-green runs of each criterion and fix are the evidence.

## 8. How to change this safely

- **Another list on the page** (say "Returned" on its own): add a `MyList` value with its statuses in `MY_STATUSES`
  (`api.ts`) and its texts in `frontend/src/features/packages/MyPackageList.tsx::TEXT`. Keep it under `myPackagesKey` so the count effect re-asks it,
  and pass it `enabled={ready}`.
- **Another migrated legacy page whose path differs only in case:** `sameLegacyPath` already covers it. Add the
  page's own route and test the legacy path as `opens the page at the legacy /Packages path` does.
- **Changing the poll:** keep `usePackageSummary` in step with `useNotificationSummary`; the criterion 2 tests and
  `frontend/src/test/queryFreshness.test.ts` (which needs `refetchOnMount: 'always'`) will catch drift.
- **Another nav count:** add a branch in `frontend/src/app/MainNav.tsx::NavLabel`, a default route in `frontend/src/test/renderApp.tsx`, and
  update the exact request lists in `nav.test.tsx`, `frontend/src/app/building.test.tsx::loadCalls` and `badge.test.tsx`.
- Run `npx vitest run src/features/packages src/app` and the backend `tests/packages`.

## 9. Must explain, then quiz

**1. Which server rule decides what this page shows?** `backend/app/packages/queries.py::visible_packages`. For a
resident it grants packages naming them as recipient, plus those received at their unit while they lived there
(`occupancy_window_clause`, ADR-0016). `list_packages`, `get_package` and `package_summary` all build on it, and so
does the photo download hook (`backend/app/packages/photos.py::can_view_package_photo`). The page itself filters nothing: the lists only
pick statuses.

**2. How does the badge stay fresh without WebSockets, and what is the worst-case delay?** `usePackageSummary` polls
`packages_summary` every 30 s while the tab is visible (`refetchIntervalInBackground: false`). It asks again as soon
as the tab becomes visible (`refetchOnWindowFocus: 'always'`, which React Query ties to `visibilitychange`) and on
every mount. Worst case: a package logged just after a poll shows at the next one, 30 s plus the request time
(measured 30.0 s). In a hidden tab it shows when the tab becomes visible. While the page is open, a changed count
also re-asks the lists (D3, D4).

**3. How is a UTC timestamp rendered in the building's timezone?** The API sends ISO UTC strings (`received_at`,
`picked_up_at`, `returned_at`). `frontend/src/features/packages/time.ts::buildingTime` builds
`Intl.DateTimeFormat(building.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: building.timezone })`
from `GET /api/buildings/{id}`, and each `<time dateTime=…>` shows `format(new Date(iso))`. `2026-03-15T23:30:00Z` in
`America/Toronto` (EDT since 8 March) reads "Mar 15, 2026, 7:30 PM", whatever the device's zone.

Quiz:

1. Why does the page cancel the lists before invalidating them, when React Query's `invalidateQueries` already
   refetches?
2. A resident opens `/packages` cold. Why do the list requests start only after the summary answers, and what happens
   if the summary fails?
3. Why doesn't `/Packages` have a `LegacyRedirect` like `/SecurityPackages`?
4. What would break if `item` in `PackageDetailDialog` ignored `query.isError`?
5. How would you show a "Returned" count in the badge too?

<details><summary>Answers</summary>

1. `invalidateQueries` cancels a running fetch only for a query that already has data; a list's first request is
   reused, so an answer read before the count changed would be kept (round 1 F1). `cancelQueries` drops it first.
2. So no list is read before the count it is compared with: the first count seen is then never newer than the
   lists, and every later difference is a real change (D4). If the summary fails, `ready` becomes true anyway, `blind`
   is set, and the count's first successful answer re-asks the lists.
3. React Router matches case-insensitively, so `/Packages` already reaches the `/packages/:packageId?` route; a
   redirect from `/Packages` to `/packages` would match itself and loop. `sameLegacyPath` drops it from the legacy
   loop.
4. Reopening a package whose request fails would show the cached answer, perhaps "Waiting at the front desk" for a
   package already picked up, with no error or Try again (round 1 F2).
5. Add the count to `PackageSummary` (backend, on `visible_packages`), regenerate types, render it in
   `PackagesNavLabel`, and decide whether the page's count effect should also compare it. Then extend the criterion 1
   badge tests and the request lists in the nav tests.

</details>
