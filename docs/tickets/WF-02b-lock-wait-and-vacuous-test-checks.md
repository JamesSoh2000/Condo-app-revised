# WF-02b — Lock-wait helper and vacuous-test check (split from WF-02)

| Field | Value |
|---|---|
| Phase / lane | Workflow (off-roadmap, like P2-gate-01) / B (QA support; the backend helper is test code) |
| Risk tier | 2 (test support that later tickets rely on as evidence) |
| Depends on | WF-02a (both edit the PR template row, the two command files and `CLAUDE.md`) |
| Replaces old | — (part of [WF-02](./WF-02-known-failure-test-kit.md)) |
| Status | todo |

Split from [WF-02](./WF-02-known-failure-test-kit.md) after its review round 3 (James's answer to inbox B-11, option
(a)). The criterion numbers are WF-02's; WF-02's "Original ticket" section holds the full text of criteria 5–8, its
interfaces and its frame notes, which apply here except where this file changes them.

## Goal

The two backend shapes in [WF-02a](./WF-02a-focus-test-kit.md)'s table get a helper or check the implementer runs before
the first review: a value used after a lock wait (`act_blocked_on_lock`), and a scratch-database test that never runs
its coroutine (an `ast` fitness test).

## Why this is redesigned

PR #142 (branch `wf-02-known-failure-test-kit`, head `2e8d559`) built both, and three review rounds each found a new
way around them:

- `act_blocked_on_lock` inferred *which* backend was the action's from pool `checkout`/`checkin` events, and that
  inference kept racing with the pool: R1 any waiter counted, R2 overlapping calls shared one flag, R3 a pid copied
  before the probe's `await` was reused by an unrelated session (proved with an instrumented interleaving).
- The vacuous-test check tried to analyse every Python binding form, and each round found another one
  (R1 nested bodies, R2 merged scopes, R3 comprehension scopes and `import`/`class` bindings).

Both are redesigned so that the gap cannot exist, instead of being patched a fourth time.

## Scope

- In:
  - **`backend/tests/helpers/lock_wait.py::act_blocked_on_lock`**, with a changed interface (a framing change from
    WF-02): the helper opens the action's session itself and passes it in.

    ```python
    async def act_blocked_on_lock[T](
        sessions: async_sessionmaker[AsyncSession],
        *,
        hold: Callable[[AsyncSession], Awaitable[None]],
        act: Callable[[AsyncSession], Awaitable[T]],      # was Callable[[], Awaitable[T]]
        change: Callable[[AsyncSession], Awaitable[None]],
        timeout: float = 5.0,
    ) -> T: ...
    ```

    It reads `pg_backend_pid()` on the action's session once, before starting `act`; that pid is the action's for
    its whole life, with no pool listeners. Everything else in WF-02's interface text holds (the holder's pid,
    `pg_blocking_pids`, the `finally` order, the chained `AssertionError`, no `sleep`). An `act` that opens a session
    of its own is not seen (document it; the helper cannot attribute it).
  - Its own tests (`backend/tests/helpers/test_lock_wait.py`), including R1–R3's cases (an unrelated waiter, a third
    session, overlapping calls, a reused connection) as tests that must still fail the helper.
  - **Criterion 7**'s restatement (`backend/tests/notices/test_expiry_during_fan_out_wait.py`), with a variant of
    `test_concurrency.py`'s `_act` that takes the session.
  - **The vacuous-test check** (`backend/tests/test_scratch_tests_run.py`), deliberately narrow and fail-closed: a
    coroutine counts as run only when the test's own statements call or pass it **by name**, or a sibling nested
    function those statements directly call or pass does. Any rebinding of that name anywhere in the test
    (assignment, parameter, comprehension variable, `import`, `class`, nested `def`, `except … as`, `with … as`,
    walrus) **fails** the test instead of being analysed. All current tests pass `body` straight to `_run`, so this
    rejects none of them (to be confirmed by the scan).
  - Docs: `act_blocked_on_lock` (`backend/tests/helpers/lock_wait.py`) named on the template's lock-wait row and in
    the lines WF-02a added to `build-ticket.md` step 3 and `implement-ticket.md` Verify step 6; the `CLAUDE.md` lock
    lesson gets "Test it with `act_blocked_on_lock` (`tests/helpers/lock_wait.py`)." appended **in place** (no line
    added).
- Out: everything in WF-02a; WF-02's "Out" list applies.

## Acceptance criteria

5–8 as in WF-02 (its "Original ticket" section, with its frame notes), with these changes:

- **5, 6:** `act` takes the session the helper opened. 6 adds: an unrelated session waiting on the holder while the
  action never waits; two overlapping calls on one engine; the action's connection reused by another session during
  the probe (the R3 interleaving): each makes the helper raise.
- **8:** "passed or called" is the narrow rule above; a test that rebinds the coroutine's name fails, naming the test
  and the binding. The negative cases include R1–R3's shapes (`[body() for body in …]`, `import … as body`,
  `class body`, a shadowing parameter); each fails. The real scan passes with no exemption list.
- **11 (lock half):** `git diff --word-diff origin/main...HEAD -- CLAUDE.md` shows only added words, the lock lesson
  names `tests/helpers/lock_wait.py`, and `wc -l CLAUDE.md` is not larger.
- **9, 10** as in WF-02, for this PR's files.

## Test plan

WF-02's backend test plan and mutation probes (`m1` … `m5`, now against the new design; PR #142's patches are in
its history), plus one per new rule in criterion 8. `cd backend && uv run pytest tests/helpers tests/notices
tests/test_scratch_tests_run.py -q`; `make check`.

## Likely files

`backend/tests/helpers/lock_wait.py`, `backend/tests/helpers/test_lock_wait.py`,
`backend/tests/notices/test_expiry_during_fan_out_wait.py`, `backend/tests/test_scratch_tests_run.py`,
`.github/pull_request_template.md`, `.claude/commands/build-ticket.md`, `.claude/commands/implement-ticket.md`,
`CLAUDE.md`. Start from PR #142's branch (`2e8d559`) for the tests, not for the attribution code.

## Must explain (learning checkpoint)

1. Why does `act_blocked_on_lock` wait for the backend to appear in `pg_blocking_pids` instead of sleeping, and how
   does it guard against a test that never waited?
2. Why did inferring the action's backend from pool events keep failing, and why does passing the session in remove
   the race rather than narrow it?
3. Why does the vacuous-test check refuse a rebound name instead of analysing it, and what does that cost?

## Frame notes (filled by the agent in step 1)
