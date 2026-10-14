# P3-05 — Frontend notification center with polling

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 2 |
| Depends on | P3-03, P2-06 |
| Replaces old | M5-T04 |
| Status | todo |

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

1. **Given** a new notification created server-side, **when** the tab is visible, **then** the badge updates
   within 30 s (Vitest with fake timers, plus manual).
2. **Given** a hidden tab (`document.visibilityState='hidden'`), **then** no summary requests are made (Vitest).
3. **Given** mark-all-read, **then** the badge goes to 0 and the list items show as read.
4. **Given** a notification click, **then** it navigates to the `link` and becomes read.
5. **Given** a building switch, **then** the panel shows the other building's notifications only.
6. **Given** a screen reader, **then** the badge count is announced politely on change, and the panel is
   keyboard operable (Esc closes, focus returns to the bell).
7. **Given** the ratchet, **then** the Base44 count decreases, and no `Entity.subscribe` remains in the shell.

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

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
