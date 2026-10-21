# P4-08d — Pending-requests nav badge and onboarding follow-ups (split from P4-08b)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08b |
| Replaces old | part of [P4-08](./P4-08-frontend-onboarding-approval-screens.md) (M4-T08) |
| Status | todo |

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

## Acceptance criteria (to sharpen when framing)

1. **Given** a property manager with 3 pending requests, **then** the nav's "Residents" item reads
   "Residents, 3 pending" to a screen reader and shows a "3" badge; with none, no badge.
2. **Given** a decision on `/manage/residents`, **then** the badge's count is asked for again.
3. **Given** a member without `property_management`, **then** no summary request is made.

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

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
