# WF-02 — Known-failure test kit: focus, lock-wait and vacuous-test checks, and the pre-review table

| Field | Value |
|---|---|
| Phase / lane | Workflow (off-roadmap, like P2-gate-01) / both (frontend and backend test support) |
| Risk tier | 2 (test support that later tickets rely on as evidence) |
| Depends on | WF-01 (both edit `.claude/commands/build-ticket.md` and `implement-ticket.md`; one agent per file) |
| Replaces old | — |
| Status | todo |

## Goal

The four defect shapes that keep reaching review round 1 (a control that drops focus, a value used after a lock wait,
a form state hidden from "dirty", a test that never runs) each have a shared test helper or check that the
implementer uses before the first review, and the PR lists them per changed control.

## Why

The same token audit as [WF-01](./WF-01-ticket-loop-helpers.md) (eight runs, P6-01b … P6-03a) found review rounds
and their fixes to be the largest category: 37.6% of cumulative tokens and 51.0% of fresh-input-plus-output tokens,
with seven of eight tickets needing more than one round. Of the roughly 19 findings the
[mistakes log](../AGENT_MISTAKES_LOG.md) records for them, about two thirds fall in these shapes:

| Shape | Findings (log rows) |
|---|---|
| A control disables or removes itself and focus falls to `<body>` | P6-02b R1 F2, R2 F1; P6-02c R1 F1, R2 F1; P6-02e R1 F1; P6-02f R2 F1 |
| A value read before a lock wait, used after it | P6-01b R1 F1; P6-01c R1 F1 |
| Form state that `value` or `dirty` does not show | P6-02d R1 F2; P6-02f R1 F1 (an unfinished replacement upload), R1 F2 (a half-typed date) |
| An error's field is not rendered, so focus has no target | P6-02d R1 F1 and the explainer's finding; P6-02f (3rd time) |
| A test that cannot fail | P6-01c coverage note (a count of zero rows); P6-03b R3 (`_run(...)` never called) |

Two of these recurred **after** the `CLAUDE.md` lesson was promoted and sharpened: P6-01c (the lock-wait lesson was
read as covering only explicit locks) and P6-02f R2 F1 (the focus lesson applied to the new controls, not to the
reused `FileUpload`). More prose did not stop them; a helper that makes the failing case a one-line test, and a
check that fails when a test is vacuous, can. The fresh reviewers, the full-diff rule and the three-round limit stay
exactly as they are: this ticket only moves the discovery of known defects from the reviewers to the implementer's
own tests, and the measure of success is fewer round-1 findings of these shapes, not fewer rounds allowed.

## Scope

- In:
  - **Frontend focus helper** `frontend/src/test/focus.ts` and **Chromium helper** `e2e/helpers/focus.ts`
    (interfaces below), each used by new tests on existing components.
  - **Backend lock-wait helper** `backend/tests/helpers/lock_wait.py`, used by a new test on an existing service.
  - **Vacuous-test check**: an `ast` fitness test that every test taking `scratch_database_url` runs the coroutine it
    defines (the candidate check in the P6-03b R3 log row).
  - **The pre-review table**: a "Known failure cases" block in the PR template's "Independent review" section, and
    the lines in `build-ticket.md` step 3 and `implement-ticket.md` Verify that require it before the first reviewer.
  - In-place edits to two `CLAUDE.md` lessons (the focus lesson and the lock-wait lesson) naming the helpers. No
    line is added and none is shortened beyond the words replaced.
- Out (do **not** do in this ticket):
  - Any change to `docs/templates/REVIEW_PROMPT.md`, `.claude/commands/review-ticket.md`, the number of rounds, who
    reviews, or what a reviewer reads.
  - Editing, moving or deleting an existing test (a protected gate). The helpers are used by **new** tests only.
  - Fixing a component the new tests find broken: that is a finding, handled test-first in this ticket if it is a
    helper's own use, otherwise a follow-up ticket.
  - A static rule that guesses which controls "disable themselves" (a regex or hand-written resolver is the
    pattern the log shows failing five times; the helpers test behaviour instead).
  - The `dirty`/native-input shapes beyond the pre-review table's line for them (no helper: each form differs;
    P6-02d/f's own tests are the examples the table points to).

## Interfaces

### `frontend/src/test/focus.ts` (jsdom, Vitest + Testing Library)

```ts
/** What a browser would report as focused: jsdom keeps a disabled or detached element focused, Chromium does not. */
export function activeElementLikeBrowser(): Element;            // returns document.body for a disabled, [inert],
                                                                // detached or [hidden]-ancestor element

/** Run `action`, wait for the UI to settle, assert focus is not on <body> and, if `within` is given, inside it. */
export async function expectFocusKept(
  action: () => void | Promise<void>,
  options?: { within?: () => Element | null; message?: string },
): Promise<void>;

/** The element that must have focus afterwards, when a specific one is meant. */
export async function expectFocusOn(action: () => void | Promise<void>, target: () => Element | null): Promise<void>;
```

`expectFocusKept` wraps `action` in `act`, then `waitFor`s `activeElementLikeBrowser() !== document.body`, and fails
with the element's description (tag, role, name) when it stays on `<body>`. It exists because the existing tests read
`document.activeElement`, which in jsdom is still the disabled button (P6-02b R2 F1: "jsdom tests didn't hold focus
on it").

### `e2e/helpers/focus.ts` (Playwright, real Chromium)

```ts
export async function expectFocusKept(
  page: Page,
  action: () => Promise<void>,
  options?: { within?: Locator },
): Promise<void>;
```

It installs a `focusout`/`focusin` recorder, runs `action`, waits for the page to be idle (network idle plus one
animation frame), and fails if the **final** `document.activeElement` is `<body>` or outside `within`. It also fails
if the recorder saw focus on `<body>` for longer than one animation frame in between, which a user with a screen
reader or the keyboard notices. It uses the existing `e2e/helpers/test.ts` fixtures.

### `backend/tests/helpers/lock_wait.py`

```python
async def act_blocked_on_lock[T](
    sessions: async_sessionmaker[AsyncSession],
    *,
    hold: Callable[[AsyncSession], Awaitable[None]],      # takes the lock (a SELECT … FOR UPDATE, a row UPDATE)
    act: Callable[[], Awaitable[T]],                        # the request under test, in its own session
    change: Callable[[AsyncSession], Awaitable[None]],      # what happens during the wait (an expiry passes, a
                                                            # status changes), in the holder's transaction
    timeout: float = 5.0,
) -> T: ...
```

It opens the holder session, runs `hold`, starts `act` as a task, **polls `pg_stat_activity` until a backend other than
the holder's is waiting on a lock** (`wait_event_type = 'Lock'`), runs `change`, commits the holder, and returns
`act`'s result or re-raises its exception. If `act` finishes **without** ever blocking, or nothing blocks within
`timeout`, it raises `AssertionError("the action never waited on the lock")`: the test would otherwise pass without
exercising the wait (the P6-03b vacuous test). No `sleep`-based ordering.

### The vacuous-test check

`backend/tests/test_scratch_tests_run.py`: for every test function under `backend/tests/` whose parameters include
`scratch_database_url`, every `async def` nested directly in it must be **referenced** (loaded as a name, passed or
called) elsewhere in that function. Parsed with `ast`, not a regex. Fail-closed: a test it cannot parse fails.

### The pre-review table (`.github/pull_request_template.md`, "Independent review")

```markdown
#### Known failure cases (filled before the first review; one row per changed control, field or wait point)
| Changed thing | Lesson that applies (CLAUDE.md) | Test | or `n/a: why` |
|---|---|---|---|
```

Rows to consider, each with the test that proves it or `n/a: why`: a control that disables or removes itself, or one
inside a **reused** component (focus on `<body>`; use `expectFocusKept`, both helpers); a refresh or a late answer that
removes the focused row or changes the surface (focus); an unfinished upload, a half-typed native input or a
replacement in progress counted in `dirty` and in what Publish/Save sends; a server error on a field the view may
not render; a statement that can wait (row lock, file claim, FK lock in an INSERT) before a time or state check (use
`act_blocked_on_lock`). `build-ticket.md` step 3 says to fill it before spawning the first reviewer and to keep
adding rows for each fix's neighbours (it already requires that list). The reviewer is not told about the table
beyond what the PR body already shows it.

## Acceptance criteria

1. **Given** a button that is focused and becomes `disabled` in jsdom, **when** `activeElementLikeBrowser()` is
   read, **then** it is `document.body`; for a removed element, an `[inert]` subtree and an element under a `[hidden]`
   ancestor too; for an enabled, attached element it is that element.
2. **Given** a component that disables its focused control and moves focus elsewhere, **then** `expectFocusKept`
   passes; **given** one that leaves focus on the disabled control or on `<body>`, **then** it fails with a message
   naming the element. (The helper's own tests, with two small throwaway components in the test file.)
3. **Given** the shared `FileUpload` (`features/files/FileUpload.tsx`: "Choose file", "Cancel" and "Retry", whose focus handoff is its own code)
   rendered inside the shared `Modal`, **when** each control is used, **then** focus stays inside the dialog:
   a new test per control using `expectFocusKept` (the P6-02f R2 F1 case, previously fixed with 4 tests that read
   `document.activeElement`). A mutation (the focus handoff removed from one control) makes the matching test fail.
4. **Given** the Chromium helper, **when** a spec disables the focused control and the app moves focus (the "Log
   package" submit on the packages desk, and a dialog's last button, e.g. "Hand out" after it succeeds), **then**
   `expectFocusKept` passes; **given** a deliberately broken page (a button that disables itself and moves no
   focus, served by the spec through `page.setContent`), **then** it fails. Both in `e2e/tests/focus.spec.ts`.
5. **Given** an action whose statement waits on a row lock held by the holder, **when** `act_blocked_on_lock` runs,
   **then** it returns the action's result after `change` ran, and the action observed the changed state.
6. **Given** an action that never blocks, **or** a holder that never takes the lock, **then** the helper raises
   `AssertionError` ("never waited"), and **given** the action raises a `DomainError`, **then** it propagates
   unchanged.
7. **Given** `NoticePriority.URGENT` publish (the P6-01c shape: the fan-out's INSERT waits on a recipient membership
   row held `FOR UPDATE`), **when** the notice's `expires_at` passes during that wait, **then** the publish is
   refused and no notification, email job or audit row exists: a new test written with `act_blocked_on_lock`
   beside, not replacing, the existing
   `test_a_notice_expiring_while_its_fan_out_waits_is_not_published` (which waits with an `INSERT` event hook). This is
   a deliberate restatement to prove the helper on a known case, not new coverage. A mutation (the final re-check removed) makes it fail.
8. **Given** a `scratch_database_url` test with a nested `async def body` that is defined and never used, **when**
   the fitness test runs, **then** it fails naming the test; **given** the real tests today, it passes (otherwise the
   offenders are listed in the PR and each is fixed by adding the missing call, never by an exemption list).
9. **Given** the PR template and the two command files, **then** the "Known failure cases" block and the sentences
   requiring it are present, `git diff --stat` shows `REVIEW_PROMPT.md`, `review-ticket.md`, the playbook's review
   section and stop rules untouched, and `python3 scripts/check-links.py` passes.
10. **Given** the existing tests, **then** none is edited, skipped or deleted (`git diff --name-status main...HEAD`
    shows only added test files, plus the one existing conftest or helper `__init__` line if an import needs it,
    justified in the PR).
11. **Given** the two `CLAUDE.md` lessons, **then** each names its helper (`src/test/focus.ts`,
    `tests/helpers/lock_wait.py`), and `wc -l CLAUDE.md` is not larger than before.

## Test plan

- Criteria 1–2: `frontend/src/test/focus.test.tsx`. Criterion 3: `frontend/src/features/files/fileUploadFocus.test.tsx`
  (new file; `files.test.tsx` stays untouched). Criterion 4: `e2e/tests/focus.spec.ts`, run by CI's `E2E journeys`
  job (and `make e2e` locally when the stack is available).
- Criteria 5–6: `backend/tests/helpers/test_lock_wait.py` on the scratch database. Criterion 7:
  `backend/tests/notices/test_expiry_during_fan_out_wait.py`. Criterion 8: `backend/tests/test_scratch_tests_run.py`
  (the check, plus its own negative case parsed from a string).
- Criteria 9–11: from the diff, shown in the PR's evidence table.
- Mutations (committed first, `scripts/mutation-probe.sh`): remove one control's focus handoff in `FileUpload`;
  remove the post-wait expiry re-check in `notices/service.py::publish_notice`; make `activeElementLikeBrowser`
  return `document.activeElement` unchanged; make `act_blocked_on_lock` skip the "never waited" check. Each makes its
  tests fail; paste that output and the restored baseline.
- Commands: `cd frontend && npx vitest run src/test/focus.test.tsx src/features/files`; `cd backend && uv run pytest
  tests/helpers tests/notices tests/test_scratch_tests_run.py -q`; `make check`; `make e2e`.
- After merge, not a criterion: for the next five tickets, count round-1 findings in these shapes in the mistakes
  log against the table above, and note in the inbox whether the number fell. A small sample cannot show the defect
  rate is unchanged; the unchanged review coverage is what keeps it so.

## Likely files

`frontend/src/test/focus.ts` (+ `focus.test.tsx`), `frontend/src/features/files/fileUploadFocus.test.tsx`,
`e2e/helpers/focus.ts`, `e2e/tests/focus.spec.ts`, `backend/tests/helpers/lock_wait.py`,
`backend/tests/helpers/test_lock_wait.py`, `backend/tests/notices/test_expiry_during_fan_out_wait.py`,
`backend/tests/test_scratch_tests_run.py`, `.github/pull_request_template.md`,
`.claude/commands/build-ticket.md`, `.claude/commands/implement-ticket.md`, `CLAUDE.md`. Patterns to follow:
`backend/tests/notices/test_concurrency.py` (`_run`, `_act`, the scratch database), `frontend/src/test/renderApp.tsx`
and `notices.ts`, `frontend/src/test/queryFreshness.test.ts` (a parser-based fitness test),
`frontend/src/features/lists/useLoadMore.test.tsx` (focus assertions), `e2e/helpers/test.ts`.

## Open decisions

Framing resolves each with the [decision rules](../AI_AGENT_PLAYBOOK.md#decision-rules). Defaults:

- Size: shared test-support modules and new tests are counted as tests (CLAUDE.md "tests don't count"); the
  non-test lines are the template, the two commands, `CLAUDE.md` and the helpers' production-free code, about 60.
  If framing measures more than ~400 non-test lines, or the test files make the PR unreviewable, split it into
  WF-02a (frontend and Chromium, criteria 1–4) and WF-02b (backend, criteria 5–8), with the template and command
  changes (9–11) in WF-02a, and add the rows.
- Chromium surfaces for criterion 4: the packages desk's "Log package" and "Hand out" (default, already in the
  seeded stack and e2e), not the notices editor (its E2E is P6-07a).
- Criterion 7 may instead use a wait no existing test covers, if framing finds one in `notices/service.py` (create and
  edit wait on `claim_file`); the default restates the P6-01c case because it is the one with a known failing mutation.
- Lock for criterion 7: the recipient membership row (`FOR UPDATE`) the P6-01c fix names; if the real service has
  moved on, the nearest statement the fan-out waits on.
- `act_blocked_on_lock` polling `pg_stat_activity` (default) versus `pg_locks`; the default needs no extra role.
- Whether the vacuous-test check also covers tests that use another scratch fixture, if any exists at framing time.

## Must explain (learning checkpoint)

1. In jsdom a disabled focused button is still `document.activeElement`. How does `activeElementLikeBrowser` make a
   test fail where Chromium would drop focus, and what does it still not model (CSS `display: none`)?
2. Why does `act_blocked_on_lock` wait for the backend to appear in `pg_stat_activity` instead of sleeping, and how
   does it guard against a test that never waited?
3. Which of the five shapes in the table have a helper, and why do the other two get only a row in the table?
4. Why are the existing tests left untouched and the new ones written beside them (protected gates)?
5. Why do the reviewers get no new instruction, and what would a falling round-1 count prove or not prove?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
