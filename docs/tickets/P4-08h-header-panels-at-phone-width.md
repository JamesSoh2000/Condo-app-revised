# P4-08h — Header panels at phone width (from P4-08f)

| Field | Value |
|---|---|
| Phase / lane | P4 / B |
| Risk tier | 2 |
| Depends on | P4-08f |
| Replaces old | — |
| Status | in progress |

Created by [P4-08f](./P4-08f-account-menu-and-notifications-follow-ups.md) (PR #108) from its stack run.

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

## Acceptance criteria

(Sharpened while framing. "Phone width" means below Tailwind's `sm` breakpoint, 640 px. Measurements are
`getBoundingClientRect()` against `document.documentElement.clientWidth`, in Chromium on the stack.)

1. **Inside the viewport at phone width.** At 320, 375 and 412 px, the open bell panel and the open account menu
   each lie fully inside the viewport (left ≥ 0, right ≤ viewport width), and opening either adds no horizontal
   page scroll (`scrollWidth ≤ clientWidth`). Each spans the header's content box: left = 16, right = viewport
   width − 16 (the header's `px-4`), whatever the width of the buttons beside it.
2. **Wider screens unchanged.** At 640 px (the breakpoint) and 1280 px, the bell panel is 320 px wide with its right
   edge on the bell's wrapper's right edge, and the account menu 256 px wide with its right edge on its button's
   right edge, as before this ticket; at 640 px both also lie inside the viewport.
3. **Covering the nav is accepted (decision, Frame notes).** At 375 px, with either panel open over the nav, a tap
   on the page below the panel closes it without navigating, and the next tap on a nav link ("Residents") follows
   it. Escape still closes the panel and returns focus to its button (unchanged; P4-08f tests).
4. **Long text stays inside (case the stub missed).** At 375 px, an account menu showing a 254-character email
   without spaces, and a bell panel holding a notification whose 200-character title and 1000-character body have
   no spaces, still meet criterion 1: the text wraps inside the panel.
5. **No change elsewhere.** The panels' contents, opening and closing rules and keyboard behaviour are unchanged;
   the existing Vitest suites and E2E journeys pass.

Tenant table (`ENGINEERING_PRACTICES.md` §7): no endpoint and no query changes, so no row applies. The bell stays
keyed by building.

Cases the stub missed: 320 px (the smallest phone width in use); the 640 px breakpoint itself; long unbroken text
(the "overflow at 375 px with long text" pattern, `AGENT_MISTAKES_LOG.md`, P4-08a and P4-08c).

## Test plan

- Playwright (`e2e/tests/header-panels.spec.ts`, both projects): criteria 1–4, measuring the boxes. Long text
  (criterion 4) by rewriting the stack's real `/api/auth/me` and notifications answers in the browser
  (`page.route`), since no seeded account has such values.
- Vitest: the existing `notifications.test.tsx`, `shell.test.tsx` (criterion 5).
- Commands: `make check`, `make e2e`.

## Must explain (learning checkpoint)

1. Which element is each panel positioned against below 640 px, and from 640 px up, and why does that keep it inside
   the viewport?
2. Why is a panel covering the nav accepted rather than moved below it?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened: the stub's criterion became 1 (adds 320 px, the no-scroll check and where the panel
  sits); added 2 (the breakpoint and desktop, so the fix can't move the desktop panels), 3 (the stub's open
  question, decided), 4 (long text) and 5.
- Criteria loosened: none.
- Tenant table: no endpoint; none applies.
- Decisions taken (with basis):
  - **Panels over the nav are accepted (stub's open question; decision rule 3, simplest and reversible).** Both
    panels are disclosures that overlay the page on every width (P2-06c, P3-05), and a tap outside already closes
    them (`pointerdown`, P4-08f criterion 4). Moving them below the nav would need the nav's height (it wraps) or a
    different layout per width, for no gain: a panel below the nav still covers the page. A covered nav link takes
    two taps (close, then follow); recorded in criterion 3.
  - **Below 640 px, both panels are placed against the header, not their button (autonomous).** The bell sits left
    of the account button, whose width follows the user's name, so no offset from the bell keeps a 320 px panel on
    screen. Against the header, `left-4 right-4` gives the header's own gutters. From 640 px up the classes keep
    today's placement. The account menu fits today, but would not with a wide name; one rule for both.
  - **Long text wraps with `[overflow-wrap:anywhere]`** (convention: `MembershipScreens.tsx`, P4-08a R2 M2).
- Estimate: ~15 non-test lines (two panels' classes, two wrappers, the header, two wrap classes). No split.
- Split: none.
