# P4-08d — Pending-requests nav badge and onboarding follow-ups (split from P4-08b)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08b |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | in progress |

Split from [P4-08b](./P4-08b-manager-pending-requests.md) while framing it (2026-10-21): with the badge and
the carried fixes its estimate was ~470 non-test lines. Not framed yet: frame it when it is picked.

## Goal

Managers see how many join requests wait, from anywhere in the app; and the follow-ups left open by the
P4-08a and P4-07b reviews are fixed.

## Scope

- In:
  - The pending count badge on the nav's "Residents" item (`onboarding_summary`), for property managers
    only; refreshed after a decision on `/manage/residents` (P4-08b's mutations invalidate
    `['b', id, 'onboarding-requests']`), and polled like the notification summary (ADR-0012).
  - The carried items below, test-first.
- Out: anything else on `/manage/residents`.

## Acceptance criteria (framed 2026-10-21)

Badge (the nav's "Residents" item, `frontend/src/app/MainNav.tsx`):

1. **Given** a property manager whose building has 3 pending requests (`GET …/onboarding-requests/summary` →
   `{"pending_onboarding_count": 3}`), **then** the nav's "Residents" link's accessible name is "Residents, 3 pending"
   and it shows a "3" badge hidden from screen readers. With 0: the name is "Residents" and no badge. With 120: the
   badge reads "99+" (as the bell) and the name keeps the exact count, "Residents, 120 pending".
2. **Given** a decision on `/manage/residents` (approve or deny; a 200, a 409 or a 500), **then** the summary is asked
   for again, so the badge shows the new count.
3. **Given** a member without `property_management` (a resident; security; council only), **then** no summary
   request is made (exact request list).
4. *(added)* **Given** a property manager who also holds `council` and views as Resident, **then** "Residents" isn't
   listed and no summary request is made; switching back to Management asks for it.
5. *(added)* Polled like the notification summary (ADR-0012): asked again every 30 s while the tab is visible, never
   while it is hidden, and again when it becomes visible even if the last answer is under 30 s old.
6. *(added)* **Given** a summary request that fails (500, or a 403 when the role was just removed), **then** no badge
   shows and the name is "Residents": never the last count.
7. *(added)* **Given** a switch to another building where the member is also a manager, **then** the badge shows
   that building's count (keyed by building).

Carried fixes:

8. **After a decision whose list refresh fails** (500), **then** "Show more" is not offered, only "Try again"
   (as `Members`); "Try again" removes the decided row and "Show more" comes back (PR #99 R3 F1).
9. **The decision's outcome message** wraps any long text (`[overflow-wrap:anywhere]`): at 375 px, a 176-character
   name in "… was approved." doesn't widen the page (checked in Chromium on the stack). *(added, the "overflow at
   375 px" promotion)* A test checks that every element on both `/manage/residents` tabs that can hold a user's name,
   email or reason (each list row, each outcome message, the dialogs) carries the class or sits inside one that does.
10. **`useMyOnboarding` never shows a previous request's details** (PR #98 R3 M1): denied with reason A → `/me` says
    pending → `/me` says denied with reason B, within 30 s: the screen shows B and never A, not even while B loads.
    *(added)* A denied screen left open while another tab resubmits and is denied again shows B once the tab is
    visible again.
11. **`parseJoinCode` matches the whole path** (PR #98 R3 L1): `…/join/MAPLE-2026/garbage`, `…/help?next=/join/MAPLE-2026`
    and `…/help#/join/MAPLE-2026` are refused with the criterion-17 error; the five accepted forms of P4-08a's table
    stay accepted.
12. **The accept-invitation new-account form sends one accept** when submitted twice in one tick. Test first: if it
    is green before any change, the race isn't real; record that and keep the test.

Lessons (playbook step 8):

13. `CLAUDE.md` gains the lessons "list refresh defeated by another fetch" and "focus dropped to body", and rule 4's
    size-estimate lesson is tightened to "estimate a UI component from a measured one of the same kind"; `CLAUDE.md`
    stays within 150 lines and no rule or lesson loses content. The overflow pattern is promoted as criterion 9's test.

## First follow-ups (playbook step 8, from P4-08b)

- Two patterns in `docs/AGENT_MISTAKES_LOG.md` reached promotion; turn each into a `CLAUDE.md` lesson (or a test) in
  this ticket's PR, keeping `CLAUDE.md` within 150 lines:
  - "list refresh defeated by another fetch" (3, all P4-08b): before review, list every other fetch that can
    interleave with a list's refresh: the next page, a focus refetch, a failed refresh, an awaited `onSettled`.
  - "focus dropped to body" (3: P2-06c, P4-07a, P4-08b): check focus after any control or row disappears in a real
    browser, not only jsdom (which loads no CSS and doesn't move focus on `fireEvent.click`).

## First follow-ups (playbook step 8, from P4-08c)

- Pattern "size estimate too low" reached 4 (P4-01, P4-08a, P4-08b, P4-08c) although `CLAUDE.md` rule 4 already says to
  cost the error and race criteria: P4-08c's `Members.tsx` was 256 lines against ~170 (markup again). Tighten the lesson
  in this PR: estimate a UI component from a measured one of the same kind (`PendingRequests.tsx` 120 lines,
  `DecisionDialog.tsx` ~200 before P4-08c's refactor, `Members.tsx` 256) rather than from its behaviours.
- Pattern "overflow at 375 px with long text" reached 2 (P4-08a round 2 M2, P4-08c stack run): every text that can hold
  a user's name, email or reason gets `[overflow-wrap:anywhere]`, including outcome messages, and every flex row of
  inputs needs a basis to wrap. Prefer a test: a check in the residents tests that every `role="status"` message and
  list row carries the class, or a `CLAUDE.md` lesson.

## Carried from P4-08c

- `frontend/src/features/residents/PendingRequests.tsx::PendingRequests`: the outcome message lacks
  `[overflow-wrap:anywhere]`, so "<176-character name> was approved." overflows at 375 px (PR #100 D3, where the same
  bug was found in `Members` on the stack). Fix test-first, check in Chromium.

## Carried from P4-08b

- **Review round 3 F1 of PR #99 (Medium, open at merge; fix test-first):**
  `frontend/src/features/residents/PendingRequests.tsx::PendingRequests`: after a decision whose list refresh fails
  (500), "Show more" loads the older page, which clears the query's error without repairing the first page: the
  "Could not refresh" warning disappears and the decided request stays listed (the server still refuses it with 409).
  Proposed: no "Show more" while `isRefetchError` (only "Try again"). Test: decision → refresh 500 → Show more
  absent or disabled; Try again → the decided row is gone.

## Carried from P4-08a (via P4-08b)

- Review round 3 of PR #98, open at merge (fix test-first):
  - **Medium:** `frontend/src/features/onboarding/api.ts::useMyOnboarding` reuses a cached status's details: denial A →
    resubmit in another tab → denial B within 30 s shows A's reason. Proposed: `staleTime: 0`.
  - **Low:** `frontend/src/features/onboarding/JoinCodeForm.tsx::parseJoinCode` accepts `/join/<code>` anywhere in a
    link (`…/join/MAPLE-2026/garbage`, `…?next=/join/MAPLE-2026`). Proposed: match the whole pathname `/join/<code>/?`.
- Likely the same race as PR #98 round 1 M2 in `frontend/src/features/auth/pages/AcceptInvitePage.tsx`: its `guarded`
  checks `inFlight` but `accept` sets it after react-hook-form's async validation, so two submits of the new-account
  form in one tick may send two accepts. Not verified: write the test first.

## Carried from P4-07b (via P4-08, P4-08b)

- **Four Lows from P2-06c's account menu** (`frontend/src/app/AccountMenu.tsx`, PR #65 round 3). Fix them
  test-first if this ticket touches the menu (the badge sits in the nav, not the menu):
  - Back to the history entry where the panel was opened shows it again (`open = openAt === key`): clear
    `openAt` when the key changes.
  - A `/me`-driven change of the selected building leaves the panel open with new contents: also close it
    when `buildingId` changes.
  - During a building 401/404 the nav hides but the menu still offers "View as" from cached roles: apply the
    same 401/404 check in `BuildingChoices` (or in `useCanViewAs`).
  - Click outside listens to `mousedown`; iOS Safari may send none for a tap on empty space: use `pointerdown`.

## Must explain (learning checkpoint)

1. Why is the badge's count polled while the pending list is only refetched on focus and after a decision?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1 (exact names, the 0 and 99+ cases), 2 (every outcome), 3 (which roles, exact request
  list); added 4 (council "view as"), 5 (polling, ADR-0012), 6 (failed summary), 7 (building switch); carried items
  written as criteria 8–12 with their tests; 9 adds the overflow test (the P4-08c promotion); 13 the lessons.
- Criteria loosened (with reason; also listed in the inbox): criterion 9's test, while implementing: framed as "every
  list row and every `role="status"` / `role="alert"` message", narrowed to the elements that can hold a user's name,
  email or reason. The others ("Loading requests…", "Could not refresh the requests.") are fixed short texts, which
  is the scope of the pattern in `docs/AGENT_MISTAKES_LOG.md` ("every text that can hold a user's name, email or
  reason").
- Tenant table (ENGINEERING_PRACTICES §7): no new endpoint. The summary endpoint's rows (role 403, cross-building 404,
  unauthenticated) are in `backend/tests/onboarding/test_decisions.py` (P4-05b).
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - The badge component is rendered inside the "Residents" nav item, so the query exists only while the item is
    listed (criteria 3, 4): role, feature and "view as" filtering come from `navPages` for free (autonomous; simplest).
  - Summary key `['b', id, 'onboarding-requests', 'summary']`, under `useDecide`'s invalidation prefix (ticket: "P4-08b's
    mutations invalidate `['b', id, 'onboarding-requests']`").
  - Criterion 10 goes beyond the proposed `staleTime: 0`: alone it would still show A's cached reason while B loads
    (the screen renders `data` as soon as there is any). Also `gcTime: 0`, so a status screen that unmounts drops its
    answer (autonomous; recorded in the PR).
  - The four AccountMenu Lows from P2-06c stay out: the ticket takes them only if it touches the menu, and the badge
    is in the nav (ticket). They will go to a new stub ticket in step 6, with the notifications panel's "Show more"
    (`NotificationPanel.tsx`: `fetchNextPage()` without `cancelRefetch: false`, disabled only while fetching the next
    page), a neighbour of criterion 8 outside this ticket's scope, not verified.
- Estimate: ~90 non-test lines (badge hook ~20 and nav item ~30, measured against `NotificationBell.tsx`'s count
  markup; carried fixes ~25; `CLAUDE.md` ~10). No split.
- Split: none.
