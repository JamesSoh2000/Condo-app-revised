# P3-05 — Frontend notification center with polling

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 2 |
| Depends on | P3-03, P2-06 |
| Replaces old | M5-T04 |
| Status | done |

## Goal

The header shows a notification bell with an unread badge. The badge stays fresh by polling every 30 s while
the tab is visible. The panel lists notifications and supports mark-read and mark-all-read, all without Base44
subscriptions.

## Why

This is the user-visible half of the notification system, and the reference for how polling works in this app
([ADR-0012](../adr/0012-polling-not-websockets.md)).

## Scope

- In:
  - **`src/features/notifications/api.ts`:**
    - `useNotificationSummary()`: key `['b', id, 'notifications', 'summary']`,
      `refetchInterval: 30_000`, `refetchIntervalInBackground: false`
    - `useNotifications()`: `useInfiniteQuery` with cursor
    - `useMarkRead()`, `useMarkAllRead()`: invalidate the summary and the list
  - **`NotificationBell.tsx`** (badge, `aria-label="Notifications, N unread"`, polite live region) and
    **`NotificationPanel.tsx`** (list, empty state, "Mark all read", click navigates to `link` and marks read).
  - **Replace** the legacy `NotificationCenter.jsx`, `NotificationHelper.jsx` and `EmergencyListener.jsx`
    subscription usage in the shell. Delete them if nothing else uses them, and lower the ratchet.
  - Building switch shows only the new building's notifications (keys are building-scoped).
- Out:
  - the urgent-notice banner (P6-02)
  - preferences UI (pilot)

## Interfaces

Consumes `notifications_list`, `notifications_summary`, `notifications_read` and `notifications_read_all`.

## Acceptance criteria

Criteria 1–7 are the ticket's, sharpened by framing; 8–12 are added by framing. Tests are Vitest + Testing
Library in `src/features/notifications/*.test.tsx`, rendering the real shell (`src/test/renderApp.tsx`).

1. **Given** a visible tab with the bell showing N unread, **when** the server's `unread_count` changes,
   **then** the badge shows the new count after the next 30 s poll, not before: with fake timers, advancing
   29 s makes no second summary request, advancing to 30 s makes exactly one and the badge updates (Vitest).
   Manual: on the local stack, a notification created server-side shows in the badge within 30 s.
2. **Given** a hidden tab (`document.visibilityState === 'hidden'`), **then** advancing 90 s makes no summary
   request (Vitest). **When** it becomes visible again (a `visibilitychange` event), **then** the summary is
   asked for again at once, without waiting for the next interval.
3. **Given** unread notifications and the panel open, **when** "Mark all read" is pressed, **then** exactly one
   `POST …/notifications/read-all` is sent, then the summary and the list are fetched again (invalidated, not
   edited locally), the badge shows no count (`aria-label="Notifications, 0 unread"`) and no item is marked
   unread. "Mark all read" is disabled when nothing is unread.
4. **Given** an unread notification with a `link`, **when** it is clicked, **then** `POST …/{id}/read` is sent,
   the app navigates to `link`, the panel closes, and the summary is fetched again. A notification with no
   `link` is marked read and the panel stays where it is. A notification that is already read sends no
   request.
5. **Given** a building switch (Maple → Birch), **then** the bell and the panel show only Birch's
   notifications, every notification request goes to `/api/buildings/{Birch}/…`, and Maple's notification
   queries are dropped from the cache (keys `['b', id, 'notifications', …]`, removed with `['b', old]`).
6. **Given** a screen reader, **then** the bell's accessible name is `Notifications, N unread`, a polite live
   region (`aria-live="polite"`) holds the count text and changes when the count changes, and the panel is
   keyboard operable: the bell is a disclosure button (`aria-expanded`, `aria-controls`), each notification
   and "Mark all read" are buttons in tab order, Escape closes the panel and returns focus to the bell.
7. **Given** the ratchet, **then** `NotificationCenter.jsx`, `NotificationHelper.jsx` and
   `EmergencyListener.jsx` are deleted, `frontend/base44-baseline.txt` is lowered to the new count (lower than
   339), and the shell import graph test (`src/app/shellImports.test.ts`) still finds no Base44 code, so no
   `Entity.subscribe` is reachable from the shell.
8. **(added)** **Given** no selected building (the picker, or no active membership), **then** no bell renders
   and no notification request is made (P2-06b: nothing under `/api/buildings/` without one).
9. **(added)** **Given** more than one page, **then** the panel shows "Load more", which fetches the next page
   with `cursor=next_cursor` and appends it; the list is requested only while the panel is open and is not
   polled (ADR-0012).
10. **(added)** **Given** a `link` that is not an app path (`//evil.example`, `https://…`, `/\x`), **then** a
    click marks it read but does not navigate (defence in depth; the API already rejects such links).
11. **(added)** **Given** a failing summary (5xx after retries) or a failing mark-read / mark-all-read,
    **then** the bell still renders without a count, a failed mutation shows an error message in the panel,
    and the badge is not changed by it.
12. **(added)** **Given** an empty list, **then** the panel shows an empty state ("No notifications").

Tenant table (`docs/ENGINEERING_PRACTICES.md` §7): the endpoints and their rows 1–6 are P3-03's and tested
there. On the client, row 3 (another building) is criterion 5 and the "no building" case is criterion 8; row 2
(a 401 while polling) is handled by the shared client middleware (`AuthProvider` sends the user to `/login`),
already tested in P2-06a. Rows 4 and 7–10 don't apply (any member may call these, no body IDs, no state
machine, read is idempotent and covered by P3-03).

## Test plan

- `src/features/notifications/*.test.tsx`
- Manual on the local stack with two browsers (create a notification via the CLI or a later slice).
- Commands: `npm run test`, `npm run typecheck`, `npm run lint`.

## Likely files

`frontend/src/features/notifications/**`, `frontend/src/Layout.jsx` (or the new layout),
`frontend/src/components/NotificationCenter.jsx` (removed), `frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. What do `refetchInterval` and `refetchIntervalInBackground` do, and why do we pause in hidden tabs?
2. Why invalidate the summary after mark-read instead of decrementing the number locally?
3. When would you switch this to SSE?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: 1–7 made measurable (request counts, exact names, which requests and when). 2
  adds the refetch when the tab becomes visible again (ADR-0012 "a refetch on window focus"). 3 adds the
  disabled button when nothing is unread. 4 adds the no-link and already-read cases. Added 8 (no building, no
  requests), 9 (pagination; the list is not polled), 10 (unsafe links), 11 (errors), 12 (empty state).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - The shell already reaches no Base44 code: `src/app/shellImports.test.ts` (P2-06a) walks the import graph
    from `main.jsx`, and none of the three legacy files is imported by anything (checked with grep). So
    "replace the subscription usage in the shell" is already true; this ticket deletes the three files (the
    ticket's "delete them if nothing else uses them") and lowers the ratchet. Basis: code.
  - `EmergencyAlertPopup.jsx` (only used by `EmergencyListener.jsx`) is **kept**: the P6 backlog replaces it
    with the urgent-notice banner (P6-02), out of scope here. It has no Base44 reference. Basis: ticket scope.
  - The bell renders in the header only when the tab has a selected building, so it never asks for a
    building it shouldn't (criterion 8). Basis: P2-06b, autonomous.
  - The list is fetched only while the panel is open, refetched each time it opens, and not polled. Basis:
    ADR-0012 ("lists refetch on focus and after mutations; they do not poll").
- Split: none. Estimate ≈ 300 non-test lines (`api.ts` ~80, `NotificationBell.tsx` ~90,
  `NotificationPanel.tsx` ~110, shell wiring ~10); the deletions don't count toward the limit.
