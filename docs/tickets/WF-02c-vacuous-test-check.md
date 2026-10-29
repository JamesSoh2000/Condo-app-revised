# WF-02c — Vacuous-test check (split from WF-02b)

| Field | Value |
|---|---|
| Phase / lane | Workflow (off-roadmap, like P2-gate-01) / B (QA support; the check is test code) |
| Risk tier | 2 (a fitness test later tickets rely on as evidence) |
| Depends on | WF-02b |
| Replaces old | — (criterion 8 of [WF-02](./WF-02-known-failure-test-kit.md), moved from [WF-02b](./WF-02b-lock-wait-and-vacuous-test-checks.md)) |
| Status | in progress |

Split from [WF-02b](./WF-02b-lock-wait-and-vacuous-test-checks.md) after its review rounds 3 and 4 (James's answer to
inbox B-12, option (a)). Criterion 8 is WF-02's, moved here word for word with WF-02b's sharpening; it is not loosened.
WF-02's "Original ticket" section and WF-02b's criterion 8 and Frame note 8 apply except where this file changes them.

## Goal

A fitness test fails any test that takes `scratch_database_url`, defines a coroutine and never runs it (P6-03b review
round 3 had one: it defined `body`, never passed it to `_run`, and passed).

## Why this is a ticket of its own

The check's rule for "this call runs" has failed review on every round that examined it:

- PR #142 (WF-02) R1–R3: binding forms the scope analysis missed (nested bodies, merged scopes, comprehensions,
  `import`, `class`).
- PR #145 (WF-02b) R3 (High): a runner call inside a `with` body (`pytest.raises` swallows an earlier error) or after
  a sibling's `return` counted.
- PR #145 R4 (High ×2), after a fix for R3: a later `with` item (`with suppress(ValueError), int("x"), _run(url,
  body)`) counted, and so did a call after a compound statement that returns (`if True: return`,
  `with nullcontext(): return`).

The lock-wait helper (WF-02b) had no open finding after four rounds, so it merges without the check.

## Scope

- In: `backend/tests/test_scratch_tests_run.py`, as on PR #145's branch at `91d3a87`, with:
  - R3's fix: no `with` body counts; reading stops at the first `return` or `raise` (written and reviewed in PR #145
    round 4, then left out of WF-02b by the split; PR #145's "Independent review" describes it);
  - R4's fix: only a `with` statement's **first** item counts; reading stops at the first statement whose own scope
    (not nested functions, classes or lambdas) contains a `return` or `raise`. Measured on 2026-10-28 against the
    real tests: 100 tests found, none rejected.
- Out: WF-02b's lock helper and docs; any change to existing tests (criterion 10).

## Acceptance criteria

- **8** as in WF-02b (the narrow, fail-closed rule; a rebound tracked name fails, naming the test and the binding;
  R1–R3 of PR #142 as negative cases; the real scan passes with no exemption list), sharpened:
  - A runner call counts only from an expression statement, an assignment's value, a `return` value, or the first
    item of a `with`/`async with`, at the top of the test's body or of a run sibling's body, before any statement that
    can leave that body (`return`, `raise`, or a compound statement containing one).
  - Negative cases, each executed as Python to show the test passes without running `body` and then rejected by the
    check: PR #145 R3's two (`with pytest.raises(...)` body; a sibling's `return` before the call), R4's three (a
    later `with` item after `suppress`; `if True: return`; `with nullcontext(): return`), plus `raise` before the
    call, `async with` body, and a `try`/`while`/`match` containing `return` before the call.
  - Positive: `return _run(url, body)` in a run sibling; `with running(body):` as the first item.
  - **Scope of the claim (B-13, James, option (a), 2026-10-28):** the check guards against an *accidental* missing or
    unreachable run, as P6-03b's was. These constructions, written to defeat it, are unsupported (it does not catch
    them): code that changes a function after it is defined (`wrapper.__code__ = …`); a `yield` hidden in a nested
    definition's default, annotation or class base, which turns its function into a generator; and code the test
    defines but the check doesn't read (a lambda, a class's constructor or `__call__`, a function defined in a
    block) ending the test before the run. Round 3 of PR #147 found these. Its cases are not tests of this
    PR. Nothing else in 8 changes.
- **9, 10** as in WF-02, for this PR's files.

## Test plan

`cd backend && uv run pytest tests/test_scratch_tests_run.py -q`; a hand mutation per rule (count every `with` item;
stop only at direct `return`/`raise`; count `with` bodies), each caught; mutation m3 (`_run(...)` removed from a real
test, as in PR #145) fails the real scan; `make check`.

## Likely files

`backend/tests/test_scratch_tests_run.py` (from PR #145's history: `721a76e`, `91d3a87`).

## Must explain (learning checkpoint)

1. Why does the check refuse a rebound name instead of analysing it, and what does that cost?
2. Why does "a statement that always runs" have to stop at the first statement that can leave the body, and why does
   a `with` count only its first item?

## Frame notes (filled by the agent in step 1)

Framed against `origin/main` at `573dd24` (WF-02b merged). Starting code: PR #145's `084499b` (R3's fix on top of
`91d3a87`, never pushed, still in the local object store), plus R4's fix.

- **The trust boundary, written down (sharpens 8).** Code outside the test (a module function such as `_run`, a
  fixture, a library, anything the test imports) is trusted to run what it is handed; code inside the test is read,
  never trusted. That is the original "passed or called" rule made exact, and it names the limitation: `print(body)` or
  `functools.partial(body)` passes, as `_run` that ignores its argument always did. Catching those is mutation probes'
  job, like "runs but cannot fail". Rejected: a list of runner names (`_run`, `asyncio.run`). The ticket's own positive
  case `with running(body):` names an arbitrary callee, and every new runner helper would need a change to the check.
- **Cases the ticket missed (added to 8).** Each was run as a pytest test on 2026-10-28 (scratchpad probe): each
  passed with `body` never run, and the R4 rule as worded accepts each:
  - an `async def` called without `await` (`body(None)`, or a sibling `async def wrapper` called as `wrapper()`)
    creates a coroutine that never runs (no `filterwarnings = error` in the backend's pytest config; only a warning);
  - a sibling generator (`def wrapper(): yield; _run(url, body)`) called as `wrapper()` never runs its body;
  - a decorated sibling (`@(lambda f: lambda: None)`) is no longer the function the check reads;
  - a coroutine handed to a function defined in the test (`def ignore(c): pass; ignore(body)`) is dropped. A local
    lambda or a name assigned in the test is the same.
  - Found by the same reasoning, and the R3 shape again: a sibling **handed** to outside code may have its errors
    caught by that code: `pytest.raises(ValueError, wrapper)` with `int("x")` before `_run(url, body)` in `wrapper`, or
    `gather(..., return_exceptions=True)`. So a function's body is read only when the test **calls it directly**, and
    then any error in it reaches the test, so only a `return` (or a `raise`) can silently skip the call.
- **Criterion 8, sharpened again (fail-closed; nothing loosened):**
  - A tracked function is **run** when (a) its name, or a call of it, is a direct argument of a call whose callee is
    outside the test (a name, or `a.b.c` rooted at a name, not bound inside the test except by `import`); or (b) it is
    called directly from a read statement: a plain `def` called, or an `async def` call awaited. Only (b) reads its
    body. A call of a generator (sync or async), an un-awaited `async def` call that is not handed over, and any
    argument handed to a callee defined in the test do not count.
  - A **read** statement is a statement of the test's body, or of a function run by (b), reached before the first
    statement whose own scope contains a `return` or `raise`. That statement's own counted part (a `return`'s value, a
    `with`'s first item) is still read, because it runs before the statement can leave. Counted parts: an expression
    statement, an assignment's (or annotated assignment's) value, a `return` value, and the **first** item of a
    `with`/`async with`. No block's body counts.
  - A decorated tracked function fails, naming the test, the name and the line ("the check can't tell what the
    decorator returns").
  - Negative cases as the ticket lists them, plus: `body()` un-awaited; an `async def` sibling called un-awaited; a
    generator sibling called; a decorated sibling; a coroutine handed to a function, a lambda and a name defined in the
    test; a sibling handed to outside code that would catch an error before the call (`pytest.raises(E, wrapper)`).
    Each is executed as Python, as the ticket asks: it ends without running `body` (the top-level `raise` case ends
    *skipped*, `raise pytest.skip.Exception`, which CI shows green; no plain `raise` can make a test pass while the
    reading is direct-call only).
  - PR #145's positive case `test_through_siblings` (`body` awaits a sibling `helper`; `body` is handed to `_run`)
    becomes a **negative** case: `body` is handed over, so its body is not read and `helper` is never counted. No real
    test does this (no tracked function refers to another today).
  - Measured at `573dd24`: the scan finds **101** tests (the ticket's "100" was measured before one more was added),
    95 nested coroutines, all `async def`, none decorated or a generator, none referring to another; each is handed
    to `_run` (83) or `asyncio.run(check())` (12) by a top-level expression statement. In-test imports (15 tests)
    bind app code and test helpers, not runners. None is rejected (re-measured with the built check in the PR).
- **Mutations (test plan, extended):** besides the ticket's three and m3, one per added rule: un-awaited calls count;
  generator calls count; decorators allowed; callees defined in the test trusted; handed functions read.
- **9, 10:** this PR adds `backend/tests/test_scratch_tests_run.py` (status `A`) and changes the ticket and the index
  only, so criterion 9's diff commands print nothing and criterion 10's filter prints nothing.
- **Estimate:** 0 non-test lines (one new test file, the ticket and the index row). No split.
- **Tier 2:** the review runs as James asked in this session: one fresh Codex session (`gpt-6.1-sol`, high effort),
  no Claude subagent reviewer.
