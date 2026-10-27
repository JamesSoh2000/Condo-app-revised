# Explanation — WF-02a Focus test kit and the pre-review table

> **PR:** #144 · **Source revision:** `bbbd000`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3) reviewed `1dbff28`; `bbbd000` is round 3's own fix
> (one condition, two tests), made after the last round (§2 D5).
> **Merge commit:** not known when written; after the merge, `gh pr view 144 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `bbbd000` the diff (`git diff --stat origin/main...HEAD`), `frontend/src/test/focus.ts`
> and `e2e/helpers/focus.ts` in full, `LogPackageForm.tsx::submit`, the test names and the assertions of the tests
> cited below; ran `npx vitest run` (41 files, 1363 passed), the Chromium helper's own cases with `--repeat-each=3`
> (84 passed), `make e2e DB_PORT=55432 args="tests/focus.spec.ts tests/j4-packages.spec.ts tests/packages-desk.spec.ts"`
> (45 passed), the MF4 and sampler mutations, and criteria 9–11's commands (no output where none is expected). Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: B (UI interaction, for the "Log package" fix) and the helpers' own flow.

## 1. What was built and why

Agents kept shipping one kind of bug to review round 1: a control that disables or removes itself (a submit, a
"Cancel") drops keyboard focus to `<body>` in a real browser, and the jsdom tests passed anyway because jsdom keeps a
disabled element as `document.activeElement`. This PR adds two test helpers that make that failure a one-line test:
`expectFocusKept` for jsdom (`frontend/src/test/focus.ts`, built on `activeElementLikeBrowser`) and for real Chromium
(`e2e/helpers/focus.ts`, with `trackRequests`). It uses them in new tests on the shared `FileUpload` and on the
packages desk, where the Chromium probe found a real drop in "Log package", fixed here. It also adds a "Known failure
cases" table to the PR template, which the implementer fills before the first review.

This is the first half of WF-02, split after WF-02's PR #142 was blocked on its backend half (inbox B-11, James chose
the split). The backend helpers are WF-02b.

## 2. Decisions

### D0. Split WF-02 and merge the focus half on a fresh PR

- **Problem or constraint:** PR #142 built all of WF-02. After three review rounds a High was still open, all of it in
  the backend lock-wait helper (stop rule 4).
- **Chosen:** WF-02a holds everything with no open finding, checked out byte for byte from #142's head `2e8d559`,
  except the docs, where every mention of the backend helper is removed. It goes on a new branch and PR (#144), with
  the review count restarted.
- **Alternatives rejected:** a 4th round on #142 (option b); dropping criteria 5–8 (option c); force-pushing #142's
  branch, which would lose the round-3 code WF-02b starts from.
- **Tradeoffs:** #142 stays open as a record. Criterion 11 (both lessons name their helper) is split: the lock half
  moves to WF-02b with the helper, so `CLAUDE.md` never names a missing file.
- **Basis:** James's answer to B-11 (option a), in session, 2026-10-27.
- **Source:** recorded (PR #144 D0, D0b; `docs/tickets/WF-02a-focus-test-kit.md` Frame notes).

### D1. The Chromium probes hold their request for three frames

- **Problem or constraint:** a local stack answers a create within about a frame, so a submit disabled while the
  request is out never shows the drop. Without a hold, the probe could not fail.
- **Chosen:** `e2e/tests/focus.spec.ts::hold` routes the probe's POST and releases it only after
  `threeFrames` (three animation frames), more than the one-frame budget.
- **Alternatives rejected:** no hold (vacuous: it passed before the fix); CDP network throttling (Chromium-only,
  timing not controlled).
- **Tradeoffs:** three frames model a slow network; they do not measure one.
- **Basis:** experiment on PR #142. Without the hold the probe passed; with it, before the fix, `focus was lost for 4
  frames in a row (on <body>); the budget is 1`.
- **Source:** recorded (PR D1).

### D2. "Log package" parks focus on its status line while the create is out

- **Problem or constraint:** `LogPackageForm` disabled its submit while `create.isPending` and moved focus only after
  a 201, so focus sat on `<body>` during the wait and stayed there after a refusal.
- **Chosen:** `frontend/src/features/packages/LogPackageForm.tsx::submit` focuses the existing status line
  (`statusRef`, now `tabIndex={-1}`, text "Logging…" while busy) just before `create.mutate`. A 201 still moves focus
  to the unit search.
- **Alternatives rejected:** `aria-disabled` on the submit (changes its semantics and styling in every state);
  focusing the `<form>` (nothing useful is announced).
- **Tradeoffs and accepted limitations:** after a refusal, focus is on the (then empty) status line, not on the error
  or its field. A follow-up (§7).
- **Basis:** ticket criterion 4 (a component-local fix under ~30 lines is made here, test-first).
- **Source:** recorded (PR D2).

### D3. `settle` runs outside `act`

- **Problem or constraint:** inside React's `act`, state updates are held until it ends, so a `findBy…` inside
  `settle` would never see the update it waits for. The first `FileUpload` "finishes"/"fails" cases timed out.
- **Chosen:** `frontend/src/test/focus.ts::sampleAfter` runs `action` and each macrotask turn inside `act`, and
  awaits `settle()` plainly (Testing Library's waiters wrap `act` themselves).
- **Basis:** test result. **Source:** recorded (PR D3).

### D4. A Chromium frame is "bad" for more than `<body>`

- **Problem or constraint:** Chromium reports a disabled focused button as `activeElement` for one frame before
  `<body>`.
- **Chosen:** the recorder's `lost` counts `<body>`, a detached element, `:disabled`, inside `[inert]`, failing
  `checkVisibility()` (so `display: none` too, which jsdom can't model), or outside `within`.
- **Basis:** experiment (a frame dump: `BUTTON disabled`, `BODY`, `BODY`). **Source:** recorded (PR D4).

### D5. Round 3's Medium fixed after the last round (autonomous)

- **Problem or constraint:** round 3, the last the playbook allows, said MERGE but confirmed a race in the Chromium
  helper's network check (§6). Later tickets will cite the helper as evidence.
- **Chosen:** apply the reviewer's own one-line fix test-first, and merge without a 4th round.
- **Alternatives rejected:** merging with a known vacuous-pass interleaving as a follow-up; a 4th round (the playbook
  caps rounds at 3, and stop rule 4 applies only to an open Critical or High).
- **Tradeoffs:** `bbbd000` (one added condition in `expectFocusKept`'s poll, one Chromium test, one jsdom test) has
  had no fresh review. Codex ran the same fix on a scratch copy, where its proof passed.
- **Basis:** autonomous; it is also in the inbox's "Decisions to audit". **Source:** recorded (PR D5).

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| `trackRequests(page)` before load; `expectFocusKept` refuses an untracked page | Listeners added by the helper; tracking inside the shared `helpers/test.ts` fixture | Late listeners miss a request already out; editing the shared fixture edits an existing test helper (criterion 10) | review finding (WF-02 R2 F2) | recorded |
| Frames compared by element identity (`WeakMap` id) | By tag and name | Two "Edit" buttons alternating looked stable | review finding (WF-02 R1 F3) | recorded |
| Focus quiet on the page's `performance.now()`, network quiet on the runner's; frames cut by position | One clock (`Date.now()` on both sides) | The clocks differ under `page.clock`; 300 ms shrank to ~140 | review finding (round 1) | recorded |
| A control in a disabled `<fieldset>` (outside its first legend) is `<body>`; a link there is not | Only `[disabled]` | HTML disables form controls through a fieldset, not links | ticket frame note (criterion 1) | recorded |
| The spec's page scripts are in a `{ }` block | Top-level `const` | `setContent` keeps the window; a second page's `const` threw and its script never ran | test result | recorded |

**Framing changes:** criterion numbers are WF-02's. 1–4 carry WF-02's frame notes (1: fieldset and any depth; 2:
leaving `within`, errors propagate, fake timers refused; 3: Cancel removed by a server answer; 4: frames and
"stable" defined). 9 adds "no line names `act_blocked_on_lock` or `lock_wait`". 10 names the one allowed `M` line. The
lock half of 11 moved to WF-02b. None loosened.

**Plan versus final code:** the Plan's helpers are the final ones, with three changes from review rounds 1–3 in
`e2e/helpers/focus.ts::expectFocusKept`: the two-clock timing, the window starting at the first frame seen, and the
second in-flight check. One deliberate deviation is listed in the PR below the Plan: the component fix (D2), which
criterion 4 allows.

## 3. How it is implemented

### Overview

- `activeElementLikeBrowser` corrects jsdom's `document.activeElement` to what Chromium would report.
- jsdom `expectFocusKept`/`expectFocusOn` check focus before the action, run it, then **keep sampling** (after it,
  after `settle`, and at five macrotask turns), so "fine at first, dropped later" still fails.
- Chromium `expectFocusKept` records every animation frame, waits until the page has settled (no request out,
  nothing changed for 300 ms), then judges the frames: the last must be good, and no more than one bad frame in a row.
- New tests use them on `FileUpload` in `Modal` (jsdom) and on the packages desk (Chromium probes), and
  `LogPackageForm` gets the fix the probe called for.
- The PR template's "Known failure cases" table, and the two command files' lines requiring it before the first
  reviewer.

### Walkthrough (variant B): the desk logs a package, in Chromium

1. **The test** (`e2e/tests/focus.spec.ts`, probe `"Log package" keeps focus while the create is out`) calls
   `trackRequests(desk)` before `goto`, fills the form on a unit of its own, focuses the submit and holds the create
   POST (`hold`).
2. **The helper** checks the submit is focused, installs the per-frame recorder, and reads the frame count and page
   time just before the action.
3. **The action** clicks "Log package". `LogPackageForm.tsx::submit` runs: if validation passes, it focuses
   `statusRef` (the `role="status"` line, now "Logging…"), then calls `create.mutate`; React re-renders with `busy`,
   which disables the submit. Focus is already on the status line, so no frame is bad.
4. **The hold** releases the POST three frames later; the 201 handler moves focus to the unit search (unchanged
   code), and the desk's list refreshes.
5. **Settling:** the poll waits while a tracked request is out, re-checks after its frame read, and returns
   `settled` only when the focused element and its bad state haven't changed for 300 ms of page time and no request
   event happened for 300 ms of runner time.
6. **Judging:** the last frame is good, and the longest bad run is 0 (budget 1). The test then asserts the unit
   search is focused.

Before the fix, step 3 left focus on the disabled submit, then `<body>`, for the whole hold: `focus was lost for 4
frames in a row (on <body>)`.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `frontend/src/test/focus.ts` | new: jsdom helpers | +160 |
| `frontend/src/test/focus.test.tsx` | new: their own tests (criteria 1–2) | +369 |
| `frontend/src/features/files/fileUploadFocus.test.tsx` | new: `FileUpload` in `Modal` (criterion 3) | +210 |
| `frontend/src/features/packages/LogPackageForm.tsx` | the focus fix (D2) | +6/−2 |
| `frontend/src/features/packages/logPackageFocus.test.tsx` | new: the fix's jsdom tests | +128 |
| `e2e/helpers/focus.ts` | new: Chromium helpers | +166 |
| `e2e/tests/focus.spec.ts` | new: own-page cases and desk probes (criterion 4) | +376 |
| `e2e/README.md` | the spec's row | +1 |
| `.github/pull_request_template.md` | "Known failure cases" block | +17 |
| `.claude/commands/build-ticket.md`, `implement-ticket.md` | the lines requiring the table | +3, +3 |
| `CLAUDE.md` | helper names in the focus lesson, in place | +1/−1 |
| `docs/tickets/WF-02*.md`, `docs/tickets/README.md` | the split | — |

**`frontend/src/test/focus.ts::activeElementLikeBrowser`**

```ts
export function activeElementLikeBrowser(): Element {
  const active = document.activeElement ?? document.body;
  if (active === document.body || !active.isConnected) return document.body;
  if (active.closest("[hidden], [inert]")) return document.body;
  if (
    active.matches(FIELDSET_DISABLES) &&
    (active.hasAttribute("disabled") || inDisabledFieldset(active))
  )
    return document.body;
  return active;
}
```

- Returns `<body>` where Chromium would: a hidden or inert ancestor at any depth (`closest` includes the element
  itself), a disabled form control, or one a disabled `<fieldset>` disables (`inDisabledFieldset` skips the first
  legend, which HTML leaves enabled).
- Without the `disabled` branch, every "control disables itself" test passes in jsdom: that is the bug class.

**`frontend/src/test/focus.ts::sampleAfter`** (trimmed)

```ts
  await act(async () => {
    await action();
  });
  sample();
  if (settle) {
    // Not inside `act`: React holds updates until an `act` ends, so a `findBy…` or `waitFor` in it (which wrap
    // `act` themselves) would never see them.
    await settle();
    sample();
  }
  let last = lastFocused;
  for (let turn = 0; turn < TURNS; turn++) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    last = sample();
  }
  return last;
```

- Before this, it refuses fake timers and checks focus is on `control` (inside `within`), so a test that forgot to
  focus fails instead of passing vacuously. `sample` throws `focus fell to <body>; last focused: <tag "name">` or
  `focus left <within>; on: …`.
- It never returns at the first good sample: the five turns catch a drop a little after the action.

**`e2e/helpers/focus.ts::expectFocusKept`**, the settle poll

```ts
    const { first, startedAt } = await page.evaluate(() => ({ first: window.__focusFrames!.length, startedAt: performance.now() }));
    await action();
    // ...
        async () => {
          if (network.inFlight.size > 0) return 'a request is in flight';
          const frames = await page.evaluate(() => window.__focusFrames ?? []);
          // Again: a request can start while the read above is out (WF-02a review round 3, Codex).
          if (network.inFlight.size > 0) return 'a request is in flight';
          const after = frames.slice(first);
          if (after.length < 2) return 'too few frames after the action';
          // From the first frame seen, not the read before the action: time no frame ran (a blocked main thread) is
          // not time focus was seen to stay put (WF-02a review round 2, Codex).
          let changed = Math.max(startedAt, after[0].at);
          for (let i = 1; i < after.length; i++) {
            if (after[i].element !== after[i - 1].element || after[i].bad !== after[i - 1].bad) changed = after[i].at;
          }
          const focusQuiet = after[after.length - 1].at - changed;
          const networkQuiet = performance.now() - network.last;
          if (focusQuiet < STABLE_MS) return `focus changed ${Math.round(focusQuiet)} ms ago (page clock)`;
          return networkQuiet >= STABLE_MS ? 'settled' : `a request ended ${Math.round(networkQuiet)} ms ago`;
        },
```

- Every subtraction stays in one clock: `frame.at` and `startedAt` are the page's `performance.now()`; `network.last`
  and the `performance.now()` here are the runner's (Node's). Frames after the action are cut by position (`first`).
- Each line closes a review finding (§6): mixing clocks let 300 ms shrink to ~140; starting the window at `startedAt`
  counted time when no frame ran; checking `inFlight` only before the read missed a request that started during it.
- After `settled`, the code judges the frames: `final.bad` must be false and the longest bad run at most
  `BAD_FRAMES_ALLOWED` (1, fixed: "never raised to make a test pass").

**`e2e/helpers/focus.ts::trackRequests`**

```ts
export function trackRequests(page: Page): void {
  if (tracked.has(page)) return;
  const network: Network = { inFlight: new Set(), last: performance.now() };
  tracked.set(page, network);
  const started = (request: Request) => {
    network.inFlight.add(request);
    network.last = performance.now();
  };
  // ...
  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
}
```

- A `Set` of requests, not a counter (a counter can go negative), started before the page loads so a refresh already
  out is seen. `expectFocusKept` throws `call trackRequests(page) before the page loads` without it.

**`frontend/src/features/packages/LogPackageForm.tsx::submit`** (the fix)

```tsx
    if (picker.chosen === null || carrierValue === null || Object.values(problems).some(Boolean)) return;
    // The submit is about to be disabled, which drops focus to <body> in a browser, for the wait and after a refusal
    // (WF-02 criterion 4's probe): the status line, which stays, holds it until a 201 moves it to the unit search.
    statusRef.current?.focus();
    create.mutate(
```

with the status line `<p ref={statusRef} tabIndex={-1} role="status" …>{busy ? 'Logging…' : logged ? 'Logged ✓' : ''}</p>`.
The validation stop returns before the focus move, so a form with errors keeps focus on its enabled submit.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| jsdom keeps a disabled / fieldset-disabled / hidden / inert element focused | `activeElementLikeBrowser` returns `<body>` | `focus.test.tsx` "criterion 1" cases, incl. `[hidden]` and `[inert]` "at any depth" |
| A test forgot to focus the control | throws before the action | `fails before running the action when the test did not focus the control` |
| Focus fine at first, dropped by a later refresh | samples after `settle` and five turns | `fails when focus is fine after the action and a refresh that \`settle\` awaits drops it`; `keeps sampling after a first good sample…` |
| Fake timers would hang the turns | refused with a message | `refuses to run under fake timers…` |
| `FileUpload`'s "Choose file", "Cancel", "Retry", and "Cancel" on finish/fail | focus stays in the dialog | `fileUploadFocus.test.tsx`, 5 tests |
| "Log package" while the create is out (201, 409 restart, 500) | focus on the status line, inside the form | `logPackageFocus.test.tsx`, 3 tests (they assert focus stays in the form; the 409 one also asserts the unit search is focused; the 201 one's name says "the unit search has it" but only the Chromium probe asserts that) |
| Chromium: no handoff, a removal, a late handoff | fails beyond one bad frame | `the same button with no handoff fails`; `a button removed…`; `a handoff three frames late is not`; `…one frame late is within the budget` |
| A request already out / starting during the frame read | not settled until it ends | `a request already in flight when the helper starts…`; `a request that starts during the frame read…` |
| Page clock not the runner's; paused page clock; a blocked main thread | 300 ms of page time; never settles; window starts at a seen frame | the three "page clock" cases; `an action that blocks rendering…` |
| An untracked page | refused | `a page whose requests are not tracked is refused` |

Acceptance criteria → tests:
1. `focus.test.tsx` "criterion 1" (7 tests). Mutation (returns `document.activeElement`), at `bbbd000`: 7 of 22 in `focus.test.tsx` fail.
2. `focus.test.tsx` "criterion 2" and `expectFocusOn` blocks.
3. `fileUploadFocus.test.tsx` (5). Mutation (`FileUpload`'s status-effect handoff removed): 5 of 5 fail.
4. `e2e/tests/focus.spec.ts` (14 own-page cases, 2 probes, both projects). Sampler mutation (`bad: false && lost(active)`), at
   `bbbd000`: 14 of 28 own-page runs fail (7 per project). `logPackageFocus.test.tsx`: 3 of 3 fail with `origin/main`'s `LogPackageForm.tsx`.
9. The criterion's commands print nothing; `check-links: 266 files, 0 broken link(s)`.
10. Prints only `M frontend/src/features/packages/LogPackageForm.tsx`.
11. Word-diff shows only additions; `wc -l CLAUDE.md` 162 before and after.

## 6. Review log

WF-02's three rounds on PR #142 also reviewed this code; its focus findings (R1 F3 frames by identity, R2 F2
in-flight requests) were fixed before the split. The rounds below are #144's own. Reviewer: Codex `gpt-6.1-sol`,
high, a fresh session per round, sole reviewer (James's instruction for WF-02).

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome |
|---|---|---|---|---|---|
| 1 | Codex | `f71851d` | MERGE | Medium: page and runner timestamps subtracted | fixed in `9472c21` |
| 2 | Codex | `9472c21` | MERGE | Medium: time with no frame counted as quiet; Low: template listed 6 of 7 shapes | fixed in `1dbff28` |
| 3 | Codex | `1dbff28` | MERGE | Medium: request starting during the frame read missed; note: `[inert]` depth untested | fixed in `bbbd000` (D5) |

- **R1 Medium.** With `page.clock.install({ time: <a day ahead> })`, every frame counted as after the action and
  the quiet window was computed across clocks: the helper settled after ~140 ms of page time, and a control removed
  225 ms after the action passed. The proofs became `a page clock a day ahead … still waits 300 ms of page time`
  (old: `Received: 139`) and `… cannot hide a drop 225 ms after the action` (old: resolved instead of rejecting).
- **R2 Medium.** An action blocking the main thread 600 ms, then handing focus to a status line removed 225 ms later,
  passed: its first frame was already the new state, so the 600 ms counted as quiet. `an action that blocks rendering
  cannot count the blocked time as stable focus` failed before and passes now. **R2 Low:** the template comment now
  lists "a test that is defined and never run".
- **R3 Medium.** A tracked request starting while the poll awaited its frame read, held past 300 ms, let the helper
  pass with it out. `a request that starts during the frame read still keeps the page from settling` (it wraps
  `page.evaluate` to place the request there) failed (`Expected: not "passed"`, both projects) and passes now.

## 7. Not verified, accepted risks and follow-ups

- `bbbd000` (the round-3 fix) had no fresh review (D5); its evidence is its red-then-green test and Codex's scratch
  run of the same line.
- The jsdom helper does not model CSS (`display: none`, `visibility: hidden`); only the Chromium helper does.
- A request that starts after the poll returned `settled` (during the final frame read) is not seen; the helper has
  decided by then. Tracked only here.
- The probes model a slow network with a three-frame hold, not a measured network.
- The 201 jsdom case does not assert where focus ends (its name says the unit search). The Chromium probe asserts it.
  Tracked only here.
- After a refusal, "Log package" leaves focus on its empty status line, not on the error or its field: a follow-up,
  added to WF-02a's ticket in the bookkeeping commit.
- The after-merge measurement (round-1 focus findings over the next five tickets): in the inbox, bookkeeping commit.
- WF-02b (lock-wait helper, vacuous-test check): `todo` in the ticket index.

## 8. How to change this safely

- To add a jsdom "lost" condition, change `frontend/src/test/focus.ts::activeElementLikeBrowser` and add a
  "criterion 1" case; the FileUpload and Log package tests show whether real components still pass.
- To change Chromium settling, keep every subtraction in one clock and run `e2e/tests/focus.spec.ts`'s "pages of its
  own" cases with `--repeat-each=3` (no stack needed:
  `cd e2e && E2E_BASE_URL=http://localhost:9 npx playwright test tests/focus.spec.ts --no-deps -g "pages of its own"`).
  Then mutate the sampler (`bad: false && lost(active)`) to see the failing cases still fail.
- Never raise `BAD_FRAMES_ALLOWED` or lower `STABLE_MS` to get a test green.
- A new spec using the Chromium helper must call `trackRequests(page)` before `goto`/`setContent`.

## 9. Must explain, then quiz

1. **Disabled focus in jsdom.** jsdom leaves a disabled (or hidden, inert, fieldset-disabled) element as
   `document.activeElement`; Chromium moves focus to `<body>`. `frontend/src/test/focus.ts::activeElementLikeBrowser`
   maps those cases to `<body>`, so `sampleAfter` throws where Chromium would drop focus. It does not model CSS: jsdom
   has no layout, so `display: none` keeps focus there; `e2e/helpers/focus.ts` covers it with `checkVisibility()`.
2. **Frames, not events; `trackRequests` first.** Chromium reports the focus change of a disabled or removed element a
   frame late and may not deliver it to React handlers on a detached node, so events are not a record. A
   `requestAnimationFrame` recorder sees each frame as a user would. `trackRequests` must run before load because a
   listener added later never hears of a request already out, and that request's answer can remove the focused row
   after the helper passed.
3. **Helper vs table.** Two focus shapes have helpers: a self-disabling or removed control, and a later drop (`settle`
   in jsdom, settling in Chromium). The lock wait and the never-run test get checks in WF-02b. A reused component's
   stale state, form state that `dirty` misses, and an error field that isn't rendered get table rows only: each
   form or component differs, and a generic static rule is the pattern the log shows failing (ticket "Out").
4. **Existing tests untouched.** They are protected gates: editing one to make room for a helper could weaken it
   unnoticed. The new tests sit beside them, and criterion 10's command proves no existing test file changed.
5. **No new reviewer instruction.** The aim is to move discovery from reviewers to the implementer, not to change
   review coverage. The table is "claims to test, not evidence" so a reviewer doesn't take a filled row as proof. A
   falling round-1 count over five tickets would suggest the helpers help. It can't prove the defect rate is
   unchanged: the sample is small, and the unchanged review coverage is what keeps it so.

Quiz:

1. Why does `expectFocusKept` (jsdom) check focus on `control` *before* running the action?
2. In the Chromium poll, why is `inFlight` checked both before and after the frame read?
3. What would break if `LogPackageForm.tsx::submit` focused the status line *before* the validation check?
4. What would break if the Chromium helper went back to `changed = startedAt`?
5. How would you extend the Chromium helper to also fail when focus lands on an element with `aria-hidden="true"`?

<details><summary>Answers</summary>

1. Otherwise a test that never focused the control would pass vacuously: focus was never on it, so it can't be
   "lost" from it.
2. Before: don't settle while a request is out. After: a request can start during the awaited `page.evaluate`, and
   only a second check sees it before `settled` is returned (round 3).
3. A form with validation errors would move focus off its still-enabled submit to an empty status line, for no
   request: worse for a keyboard user, and the "Validation stop" row in the PR's table would be wrong.
4. An action that blocks the main thread would count the blocked time as quiet focus, so a drop shortly after the
   first frame could pass (round 2's proof test would fail again).
5. Add `element.closest('[aria-hidden="true"]') !== null` to the recorder's `lost`, and an own-page case in
   `focus.spec.ts` that fails with it, plus a sampler-mutation check that the new case can fail.

</details>
