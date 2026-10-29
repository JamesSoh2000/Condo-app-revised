# Explanation — P6-04a Maintenance hooks and the resident's request list

> **PR:** #153 · **Source revision:** `df6bfc5a8fb459dd23f96ba4f22dbd1c9ce2f607` (pre-merge), the PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (2, Codex `gpt-6.1-sol` at
> high effort) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 153 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `df6bfc5` the diff (`git diff --stat origin/main...HEAD`, 14 paths), the whole of
> `api.ts`, `labels.ts`, `MyMaintenanceList.tsx` and `MyMaintenancePage.tsx` under `frontend/src/features/maintenance/`,
> the `pages.ts` and `routes.tsx` patches, the assertions of the criterion 5, 9, 10, 11 and round 1 F1 tests, and the PR body (Plan, decisions, both
> review rounds). Ran `npx vitest run` on `myMaintenance.test.tsx`, `queryFreshness.test.ts`, `buildingDenial.test.ts`,
> `building.test.tsx`, `nav.test.tsx`, `shell.test.tsx`, `LoginPage.test.tsx`, `notifications.test.tsx`: 8 files,
> 320 passed. Differences from the plan: two, both recorded (see §2 "Plan versus final code").
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

A resident of a building with `maintenance` on now opens **Maintenance requests** at `/maintenance` and sees the
requests the API lets them see, newest first: one card each with the category, the status in words, the location,
the first line of the description, "Submitted <time>" in the building's timezone, and the photo count, 25 a page
with "Load more". It is the first migrated maintenance screen (the legacy page stays until P6-04b), and it adds the
pieces P6-04b–d build on: the query key root `maintenanceKey`, the list hook `useMaintenanceRequests` (which already
takes a `status` for the manager's filter) and the label maps in `labels.ts`.

The decisions that matter most: the path is `/maintenance` because the API's notifications already link to
`/maintenance/<id>` (D1), and the browser shows every item the API returns, never filtering by requester, because
`visible_maintenance` on the server decides (criterion 9).

## 2. Decisions

### D1. The path is `/maintenance`, and one route takes `/maintenance/:requestId?`

- **Problem or constraint:** the page needs its own path. The API's new-request notification already links to
  `/maintenance/<request id>` (`backend/app/maintenance/service.py::link=f"/maintenance/{request_id}"`), and the
  legacy `/Maintenance` must keep working.
- **Chosen:** `/maintenance`, with one route `/maintenance/:requestId?`. React Router matches paths
  case-insensitively, so this route also answers `/Maintenance`; `frontend/src/app/routes.tsx::sameLegacyPath` then
  leaves that page out of the legacy redirects, so the URL stays `/Maintenance` (no redirect loop). Until P6-04c,
  `/maintenance/<anything>` shows the list on the same mounted page.
- **Alternatives rejected:** `/my/maintenance` or `/maintenance-requests`: the notification links would land on
  "Page not found" and need a backend change (PR D1).
- **Tradeoffs and accepted limitations:** `/maintenance/<id>` shows the list, not the request, until P6-04c.
- **Basis:** the ticket's default; existing convention (`/packages`, P5-04 D2).
- **Source:** recorded (ticket Frame notes decision 1, PR D1).

### D2. The page reads `useBuildingDenied()` instead of a fitness-test exemption

- **Problem or constraint:** the page reads the building passively (`useBuilding({ passive: true })`) for its
  timezone and locale. `frontend/src/test/buildingDenial.test.ts` fails any passive reader that doesn't also read
  `useBuildingDenied()`, unless the test's `EXEMPT` table lists it; the ticket says that test passes "with no change".
- **Chosen:** `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::Maintenance` reads `useBuildingDenied()`
  and drops the time formatter when the building is denied.
- **Alternatives rejected:** an `EXEMPT` entry, as `NoticesPage` and `MyPackagesPage` have: it edits a protected
  fitness test, and an exemption widens what it lets through (PR D2).
- **Tradeoffs and accepted limitations:** one hook call that changes nothing on screen today, since the guards
  (`BuildingLoaded`) replace the page with the denial screen anyway.
- **Basis:** ticket test plan; the fitness test. Mutation M3 in the PR (the call removed) makes that test fail.
- **Source:** recorded (PR D2).

### D3. A failed first page's "Try again" parks focus on the heading (review round 1 F1)

- **Problem or constraint:** Codex round 1 F1: a keyboard user presses "Try again" on a failed first page; the cards
  replace the alert, and focus drops to `<body>`. Writing the neighbour tests showed more: a failed first page has no
  data, so React Query v5 puts its refetch back to `pending`, and the alert with its button is replaced by "Loading
  requests…" while the retry runs. Focus drops even when the retry fails again.
- **Chosen:** `frontend/src/features/maintenance/MyMaintenanceList.tsx::MyMaintenanceList`'s `retry`: if focus is on
  the button when it is pressed, focus moves first to the page heading (always mounted). If the retry fails, a state
  change makes an effect move focus to the new "Try again" once it renders, unless the user moved focus meanwhile.
  The same shape as `frontend/src/features/lists/useLoadMore.ts::useLoadMore`.
- **Alternatives rejected:** none recorded beyond the n/a the PR's "Known failure cases" first gave this row, which
  round 1 showed was wrong.
- **Tradeoffs and accepted limitations:** a successful retry leaves focus on the heading, not the first card.
  `MyPackageList`'s "Try again" has the same drop and is not changed here (§7).
- **Basis:** review finding (round 1, Medium).
- **Source:** recorded (PR "Independent review", round 1 F1).

Smaller decisions, one row each:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Nav label and heading "Maintenance requests" | "My requests" | doesn't say what kind; the staff page is "Maintenance", so they already differ | default (keep what exists) | ticket Frame notes 2, PR table |
| No status filter for residents; the hook still takes `status` for P6-04d | a filter | the ticket's default, as `MyPackagesPage` shows everything | ticket default | Frame notes 3 |
| One `labels.ts` (status, category, location, first line) instead of `statusLabel.ts` | two files | the cards need category labels too, and P6-04b–d reuse them | autonomous | Frame notes, PR table |
| First line of the description, cut at 120 characters with "…" | a CSS line clamp | a clamp hides text a screen reader still reads in full; a fixed cut is testable in jsdom | autonomous | PR table |
| The cut counts characters (`Array.from`), not UTF-16 units | `slice` on the string | a unit cut splits an emoji at the boundary (mutation M4, after the test was changed to an emoji) | test result | PR mutation M4 |
| A line ends at CRLF, CR, LF, U+2028 or U+2029 | `\r?\n` only | the API keeps a lone CR and the two separators (`backend/app/units/schemas.py::multiline_before_strip` rejects only other control characters) | review finding (round 1 F2) | PR round 1 |
| Photo count only when there are photos | "No photos" on every card | noise on most cards | autonomous | PR table |
| No link on a card yet | a link to `/maintenance/<id>` | it would open nothing until P6-04c | ticket scope | Frame notes 5 |
| `limit=25` sent | the API default (also 25) | the default is the server's to change | ticket ("25 a page") | PR table |
| `staleTime: 0`, not `gcTime: 0` | `gcTime: 0` | one list without filter combinations to drop; what `useMyPackages` uses | convention | PR table |
| The page is keyed by building, besides the key holding the building id | the query key alone | the resident pages' pattern; also resets the list's focus state | convention | PR table |
| Local checks on a scratch Postgres 16.2 + uvicorn + Vite | `make up` / `make check` | Docker unreachable (inbox PRE-8) | environment | PR table |
| Codex `gpt-6.1-sol` at high effort as the only reviewer | the playbook's fresh Claude reviewer for Tier 2 | James's instruction for this run | James, in session | PR table |

**Framing changes:** criteria 1, 3, 4, 6, 7 and 8 sharpened (exact card fields and copy, `limit=25` and the cursor,
"no request to `…/maintenance-requests`", the denial screen, focus after "Load more", the exact longest values and a
failing probe for 375 px). Added 9 (a co-occupant's request shows; the browser never filters), 10
(`/maintenance/<id>` before P6-04c) and 11 (coming back asks again). Nothing loosened.

**Plan versus final code:** two differences, both recorded in the PR. (1) Two shell tests that need a page with the
resident role or a feature couldn't move to `/Dashboard` (no unmigrated page of that kind is left): they keep
`/Maintenance`, stub its list and assert the new page's heading (PR "Deviation noted after implementation").
(2) `MyMaintenanceList` gained the `retry` handler and `failedRetry` effect (D3, round 1).

## 3. How it is implemented

### Overview

- `frontend/src/app/pages.ts::PAGE_ACCESS`: the `Maintenance` row gains `path: '/maintenance'`; its roles
  (`resident`) and feature (`maintenance`) already existed, so the guards and the nav follow from it.
- `frontend/src/app/routes.tsx::AppRoutes`: one route `/maintenance/:requestId?` under `RequirePageAccess`.
- `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::MyMaintenancePage`: keyed by building; the heading
  and the building's time formatter.
- `frontend/src/features/maintenance/MyMaintenanceList.tsx::MyMaintenanceList`: the query, the states, the cards,
  "Load more" and "Try again".
- `frontend/src/features/maintenance/api.ts::useMaintenanceRequests` and `labels.ts`: the hook and the words.

### Walkthrough (variant B: a resident opens the page and presses "Load more")

1. **The action.** The resident follows "Maintenance requests" in the nav (`/maintenance`), or the bell's link to
   `/maintenance/<id>`. `RequireAuth`, `RequireActiveMembership` and `RequirePageAccess` check the session, the
   building and the `PAGE_ACCESS.Maintenance` row; a staff or council-only member, or a building with the feature
   off, goes to `/403` before the page mounts, so no list request is sent (criterion 3).
2. **No form.** Nothing is typed; the only inputs are the two buttons.
3. **Hook.** `useMaintenanceRequests(buildingId)` is an infinite query under
   `['b', buildingId, 'maintenance', 'list', null]`. `staleTime: 0`, so every mount asks again: leaving the page and
   coming back shows a status a manager changed meanwhile (criterion 11).
4. **API call.** `GET /api/buildings/{building_id}/maintenance-requests?limit=25` (`maintenance_list`), then
   `&cursor=<next_cursor>` for "Load more". On the server, `backend/app/maintenance/queries.py::visible_maintenance`
   decides which requests the resident sees: their own, and those filed for a unit while they lived there, a
   co-occupant's included. The browser shows every item and asks no `status` (criterion 9).
5. **Response handling.** 200: cards in the API's order (`id DESC`, newest first). A `building_not_found` on the list
   marks the building denied through the query cache (`frontend/src/app/buildingDenial.ts::recordBuildingDenial`), and the guards show "no longer have
   access" (criterion 4). 429: `rateLimitMessage` says how long to wait. Other failures: "Could not load your
   requests." with "Try again", or, for a next page, "Could not load more requests." with the cards kept.
6. **Cache.** Nothing is invalidated: no mutation here. The key is building-scoped, and the page is keyed by
   building, so another building's list is another query and another component (criterion 5).
7. **States and focus.** "Loading requests…" (`role="status"`), the empty message, the alerts above. "Load more"
   is disabled while any fetch is out and hidden after a failed refresh; `useLoadMore` moves focus to the first new
   card, back to the button on failure, or to the heading after an empty page. "Try again" parks focus on the
   heading (D3). At 375 px the cards wrap even a 2,000-character word (`[overflow-wrap:anywhere]`, criterion 8).

### Data model changes

None (frontend only; no API change).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/maintenance/MyMaintenanceList.tsx` | new: the list, its states, cards, Load more, Try again | +111 |
| `frontend/src/features/maintenance/api.ts` | new: keys and `useMaintenanceRequests` | +39 |
| `frontend/src/features/maintenance/labels.ts` | new: status and category labels, location, first line | +40 |
| `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx` | new: the page, keyed by building | +33 |
| `frontend/src/app/pages.ts` | `Maintenance.path = '/maintenance'` | +1/−1 |
| `frontend/src/app/routes.tsx` | the `/maintenance/:requestId?` route | +10 |
| `frontend/src/features/maintenance/myMaintenance.test.tsx` | new: criteria 1–7, 9–11, round 1 | +582 |
| `frontend/src/app/{building,nav,shell}.test.tsx`, `frontend/src/features/auth/pages/LoginPage.test.tsx`, `frontend/src/features/notifications/notifications.test.tsx` | off `/Maintenance` as "an unmigrated page", onto `/Dashboard` (two keep `/Maintenance`, see §2) | +44/−45 |
| `docs/tickets/P6-04a-resident-maintenance-list.md`, `docs/tickets/README.md` | framing, status | +73/−21 |

Non-test, non-doc lines: 234.

`frontend/src/features/maintenance/api.ts::useMaintenanceRequests`

```ts
export const maintenanceKey = (buildingId: string) => ['b', buildingId, 'maintenance'] as const;
export const maintenanceListKey = (buildingId: string, status: MaintenanceStatus | null) =>
  [...maintenanceKey(buildingId), 'list', status] as const;

export function useMaintenanceRequests(buildingId: string, status: MaintenanceStatus | null = null) {
  return useInfiniteQuery({
    queryKey: maintenanceListKey(buildingId, status),
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/maintenance-requests', {
        params: {
          path: { building_id: buildingId },
          query: { limit: PAGE_SIZE, ...(status !== null && { status }), ...(pageParam !== null && { cursor: pageParam }) },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}
```

- The building id in the key keeps each building's list apart, and `['b', id, …]` lets a building denial and a
  building switch find it. P6-04b–d invalidate `maintenanceKey(buildingId)` to refresh every maintenance query.
- Without `staleTime: 0`, the app's 30 s default would serve the cached list on coming back (mutation M1: criterion
  11's test and `queryFreshness.test.ts` fail).

`frontend/src/features/maintenance/labels.ts::firstLine`

```ts
export function firstLine(description: string): string {
  const chars = Array.from(description.split(/\r\n|[\r\n  ]/, 1)[0]);
  return chars.length > FIRST_LINE_MAX ? `${chars.slice(0, FIRST_LINE_MAX).join('')}…` : chars.join('');
}
```

- Takes the text before the first line break the API can store, then cuts it at 120 characters. `Array.from` splits
  by code point, so an emoji at the boundary is kept whole.
- Without `\r` and the separators in the pattern, a description with a lone CR shows its second line on the card
  (round 1 F2).

`frontend/src/features/maintenance/MyMaintenanceList.tsx::MyMaintenanceList` (the retry, trimmed)

```tsx
  const retryRef = useRef<HTMLButtonElement>(null);
  const [failedRetry, setFailedRetry] = useState<{ parked: Element | null } | null>(null);

  useEffect(() => {
    if (!failedRetry) return;
    const active = document.activeElement;
    if (active === failedRetry.parked || active === document.body || active === null) retryRef.current?.focus();
  }, [failedRetry]);

  const retry = (event: MouseEvent<HTMLButtonElement>) => {
    const pressed = document.activeElement === event.currentTarget;
    if (pressed) focusHeading();
    const parked = document.activeElement;
    void query.refetch().then((result) => {
      if (pressed && result.isError) setFailedRetry({ parked });
    });
  };
  // ...
  if (query.isPending) body = <p role="status">Loading requests…</p>;
  else if (query.isError && !query.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(query.error) ?? 'Could not load your requests.'}{' '}
        <button type="button" ref={retryRef} className="underline" onClick={retry}>
          Try again
        </button>
      </div>
    );
  }
```

- The button goes while its refetch is pending (the query has no data, so it is `pending` again), so focus can't
  stay on it. It waits on the heading; a failed retry brings it back to the new button after React renders it (the
  effect runs on the state change, not in the promise, which settles before the render).
- `parked` is the heading the press moved focus to; if the user moved focus elsewhere meanwhile, the effect leaves
  it. Mutations in the PR: without `focusHeading()`, the success and empty-result tests fail; without
  `setFailedRetry`, the fail-again and 429 tests fail.

`frontend/src/features/maintenance/MyMaintenanceList.tsx::Card`

```tsx
    <li tabIndex={-1} className="flex flex-col gap-1 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="min-w-0 font-medium">{CATEGORY_LABEL[item.category]}</h3>
        <p className="text-sm font-medium">{STATUS_LABEL[item.status]}</p>
      </div>
      <p className="text-sm text-slate-700">{requestLocation(item)}</p>
      <p className="text-sm">{firstLine(item.description)}</p>
      <p className="text-sm text-slate-700">
        Submitted <time dateTime={item.submitted_at}>{time?.format(new Date(item.submitted_at))}</time>
        {photos > 0 && ` · ${photos} ${photos === 1 ? 'photo' : 'photos'}`}
      </p>
    </li>
```

- `tabIndex={-1}` lets `useLoadMore` focus a card. `[overflow-wrap:anywhere]` is what keeps a 2,000-character word
  inside 375 px: with it turned off the page measured 1704 px wide in Chromium.
- `STATUS_LABEL` and `CATEGORY_LABEL` are `Record`s over the generated enums, so a new API value fails `tsc` until it
  has words.

`frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::MyMaintenancePage`

```tsx
export function MyMaintenancePage() {
  const buildingId = useBuildingId();
  return <Maintenance key={buildingId} buildingId={buildingId} />;
}

function Maintenance({ buildingId }: { buildingId: string }) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const building = useBuilding({ passive: true }).data;
  const time = useBuildingDenied() ? undefined : buildingTime(building);
  // ...
}
```

- `buildingTime` (`frontend/src/features/packages/time.ts::buildingTime`) formats in the building's timezone and
  locale, not the device's (criterion 2). The denial read is D2.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A card shows an enum value (`heating_cooling`) | labels from `labels.ts` | `labels every status and category in words, never the raw value` |
| Status shown by colour only | the status is text beside the heading | `shows three cards in the API’s order…` (`statusOf`) |
| A long first line, an emoji at character 120 | cut by code point with "…" | `cuts a long first line at 120 characters, not UTF-16 units…` (mutation M4) |
| A lone CR, U+2028 or U+2029 shows the second line | split on every break the API keeps | `F2: the first line ends at %s` ×5, `F2 neighbour: a tab is not a line end…` |
| "Load more" repeats or skips a card | the API's cursor | `asks limit=25 first, then the cursor, and shows 26 cards once each in order`; stack: 26 distinct |
| Focus lost after "Load more" | `useLoadMore` | `moves focus to the first new card…`, `sends focus to the heading after an empty last page`, `keeps the cards when Load more fails…`; Chromium: focus on card 26 |
| Focus lost after "Try again" | D3 | `F1: …` and its five neighbours; Chromium: heading on success, button on failure |
| The device's timezone used | `buildingTime` | `shows 23:30 UTC as 7:30 PM in an America/Toronto building`; stack in an `Asia/Tokyo` browser |
| Staff, council-only or feature off see the page or ask the API | the `PAGE_ACCESS` guard | `access (criterion 3…)` ×8 |
| Another building's URL asked | the building id in the key and path | `asks only the selected building’s maintenance URLs` |
| A denied building keeps showing | the cache's denial | `marks the building denied when the list answers building_not_found` |
| A's cards show in B | building-scoped key and page key | `shows none of the first building’s requests while the second’s load` (see §7 on what it isolates) |
| The browser hides a co-occupant's request | no client filter | `shows a request a co-occupant filed, and asks for no status` |
| `/maintenance/<id>` 404s, or Back refetches | one route keeps the page mounted | `shows the list at the notification’s link, and Back to /maintenance asks no second time`, `shows the list for an id that is not a UUID` |
| An old answer on coming back | `staleTime: 0` | `asks for the list again after another page, and shows the new status` (M1) |
| A 2,000-character word at 375 px | `[overflow-wrap:anywhere]` | No Vitest test (jsdom has no layout); Chromium stack run in the PR: scrollWidth 375, probe 1704 |
| A unit request without a unit label, or a common-area one without text | "Your unit" / "A common area" | No test: the API always sends them for those locations (`_outs` reads the unit; the schema requires `common_area`) |

Acceptance criteria → tests:
1. `the cards (criterion 1)` ×6; stack 25 then 26 cards.
2. `building time (criterion 2)`; stack in Tokyo time.
3. `access (criterion 3; tenant rows 1, 2 and 4)` ×8; stack: security, manager, council → `/403`, no list request.
4. `tenant row 3, UI side (criterion 4)` ×2.
5. `switching building (criterion 5)`.
6. `states (criterion 6)` ×4.
7. `legacy path (criterion 7)`; stack `/Maintenance?from=old#top`.
8. Chromium at 375 px in the PR (no Vitest test).
9. `the browser does not filter (criterion 9)`; stack: resident3's request on resident2's list.
10. `/maintenance/<id> until P6-04c (criterion 10)` ×2.
11. `coming back (criterion 11)`.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome (fixed in commit / dismissed: why) |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high, fresh | `9509509` | MERGE | F1 Medium: keyboard "Try again" drops focus to `<body>`; F2 Low: a lone CR isn't a line end | both fixed in `df6bfc5` (tests in `951463b`) |
| 2 | Codex `gpt-6.1-sol`, high, new fresh session | `df6bfc5` | MERGE | none | — |

- **F1.** Failure: first page 500 → focus on "Try again" → Enter → retry succeeds → cards replace the alert → focus on
  `<body>`. The neighbour tests found the wider case (the button goes during the retry, also when it fails again).
  Evidence: `F1: a keyboard Try again that brings the cards keeps focus, on the heading` failed at `951463b` and
  passes at `df6bfc5`, with `expectFocusKept`; the fail-again neighbour also failed first. Produced D3.
- **F2.** Failure: description `"Tap leaks\rAdditional details"` → both lines on the card. Evidence: the lone CR,
  U+2028 and U+2029 cases of `F2: the first line ends at %s` failed at `951463b` and pass at `df6bfc5`.

Round 2 re-read all 14 paths, found nothing, and repeated that criterion 5's test doesn't isolate the page key.

## 7. Not verified, accepted risks and follow-ups

- **No test isolates `key={buildingId}` on the page** (mutation M2 survives): the query key already holds the
  building id, and switching buildings goes home first (P2-06a), so the criterion 5 test, which comes back through
  the nav, passes without the key. The key stays as the resident pages' pattern. Tracked only here and in the PR.
- **375 px is checked only in Chromium by hand** (PR evidence), not by a test. The only element reaching past 375 px
  (410) is the shell's 1 px clipped `span.sr-only` outside `<main>`, the same on `/packages`.
- **Local runs had no Docker** (inbox PRE-8): `make check` stopped at `db-guard`; backend pytest and `alembic check`
  ran only in CI (no backend file changed). The stack journey ran on a scratch `pgserver` Postgres 16.2 (CI uses 18)
  with uvicorn and Vite; two statuses and one `submitted_at` were set by SQL because the manager transitions are
  P6-03c.
- **`MyPackageList`'s "Try again"** has the same focus drop as round 1 F1. Will be added as a follow-up in the
  bookkeeping commit.
- After a successful "Try again", focus is on the page heading, not the first card.
- The legacy `frontend/src/pages/Maintenance.jsx` stays until P6-04b deletes it (ticket scope); nothing routes to it.

## 8. How to change this safely

- **P6-04c (one request):** read `useParams().requestId` in `frontend/src/features/maintenance/pages/MyMaintenancePage.tsx::Maintenance` and render the view
  over the list, as `MyPackagesPage` does with `PackageDetailDialog`; add a link on each card. Criterion 10's tests
  will need the new expectation for `/maintenance/<id>`.
- **P6-04b/d (mutations):** cancel, then invalidate `maintenanceKey(buildingId)` in `onSettled`, as
  `useLogPackage` does; that covers this list and P6-04d's filtered ones.
- **A new status or category** in the API: `tsc` fails on `STATUS_LABEL` / `CATEGORY_LABEL` until it has a label;
  `labels every status and category in words…` then needs the new value.
- **Changing the card's layout:** re-run the 375 px Chromium check with the longest values; jsdom can't see it.

## 9. Must explain, then quiz

**1. Which server function decides which requests the list shows, and why does the browser not filter again?**
`backend/app/maintenance/queries.py::visible_maintenance`: for a resident, their own requests and those filed for a
unit while they lived there (ADR-0016's occupancy window); staff see all; council alone sees none. The browser
doesn't filter because the server is the authority (CLAUDE.md rule 3: never hand-roll this filter) and because a
browser filter would hide records the resident may see: a co-occupant's request has another
`requester_membership_id` but is theirs to see (criterion 9's test). A browser filter is also no protection: the
API answer is what a user can read.

**2. Why is the page keyed by building, and what would show for a moment without it?**
`MyMaintenancePage` renders `<Maintenance key={buildingId}>`, so a new building mounts a new component with fresh
state. Today the query key alone already keeps A's cards out (a new key starts `pending`, with no data), and the
switch goes home first, so nothing of A's would show even without the page key (mutation M2). What the key also
resets is component state that isn't in the query: `useLoadMore`'s pending focus and the `failedRetry` state, which
would otherwise act on B's list after an action in A. Inferred: P6-04c's open request (`requestId` state, focus
return) will make the key matter more.

**3. Why does the route take `:requestId?` now, before P6-04c needs it?**
The API already sends notifications linking to `/maintenance/<id>` (D1). Without the optional segment those links
would hit "Page not found" until P6-04c. With it, they land on the list now, and P6-04c can add its view without
changing the route; going between `/maintenance/<id>` and `/maintenance` keeps the page mounted, so Back asks for
nothing again (criterion 10's test).

Quiz:

1. A resident's list request answers `building_not_found`. What does the resident see, and which code makes that
   happen without this page handling the error itself?
2. Why does the "Try again" fix need a `useState` and an effect instead of focusing the button in the `refetch()`
   promise's `then`?
3. Why is `limit=25` sent explicitly when the API's default is 25?
4. What would break if `staleTime: 0` were removed from `useMaintenanceRequests`?
5. How would you extend this list to let residents filter by status, and what would you have to check about the
   query key and "Load more"?

<details><summary>Answers</summary>

1. The "no longer have access" screen. The list query's key starts `['b', buildingId]`, so the client's query cache
   `onError` calls `frontend/src/app/buildingDenial.ts::recordBuildingDenial`, which sees the `building_not_found` code and marks the building
   denied; the guards (`BuildingLoaded`) then render the denial screen in place of the page. Test:
   `marks the building denied when the list answers building_not_found`.
2. The promise settles before React has rendered the new state, and during the retry the old button was removed
   (the query was `pending`). Focusing in `then` would find no button, or a stale ref. Setting state makes the
   effect run after the commit that shows the new button, as `useLoadMore` does.
3. The page size is the ticket's requirement; the default belongs to the server (`DEFAULT_LIMIT` in
   `backend/app/core/pagination.py`) and could change for other lists. The test asserts `limit=25`.
4. The app's default `staleTime` (30 s) would serve the cached list when the resident comes back within 30 s, so a
   status a manager changed wouldn't show. `asks for the list again after another page…` and the
   `queryFreshness.test.ts` fitness test fail (mutation M1).
5. Pass the chosen status to `useMaintenanceRequests(buildingId, status)`: it is already in the key
   (`maintenanceListKey`), so each status is its own query with its own pages and cursor, and "Load more" continues
   the right list. Check: whether switching back to a filter should show cached pages (consider `gcTime: 0`, as
   `useWaitingPackages` does), that the empty message says "no requests with this status", and that focus after a
   filter change lands somewhere stable.

</details>
