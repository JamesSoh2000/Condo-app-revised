# P4-08f — Account menu and notifications panel follow-ups (from P4-08d)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08d |
| Replaces old | — |
| Status | done |

Created by [P4-08d](./P4-08d-pending-badge-and-onboarding-follow-ups.md) (PR #101) for follow-ups it left out of scope.
Framed 2026-10-22.

## Goal

The account menu's four open Lows and the notifications panel's paging race are fixed, test-first.

## Scope

- In:
  - **Four Lows from P2-06c's account menu** (`frontend/src/app/AccountMenu.tsx`, PR #65 round 3; carried through
    P4-07b, P4-08, P4-08b and P4-08d, which took them only if it touched the menu):
    - Back to the history entry where the panel was opened shows it again (`open = openAt === key`): clear `openAt`
      when the key changes.
    - A `/me`-driven change of the selected building leaves the panel open with new contents: also close it when
      `buildingId` changes.
    - During a building 401/404 the nav hides but the menu still offers "View as" from cached roles: apply the same
      401/404 check in `BuildingChoices` (or in `useCanViewAs`).
    - Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space: use `pointerdown`
      (the bell, `NotificationBell.tsx`, has the same listener).
  - **The notifications panel's "Show more"** (`frontend/src/features/notifications/NotificationPanel.tsx`): it calls
    `fetchNextPage()` without `cancelRefetch: false` and is disabled only while the next page loads, the shape PR #99
    round 2 F1 fixed in `PendingRequests` (a next page cancels a refresh after mark-read and appends to old pages). Not
    verified: write the test first. Also check the failed-refresh case (PR #99 round 3 F1).
- Out: anything else in the menu or the panel.

## First follow-ups (playbook step 8, from P4-08e)

- Pattern "cached answer reused on remount" reached 3 (PR #98 R3 M1, P4-08d R1 F2, P4-08e R1 F2), the third in the PR that
  added its `CLAUDE.md` lesson: the lesson alone didn't stop it. Add a test that enforces it (the playbook prefers one),
  for example a frontend test that lists the building queries a remountable component mounts and fails on any served
  from cache without `refetchOnMount: 'always'`, `gcTime: 0` or `staleTime: 0`, or record in the ticket why none can be
  written.

## Acceptance criteria (framed 2026-10-22)

Account menu (`frontend/src/app/AccountMenu.tsx`):

1. **Back/Forward** (Low 1): open the menu on `/`, follow a nav link (the menu closes), go Back to `/`: the menu stays
   closed (`aria-expanded="false"`, no "Log out"). Forward to the link's page and Back again: still closed.
2. **A `/me`-driven building change** (Low 2): the menu open on Maple; a `/me` refetch ends the Maple membership while
   Birch stays active, so the tab's selection moves to Birch: the menu is closed, at the same location, with no panel.
3. **"View as" during a denial** (Low 3): a council member's menu offers "View as"; then the building answers
   401/404 (a `building_not_found` from any of its requests, or the building's own 404): the nav is hidden and the
   open menu offers no "View as" radios. *(added)* When the building answers again ("Choose again" or a refetch that
   succeeds), "View as" comes back.
4. **Click outside on touch** (Low 4): a `pointerdown` outside the menu closes it (a `pointerType: 'touch'` event with
   no `mousedown`), and a `pointerdown` inside it doesn't. The same for the bell (`NotificationBell.tsx`).

Notifications (`frontend/src/features/notifications/`):

5. *(added; Low 1's neighbour in the bell, which has the same `openAt === key` shape)* Open the bell's panel, follow a
   nav link, go Back: the panel stays closed.
6. **"Load more" waits for a refresh** (the ticket's "Show more"; the button is labelled "Load more"): after a
   mark-read whose list refresh is in flight, "Load more" is disabled; the refresh is not cancelled, and when it
   answers the read notification shows as read. *(added)* Disabled during any list refetch (a focus refetch too), and a
   mark-read while "Load more" is loading ends with the server's list (the notification read).
7. **After a failed list refresh** (PR #99 round 3 F1): a mark-read whose refresh fails (500) with notifications
   already listed shows "Could not refresh notifications." with "Try again" and no "Load more"; "Try again" shows the
   notification as read and brings "Load more" back. (Today a failed refresh with rows listed shows nothing.)
8. *(added, from the remount-cache lesson)* The unread count is asked for again each time the bell mounts
   (`refetchOnMount: 'always'`, as the pending badge): a count changed elsewhere while the bell was unmounted (Back
   from a page outside the shell) isn't served from the 30 s cache.

Fitness test (first follow-up from P4-08e):

9. `frontend/src/test/queryFreshness.test.ts` lists every `useQuery`/`useInfiniteQuery` call under `src/app` and
   `src/features` (non-test). A building query (any whose `queryKey` is not an array literal starting with a string
   other than `'b'`) passes only with `refetchOnMount: 'always'`, `gcTime: 0` or `staleTime: 0` in its options, or with
   an entry in the test's exemption list giving the reason. A new call site with none fails, and so does an exemption
   that no longer matches a call site. Shown failing first (on the summary before criterion 8, and by a mutation
   probe).

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: each Low is written as a given/then (1–4); 1 adds Forward; 3 adds the denial ending;
  4 names the inside case and the bell. Added 5 (the bell's Back, same shape as Low 1), 8 (the bell's count on
  remount, found by the fitness test's inventory), 9 (the follow-up as a criterion). Criterion 2 of the stub became
  6–7, with the focus-refetch and in-flight-next-page neighbours of PR #99 round 2.
- Criteria loosened: none. The stub said "Show more"; the panel's button is "Load more" (code is the truth).
- Tenant table (ENGINEERING_PRACTICES §7): no endpoint changes. Building isolation in the UI is unchanged (the bell is
  keyed by building; queries are `['b', id, …]`).
- Decisions taken (with basis):
  - Low 3 goes into `useCanViewAs` (it then also reads `useBuildingDenied()`), so the nav and the menu share one rule
    (ticket offers either; autonomous: one place).
  - Lows 1–2: the open state is stored as the location key *and* building it was opened at, and cleared when either
    changes, so no render shows it open at a new key and Back can't find it again (autonomous; simplest).
  - Criterion 7 adds a refresh-failed message to the panel: hiding "Load more" alone would leave a stale list with no
    way out but closing the panel (follows `PendingRequests`; convention).
  - Criterion 9 is a static source test: a runtime one only sees the screens a test renders, so a new page would slip
    by. Fail-closed: a key it can't read as non-building counts as a building query (autonomous).
- Estimate: ~60 non-test lines (menu ~15, bell ~10, `useCanViewAs` ~2, panel ~20, summary ~2, comments). No split.
- Split: none.

## Follow-ups (at merge, PR #108)

- **R3-F1 (Medium, open):** `frontend/src/test/queryFreshness.test.ts::inspect` finds query hooks by identifier name only,
  so an aliased import (`useQuery as q`) or a namespace call (`RQ.useQuery`) escapes it. Moved to
  [P4-08g](./P4-08g-staff-invitations-screen.md) "First follow-ups".
- The bell's panel is cut off at phone width and both header panels cover the nav links (seen on the stack, Pixel 7):
  new stub [P4-08h](./P4-08h-header-panels-at-phone-width.md).
- iOS Safari's tap behaviour (Low 4) was checked only with Chromium touch emulation.
