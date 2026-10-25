# Explanation — P6-02e List focus fixes ("Load more", the feed card)

> **PR:** #133 · **Source revision:** `427bb63`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 133 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read `git diff origin/main...HEAD` (all 19 paths), the whole of
> `frontend/src/features/lists/useLoadMore.ts`, the changed components and the assertions of every test cited
> below, at `427bb63`; ran `npx vitest run src/features/lists src/features/notices src/features/packages
> src/features/residents`: 19 files, 642 tests passed. The Chromium transcript in §5 is from the PR (run on the
> scratch stack after the round 1 fix), not re-run for this text. Differences from the plan: none (see §2).
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B.

## 1. What was built and why

Seven lists page their rows with a "Load more" (or "Show more") button that is `disabled` while any fetch is out
and disappears after the last page. In Chromium a focused button that becomes disabled or is removed drops
keyboard focus to `<body>`, so a keyboard user pressing it lost their place on every press. A new shared hook,
`frontend/src/features/lists/useLoadMore.ts::useLoadMore`, parks focus on the last row before the button
disables, then moves it to the first new row when the page lands (or back to the button if it failed, or to the
list's heading if nothing was added). Separately, a feed card that holds focus and is removed by a refresh now
hands focus to the page's heading, as the manager's rows already did. Both were carried from P6-02c's review.

## 2. Decisions

### D1. One shared hook in a new `features/lists/` folder

- **Problem or constraint:** seven components share the same `hasNextPage && <button disabled={isFetching}>`
  shape; P6-02c's review round 1 said "one fix for all of them belongs in one place".
- **Chosen:** `useLoadMore(query, focusHeading)` returning `listRef`, `buttonRef` and `onClick`, in
  `frontend/src/features/lists/`, since no shared feature folder existed (`features/` is by domain).
- **Alternatives rejected:** a `<LoadMoreButton>` component: the hook also needs the list element and the
  heading, which live in each list's own markup, so a component would still need refs passed in. Copying the
  logic into each list: seven copies of the same race-prone code.
- **Tradeoffs and accepted limitations:** a new folder holding one file.
- **Basis:** review finding (P6-02c round 1 F2), autonomous.
- **Source:** recorded (PR #133 D1; ticket Frame notes D1).

### D2. Park focus on the last row, then find the first new row by position

- **Problem or constraint:** the button disables while the page loads, which drops focus on every press, not only
  the last page. After the page lands, focus should go to what was added.
- **Chosen:** on a press that left focus on the button, focus the last row shown (rows now have
  `tabIndex={-1}`), remember the row count, and after the landing commit focus `ul.children[count]`.
- **Alternatives rejected:** `aria-disabled` instead of `disabled`, so the button keeps focus: it changes every
  list's existing disabled behaviour and its tests (`toBeDisabled`), outside the ticket's "Out: any other change
  to these lists". Finding the new row by item id: the hook would need each list's item type and key.
- **Tradeoffs and accepted limitations:** a refresh that reorders or removes rows during the load can land focus
  on another row (never `<body>`). Rows become focusable by click, which is harmless.
- **Basis:** CLAUDE.md lesson (a control that disables itself drops focus), autonomous.
- **Source:** recorded (PR #133 D2; ticket Frame notes D2).

### D3. A stale focus flag hands focus on only if focus is on `<body>` (review round 1 F1)

- **Problem or constraint:** a card or row tracks "focus is inside me" with `onFocus`/`onBlur`. A removed node fires
  no blur, so when a refresh removed only a focused child (a "Mark as read" button after another tab read the
  notice), the flag stayed true. A later removal of the card then took focus from wherever the user had moved it.
- **Chosen:** the unmount cleanup calls `onFocusLost` only if `document.activeElement === document.body`, in both
  `frontend/src/features/notices/NoticeList.tsx::Card` and `frontend/src/features/notices/ManagerNoticeList.tsx::Row`.
- **Alternatives rejected:** tracking `focusout` on each child, or a `MutationObserver` for removed focused children:
  both are more code for the same answer; what matters is whether focus is lost now.
- **Tradeoffs and accepted limitations:** none recorded.
- **Basis:** review finding (round 1), test result.
- **Source:** recorded (PR #133 "Decisions and alternatives" table; "Independent review" round 1).

Smaller decisions:

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Move focus at landing only if it is still on the parked row or on `<body>` | always move | it would take focus from a user who tabbed on during a slow load | autonomous | recorded (PR) |
| A failed page focuses the button again | focus the alert | the button is the retry, and the alert is `role="alert"`, announced anyway; same as the feed's "Mark as read" (P6-02c criterion 9) | convention | recorded (PR) |
| The feed card's fallback is the feed page's `h1` | the "no longer available" alert | the ticket says the heading | ticket | recorded (PR) |
| Out of scope: a "Load more" disabled by a background refresh while focused, and the notifications panel's "Load more" | fix them here | no press is involved in the first (the hook sees only presses); the second is not in the ticket's scope | ticket scope | recorded (Frame notes D3) |

**Framing changes:** criterion 1 now names the seven components, each one's fallback heading and the parking
step. Added 4 (a page that is not the last), 5 (a failed page), 6 (focus not on the button at the press, or moved
during the load), 7 (the feed unmounting). Nothing loosened. The tenant table does not apply (no endpoint).

**Plan versus final code:** compared the PR's Plan with the code at `427bb63`. The hook, the wiring, the row
`tabIndex`, the new heading refs and the card's `onFocusLost` are as planned. The round 1 fix (D3) added the
`<body>` check to both cleanups, and the same check to `frontend/src/features/notices/ManagerNoticeList.tsx::Row`, which the plan didn't touch
beyond the hook; recorded in the PR's review section.

## 3. How it is implemented

### Overview

- `useLoadMore` owns two refs (the `<ul>` and the button), one piece of state (`landed`) and the click handler.
- Each list passes its infinite query and a "focus my heading" callback, attaches `listRef` and `buttonRef`, and
  replaces its inline `fetchNextPage` call with `more.onClick`. The `disabled={isFetching}` rule is unchanged.
- Rows (`<li>`) get `tabIndex={-1}` so script can focus them; Tab still skips them.
- `MyPackageList` and `PendingRequests` get a heading ref and `tabIndex={-1}` on their `h2` (the latter is
  `sr-only`, as `Members`' heading already was).
- The feed card copies the manager row's focus tracking and reports to a new `NoticeList` prop, `onFocusLost`,
  which `NoticesPage` wires to its `h1`.

### Walkthrough (variant B: a keyboard user presses "Load more" in the feed)

1. **The control.** `/notices` renders `frontend/src/features/notices/NoticesPage.tsx::Notices`, whose `NoticeList` shows the cards and, when
   `query.hasNextPage && !query.isRefetchError`, the button with `ref={more.buttonRef}` and `onClick={more.onClick}`.
2. **The press.** `useLoadMore`'s `onClick` checks `document.activeElement === event.currentTarget`
   (criterion 6: a mouse press in a browser that does not focus buttons is left alone). It reads the row count
   from `listRef.current.children`, focuses the last row (or calls the heading callback if there is none), and
   records what is focused now as `parked`.
3. **The fetch.** It calls `query.fetchNextPage({ cancelRefetch: false })`, exactly as the lists did before. React
   Query sets `isFetching`, the button re-renders `disabled`; focus is already on the row, so nothing is lost.
4. **Landing.** When the promise settles, the handler sets `landed` to `{ rows, parked, failed }`, `failed` being
   the result's `isFetchNextPageError`. The re-render this state change causes reads the query's current data, so
   the new rows are in the same commit.
5. **The effect.** After that commit, the effect returns early if focus is neither on `parked` nor on `<body>`
   (the user moved on). Otherwise it focuses the button if the page failed, else `listRef.current.children[rows]`
   (the first new row) if it exists and is connected, else calls the heading callback.
6. **States.** Not the last page: the first new row is focused and the button comes back enabled below. The last
   page: the button is gone, focus is on the first new row. An empty page: the heading.

The card path: `frontend/src/features/notices/NoticeList.tsx::Card` sets `focused` on `onFocus` and clears it on `onBlur`. If the card unmounts
(a refresh dropped it) while `focused` is true and focus is now on `<body>`, its cleanup calls `onFocusLost`,
which focuses the "Notices" `h1`.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/features/lists/useLoadMore.ts` | new hook | +47 |
| `frontend/src/features/notices/NoticeList.tsx` | hook; card focus tracking; `onFocusLost` prop | +24 −6 |
| `frontend/src/features/notices/ManagerNoticeList.tsx` | hook; row `tabIndex`; `<body>` check (D3) | +13 −4 |
| `frontend/src/features/notices/NoticesPage.tsx` | passes `onFocusLost` | +1 −1 |
| `frontend/src/features/packages/MyPackageList.tsx` | hook; heading ref; row `tabIndex` | +11 −4 |
| `frontend/src/features/packages/WaitingList.tsx` | hook; row `tabIndex` | +6 −3 |
| `frontend/src/features/residents/Members.tsx`, `Invitations.tsx` | hook; row `tabIndex` | +6 −3 each |
| `frontend/src/features/residents/PendingRequests.tsx` | hook; heading ref; row `tabIndex` | +10 −4 |
| `frontend/src/features/lists/useLoadMore.test.tsx` | new: criteria 1, 4–6 through a minimal list | +157 |
| six list test files | one criterion 1 test each (two in `myPackages`), F1 tests | +226 |
| `docs/tickets/P6-02e-list-focus-fixes.md`, `docs/tickets/README.md` | frame, status | +39 −11 |

**Key excerpts**

`frontend/src/features/lists/useLoadMore.ts::useLoadMore`

```ts
  const [landed, setLanded] = useState<{ rows: number; parked: Element | null; failed: boolean } | null>(null);
  const heading = useRef(focusHeading);
  heading.current = focusHeading;

  useEffect(() => {
    if (!landed) return;
    const active = document.activeElement;
    if (active !== landed.parked && active !== document.body && active !== null) return;
    const target = landed.failed ? buttonRef.current : listRef.current?.children[landed.rows];
    if (target instanceof HTMLElement && target.isConnected) target.focus();
    else heading.current();
  }, [landed]);

  const onClick = (event: MouseEvent<HTMLButtonElement>) => {
    const pressed = document.activeElement === event.currentTarget;
    const rows = listRef.current?.children.length ?? 0;
    let parked: Element | null = null;
    if (pressed) {
      const last = listRef.current?.children[rows - 1];
      if (last instanceof HTMLElement) last.focus();
      else heading.current();
      parked = document.activeElement;
    }
    void query.fetchNextPage({ cancelRefetch: false }).then((result) => {
      if (pressed) setLanded({ rows, parked, failed: result.isFetchNextPageError });
    });
  };
```

- What it does: the press parks focus and records the row count; the settled fetch sets `landed`, and the
  effect moves focus after the commit that rendered the new rows.
- Why: D2. The focus move happens in an effect on state, not in the `.then`, because the promise settles before
  React has rendered the new rows (the hook's own comment); the state change is what triggers that render.
- What breaks without key lines: without `last.focus()` focus drops to `<body>` while loading (mutation M2 in the
  PR failed the hook's criterion 1 and 6-neighbour tests). Without the early `return` on a moved focus, the user's
  new focus is taken (M3 failed criterion 6). Without `landed.failed ?`, a failed page focuses a non-existent row,
  then the heading (M4 failed criterion 5). Each `landed` is a new object, so two presses each run the effect.

`frontend/src/features/notices/NoticeList.tsx::Card` (the focus tracking)

```tsx
  const focused = useRef(false);
  const lost = useRef(onFocusLost);
  lost.current = onFocusLost;
  useEffect(() => () => void (focused.current && document.activeElement === document.body && lost.current()), []);
  return (
    <li
      ref={cardRef}
      tabIndex={-1}
      onFocus={() => (focused.current = true)}
      onBlur={() => (focused.current = false)}
```

- What it does: React's `onFocus`/`onBlur` bubble, so `focused` is true while focus is anywhere in the card. A
  card removed from the DOM fires no blur, so at unmount a true flag means "I may have held focus".
- Why: criterion 2, as `frontend/src/features/notices/ManagerNoticeList.tsx::Row`. The `document.activeElement === document.body` check is D3:
  the flag alone also stays true after a focused child was removed earlier.
- What breaks without it: without the cleanup, criterion 2's test sees `<body>` (mutation M5). Without the `<body>`
  check, the round 1 F1 tests see the heading take focus from another card or row. When the whole page unmounts
  (criterion 7), `onFocusLost` focuses nothing: the test shows `<body>` afterwards. Inferred: the page's heading ref is
  already detached when the card's cleanup runs.

`frontend/src/features/notices/ManagerNoticeList.tsx::Row` received the same one-line `<body>` check and a
`tabIndex={-1}` on its `<li>`.

`frontend/src/features/lists/useLoadMore.test.tsx` (criterion 1, the hardest)

```tsx
  it('criterion 1: parks on the last row while loading, then the first new row; the button goes after the last page', async () => {
    const api = await setup();
    press();
    expect(document.activeElement).toBe(row('b'));
    await waitFor(() => expect(button().disabled).toBe(true));

    await api.answer({ items: ['c', 'd'], next: null });
    await waitFor(() => expect(document.activeElement).toBe(row('c')));
    expect(screen.queryByRole('button', { name: 'Load more' })).toBeNull();
  });
```

- The test's server holds each page until the test answers it, so it can assert the parked focus while the button
  is disabled, and then the landing. jsdom does not drop focus on `disabled`, which is why the Chromium run in §5
  matters for the parking step.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Last page removes the button | focus on first new row | criterion 1 test in each list's file (below) |
| Button disables during the load | focus parked on the last row | `useLoadMore.test.tsx › criterion 1: parks on the last row…`; Chromium: `LI "Focus probe 03"` while loading |
| Last page adds no row | heading | `useLoadMore.test.tsx › criterion 1: a last page with no rows sends focus to the heading`; `myPackages.test.tsx › an empty last page of "Waiting for you" sends focus to its heading` |
| A page that is not the last | first new row, button enabled again | `useLoadMore.test.tsx › criterion 4` |
| The page fails | button | `useLoadMore.test.tsx › criterion 5: a failed page focuses the button again` |
| Press with focus elsewhere | nothing moves | `useLoadMore.test.tsx › criterion 6: a press that left focus elsewhere moves nothing` |
| User tabs on during the load | nothing moves | `useLoadMore.test.tsx › criterion 6: focus moved on during the load stays where the user put it` |
| Parked row lost during the load (focus on `<body>`) | first new row | `useLoadMore.test.tsx › criterion 6 neighbour: a parked row removed during the load…` (simulated with `blur()`) |
| Focused feed card removed by a refresh | the feed's `h1` | `notices.test.tsx › criterion 2: focus in a card the refresh drops moves to the feed’s heading` |
| Unfocused card removed | nothing moves | `notices.test.tsx › criterion 2: a card the refresh drops without focus moves nothing` |
| Card whose focused child went earlier, removed later | nothing moves | `notices.test.tsx › review round 1 F1: …`; `managerNotices.test.tsx › P6-02e review round 1 F1 neighbour: …` |
| Leaving the page with focus in a card | nothing focused | `notices.test.tsx › criterion 7: …` — a guard only: it also passes without the card's tracking (inferred: the heading ref is detached by then) |

Acceptance criteria → tests:

1. `P6-02e criterion 1: …` in `notices.test.tsx`, `managerNotices.test.tsx`, `packages.test.tsx`,
   `myPackages.test.tsx` (two), `members.test.tsx`, `invitationActions.test.tsx` (the `Invitations` list) and
   `residents.test.tsx` (`PendingRequests`); each asserts `document.activeElement` is the first new `<li>` (or the
   heading) and the button is gone. All failed before the hook existed (PR evidence).
2. The criterion 2 tests above.
3. The PR's Playwright Chromium run (375×812, keyboard `Enter` and `Tab`, the cursor request held 1.5 s), on a scratch
   stack after the round 1 fix:
   `feed, while the page loads: LI "Focus probe 03"` → `after the last page: LI "Focus probe 02" | Load more shown: 0`
   → `after the refresh removed that card: H1 "Notices"` → `manager Published, after the last page: LI "Focus probe
   01"`. The same script on `origin/main`'s frontend printed `BODY` at each step.
4. – 7. The `useLoadMore.test.tsx` and `notices.test.tsx` tests in the table.

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome (fixed in commit / dismissed: why) |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol`, high effort (sole reviewer, per James's run instruction) | `ca369c5` | MERGE | Medium: a stale focus flag lets a removed card take focus from another card | fixed in `427bb63`, also in `frontend/src/features/notices/ManagerNoticeList.tsx::Row` |
| 2 | Codex `gpt-6.1-sol`, high effort, fresh run | `427bb63` | MERGE | none | — |

**Round 1 F1.** Failure: focus "Mark as read" on notice A → another tab marks A read → the refresh removes only that
button, with no blur → focus Notice B's "Open" → a later refresh removes A → A's cleanup focuses the "Notices"
heading, taking focus from B. The manager's row had the same flaw (a focused link in a draft body removed by an
edit, then the row leaving). Evidence: the two F1 tests failed first (`expected <h1 …> to be <a aria-label="Open:
Notice 3">`, `expected <h2 …> to be <button …>`) and pass after D3. Codex's round 2 confirmed it fixed in its
own Chromium checks.

## 7. Not verified, accepted risks and follow-ups

- **Chromium coverage per list.** Only the feed and the manager's Published list were driven in Chromium on the real
  API. The other five lists use the same hook and are covered by jsdom tests; Codex's round 2 ran Chromium checks
  over every list on mocked API responses.
- **The parked-row-removed case** is simulated in jsdom with `blur()`, not with a real refresh during a load.
- **Criterion 7's test** cannot fail on the code it describes (see §5); no mutation catches it.
- **Backend tests and `alembic check` were not run locally** (Docker unreachable, inbox PRE-8); this PR changes no
  backend file, and CI's backend job passed.
- **Accepted risk: a refresh reordering rows during a load** can land focus on a different row than the first new
  one (D2). No test.
- **Follow-up: a "Load more" disabled by a background refresh** (a focus refetch) while it holds focus still drops
  focus to `<body>` in Chromium; no press is involved, so the hook does not see it. Will be added to the follow-ups
  in the bookkeeping commit; tracked in the PR until then.
- **Follow-up: the notifications panel's "Load more"** (`features/notifications`) has the same shape and is not
  covered. Same tracking.

## 8. How to change this safely

- **A new paged list:** call `useLoadMore(query, () => headingRef.current?.focus())`, put `ref={more.listRef}` on the
  `<ul>` whose direct children are the rows, `tabIndex={-1}` on each `<li>`, and `ref={more.buttonRef}`
  `onClick={more.onClick}` on the button; give the heading `tabIndex={-1}`. Copy one list's criterion 1 test.
- **Don't wrap rows** in another element between `<ul>` and `<li>`: the hook counts `listRef.current.children`.
- **Changing the button to `aria-disabled`** would make the parking step unnecessary but changes each list's tests
  (D2); `useLoadMore.test.tsx` would then need its parking assertion revisited.
- Tests that tell you if you broke it: `useLoadMore.test.tsx`, each list's `P6-02e criterion 1` test, and the F1
  tests in `notices.test.tsx` and `managerNotices.test.tsx`.

## 9. Must explain, then quiz

The ticket has no "Must explain" questions.

1. Why does the hook move focus in an effect on `landed` rather than directly in the `fetchNextPage` promise's `.then`?
2. Why does the press park focus on the last row instead of leaving it on the button until the page lands?
3. A user presses "Load more", then tabs to the nav while the page loads. Where is focus after the page lands, and
   which line decides it?
4. What would break if we removed `document.activeElement === document.body` from `frontend/src/features/notices/NoticeList.tsx::Card`'s cleanup?
5. How would you extend this to the notifications panel's "Load more"?

<details><summary>Answers</summary>

1. The promise settles before React has rendered the new rows; setting `landed` causes a render that reads the
   query's current data, and the effect runs after that commit, when `listRef.current.children[rows]` exists.
2. The button becomes `disabled` while any fetch is out, and in Chromium a focused element that becomes disabled
   loses focus to `<body>`. Parking on a row that stays mounted avoids that on every press (D2).
3. Still in the nav: the effect returns early because `document.activeElement` is neither `landed.parked` nor
   `<body>` (`useLoadMore`'s first check in the effect; criterion 6 test).
4. A card whose focused child was removed by an earlier refresh keeps `focused` true; removing the card later would
   move focus to the "Notices" heading even though the user is focused elsewhere (round 1 F1; its test fails).
5. In its list component, call `useLoadMore` with the panel's query and a fallback (the panel's heading), attach
   `listRef` to the `<ul>` of rows, `tabIndex={-1}` to each `<li>`, and `buttonRef`/`onClick` to its button; then copy a
   criterion 1 test into `notifications.test.tsx`.

</details>
