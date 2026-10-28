# WF-02c — Vacuous-test check (split from WF-02b)

| Field | Value |
|---|---|
| Phase / lane | Workflow (off-roadmap, like P2-gate-01) / B (QA support; the check is test code) |
| Risk tier | 2 (a fitness test later tickets rely on as evidence) |
| Depends on | WF-02b |
| Replaces old | — (criterion 8 of [WF-02](./WF-02-known-failure-test-kit.md), moved from [WF-02b](./WF-02b-lock-wait-and-vacuous-test-checks.md)) |
| Status | todo |

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
