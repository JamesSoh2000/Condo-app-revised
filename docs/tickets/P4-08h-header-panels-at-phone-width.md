# P4-08h — Header panels at phone width (from P4-08f)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08f |
| Replaces old | — |
| Status | todo |

Created by [P4-08f](./P4-08f-account-menu-and-notifications-follow-ups.md) (PR #108) from its stack run. Not framed yet:
frame it when it is picked.

## Goal

The header's notification panel and account menu fit a phone screen.

## Scope

- In:
  - On a Pixel 7 (412 px wide) in Chromium, the bell's panel (`frontend/src/features/notifications/NotificationPanel.tsx`,
    `w-80`, `right-0` under the bell) is cut off past the left edge of the screen (screenshot in PR #108's stack run).
  - Both open panels cover the nav links below the header, so a link can't be followed with a panel open on a phone.
    Decide while framing whether that is acceptable (a click outside closes the panel first) or the panels should sit
    inside the viewport and below the nav.
- Out: anything else in the menu or the panel.

## Acceptance criteria (to sharpen when framing)

1. At 375 px and 412 px in Chromium, the open bell panel and account menu lie fully inside the viewport
   (`getBoundingClientRect` left ≥ 0, right ≤ viewport width), checked on the stack.
