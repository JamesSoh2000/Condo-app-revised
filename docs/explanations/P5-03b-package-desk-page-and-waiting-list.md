# Explanation — P5-03b Package desk page and waiting list

> **PR:** #117 · **Source revision:** `411c455`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 117 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `411c455` the diff (`git diff origin/main...HEAD`: every changed path), the four
> files under `frontend/src/features/packages/` in full, `frontend/src/app/routes.tsx`, `frontend/src/app/pages.ts`,
> the `UnitPicker.tsx` change, the names and assertions of the tests cited in §5, the PR body (Plan, decisions,
> both review rounds) and both Codex reports; ran `npx vitest run src/features/packages src/features/residents
> src/app src/test/queryFreshness.test.ts`: 17 files, 552 passed; `bash scripts/base44-count.sh`: 281 (baseline
> 281); a mutation probe on `gcTime: 0` (§5). Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Front-desk staff (the `security` and `property_management` roles) get a typed page at `/security/packages`
with the **"Waiting" list**: every package with status `received`, newest first, each row showing its photo,
unit, recipient, carrier and how long ago it arrived, in the building's own time. They can narrow it to one
unit (a search over the building's active units) and to one carrier. The page replaces the Base44
`SecurityPackages.jsx`, which is deleted with its Base44 email calls, so the Base44 ratchet drops from 299 to
281. The old `/SecurityPackages` URL now redirects. Logging a package (P5-03c) and pickup/return (P5-03d) will
be added to this page.

The decisions that matter most: the unit search **reuses the residents `UnitPicker`** (D1), and each filter
combination **starts from its first page** because the list query is dropped as soon as nothing shows it
(`gcTime: 0`, D4).

## 2. Decisions

### D1. Unit search reuses the residents `UnitPicker`

- **Problem or constraint:** the API filters by `unit_id` (an exact UUID, P5-03a); staff think in unit numbers.
- **Chosen:** the existing `frontend/src/features/residents/UnitPicker.tsx::useUnitPicker` and `UnitPicker`
  (prefix search over the building's active units, shown as radio buttons). The chosen unit's ID becomes the
  list's `unit_id`; "All units" clears it.
- **Alternatives rejected:** a new combobox (more code and accessibility surface for the same result; P5-03c may
  build one for logging); filtering the loaded rows in the browser (wrong once the list has more than one page).
- **Tradeoffs and accepted limitations:** only active units can be chosen, so a package still waiting on a unit
  deactivated after it was logged appears under "All units" only. With the search empty the picker lists up to 25
  active units, which takes vertical space above the list on a phone (visible in the 375 px stack run).
- **Basis:** autonomous (decision rule 3: simplest, reversible, matches existing code).
- **Source:** recorded (PR #117 D1; ticket Frame notes).

### D2. The carrier filter is a fixed select

- **Problem or constraint:** `?carrier=` matches the whole carrier name, ignoring case (P5-03a).
- **Chosen:** "All carriers" plus the six carriers the seed uses, exported as
  `frontend/src/features/packages/api.ts::CARRIERS` so P5-03c's quick-pick can reuse it.
- **Alternatives rejected:** free text (matches nothing until the whole name is typed); a list built from the
  loaded rows (incomplete when the list has several pages).
- **Tradeoffs and accepted limitations:** a package logged with another carrier is found under "All carriers" only.
- **Basis:** autonomous; seed data `backend/app/seed.py::PACKAGES`.
- **Source:** recorded (PR #117 D2).

### D3. Freshness: asked again on mount, focus and Refresh; never polled

- **Problem or constraint:** a desk tablet stays open all day; ADR-0012 says lists refetch on focus and after
  mutations and do not poll.
- **Chosen:** `staleTime: 0` (so the list is asked again on every mount), React Query's default refetch on focus,
  and a "Refresh" button. P5-03c/d will invalidate the `['b', buildingId, 'packages']` prefix after their
  mutations (`frontend/src/features/packages/api.ts::packagesKey`).
- **Alternatives rejected:** a 30 s poll of the list (contradicts ADR-0012); polling the summary count and
  refetching when it changes (one pickup plus one new package leave the count unchanged).
- **Tradeoffs and accepted limitations:** a colleague's change on another tablet shows only after focus, Refresh
  or this tablet's own mutation.
- **Basis:** ADR-0012; autonomous for the button.
- **Source:** recorded (PR #117 D3).

### D4. A filter combination starts from its first page through `gcTime: 0`

- **Problem or constraint:** an infinite query (a React Query list loaded one page at a time) that goes back to a
  cached key refetches *every* cached page. The members list avoids that by removing the next key's cache before
  changing its filters (P4-08c review round 1). Here the unit choice lives inside `useUnitPicker`: choosing,
  typing, "All units" and a units refetch that drops the chosen unit all change it, so there is no single place to
  remove the cache first.
- **Chosen:** `gcTime: 0` on `useWaitingPackages`: a combination's cache entry is dropped as soon as no component
  shows it, so going back starts from page one whichever way the filter changed.
- **Alternatives rejected:** wrapping every picker setter (misses the refetch path, and more code); a `useEffect`
  that removes queries after the change (it runs after the query has already read its cache).
- **Tradeoffs and accepted limitations:** leaving the page and coming back shows "Loading packages…" instead of
  the old rows while it refetches.
- **Basis:** autonomous; test plus mutation probe (§5).
- **Source:** recorded (PR #117 D4, added while coding; see "Plan versus final code").

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Path `/security/packages` set as `PAGE_ACCESS.SecurityPackages.path`, like `Residents` | — | the ticket names the path; P4-08b's convention for a migrated page | ticket; convention | ticket, PR |
| `/SecurityPackages` redirects there (replace, query and hash kept) | a 404 | old bookmarks and `Dashboard.jsx`'s link would break for no gain | autonomous | PR table |
| The received time is shown in the building's `timezone` and `locale` (as `Invitations.tsx` does); the age is relative and needs no timezone | the device's timezone | the desk, residents and notices share the building's clock | ticket "Must explain"; convention | PR table |
| Round 1 F1 fixed in the shared `UnitPicker`, not by a wrapper on this page | a `min-w-0` wrapper here | the residents dialogs use the same fieldset; one fix covers both | review round 1 | PR table |
| Three existing tests that used `/SecurityPackages` as an example of an unmigrated page now use `/ManagementNotices`, assertions unchanged | rewriting them against the new page | their subject is the guard and the placeholder | convention | PR table |
| The P3-05 fitness-test follow-up (passive `useBuilding` readers must call `useBuildingDenied`) not picked up | adding it here | as worded it fails on `frontend/src/app/AccountMenu.tsx::BuildingChoices`, outside this ticket; this page renders under `BuildingLoaded`, which already gates on the denial | ticket Frame notes | ticket, PR |

**Framing changes:** criterion 1 was sharpened (the file deleted, the baseline lowered, a grep for package
email/SMS). Criteria 2–11 were added: route and access, the rows, building time, unit search, carrier filter, the
list's states, freshness, another building, widths, and an unreadable photo. Nothing was loosened.

**Plan versus final code:** two deviations, both noted in the PR below the Plan. (1) The plan said filter changes
would `removeQueries` the next combination first, as `Members` does; the code uses `gcTime: 0` instead (D4).
(2) The plan left open whether `Dashboard.jsx`'s link should change; it is unchanged, because that legacy page
isn't routed and its link lands on the redirect. Review round 1 then added the `UnitPicker` change and the
next-page rate-limit message (§6). Everything else matches the Plan's files and criterion→test map.

## 3. How it is implemented

### Overview

- `frontend/src/app/routes.tsx::AppRoutes` mounts `SecurityPackagesPage` at `PAGE_ACCESS.SecurityPackages.path`
  behind `RequirePageAccess` (roles plus the `packages` feature). Any demo page that now has its own `path`
  gets a `LegacyRedirect` at its old `/<Name>` path instead of the "being migrated" placeholder.
- `frontend/src/features/packages/pages/SecurityPackagesPage.tsx::SecurityPackagesPage` is the heading plus
  `WaitingList`, keyed by building ID.
- `frontend/src/features/packages/WaitingList.tsx::WaitingList` holds the filters, the list, and their states.
- `frontend/src/features/packages/api.ts::useWaitingPackages` is the query; `frontend/src/features/packages/time.ts::packageAge` and `frontend/src/features/packages/time.ts::useNow`
  produce the ages.

### Walkthrough (variant B: a desk user narrows the list to one unit)

1. **The user action.** A security member opens `/security/packages`. The guards have already loaded the
   building (`useBuilding`), so `WaitingList` reads it passively for `timezone` and `locale`. The user types "10"
   into "Unit number" and picks "A-101".
2. **Validation.** `useUnitPicker` checks for control characters before sending anything ("Search with visible
   characters only."), debounces the text by 300 ms, and asks `GET /units?active=true&search=10`. Only a unit the
   current options list contains counts as `chosen`.
3. **Hook.** `filters = { unitId: picker.chosen, carrier }` changes, so `useWaitingPackages` gets a new key,
   `['b', buildingId, 'packages', 'waiting', { unitId, carrier }]`. The previous combination's entry is dropped
   (`gcTime: 0`).
4. **API call.** `api.get('/api/buildings/{building_id}/packages')` (operation `packages_list`) with
   `status=received&unit_id=<id>`, plus `cursor` for later pages. The server applies visibility, tenancy and the
   filters (P5-02a, P5-03a).
5. **Response handling.** The rows render through `Row`. A 429 shows the shared `rateLimitMessage`. Any other
   failure shows "Could not load the packages." with no data, or "Could not refresh the packages." over the kept
   rows. A next-page failure has its own alert. A `404 building_not_found` is caught by the query client's cache
   `onError` (`frontend/src/app/buildingDenial.ts::recordBuildingDenial`) and closes the building, because the key
   starts with `['b', id]`.
6. **Cache.** Nothing is invalidated here (the page writes nothing). P5-03c/d will invalidate `packagesKey`.
7. **States and widths.** "Loading packages…", the two empty messages, "Show more" while `next_cursor` is set.
   Below 768 px everything is one column. From 768 px (Tailwind `md`), the filters sit in a 16rem column beside
   the list.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/packages/WaitingList.tsx` | new: filters, list, states, rows | +144 |
| `frontend/src/features/packages/api.ts` | new: keys, `CARRIERS`, `useWaitingPackages` | +51 |
| `frontend/src/features/packages/time.ts` | new: `packageAge`, `useNow` | +27 |
| `frontend/src/features/packages/pages/SecurityPackagesPage.tsx` | new: the page | +19 |
| `frontend/src/app/routes.tsx` | route, `LegacyRedirect` | +26 −7 |
| `frontend/src/app/pages.ts` | `path: '/security/packages'` | +6 −1 |
| `frontend/src/features/residents/UnitPicker.tsx` | fieldset `min-w-0`, labels wrap (round 1 F1) | +8 −2 |
| `frontend/base44-baseline.txt` | 299 → 281 | +1 −1 |
| the legacy `SecurityPackages.jsx` (under `frontend/src/pages/`) | deleted | −971 |
| `frontend/src/features/packages/packages.test.tsx` | new: 46 tests | +613 |
| `frontend/src/app/building.test.tsx`, `shell.test.tsx` | example page `/SecurityPackages` → `/ManagementNotices` | +5 −3, +3 −2 |
| ticket, index | frame, status | — |

**Key excerpts**

`frontend/src/features/packages/api.ts::useWaitingPackages`

```ts
export function useWaitingPackages(buildingId: string, filters: WaitingFilters) {
  return useInfiniteQuery({
    queryKey: waitingListKey(buildingId, filters),
    staleTime: 0,
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/packages', {
        params: {
          path: { building_id: buildingId },
          query: {
            status: 'received',
            ...(filters.unitId && { unit_id: filters.unitId }),
            ...(filters.carrier && { carrier: filters.carrier }),
            ...(pageParam !== null && { cursor: pageParam }),
          },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}
```

- One query per filter combination. The key carries the building ID and the filters, and starts with
  `packagesKey`, so P5-03c/d can invalidate it with one prefix.
- `staleTime: 0` makes the list ask again on every mount (D3); it also satisfies the
  `frontend/src/test/queryFreshness.test.ts` fitness test. `gcTime: 0` is D4.
- Remove `gcTime: 0` and going back to a combination seen before fetches all its cached pages again (the mutation
  probe in §5 shows the test failing). Remove `status: 'received'` and picked-up and returned packages appear.

`frontend/src/features/packages/WaitingList.tsx::WaitingList` (states, trimmed)

```tsx
  const filters = { unitId: picker.chosen, carrier };
  const waiting = useWaitingPackages(buildingId, filters);
  const now = useNow();
  // ...
  const time = building && new Intl.DateTimeFormat(building.locale, { dateStyle: 'medium', timeStyle: 'short', timeZone: building.timezone });
  // ...
  if (waiting.isPending) body = <p role="status">Loading packages…</p>;
  else if (waiting.isError && !waiting.isFetchNextPageError) {
    body = (
      <div role="alert" className="text-sm text-red-700">
        {rateLimitMessage(waiting.error) ?? (waiting.data ? 'Could not refresh the packages.' : 'Could not load the packages.')}{' '}
        <button type="button" className="underline" onClick={() => void waiting.refetch()}>
          Try again
        </button>
      </div>
    );
  }
  // ...
        {waiting.isFetchNextPageError && (
          <p role="alert" className="text-sm text-red-700">
            {rateLimitMessage(waiting.error) ?? 'Could not load more packages.'}
          </p>
        )}
        {waiting.hasNextPage && !waiting.isRefetchError && (
          // As the members list: not while any fetch is out, nor after a failed refresh (P4-08b review rounds 2, 3).
          <button
            type="button"
            disabled={waiting.isFetching}
            onClick={() => void waiting.fetchNextPage({ cancelRefetch: false })}
```

- The filters are derived on every render from the picker's `chosen` and the carrier state, so there is no
  second copy of the unit choice to drift.
- The formatter takes the building's `locale` and `timeZone`, never the device's (criterion 4).
- A refresh error keeps the rows (`waiting.data` stays); a next-page error is its own alert, so it isn't
  mistaken for a failed refresh. The 429 branch on the next-page alert is review round 1 F2.
- "Show more" copies the members list's guards: disabled while any fetch is out, hidden after a failed refresh.
  Those guards come from P4-08b review rounds 2 and 3.

`frontend/src/features/packages/WaitingList.tsx::Row`

```tsx
    <li className="flex gap-3 rounded border bg-white p-3 [overflow-wrap:anywhere]">
      {item.photo_file_id ? (
        <PrivateImage fileId={item.photo_file_id} alt={`Package photo for unit ${unit}`} className={THUMBNAIL} />
      ) : (
        <div className={`${THUMBNAIL} flex items-center justify-center bg-slate-100 text-xs text-slate-600`}>No photo</div>
      )}
      <div className="min-w-0 flex-1">
        <h3 className="font-medium">Unit {unit}</h3>
        {/* Null for a package addressed to the unit: staff always get the recipient's name (P5-03a). */}
        <p className="text-sm">{item.recipient_name ?? 'Anyone in the unit'}</p>
        // ...
        <p className="text-sm text-slate-700">
          {packageAge(item.received_at, now)} · <time dateTime={item.received_at}>{time?.format(new Date(item.received_at))}</time>
        </p>
```

- This is the first real page to mount `PrivateImage` (P3-06): it fetches a short-lived download URL and shows
  "Image unavailable" on a 404. Without a photo, no download URL is requested.
- `[overflow-wrap:anywhere]` plus `min-w-0` let long names, descriptions and carriers wrap inside a phone-width row.
- `recipient_name ?? 'Anyone in the unit'` leans on P5-03a: for staff, `recipient_name` is null only when the
  package is addressed to the unit.

`frontend/src/features/packages/time.ts::packageAge` and `frontend/src/features/packages/time.ts::useNow`

```ts
export function packageAge(receivedAt: string, now: number): string {
  const age = now - Date.parse(receivedAt);
  if (age < MINUTE) return 'just now';
  if (age < HOUR) return `${Math.floor(age / MINUTE)} min ago`;
  if (age < DAY) return `${Math.floor(age / HOUR)} h ago`;
  return `${Math.floor(age / DAY)} d ago`;
}

export function useNow(intervalMs = MINUTE): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [intervalMs]);
  return now;
}
```

- Whole units, rounded down. A negative age (a `received_at` ahead of this device's clock) is under a minute, so
  it reads "just now".
- `useNow` re-renders the list once a minute, so ages move on without a request (criterion 4).

`frontend/src/app/routes.tsx::LegacyRedirect`, and the loop that uses it

```tsx
              element={
                PAGE_ACCESS[page].path ? (
                  <LegacyRedirect to={pagePath(page)} />
                ) : (
                  <RequirePageAccess access={PAGE_ACCESS[page]}>
                    <BeingMigrated page={page} />
                  </RequirePageAccess>
                )
              }
// ...
function LegacyRedirect({ to }: { to: string }) {
  const { search, hash } = useLocation();
  return <Navigate replace to={{ pathname: to, search, hash }} />;
}
```

- This applies to any demo page that gains a `path`, so the next migrated legacy page (P5-04's `Packages`) gets
  its redirect by setting `path` alone. The redirect itself needs no guard: the target route has one, which is
  why a resident on `/SecurityPackages` still ends at `/403`.

## 5. Edge cases and tests

All tests are in `frontend/src/features/packages/packages.test.tsx` unless stated otherwise.

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| A resident or a building without `packages` opens the page | `RequirePageAccess` → `/403`; no list request | `sends a resident to /403`, `sends the user to /403 when the building has packages off` |
| Signed out | login with `next=/security/packages` | `sends a signed-out user to the login page with the way back` |
| An old bookmark | redirect, query kept; still `/403` for a resident | `redirects the legacy /SecurityPackages path, keeping its query`, `still sends a resident on the legacy path to /403` |
| A unit-addressed package | "Anyone in the unit" | `shows "Anyone in the unit" for a package addressed to the unit` |
| No photo / an unreadable photo | "No photo", no URL asked / "Image unavailable", rest of row intact | `shows a "No photo" box…`, `shows "Image unavailable" in its row and still renders the rest` |
| Ages at the unit boundaries, a future time | the eight `reads an age of … ms as …` cases | `reads an age of %i ms as "%s"` |
| The device's timezone used by mistake | 23:30 UTC in an `Asia/Tokyo` building shows "Oct 24, 2026" and "8:30" | `formats the received time in the building’s timezone and locale, not the device’s` |
| Ages frozen while the page stays open | 1 min → 2 min after 60 s of fake time, no new request | `moves the age on while the page stays open, without asking again` |
| A control character in the unit search | message, no units request | `refuses control characters without asking for units` |
| Typing after choosing a unit | the choice drops; the list asks without `unit_id` | `drops the chosen unit when a new search is typed` |
| Going back to a filter seen before re-fetches all its pages | exactly one request, one row | `starts a filter combination seen before from its first page`. Mutation probe: without `gcTime: 0` it fails with `expected [ <li …>, … ] to have a length of 1 but got 2`; restored, it passes |
| First load, refresh, next page fail | three distinct alerts; rows kept on refresh and next page | `shows a failed first load with Try again…`, `keeps the rows when a refresh fails`, `shows more with the next cursor, and keeps the rows when the next page fails` |
| 429 on first load, refresh, next page | the shared rate-limit message | `shows the rate-limit message on a 429`, `review round 1 › … when a refresh gets a 429…`, `review round 1 › … when Show more gets a 429…` |
| The list polls | no request in 5 minutes of fake time | `does not poll` |
| A mutation's invalidation misses the list | `['b', id, 'packages']` prefix refetches it | `keys the list under the building’s packages…` |
| Access to the building is lost (tenant row 3) | the building closes ("no longer have access") | `closes the building when the list answers building_not_found` |
| One building's rows shown in another | after a switch, Birch shows loading, never Maple's rows | `shows nothing of one building’s list after switching to another` |
| A long unit name widens the page | fieldset `min-w-0`, labels wrap | `review round 1 › lets the unit picker shrink and wrap a long unit name` (classes only; the measurement is Chromium evidence, §6) |
| Long text widens a row | `[overflow-wrap:anywhere]` | `wraps long names, descriptions and carriers instead of widening the row` (class only; measured on the stack, criterion 10) |

**Acceptance criteria → tests**

1. Ratchet 281 (`scripts/base44-count.sh`), and a grep showing no package file calls `SendEmail`/`SendSMS` (PR evidence).
2. The seven tests in `the route and its access`, plus the stack run.
3. The `the waiting list` tests.
4. The two `building time` tests.
5. The four `search by unit` tests.
6. The three `filter by carrier` tests.
7. The `the list’s states` tests and the two round-1 429 tests.
8. The `freshness` tests and `frontend/src/test/queryFreshness.test.ts`.
9. The `another building` tests.
10. The stack run on `make prodlike` in the PR (375 px: `scrollWidth 375 = clientWidth 375`; 768 px: 768 = 768;
    photo loaded under the production CSP, no console errors), plus round 1's Chromium proof after the fix.
11. `shows "Image unavailable" in its row and still renders the rest`.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high effort, fresh session (sole reviewer by James's run instruction) | `5b96146` | MERGE | F1 Medium: a long unit name widens the unit picker past 375 px. F2 Low: a 429 on "Show more" lost the rate-limit message | both fixed in `411c455` |
| 2 | Codex `gpt-6.1-sol`, high effort, new fresh session | `411c455` | MERGE | none | — |

- **F1.** *Failure:* a unit with a 20-character tower and a 20-character label made the picker's `<fieldset>` 368 px
  wide. A fieldset's minimum width is its content by default, so at 375 px the page scrolled sideways
  (`scrollWidth` 384), and at 768 px the fieldset spilled out of its 256 px column. *Fix:* `className="min-w-0"`
  on the fieldset and `[overflow-wrap:anywhere]` on each unit label, in the shared `UnitPicker` (smaller decision
  in §2). *Evidence:* the class test failed, then passed. Re-run on the prod-like build, Codex's Chromium proof
  went from `"scroll":384` and fieldset width 367.89 to `"scroll":375` and 343 at 375 px, and 256 at 768 px.
- **F2.** *Failure:* `Retry-After: 30` on the next page showed only "Could not load more packages." *Fix:* that
  alert uses `rateLimitMessage(waiting.error)` first. *Evidence:* the test failed with `expected 'Could not load
  more packages.' to contain 'Too many requests. Try again in 30 se…'`, and now passes. The refresh-429 neighbour
  already passed before the fix.
- Round 1 also noted that criterion 4's locale is asserted with `en` only. Round 2 checked a French locale with
  Tokyo dates in its own proof (passed). That proof was scratch and is not in the repo.

## 7. Not verified, accepted risks and follow-ups

- **Not verified:** a real tablet (D-06 on staging, if available). Layout is proven only by the Chromium runs at
  375 and 768 px; jsdom tests check classes, not widths. The building-locale assertion in the repo uses `en` only.
  The photo-under-CSP check used one 1×1 PNG uploaded through the API on `make prodlike` (the seed has no photos),
  and was run by this session's script, not by a committed test. The packages E2E is P5-05.
- **Accepted (D1, D2):** only active units can be chosen, and only the six listed carriers; other packages are
  found under "All units" or "All carriers". With the search empty, the picker lists up to 25 units above the list
  on a phone.
- **Accepted (D3):** a colleague's change on another tablet shows only after focus, Refresh or this tablet's own
  mutation (ADR-0012).
- **Accepted (D4):** coming back to the page shows loading rather than the previous rows.
- **Follow-up:** the P3-05 fitness test (every component reading `useBuilding({ passive: true })` also calls
  `useBuildingDenied()`) is carried on to P5-03c; it is added to that ticket in this PR's bookkeeping commit.

## 8. How to change this safely

- **P5-03c/d (log, pickup, return):** after each mutation, invalidate `packagesKey(buildingId)` (the prefix). The
  test `keys the list under the building’s packages…` shows the waiting list follows. Put new panels inside
  `SecurityPackagesPage`'s keyed `div` so a building switch resets them too.
- **Another filter:** add it to `WaitingFilters` and to the query in `useWaitingPackages`. Because `gcTime: 0` is
  on, no cache removal is needed; extend `starts a filter combination seen before from its first page`.
- **Migrating another legacy page** (P5-04's `Packages`): set its `path` in `PAGE_ACCESS`, add its route, and
  `LegacyRedirect` covers the old URL. `shell.test.tsx`'s placeholder list will then need another unmigrated
  example.
- **Touching `UnitPicker`:** the residents transfer and invite flows use it too; run `src/features/residents` as
  well.

## 9. Must explain, then quiz

**Why show times in the building's timezone rather than the device's?** The building is one place with one
clock. A package logged at the desk at 23:30 Tokyo time arrived "on the 24th" for the desk, for the resident, and
in any notice that mentions it (P5-02a's `package.arrived` email renders times in the building's timezone, per the
inbox entry). A device can be set to another zone: a manager checking from abroad, a tablet left on UTC. Formatting
in the device's zone would then show a different day or hour than everyone else sees for the same package.
`frontend/src/features/packages/WaitingList.tsx::WaitingList` builds its `Intl.DateTimeFormat` from `building.timezone` and `building.locale`. The
test `formats the received time in the building’s timezone and locale, not the device’s` proves it with a Tokyo
building. The relative age ("2 h ago") is a difference between two instants, so it doesn't depend on any timezone.

Quiz:

1. Why does the waiting list use `gcTime: 0` instead of removing the next filter's cache before the change, as
   the members list does?
2. A colleague picks up a package on another tablet. When does this tablet's list stop showing it, and why
   doesn't it poll?
3. A resident opens an old `/SecurityPackages` bookmark. Walk through what happens and where it ends.
4. What would break if `min-w-0` were removed from `UnitPicker`'s fieldset?
5. How would you extend the list to show packages waiting more than 3 days in red?

<details><summary>Answers</summary>

1. The unit choice lives inside `useUnitPicker` and changes through several paths (choose, type, "All units", a
   units refetch that drops the unit), so there is no single place to remove the cache first. With `gcTime: 0` an
   unobserved combination disappears at once, so any path back starts from page one (D4; the mutation probe shows
   the test failing without it).
2. On the next window focus, a press of Refresh, or this tablet's own mutation (P5-03c/d will invalidate
   `packagesKey`). ADR-0012 says lists refetch on focus and after mutations and do not poll (only the cheap
   summary and badge endpoints poll, every 30 s); the Refresh button is this ticket's addition for a tablet that
   stays in the foreground (D3).
3. `routes.tsx` renders `LegacyRedirect` for `/SecurityPackages`, which replaces the URL with
   `/security/packages` (query and hash kept). That route's `RequirePageAccess` sees no `security` or
   `property_management` role and sends the resident to `/403`. Test: `still sends a resident on the legacy path to /403`.
4. A `<fieldset>`'s minimum width is its content by default. A long unit name would widen it past a 375 px phone
   (sideways scrolling) and out of its 16rem column at 768 px. Round 1 F1 measured 384 px; the class test
   `lets the unit picker shrink and wrap a long unit name` would fail.
5. In `Row`, compare `now - Date.parse(item.received_at)` with three days (`useNow` already re-renders it each
   minute) and add a class and a text cue, not colour alone. Test it with fake timers, as `moves the age on…` does.

</details>
