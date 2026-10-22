# Explanation — P4-08h Header panels at phone width

> **PR:** #111 · **Source revision:** `4d31feeefd30244d6cafe22e63880d26e7f617c9`, the pre-merge PR head this
> explanation was written from and checked against. **Reviewed:** the final review round (1) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 111 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `4d31fee` the diff (`git diff origin/main...HEAD`, 9 paths), the whole of
> `e2e/tests/header-panels.spec.ts`, the changed render blocks of `AccountMenu.tsx`, `NotificationBell.tsx`,
> `NotificationPanel.tsx` and `AppShell.tsx`, and the PR body; ran `npx playwright test header-panels` on the dev
> stack: 16 passed (2 setup + 7 tests × 2 projects), and
> `npx vitest run src/features/notifications/notifications.test.tsx src/app/shell.test.tsx`: 2 files, 93 passed.
> Differences from the plan: two additions while coding, recorded below the PR's Plan (§2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full (short in practice: the change is 13 non-test lines). Tier: 2. Walkthrough variant: B.

## 1. What was built and why

On a phone the notification bell's panel ran off the left edge of the screen. The panel was 320 px wide and
hung from the bell's right edge, and the bell sits to the left of the account button, so on a 412 px Pixel 7 its
left edge landed at about −72 px. Now, below Tailwind's `sm` breakpoint (640 px), both header panels (the bell's
and the account menu) are placed against the header and span it with the header's own 16 px gutters; from 640 px
up they hang under their buttons exactly as before. Long unbroken text (an email, a notification title) wraps
inside the panels. The stub's open question, panels covering the nav links, was decided as acceptable: a tap
outside closes a panel, and the next tap follows a link. A new Playwright spec measures all of it in Chromium.
No backend or API change.

## 2. Decisions

### D1. A panel may cover the nav at phone width

- **Problem or constraint:** an open panel covers the nav links below the header, so a covered link can't be
  followed while it is open (stub scope, second bullet).
- **Chosen:** accepted. Both panels are disclosures that overlay the page on every width; a tap outside closes them
  (the `pointerdown` listener from P4-08f criterion 4), then the link can be followed.
- **Alternatives rejected:** placing the panels below the nav at phone width: the nav wraps to a varying height, so
  the panel's top would need measuring or a separate layout per width, and the panel would then cover the page
  instead.
- **Tradeoffs and accepted limitations:** a covered nav link takes two taps (close, then follow).
- **Basis:** decision rule 3, autonomous (simplest, reversible, matches the P2-06c/P3-05 disclosures).
- **Source:** recorded (ticket Frame notes; PR decision D1).

### D2. Below 640 px the panels are placed against the header, not their button

- **Problem or constraint:** the bell is left of the account button, whose width follows the user's name, so no
  offset from the bell's right edge leaves a fixed amount of room for a 320 px panel.
- **Chosen:** below `sm`, the wrappers around each button are not positioned (`sm:relative` instead of `relative`)
  and the header is (`relative`), so the panel's `absolute left-4 right-4` resolves against the header: 16 px from
  each side. From 640 px, `sm:relative sm:left-auto sm:right-0 sm:w-80` (bell) and `sm:w-64` (menu) restore the old
  placement under the button. Applied to both panels; the account menu already fitted, but would not with a wide
  name.
- **Alternatives rejected:** `max-w-[calc(100vw-2rem)]` on the panel: still anchored to the bell's right edge, so its
  left runs off screen when the account button is wide. `position: fixed` with a measured top: needs the header's
  height in code.
- **Tradeoffs and accepted limitations:** at phone width a panel's horizontal position no longer follows its button.
- **Basis:** autonomous.
- **Source:** recorded (ticket Frame notes; PR decision D2).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Long text wraps with `[overflow-wrap:anywhere]` | `break-all` | breaks words that would fit | convention (`MembershipScreens.tsx`, P4-08a R2 M2) | recorded (PR table) |
| Long-text values injected with `page.route` over the stack's real answers | seed an account with a 254-character email | the seed is shared by every journey and the backend tests | autonomous | recorded (PR table) |
| The header gets `relative` although a probe without it passes | leave the header unpositioned | the header is viewport-wide today, so both give the same box; `relative` keeps the header the reference if the shell ever wraps it | autonomous | recorded (PR table; probe `no-header-relative`) |
| The spec runs in both Playwright projects | `chromium` only | the `mobile` project (Pixel 7) has a touchscreen, so the tap in criterion 3 is a real touch there | convention (`playwright.config.ts`) | recorded (PR table) |

**Framing changes:** criterion 1 gained 320 px, the no-scroll check and the exact place (16 px gutters); added 2
(640 px and 1280 px unchanged), 3 (D1), 4 (long text) and 5 (nothing else changes). None loosened.

**Plan versus final code:** two additions while coding, both recorded below the PR's Plan. (1) `e2e/helpers/test.ts`
also re-exports Playwright's `Locator` type, because specs import from that helper and the e2e `typecheck` refused
the spec without it. (2) The phone check also asserts the panel's own `scrollWidth ≤ clientWidth`: the bell's panel
has `overflow-y-auto`, which makes its horizontal overflow `auto` as well, so unwrapped text would scroll inside the
panel and never widen the page. Otherwise the code matches the Plan.

## 3. How it is implemented

### Overview

- `frontend/src/app/AppShell.tsx::AppShell`: the `<header>` is `relative`, the containing block for the panels
  below 640 px.
- `frontend/src/features/notifications/NotificationBell.tsx::NotificationBell` and
  `frontend/src/app/AccountMenu.tsx::AccountMenu`: each wrapper `<div ref={root}>` is positioned only from 640 px
  (`sm:relative`).
- `frontend/src/features/notifications/NotificationPanel.tsx::NotificationPanel` and the account menu's panel
  `<div id={panelId}>`: `left-4 right-4` below 640 px, `sm:left-auto sm:right-0 sm:w-80`/`sm:w-64` from there.
- `e2e/tests/header-panels.spec.ts`: measures the boxes at 320, 375, 412, 640 and 1280 px.

### Walkthrough (variant B: tapping the bell on a 375 px phone)

1. **The action.** The user taps the bell button in `NotificationBell`. Its `onClick` sets `openAt` to the current
   location key; nothing about opening changed in this ticket.
2. **Rendering.** `NotificationPanel` renders a `<section>` with `absolute left-4 right-4 … mt-2`. An absolutely
   positioned box is placed against its nearest positioned ancestor. Below 640 px the wrapper `div` has no
   `position` (only `sm:relative`), so that ancestor is the `<header>` (`relative`). `left: 1rem; right: 1rem` then
   make the panel the header's width minus 16 px each side: on 375 px, from x = 16 to x = 359.
3. **Vertical position.** No `top` is set, so the panel keeps its *static position*: where it would sit in normal
   flow, just under the button inside the wrapper, plus `mt-2`. That is unchanged from before.
4. **At 640 px and wider** `sm:relative` makes the wrapper the containing block again, and `sm:left-auto
   sm:right-0 sm:w-80` put the panel's right edge on the wrapper's right edge with its old width: the desktop
   look before this ticket.
5. **Long text.** Each notification's button and the account menu's "Signed in as" line carry
   `[overflow-wrap:anywhere]`, so a word with no spaces breaks at the panel's edge instead of overflowing it.
6. **Closing.** Unchanged: Escape, the button again, a `pointerdown` outside the wrapper, or a navigation (the
   panel is open only at the location key it was opened at). The panel is still inside the wrapper in the DOM,
   so a tap on it doesn't count as "outside", even though its box is now laid out against the header.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/app/AppShell.tsx` | header `relative`; doc comment | +2 −2 |
| `frontend/src/app/AccountMenu.tsx` | wrapper `sm:relative`; panel placement; email wraps | +5 −3 |
| `frontend/src/features/notifications/NotificationBell.tsx` | wrapper `sm:relative` | +2 −1 |
| `frontend/src/features/notifications/NotificationPanel.tsx` | panel placement; items wrap | +3 −2 |
| `e2e/tests/header-panels.spec.ts` | new spec, 7 tests per project | +159 |
| `e2e/helpers/test.ts` | re-exports `Locator` | +1 −1 |
| `e2e/README.md` | the spec's row | +1 |
| `docs/tickets/P4-08h-header-panels-at-phone-width.md`, `docs/tickets/README.md` | framing, status | |

**Key excerpts**

`frontend/src/features/notifications/NotificationPanel.tsx::NotificationPanel`

```tsx
    <section
      id={id}
      aria-label="Notifications"
      // As the account menu: across the header below 640 px, under the bell from there up (P4-08h).
      className="absolute left-4 right-4 z-10 mt-2 flex max-h-[28rem] flex-col gap-2 overflow-y-auto rounded border bg-white p-3 shadow sm:left-auto sm:right-0 sm:w-80"
    >
```

- Below 640 px the panel's horizontal box comes from `left-4 right-4` against the header; from 640 px the `sm:`
  classes take over (D2).
- Without the `sm:` overrides, `left: 1rem` would still apply on desktop: probe `no-sm-right` (dropping
  `sm:left-auto sm:right-0`) made the 640/1280 tests fail, 4 of 4.

`frontend/src/features/notifications/NotificationBell.tsx::NotificationBell` (the wrapper; the account menu's is the
same)

```tsx
  return (
    // Not positioned below 640 px, so the panel is placed against the header (P4-08h).
    <div ref={root} className="sm:relative" onKeyDown={onKeyDown}>
```

- This is the line that lets the panel escape the button's box at phone width. With plain `relative` (as on
  `main`) the panel would be placed against this narrow wrapper and `left-4 right-4` would squeeze it to the
  button's width minus 32 px.

`frontend/src/app/AccountMenu.tsx::AccountMenu` (panel)

```tsx
        <div id={panelId} className="absolute left-4 right-4 z-10 mt-2 flex flex-col gap-3 rounded border bg-white p-3 shadow sm:left-auto sm:right-0 sm:w-64">
          <p className="text-sm text-slate-600 [overflow-wrap:anywhere]">Signed in as {me?.user.email}</p>
```

`e2e/tests/header-panels.spec.ts::expectPhoneFit`, the check behind criteria 1 and 4

```ts
async function expectPhoneFit(page: Page, panel: Locator, label: string) {
  await expect(panel).toBeVisible();
  const { clientWidth, scrollWidth } = await viewport(page);
  const rect = await box(panel);
  expect(rect.left, `${label} left`).toBeGreaterThanOrEqual(0);
  expect(rect.right, `${label} right`).toBeLessThanOrEqual(clientWidth);
  expect(rect.left, `${label} left`).toBeCloseTo(16, 0);
  expect(rect.right, `${label} right`).toBeCloseTo(clientWidth - 16, 0);
  expect(scrollWidth, `${label}: horizontal scroll`).toBeLessThanOrEqual(clientWidth);
  // The bell's panel scrolls itself (`overflow-y-auto` makes x `auto` too): text wider than it would scroll inside it.
  const inner = await panel.evaluate((element) => ({ scrollWidth: element.scrollWidth, clientWidth: element.clientWidth }));
  expect(inner.scrollWidth, `${label}: scrolls sideways`).toBeLessThanOrEqual(inner.clientWidth);
}
```

- The last two lines are why the wrap is tested for the bell: the page-level check alone could never fail for a
  panel that scrolls itself (Plan versus final code, (2)).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Bell panel off the left edge on a phone | placed against the header, 16 px gutters | `inside the viewport at {320,375,412} px` (red on `main`: left −118.7, −91.4, −72.3) |
| Smallest phone width, 320 px | same rule | `inside the viewport at 320 px` |
| The breakpoint itself, 640 px | `sm:` classes apply: under the button, inside the viewport | `wider screens keep the panels under their buttons at 640 px` |
| Desktop placement moved by the fix | `sm:left-auto sm:right-0 sm:w-80`/`sm:w-64` | `… at 1280 px`; probe `no-sm-right`: 4 failed |
| 254-character email with no spaces | wraps (`[overflow-wrap:anywhere]`) | `long text wraps inside the panels`; probe `nowrap-menu`: 2 failed |
| 200/1000-character title/body with no spaces | wraps inside the panel, no sideways scroll in it | same test; probe `nowrap-panel`: 2 failed |
| A covered nav link can't be followed | tap below closes the panel without navigating; next tap follows | `a tap below an open panel closes it, and the next tap follows a nav link` (passes on `main` too: D1 keeps that behaviour) |
| Escape, focus return, outside click/touch | unchanged | `notifications.test.tsx` "opens as a disclosure; Escape closes it and returns focus to the bell", "closes on a click outside", "criterion 4: a touch outside …" |

Acceptance criteria → tests:
1. `inside the viewport at {320,375,412} px`, both projects.
2. `wider screens keep the panels under their buttons at {640,1280} px`.
3. `a tap below an open panel closes it, and the next tap follows a nav link`; Escape by the Vitest tests above.
4. `long text wraps inside the panels`.
5. `make check` (2214 backend, 844 frontend tests) and the full `make e2e`, 28 passed (PR evidence table).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` (high), fresh session | `4d31fee` | MERGE | none | nothing to fix |

Codex ran the frontend lint, typecheck and tests (844 passed), a build, the e2e lint and typecheck, the Playwright
suite and its own 48-check browser script. Its note: an interrupted E2E run of its own refreshed the ignored
`e2e/.auth` cookie files; no tracked file changed.

## 7. Not verified, accepted risks and follow-ups

- **iOS Safari** is not checked; only Chromium (desktop, and Pixel 7 emulation with touch). The criteria name
  Chromium.
- **Widths between 412 and 640 px** are not measured; the same classes apply across that range (below `sm`), but
  no test runs at, say, 600 px.
- **The header itself** with a very long user name (the account button's text) is out of scope; the panels no
  longer depend on the button's width.
- **The `relative` on the header** is not proven by a test: a probe without it passed, because the header is as
  wide as the viewport (§2).
- Accepted (D1): a nav link under an open panel takes two taps.

Tracked only here and in the PR's follow-ups; none needs action now.

## 8. How to change this safely

- Adding a third header panel: put it in a wrapper with `sm:relative` (not `relative`) and give the panel
  `absolute left-4 right-4 … sm:left-auto sm:right-0 sm:w-…`; add it to `header-panels.spec.ts`'s `openHome`.
- Changing the header's padding: the spec expects 16 px gutters (`toBeCloseTo(16, 0)`), so it will fail and tell
  you to move `left-4 right-4` with it.
- Wrapping the header in a narrower or positioned container: the panels follow the header (it is `relative`); run
  `npx playwright test header-panels` at the end.

## 9. Must explain, then quiz

**1. Which element is each panel positioned against below 640 px, and from 640 px up, and why does that keep it
inside the viewport?** Below 640 px, the `<header>` in `frontend/src/app/AppShell.tsx::AppShell`: the button's
wrapper has only `sm:relative`, so it is not positioned, and the nearest positioned ancestor is the header
(`relative`). `left-4 right-4` then pin both sides to the header's box, which is the viewport's width, so the panel
is 16 px in from each screen edge whatever the buttons' widths. From 640 px, the wrapper (`sm:relative`), with the
panel's right edge on it (`sm:right-0`) and its old width; at 640 px and wider there is room to its left, which the
640 px test checks.

**2. Why is a panel covering the nav accepted rather than moved below it?** D1: a disclosure overlays the page at
every width, a tap outside already closes it, and moving it below a nav that wraps to a varying height would need
measuring or a second layout, while still covering the page. The cost is two taps to reach a covered link,
checked by the tap test.

Quiz:

1. Why does the bell's panel not cause a horizontal page scroll even when its text doesn't wrap, and what did the
   spec have to add because of that?
2. The panel is laid out against the header but still lives inside the wrapper in the DOM. Why does that matter for
   closing it?
3. What happens on desktop if you remove `sm:left-auto` but keep `sm:right-0 sm:w-80`?
4. What would break if the wrapper went back to `relative` (without `sm:`)?
5. How would you extend this so the panels sit below the nav on phones instead?

<details><summary>Answers</summary>

1. `overflow-y-auto` makes the panel's horizontal overflow `auto` too, so wide text scrolls inside the panel and
   never adds to the page's `scrollWidth`. `expectPhoneFit` also checks the panel's own `scrollWidth ≤ clientWidth`.
2. The outside-tap listener tests `root.current.contains(event.target)`: a tap on the panel is inside the wrapper
   in the DOM, so it doesn't close the panel, whatever box the panel is drawn in.
3. `left: 1rem` (from `left-4`), `right: 0` and `width: 20rem` are then all set; with `direction: ltr` CSS ignores
   `right`, so the panel would start 16 px from the wrapper's left edge and extend right, off its button and
   possibly off screen. (From the CSS rule for over-constrained boxes; the probe run removed `sm:left-auto` and
   `sm:right-0` together, and made the 640/1280 tests fail.)
4. Below 640 px the panel would be placed against the narrow wrapper, so `left-4 right-4` would make it the
   button's width minus 32 px (or negative), and the phone tests' "16 px from each edge" checks would fail.
5. Give the panel a `top` below the nav (measure the nav's height in a ref and set it, or move the panels' markup
   after `MainNav` in `AppShell`); then update criterion 3's test, since the nav would no longer be covered.

</details>
