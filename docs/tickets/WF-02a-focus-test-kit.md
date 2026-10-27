# WF-02a — Focus test kit and the pre-review table (split from WF-02)

| Field | Value |
|---|---|
| Phase / lane | Workflow (off-roadmap, like P2-gate-01) / B (QA support) |
| Risk tier | 2 (test support that later tickets rely on as evidence) |
| Depends on | WF-01 |
| Replaces old | — (part of [WF-02](./WF-02-known-failure-test-kit.md)) |
| Status | done |

Split from [WF-02](./WF-02-known-failure-test-kit.md) after its review round 3 (James's answer to inbox B-11, option
(a)). The criterion numbers are WF-02's, so code comments that say "WF-02 criterion 3" still match; criteria 5–8 and
the lock half of 11 are in [WF-02b](./WF-02b-lock-wait-and-vacuous-test-checks.md).

## Goal

The two focus shapes in the table below that keep reaching review round 1 get a helper the implementer runs before the
first review, in jsdom and in real Chromium; every shape gets a row in a pre-review table in the PR, which lists them
per changed control.

## Why

WF-02's audit (eight runs, P6-01b … P6-03a) found review rounds and their fixes to be the largest token category, and
most round-1 findings in the [mistakes log](../AGENT_MISTAKES_LOG.md) fall in these shapes:

| Shape | Findings (log rows) | Covered by |
|---|---|---|
| A control disables or removes itself and focus falls to `<body>` | P6-02b R2 F1; P6-02c R2 F1 ("Load more" removes itself); P6-02f R2 F1 (the reused `FileUpload`) | `expectFocusKept` (this ticket) |
| The focus target disappears later, e.g. a slow refresh removes the row | P6-02c R1 F1 | `expectFocusKept` with `settle` (this ticket) |
| A reused component's state goes stale (a "focus is inside me" flag; a Tab trap that does not know a new element) | P6-02e R1 F1; P6-02b R1 F2 | table row only |
| A value read before a lock wait, used after it | P6-01b R1 F1; P6-01c R1 F1 | table row; a helper in [WF-02b](./WF-02b-lock-wait-and-vacuous-test-checks.md) |
| Form state that `value` or `dirty` does not show | P6-02d R1 F2; P6-02f R1 F1 (an unfinished replacement upload), R1 F2 (a half-typed date) | table row only |
| An error's field is not rendered, so focus has no target | P6-02d R1 F1 and the explainer's finding; P6-02f (3rd time) | table row only |
| A test that is defined and never run | P6-03b R3 (`_run(...)` never called) | a check in WF-02b |

The focus lesson recurred **after** it was promoted to `CLAUDE.md` (P6-02f R2 F1: it was applied to the new controls,
not to the reused `FileUpload`). A helper that makes the failing case a one-line test can stop that where more prose
did not. Reviewers, rounds and the review prompt stay exactly as they are.

## Scope

- In:
  - **Frontend focus helper** `frontend/src/test/focus.ts` and **Chromium helper** `e2e/helpers/focus.ts`
    (interfaces below), each used by new tests on existing components.
  - **The pre-review table**: a "Known failure cases" block in the PR template's "Independent review" section, and
    the lines in `build-ticket.md` step 3 and `implement-ticket.md` Verify that require it before the first reviewer.
    The lock-wait row is in the table without a helper name; WF-02b adds the name when its helper exists.
  - The `CLAUDE.md` focus lesson gets the helper names appended **in place**. Every existing word stays verbatim, in
    particular "assert `document.activeElement` after the action", and the separate "Check focus and accessible names
    in Chromium" lesson is unchanged; no line is added.
  - The "Log package" focus drop the Chromium probe found (criterion 4), fixed test-first.
- Out (do **not** do in this ticket):
  - Anything in WF-02b: `backend/tests/helpers/lock_wait.py`, criterion 7's restatement, the vacuous-test check, the
    lock lesson's words.
  - Any change to `docs/templates/REVIEW_PROMPT.md`, `.claude/commands/review-ticket.md`, the number of rounds, who
    reviews, or what a reviewer reads.
  - Editing, moving or deleting an existing test (a protected gate). The helpers are used by **new** tests only.
  - A static rule that guesses which controls "disable themselves".

## Interfaces

### `frontend/src/test/focus.ts` (jsdom, Vitest + Testing Library)

```ts
/** What a browser would report as focused. jsdom keeps a *disabled* element (also one a disabled <fieldset>
 *  disables), one under a `[hidden]` ancestor and an `[inert]` one as `document.activeElement`; Chromium moves focus
 *  to <body>. (A removed element is already <body>.) */
export function activeElementLikeBrowser(): Element;

export async function expectFocusKept(
  action: () => void | Promise<void>,
  options: {
    control: () => Element | null;          // required: the element the test has focused and the action acts on
    within?: () => Element | null;          // focus must stay inside this (the dialog, the card)
    settle?: () => Promise<void>;           // await the slow part (a refresh that removes the row) before sampling
  },
): Promise<void>;

export async function expectFocusOn(
  action: () => void | Promise<void>,
  target: () => Element | null,
  options: { control: () => Element | null; settle?: () => Promise<void> },
): Promise<void>;
```

`expectFocusKept` asserts **before** the action that `activeElementLikeBrowser()` is `control()` (and inside `within`),
so a test that forgot to focus the control fails instead of passing vacuously. It runs `action` inside `act`, awaits
`settle` **outside** `act` (inside it React holds updates, so a `findBy…` never resolves), then samples right after the
action, after `settle`, and at five real macrotask turns, failing if **any** sample is `<body>` or outside `within`:
`focus fell to <body>; last focused: <button "Choose file">`, or `focus left <within>; on: <tag "name">`. A test with
fake timers installed fails fast with a message naming that.

### `e2e/helpers/focus.ts` (Playwright, real Chromium)

```ts
export function trackRequests(page: Page): void;   // before the page loads; expectFocusKept refuses an untracked page
export async function expectFocusKept(
  page: Page,
  action: () => Promise<void>,
  options: { control: Locator; within?: Locator },
): Promise<void>;
```

It checks `control` is focused, starts a `requestAnimationFrame` recorder, runs `action`, and waits (an `expect.poll`,
no sleep) until no tracked request is in flight and neither the focused element (by identity) nor its "bad" state has
changed for 300 ms of the page's clock. A frame is bad when focus is on `<body>`, a detached, `:disabled`, `[inert]` or
invisible (`checkVisibility()`) element, or outside `within`. It fails if the final frame is bad or if more than one
consecutive frame after the action was bad. The budget (one bad frame) is fixed in the helper and is never raised to
make a test pass.

### The pre-review table (`.github/pull_request_template.md`, "Independent review")

```markdown
#### Known failure cases (filled before the first review; one row per changed control, field or wait point)
| Changed thing | Lesson that applies (CLAUDE.md) | Test | or `n/a: why` |
|---|---|---|---|
```

Its comment lists the rows to consider (the seven shapes above, with `expectFocusKept` named on the focus rows) and
says: "These are the implementer's claims for the reviewer to test, not evidence." `review-ticket.md` and the review
prompt are not edited.

## Acceptance criteria

1. **Given** a focused button that becomes `disabled` in jsdom, **when** `activeElementLikeBrowser()` is read, **then** it
   is `document.body`; likewise for a focused control inside a `<fieldset disabled>` (outside its first legend), an
   element under a `[hidden]` ancestor and inside an `[inert]` subtree at any depth; for an enabled, attached element
   it is that element, and a removed element is already `<body>` in jsdom.
2. **Given** a component that disables its focused control and moves focus into the dialog, **then** `expectFocusKept`
   passes; **given** one that leaves focus on the disabled control or on `<body>`, **then** it fails with
   `focus fell to <body>; last focused: <tag "name">`; focus that moves to an enabled element outside `within` fails
   with `focus left <within>; on: <tag "name">`; focus that is fine right after the action and is dropped by a refresh
   that `settle` awaits fails; a test that did not focus `control` first fails before running the action; an `action`
   or `settle` that throws propagates its own error; fake timers are refused. (The helper's own tests, with throwaway
   components.)
3. **Given** the shared `FileUpload` rendered inside the shared `Modal`, **when** "Choose file" (a chosen file starts an
   upload and disables it), "Cancel" (removed when clicked) and "Retry" (removed when the retry starts) are used, and
   when "Cancel" is focused as the upload **finishes** or **fails** (removed by a server answer: the `settle` shape),
   **then** focus stays inside the dialog: a new test per case using `expectFocusKept`. A mutation (the handoff removed
   from one control) makes the matching test fail.
4. **Given** the Chromium helper, **when** a new spec serves (through `page.setContent`) a button that disables itself
   after moving focus to a status region, **then** `expectFocusKept` passes; **given** the same page with the handoff
   removed, or a button removed with no handoff, **then** it fails. `e2e/tests/focus.spec.ts` also runs the helper once
   as a **probe** on the packages desk's "Log package" submit (on a unit of its own) and the "Hand out" confirm, in both
   Playwright projects. A real drop the probe shows is fixed test-first here when component-local and under ~30
   non-test lines, else recorded as a follow-up ticket; the budget is never relaxed to get green.
9. **Given** the PR template and the two command files, **then** the "Known failure cases" block (with the comment "the
   implementer's claims for the reviewer to test, not evidence") and the sentences requiring it are present, no line
   in them names `act_blocked_on_lock` or `lock_wait` (they don't exist on `main` until WF-02b), and these print
   nothing: `git diff --exit-code origin/main...HEAD -- docs/templates/REVIEW_PROMPT.md
   .claude/commands/review-ticket.md docs/AI_AGENT_PLAYBOOK.md`; `git diff --word-diff origin/main...HEAD --
   .github/pull_request_template.md .claude/commands/build-ticket.md .claude/commands/implement-ticket.md | grep -F
   '[-'`; `python3 scripts/check-links.py` passes.
10. **Given** the existing tests, **then** none is edited, skipped or deleted: `git diff --name-status
    origin/main...HEAD -- backend/tests frontend/src e2e | grep -v '^A' | grep -vP '\te2e/README\.md$'` prints only the
    component fix criterion 4 allows (`M frontend/src/features/packages/LogPackageForm.tsx`, not a test), named in the
    PR.
11. (Focus half; the lock half moved to WF-02b.) **Given** the `CLAUDE.md` focus lesson, **then** `git diff --word-diff
    origin/main...HEAD -- CLAUDE.md` shows only added words, the lesson names `src/test/focus.ts` and
    `e2e/helpers/focus.ts`, and `wc -l CLAUDE.md` is not larger than before.

## Test plan

- Criteria 1–2: `frontend/src/test/focus.test.tsx`. Criterion 3: `frontend/src/features/files/fileUploadFocus.test.tsx`.
  Criterion 4: `e2e/tests/focus.spec.ts` (CI's `E2E journeys`, `make e2e` locally) and, for the fix,
  `frontend/src/features/packages/logPackageFocus.test.tsx`; the spec's row in `e2e/README.md`.
- Criteria 9–11: the commands in the criteria, shown in the PR's evidence table.
- Mutations by hand on a clean committed tree, restored with `git checkout`: one control's handoff in `FileUpload`;
  `activeElementLikeBrowser` returning `document.activeElement`; the Chromium sampler never bad; the in-flight check
  disabled; `origin/main`'s `LogPackageForm.tsx` against its new tests.
- After merge, not a criterion: for the next five tickets, count round-1 findings in the focus shapes against the
  table above, and note in the inbox whether the number fell.

## Likely files

`frontend/src/test/focus.ts` (+ `focus.test.tsx`), `frontend/src/features/files/fileUploadFocus.test.tsx`,
`frontend/src/features/packages/LogPackageForm.tsx` (+ `logPackageFocus.test.tsx`), `e2e/helpers/focus.ts`,
`e2e/tests/focus.spec.ts`, `e2e/README.md`, `.github/pull_request_template.md`, `.claude/commands/build-ticket.md`,
`.claude/commands/implement-ticket.md`, `CLAUDE.md`.

## Must explain (learning checkpoint)

1. In jsdom a disabled focused button is still `document.activeElement`. How does `activeElementLikeBrowser` make a
   test fail where Chromium would drop focus, and what does it still not model (CSS `display: none`)?
2. Why does the Chromium helper record frames instead of listening for focus events, and why must `trackRequests` run
   before the page loads?
3. Which of the shapes in the table have a helper, which get only a row in the pre-review table, and why?
4. Why are the existing tests left untouched and the new ones written beside them (protected gates)?
5. Why do the reviewers get no new instruction, why does the table say "claims to test, not evidence", and what would
   a falling round-1 count prove or not prove?

## Frame notes (filled by the agent in step 1)

Split from WF-02 on 2026-10-27, against `origin/main` at `72ea91d`. The code is PR #142's at `2e8d559` (WF-02's three
review rounds: its focus findings R1 F3 and R2 F2 were fixed there), cut down to this part.

- Criteria moved, none loosened: 5–8 and the lock half of 11 (the lock lesson names its helper) go to WF-02b, whose
  helper does not exist on `main` yet; a lesson naming it would point at a missing file. The template's lock-wait row
  stays, without the helper's name.
- Criteria sharpened over WF-02's text: 1–4 carry WF-02's frame notes; 9 adds "no line names `act_blocked_on_lock` or
  `lock_wait`"; 10 names the one allowed `M` line.
- The template's comment points to this ticket's shape table (WF-02's file is now a split stub).
- Review: a fresh round count (round 1 here), since the diff changed; same reviewer as WF-02 (James's instruction).

## Follow-ups (from PR #144)

- After a refusal, "Log package" leaves focus on its (then empty) status line, not on the error or the field it
  names. Focus stays in the form, but not at the most useful place. Candidate for a small packages ticket.
- After-merge measurement (Test plan): over the next five tickets, count round-1 findings in the focus shapes in the
  [mistakes log](../AGENT_MISTAKES_LOG.md) against the table above, and note in the inbox whether the number fell.
