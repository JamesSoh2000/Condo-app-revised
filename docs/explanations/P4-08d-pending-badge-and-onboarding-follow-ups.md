# Explanation — P4-08d Pending-requests nav badge and onboarding follow-ups

> **PR:** #101 · **Source revision:** `a472d0e`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 101 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `a472d0e` the diff of every code file (`git diff origin/main...HEAD` for
> `frontend/src/features/residents/api.ts`, `PendingBadge.tsx`, `PendingRequests.tsx`, `frontend/src/app/MainNav.tsx`,
> `frontend/src/features/onboarding/api.ts`, `JoinCodeForm.tsx`, `frontend/src/test/renderApp.tsx`), `CLAUDE.md`'s diff,
> the PR body (no comments or reviews on the PR) and the assertions of every test named below; ran
> `npx vitest run src/features/residents/ src/features/membership/ src/features/auth/pages/AcceptInvite.test.tsx`:
> 5 files, 247 passed. The Chromium journey was not re-run for this text (its transcript is in the PR, run on
> `ff106f2`; round 1's fix changed only query options and the mutation's `onSettled`). Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Property managers now see how many join requests wait, as a red badge on the nav's "Residents" item
(`frontend/src/features/residents/PendingBadge.tsx::ResidentsNavLabel`). It reads "Residents, 3 pending" to a screen
reader, is polled every 30 s like the notification bell (ADR-0012), and is asked for again after every approve or deny.
The ticket also fixed four follow-ups that earlier reviews left open: "Show more" after a failed list refresh, an
outcome message that overflowed at 375 px, a repeated denial that showed the previous denial's reason, and a join-link
parser that accepted `/join/<code>` anywhere in a link. A fifth suspected bug (a double accept on the invitation form)
was tested and isn't real. Three mistake patterns were promoted: two into `CLAUDE.md` lessons, one into a test.

The two decisions that matter most: the badge is a component *inside* the nav item, so only someone who sees the item
asks for the count (D1); and a decision cancels the summary's in-flight fetch before invalidating, because TanStack
Query reuses a first fetch rather than restarting it (D6, review round 1).

## 2. Decisions

### D1. The badge lives inside the "Residents" nav item

- **Problem or constraint:** only property managers may ask for the count (the endpoint answers 403 to others;
  criterion 3), and a council member viewing as Resident doesn't see the item (criterion 4).
- **Chosen:** `MainNav` renders `ResidentsNavLabel` as the Residents link's content; the query lives in that component,
  so it exists only while `navPages` lists the item.
- **Alternatives rejected:** a query in `BuildingNav` with `enabled: hasRole(…)`: it would repeat the role, feature and
  "view as" filtering that `navPages` already does.
- **Tradeoffs and accepted limitations:** the count is tied to the nav being shown; screens without the nav don't poll.
- **Basis:** autonomous (simplest; matches the bell being rendered only for a loaded building).
- **Source:** recorded (PR decision D1; ticket Frame notes).

### D2. `useMyOnboarding`: `staleTime: 0` and `gcTime: 0`

- **Problem or constraint:** PR #98 round 3 M1. A resident denied with reason A, then pending, then denied again with
  reason B within 30 s saw A: the query key `['b', id, 'onboarding', 'me', 'denied']` comes back with A's cached answer.
- **Chosen:** `gcTime: 0` (garbage-collection time: how long an answer nobody is watching stays cached), so an unmounted
  status screen's answer goes at once, plus `staleTime: 0`, so a screen left open asks again on focus.
- **Alternatives rejected:** `staleTime: 0` alone, the review's proposal. It was tried: the remounted screen still
  rendered A's cached reason until B arrived (the test failed with `expected <p data-testid="denied-reason"></p> to be
  null`). Adding a request id to the key: `/me` doesn't carry one.
- **Tradeoffs and accepted limitations:** one more `GET …/onboarding/me` each time a status screen mounts.
- **Basis:** review finding (PR #98 round 3), then a test result.
- **Source:** recorded (PR decision D2).

### D3. The overflow pattern is promoted as a test, not a `CLAUDE.md` lesson

- **Problem or constraint:** the pattern "overflow at 375 px with long text" reached 2 and had to be promoted;
  `CLAUDE.md` was already at its 150-line limit.
- **Chosen:** tests in `residents.test.tsx` that every element on `/manage/residents` that can hold a user's name, email
  or reason carries `[overflow-wrap:anywhere]` or sits inside one that does.
- **Alternatives rejected:** a lesson: the playbook prefers a test, and the line budget was needed for the other two.
- **Tradeoffs and accepted limitations:** jsdom can't measure widths, so the test checks the class; the real width is
  checked in Chromium.
- **Basis:** ticket ("Prefer a test"); playbook step 8.
- **Source:** recorded (PR decision D3).

### D4. The badge item's whole name in one hidden span

- **Problem or constraint:** the first build rendered visible "Residents" plus an `sr-only` ", 3 pending". jsdom named the
  link "Residents, 3 pending", but on the stack Chromium named it "Residents , 4 pending": the `sr-only` span is
  absolutely positioned, Chromium treats it as a block and adds a space before it. No link was named
  "Residents, 4 pending".
- **Chosen:** the visible label and the badge are `aria-hidden`; one `sr-only` span carries `Residents, N pending`.
- **Alternatives rejected:** `aria-label` on the `NavLink`: computed in `MainNav` for one item, and it overrides the
  content for every assistive technology. Leaving it: the criterion names the exact text.
- **Tradeoffs and accepted limitations:** jsdom can't reproduce Chromium's spacing, so the unit test pins the structure
  (only one part is read, and it holds the whole name); the exact name is proved by the stack run only.
- **Basis:** experiment (the stack run).
- **Source:** recorded (PR decision D4).

### D5. Criterion 12 needed no change

- **Problem or constraint:** PR #98 suspected that two submits of the invitation's new-account form in one tick send two
  accepts, because `guarded` reads the in-flight flag before `accept` sets it.
- **Chosen:** no code change. Both submits pass `guarded`, but `accept` checks the flag itself and sets it before its
  first `await`, so the second call returns.
- **Alternatives rejected:** moving the flag into `guarded`: it would fix nothing a test can show.
- **Basis:** test result: the new test is green on the unchanged page and fails (`expected [ …(3) ] to have a length of
  2 but got 3`) when `accept`'s own check is removed.
- **Source:** recorded (PR decision D5).

### D6. Cancel the summary, then invalidate (review round 1)

- **Problem or constraint:** TanStack Query's `fetch` cancels an in-flight fetch only when the query already has data. A
  summary whose *first* fetch is still out when the manager decides is reused by `invalidateQueries`, and it counted
  before the decision: the badge said "1 pending" next to "No pending requests."
- **Chosen:** `useDecide`'s `onSettled` calls `cancelQueries` on the summary key, then `invalidateQueries` on every
  request key, and returns neither.
- **Alternatives rejected:** `refetchQueries({ cancelRefetch: true })` on the summary: same reuse without data.
  `resetQueries`: drops a count already shown, so the badge would blink off. Faster polling: doesn't fix the order.
- **Tradeoffs and accepted limitations:** the list's invalidation starts after the cancel resolves (immediately for an
  idle query).
- **Basis:** review finding (round 1, Codex F1).
- **Source:** recorded (PR decision D6).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Summary key `['b', id, 'onboarding-requests', 'summary']` | A key of its own | Under `useDecide`'s invalidation prefix, so criterion 2 needs no extra invalidation | ticket | recorded (Frame notes) |
| `refetchOnMount: 'always'` on the summary | The client's 30 s stale time | Back to Management within 30 s showed the old count (round 1, Codex F2) | review finding | recorded (PR review log) |
| Badge caps at "99+", the name keeps the exact count | Exact number in the badge | Same as the bell | existing convention | recorded (PR table) |
| No count on a failed summary | Keep the last count | A stale count misleads (bell, P3-05) | existing convention | recorded (PR table) |
| `parseJoinCode` still accepts `//host/join/<code>` | Refuse it | It was accepted before; not asked | autonomous | recorded (PR table) |
| Default summary routes in `frontend/src/test/renderApp.tsx::DEFAULT_ROUTES` | A route in every manager test | Tests about something else would each need it | existing convention | recorded (PR table) |
| AccountMenu Lows and the notifications panel's "Show more" left out | Fix them here | The ticket takes the menu fixes only if the menu is touched | ticket | recorded (Frame notes) |

**Framing changes:** criteria 1–3 sharpened (exact names, 0 and 99+, every decision outcome, which roles); 4–7 added
(council "view as", polling, a failed summary, a building switch); the carried items became 8–12; 13 the lessons. One
narrowing while implementing, recorded in the Frame notes: criterion 9's test covers the elements that can hold a
user's text, not every `status`/`alert` (the others are fixed short texts such as "Loading requests…").

**Plan versus final code:** compared with the PR's Plan. Differences: D4 (the name's structure, from the stack run);
D5 (criterion 12 needed no change to `AcceptInvitePage.tsx`); criterion 9's narrower test; and round 1 added
`refetchOnMount: 'always'` and the cancel in `useDecide` (D6). All are noted below the Plan in the PR or in its review log.

## 3. How it is implemented

### Overview

- `frontend/src/features/residents/api.ts::usePendingSummary`: the summary query (key, polling, refetch on mount and focus).
- `frontend/src/features/residents/PendingBadge.tsx::ResidentsNavLabel`: renders the label, the badge and the hidden name.
- `frontend/src/app/MainNav.tsx::BuildingNav`: puts `ResidentsNavLabel` in the Residents link.
- `frontend/src/features/residents/api.ts::useDecide`: after any decision, cancels the summary, then invalidates the list and the summary.
- The carried fixes: `frontend/src/features/residents/PendingRequests.tsx::PendingRequests` (Show more, message class),
  `frontend/src/features/onboarding/api.ts::useMyOnboarding` (cache times),
  `frontend/src/features/onboarding/JoinCodeForm.tsx::parseJoinCode` (whole path).

### Walkthrough (variant B): a manager approves a request while the badge shows 1

1. **The nav renders.** `BuildingNav` maps `navPages(building, view)` to links. For the `Residents` page it renders
   `<ResidentsNavLabel label="Residents" />` instead of the plain label. `navPages` lists the page only when the
   building's `my_roles` include `property_management` and, for a council member, the view isn't Resident.
2. **The count is asked for.** `ResidentsNavLabel` calls `usePendingSummary(useBuildingId())`:
   `GET /api/buildings/{building_id}/onboarding-requests/summary` (operation `onboarding_summary`, P4-05b), key
   `['b', id, 'onboarding-requests', 'summary']`. It refetches every 30 s while the tab is visible
   (`refetchInterval`, `refetchIntervalInBackground: false`), when the tab becomes visible (`refetchOnWindowFocus:
   'always'`) and each time the component mounts (`refetchOnMount: 'always'`).
3. **It renders.** With `{"pending_onboarding_count": 1}` it renders `<span aria-hidden>Residents</span>`, an
   `aria-hidden` badge "1" and `<span class="sr-only">Residents, 1 pending</span>`. With 0, an error, or no answer yet
   it renders the plain label.
4. **The manager approves** on `/manage/residents`. `DecisionDialog` calls `useDecide`'s mutation
   (`POST …/onboarding-requests/{request_id}/approve`).
5. **Cache.** Whatever the answer (200, 409, 500), `onSettled` cancels any summary fetch still out, then invalidates
   `['b', id, 'onboarding-requests']`: the pending list and the summary are both asked for again. Neither is awaited,
   so the dialog's answer isn't held back.
6. **Result.** The summary answers 0 and the nav item reads "Residents" with no badge.
7. **States.** Loading and errors show the plain label; a 404 `building_not_found` from the summary marks the building
   denied through the query cache's `onError` (`frontend/src/app/buildingDenial.ts::recordBuildingDenial`, unchanged),
   because the key starts with `['b', id]`. At 375 px the badge wraps with the nav (screenshot in the PR).

### Data model changes

None (frontend only; the summary endpoint exists since P4-05b).

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/residents/api.ts` | `usePendingSummary`, `summaryKey`; `useDecide` cancels then invalidates | +30/−3 |
| `frontend/src/features/residents/PendingBadge.tsx` | new: `ResidentsNavLabel` | +25 |
| `frontend/src/app/MainNav.tsx` | Residents item renders `ResidentsNavLabel` | +2/−1 |
| `frontend/src/features/residents/PendingRequests.tsx` | no Show more after a failed refresh; message wraps | +4/−3 |
| `frontend/src/features/onboarding/api.ts` | `staleTime: 0`, `gcTime: 0` | +5 |
| `frontend/src/features/onboarding/JoinCodeForm.tsx` | `parseJoinCode` matches the whole path | +9/−4 |
| `frontend/src/test/renderApp.tsx` | default summary routes | +4/−1 |
| `CLAUDE.md` | rule 4 and two lessons; rewrapped to stay at 150 lines | +46/−46 |
| tests | `badge.test.tsx` (new), `residents.test.tsx`, `MembershipScreens.test.tsx`, `AcceptInvite.test.tsx` | tests |

**Key excerpts**

`frontend/src/features/residents/api.ts::usePendingSummary`

```ts
export function usePendingSummary(buildingId: string) {
  return useQuery({
    queryKey: summaryKey(buildingId),
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/onboarding-requests/summary', {
        params: { path: { building_id: buildingId } },
        signal,
      }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  });
}
```

- The bell's polling options (`frontend/src/features/notifications/api.ts::useNotificationSummary`), plus
  `refetchOnMount: 'always'`.
- Without `refetchOnMount`, the client's 30 s `staleTime` (`frontend/src/app/queryClient.ts::createQueryClient`) lets a
  remounted badge show a count from before the item was hidden (round 1, F2).

`frontend/src/features/residents/api.ts::useDecide` (its `onSettled`)

```ts
    onSettled: () => {
      void queryClient
        .cancelQueries({ queryKey: summaryKey(buildingId) })
        .then(() => queryClient.invalidateQueries({ queryKey: requestsKey(buildingId) }));
    },
```

- Cancels a summary fetch still out, then asks for the list and the summary again (D6).
- Without the cancel, a first summary fetch that started before the decision is reused and its old count stays
  (test "F1: a decision asks again even while the first summary is still out…").
- Returning the promise would make `mutateAsync` wait for the refetch (P4-08b round 1).

`frontend/src/features/residents/PendingBadge.tsx::ResidentsNavLabel`

```tsx
export function ResidentsNavLabel({ label }: { label: string }) {
  const summary = usePendingSummary(useBuildingId());
  // A failed refresh shows no count rather than the last one, as the bell.
  const count = summary.isError ? undefined : summary.data?.pending_onboarding_count;
  if (!count) return <>{label}</>;
  // ...
  return (
    <>
      <span aria-hidden>{label}</span>
      <span aria-hidden className="ml-1 rounded-full bg-red-600 px-1.5 text-xs text-white">
        {count > 99 ? '99+' : count}
      </span>
      <span className="sr-only">{`${label}, ${count} pending`}</span>
    </>
  );
}
```

- `!count` covers 0, no answer and an error: the plain label, so the link's name is "Residents".
- One read part carries the whole name (D4). Splitting the `sr-only` text brings back "Residents , N pending" in
  Chromium (the stack run on the first build). Inferred, not tested: removing `aria-hidden` from the label would make
  the name "Residents Residents, N pending".

`frontend/src/features/onboarding/api.ts::useMyOnboarding`

```ts
  return useQuery({
    queryKey: ['b', buildingId, 'onboarding', 'me', status],
    staleTime: 0,
    gcTime: 0,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/onboarding/me', { params: { path: { building_id: buildingId } }, signal }),
  });
```

- `gcTime: 0` is what keeps reason A off the screen when the denied screen comes back; `staleTime: 0` covers a denied
  screen that stayed open (D2).

`frontend/src/features/onboarding/JoinCodeForm.tsx::parseJoinCode`

```ts
  if (value.includes('/')) {
    // The link's path: its query and fragment cut, then its scheme and host (`https://host`, `//host` or a bare `host`).
    const path = value
      .split(/[?#]/, 1)[0]
      .replace(/^(?:[a-z][a-z0-9+.-]*:)?\/\/[^/]*/i, '')
      .replace(/^[^/]*/, '');
    const match = /^\/join\/([^/]*)\/?$/i.exec(path);
    if (!match) return null;
    value = match[1];
  }
```

- Cuts the query and fragment first, so `…/help?next=/join/X` leaves `/help`; drops the scheme and host (with or
  without a scheme); then the whole path must be `/join/<code>` with an optional trailing slash. `…/join/X/garbage` and
  `…/x/join/X` no longer match.

`frontend/src/features/residents/PendingRequests.tsx::PendingRequests` (the Show more condition)

```tsx
      {requests.hasNextPage && !requests.isRefetchError && (
```

- After a refresh fails, "Show more" would clear the query's error without repairing the first page; now only
  "Try again" is offered, as in `Members` (PR #99 round 3 F1).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Name read wrongly | One hidden-name span, visible parts `aria-hidden` | `badge.test.tsx` "names the count to a screen reader and shows it as a badge" (structure); stack run (exact name) |
| No requests pending | Plain "Residents", no badge | "shows no badge and the plain name with none pending" |
| More than 99 | Badge "99+", name "Residents, 120 pending" | "shows 99+ above 99, with the exact count in the name" |
| Non-manager asks for the count | Item not listed, no query | "a resident / security / council only makes no summary request" (exact request list) |
| Council member views as Resident, then Management | No request while hidden; asks again on return, even under 30 s | "viewing as Resident: no item and no request; Management asks"; "F2: back to Management under 30 s asks again…" |
| Decision of any outcome | Summary asked again | "after an approval / a deny / a 409 / a 500" |
| Decision while the first summary is still out | Cancelled, asked again | "F1: a decision asks again even while the first summary is still out…" |
| Decision while a poll is out | The invalidation cancels it; newer count wins | "F1 neighbour: a decision while a poll is out ends with the newer count" |
| Polling in a hidden tab | None; asked again when visible, even under 30 s | "asks again at 30 s, not before"; "never while hidden, and again as soon as the tab is visible, even under 30 s" |
| Summary fails (500, 403) | No count, not the last one | "a 500 / a 403 shows no count, not the last one" |
| Building switch, and back under 30 s | Each building's own count, asked again | "shows the other building’s count after a switch"; "F2 neighbour: back to a building under 30 s asks again for its count" |
| Show more after a failed refresh | Hidden; Try again repairs the list | `residents.test.tsx` "offers only Try again, which removes the decided row and brings Show more back" |
| Long names at 375 px | Rows, messages, dialogs wrap anywhere | `residents.test.tsx` "pending tab: each row, the outcome message and the dialog", "members tab: each row and the outcome message" (class only); stack run (widths, pending tab) |
| Second denial shows the first reason | Never: cache dropped on unmount, refetched on focus | `MembershipScreens.test.tsx` "denied → pending → denied within 30 s: …", "a denied screen left open shows a newer denial once the tab is visible again" |
| Join link with extra path, a query or a fragment | Refused | `MembershipScreens.test.tsx` "parseJoinCode (17)" table: 4 new refusals, `//condo.example/join/MAPLE-2026` still accepted |
| Double submit of the new-account form | One accept | `AcceptInvite.test.tsx` "the new-account form sends one accept when submitted twice before validation ends" |

Acceptance criteria → tests: 1 the first three rows; 2 "after an approval / a deny / a 409 / a 500" and F1; 3 the
non-manager tests; 4 the "view as" tests; 5 the two polling tests; 6 the failure tests; 7 the building tests; 8 the
Show more test; 9 the two wrapping tests and the stack run; 10 the two denial tests; 11 the `parseJoinCode` table;
12 the double-submit test; 13 `CLAUDE.md` at 150 lines (`wc -l`), with the interleaving-fetches clause added to the
first lesson, a focus lesson, and rule 4's measured-component estimate.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), fresh | `ff106f2` | BLOCK | F1 Medium: a decision could lose the badge refresh. F2 Medium: back to Management showed the old count | Both fixed in `a472d0e` |
| 2 | Codex `gpt-6.1-sol` (high), new and fresh | `a472d0e` | MERGE | None | — |

- **R1 F1.** Inputs: the summary's first fetch is slow and counts 1; the manager approves; the list refreshes to empty.
  Wrong outcome: `invalidateQueries` reused the first fetch, so one summary request was made and the badge stayed at
  "1 pending". Evidence: the F1 test failed on `ff106f2` (`expected 1 to be 2`) and passes on `a472d0e`. Decision D6.
- **R1 F2.** Inputs: count 3, view as Resident, the server's count becomes 7, back to Management within 30 s. Wrong
  outcome: the badge remounted with 3 and made no request. Evidence: the F2 test failed on `ff106f2` (`expected 1 to be
  2`) and passes on `a472d0e`.
- Round 1 also noted that criterion 9's members-tab test opens no dialog. Not changed: the member dialogs use the same
  `Modal` as the decision dialog, whose wrapping the pending-tab test checks.
- Before review, the implementer's own Chromium run found the accessible-name spacing (D4), fixed in `ff106f2`.

## 7. Not verified, accepted risks and follow-ups

- The badge's exact accessible name in a real browser is proved only by the stack run on `ff106f2`; jsdom tests check the
  structure. Not re-run after round 1, whose fix doesn't touch the markup.
- Criterion 9's widths are proved in Chromium for the pending tab only (the outcome message with a 176-character name:
  `scrollWidth 375, clientWidth 375`); the members tab was checked by P4-08c. The tests check the class, not the width.
- The badge isn't announced when it changes (no live region, unlike the bell). Not asked by the ticket; tracked only here.
- Open follow-ups, to be added to a new stub ticket in the bookkeeping commit: the four AccountMenu Lows from P2-06c,
  and `frontend/src/features/notifications/NotificationPanel.tsx`'s "Show more" (calls `fetchNextPage()` without
  `cancelRefetch: false`, disabled only while the next page loads; the same shape as PR #99 round 2 F1). Not verified.

## 8. How to change this safely

- To badge another nav item (say, maintenance requests): add a label component like `ResidentsNavLabel` with its own
  summary hook under the domain's key prefix, render it from `frontend/src/app/MainNav.tsx::BuildingNav` for that page, and add the
  default route in `frontend/src/test/renderApp.tsx::DEFAULT_ROUTES`. Copy `badge.test.tsx`'s criteria 3 and 4 tests:
  they fail if a non-entitled member makes the request.
- If a new mutation changes the pending count (e.g. P4-08e removing a pending member), it must cancel and invalidate the
  summary as `useDecide` does; the F1 test pattern shows how to prove it.
- Changing the summary's polling: `badge.test.tsx`'s criterion 5 tests use fake timers and will tell you.

## 9. Must explain, then quiz

**Why is the badge's count polled while the pending list is only refetched on focus and after a decision?**
ADR-0012 decides it: badge and summary endpoints are cheap indexed counts, polled every 30 s while the tab is
visible; lists refetch on focus and after mutations and do not poll. `usePendingSummary`'s `refetchInterval` follows the
first rule. Inferred: the badge is on every page, and a new request comes from someone else with no event in this tab,
so only polling can show it. The list is only on `/manage/residents`, is paged and heavier, and its
manager is looking at it: it is stale at once (`usePendingRequests`'s `staleTime: 0`), so it refreshes when the tab
regains focus and after each decision (`useDecide`'s invalidation). Inferred: polling a paged list would also fight
"Show more" (the pattern behind criterion 8).

Quiz:

1. A council member who also manages views as Resident. Which code makes sure no summary request is sent?
2. Why does `useDecide` cancel the summary before invalidating, when `invalidateQueries` already cancels in-flight fetches?
3. Why does `useMyOnboarding` need `gcTime: 0`, not just `staleTime: 0`?
4. What breaks if you remove `!requests.isRefetchError` from the Show more condition in `PendingRequests`?
5. How would you extend the badge to announce a new count to screen-reader users as it changes?

<details><summary>Answers</summary>

1. None checks it directly: `navPages` leaves the Residents page out for that view, so `BuildingNav` never renders
   `ResidentsNavLabel`, and the query exists only in that component (D1). Test: "viewing as Resident: no item and no request…".
2. It cancels only when the query has data. A first fetch has none, so it's reused, and it may have counted before the
   decision (D6, round 1 F1).
3. `staleTime: 0` refetches on mount but still renders the cached answer meanwhile, so reason A shows until B arrives;
   `gcTime: 0` removes the answer when the denied screen unmounts, so the next denied screen starts empty (D2).
4. After a decision whose refresh failed, "Show more" would load the next page, which clears the error without
   repairing the first page: the warning goes and the decided request stays listed (PR #99 round 3 F1). The test
   "offers only Try again…" fails.
5. Add a polite live region, as `NotificationBell` does, that says "N pending join requests" when the count changes.
   Keep it outside the link, so the link's name stays "Residents, N pending", and test it in jsdom and on the stack.

</details>
