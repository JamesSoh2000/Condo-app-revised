# Explanation — WF-02c Vacuous-test check

> **PR:** #147 · **Source revision:** `539391812ef5f1da698f2056498f8c3d819825dd` (pre-merge), the PR head this explanation
> was written from and checked against. **Reviewed:** the final review round (after B-13, Codex `gpt-6.1-sol` high,
> `MERGE`) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 147 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `5393918` the diff (`git diff --numstat origin/main...HEAD`: the check file, the ticket,
> the index, the inbox), all of `backend/tests/test_scratch_tests_run.py` (every helper in full, and
> the assertions of each test cited below), and the PR's description and review section; ran
> `uv run pytest tests/test_scratch_tests_run.py -v`: 20 passed. Mutation results are quoted from the PR (run at
> `3be26b3`, `f0c7327` and `ef4d0f4`; the code is unchanged since `ef4d0f4` except the module docstring), not re-run
> for this text. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C.

## 1. What was built and why

Some backend tests take the `scratch_database_url` fixture, build their world in a nested `async def body` and hand it
to a runner (`_run(url, body)`). In P6-03b review round 3 one test defined `body` and never handed it over, so it ran
nothing and passed. This PR adds a fitness test,
`backend/tests/test_scratch_tests_run.py::test_every_scratch_database_test_runs_the_coroutine_it_defines`. It parses
every test file with `ast` and fails any such test whose nested `async def` is never run. At the source revision it
finds 101 tests and no problem.

The rule is narrow and fail-closed. It reads only what certainly runs, trusts only code from outside the test, and
refuses what it can't read. After three review rounds that each found new ways around the rule, James narrowed the
claim (inbox B-13, option (a)): the check guards against an *accidental* missing or unreachable run, and constructions
written to defeat it are listed as unsupported.

## 2. Decisions

### D1. One trust boundary: code outside the test runs what it is handed; code inside is read, never trusted

- **Problem or constraint:** WF-02's "passed or called" didn't say passed *to what*. A coroutine handed to a function,
  lambda or name defined in the test can be dropped.
- **Chosen:** a direct argument counts only when the callee is code from outside the test (`_trusted`, D5 sharpens
  it). Imports inside the test count as outside.
- **Alternatives rejected:** a list of runner names (`_run`, `asyncio.run`). The ticket's own positive case
  `with running(body):` names an arbitrary callee, and every new runner would need a change to the check.
- **Tradeoffs and accepted limitations:** an outside callee that drops what it gets (`print(body)`,
  `functools.partial(body)`) passes. A name bound anywhere in the test, even as a nested parameter, is distrusted
  everywhere in it.
- **Basis:** ticket (narrow, fail-closed); autonomous for the boundary itself. **Source:** recorded (PR #147 D1).

### D2. Only a function the test calls directly is read further

- **Problem or constraint:** PR #145 round 3's shape in call form. In `pytest.raises(ValueError, wrapper)`, an error
  raised in `wrapper` before its `_run(url, body)` is caught, and the test passes.
- **Chosen:** `_run_by` reads a tracked function's body only when it was started by a direct call (`called` is
  true), so any error in it reaches the test. A function that is only handed over counts as run but is not read.
- **Alternatives rejected:** reading handed functions and stopping at any statement that may raise. Any call can
  raise, so that reads one statement; a list of error-catching callees can't be complete.
- **Tradeoffs:** PR #145's positive `test_through_siblings` (`body` awaits a sibling) became a negative case. No real
  test has one tracked function referring to another.
- **Basis:** review finding (PR #145 round 3, generalised). **Source:** recorded (D2).

### D3. A call starts a function only if it is a plain `def`, or an awaited `async def`

- **Problem or constraint:** while framing, these ran as pytest tests that passed without running `body`: `body(None)`
  never awaited, `wrapper()` for an `async def` or a generator, and a decorated `wrapper` replaced by its decorator.
  The backend has no `filterwarnings = error`, so "never awaited" is only a warning.
- **Chosen:** `_starts`. A decorated tracked function is refused outright, with a message naming it.
- **Alternatives rejected:** trusting the decorator, which is code in the test's own source.
- **Basis:** experiment (scratchpad probe, recorded in the ticket's Frame notes). **Source:** recorded (D3).

### D4. A statement that runs a function that may raise ends the reading (review round 1 F1)

- **Chosen:** `_raising` marks a tracked function with a `raise` anywhere inside it, or one that refers to such a
  function, repeated until nothing changes. `_runs` stops after a statement that refers to one; that statement's own
  counted part still counts.
- **Alternatives rejected:** ending the reading only at a call of the raising function. A reference is enough to hand
  it on.
- **Tradeoffs:** over-approximate. 6 real coroutines contain a `raise`, and the scan still finds no problem.
- **Source:** recorded (D4).

### D5. A name is trusted only if the test uses it solely as a callee root (review round 1 F2)

- **Chosen:** `_trusted`. A name counts only if every use of it in the test is `a` in `a.b(...)`, and the test binds
  it only by `import`, if at all. If the test stores into an attribute or item of something it didn't bind
  (`globals()[…]`, an outside object), it trusts no name at all.
- **Alternatives rejected:** Codex's minimal fix (attribute stores only). It misses `setattr`, aliases and `globals()`.
- **Tradeoffs:** a runner rebound by a call that doesn't name it (`monkeypatch.setattr("tests.x._run", …)`) is not
  seen. Measured: `_run` (83) and `asyncio` (12) are only ever callee roots in the real tests.
- **Source:** recorded (D5).

### D6. Reading follows evaluation order (review round 2)

- **Chosen:** `_evaluated` reads a call's callee, then its arguments, then its keywords. A sibling started inside a
  part counts at once. The call's own start and the names handed to it count only after every part, and nothing counts
  after a part that may raise (`_may_raise`). The leave check reads `_eager` nodes: what a statement evaluates when it
  runs, including a function's decorators, arguments and annotations and a class's whole body, but not deferred
  bodies.
- **Alternatives rejected:** refusing any call with a raising argument. Without the order, that would also refuse
  `print(wrapper(), abort())`, where `wrapper` really ran.
- **Source:** recorded (D6).

### D7. The claim is narrowed to accidental shapes (James, B-13 option (a))

- **Problem or constraint:** round 3 found three more constructions (§6). Every round since PR #142 had found new ways
  around the rule.
- **Chosen by James:** merge at `ef4d0f4`'s code. Unsupported, and written in the ticket's criterion 8 and the module
  docstring: changing a function after it is defined (`__code__`), a `yield` hidden in a nested definition's default
  or class base, and code the test defines but the check doesn't read ending the test before the run.
- **Alternatives rejected (James):** (b) a 4th fix round; (c) a runtime check in the shared fixture (criterion 10
  forbids editing it here; would need its own ticket).
- **Source:** recorded (inbox B-13, Resolved).

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| The counted part of a statement that can leave still counts (`return _run(url, body)`) | stop before it | it is evaluated before the statement can leave; the ticket's positive case needs it | ticket | PR smaller decisions |
| Negative cases are executed with `exec` against `_HARNESS` | string-only cases | the ticket asks that each be shown to pass without running `body`; the positives are executed too | ticket | PR smaller decisions |
| The top-level `raise` case ends *skipped* (`raise pytest.skip.Exception`) | a plain `raise` | a plain `raise` fails the test; a skip is what green CI shows | autonomous | PR smaller decisions |
| Scan floor raised from 81 to 101 | keep 81 | 101 found today | autonomous | PR smaller decisions |
| Merge `origin/main` into the branch instead of rebasing (`0ccaca9`) | rebase | the rebase conflicted on the index row and would need a force-push, which was refused during WF-02b | existing practice (PR #145) | PR round 3 entry |

**Framing changes:** criterion 8 sharpened with the trust boundary and five escapes the ticket missed (D1–D3), and
PR #145's `test_through_siblings` made negative. After round 3, narrowed by James (D7). The scan's count is 101, not
the ticket's 100.

**Plan versus final code:** the Plan described the rule at `3be26b3`. Reviews added D4–D6: a statement that runs a
raising function ends the reading, trust requires callee-only use, and reading follows evaluation order with `_eager`.
The Plan's other parts stand.

## 3. How it is implemented

### Overview

- `unrun_coroutines` parses one file and runs `_problems` on every `test*` function taking `scratch_database_url`.
- `_problems` collects the *tracked* functions (the `def`/`async def`s directly in the test's body). It refuses a
  rebound tracked name, a decorated tracked function, and an `async def` inside a block. Then it asks `_run_by` which
  tracked functions run.
- `_run_by` reads statement lists with `_runs`, and each counted expression with `_evaluated`.
- `_trusted`, `_raising`, `_starts`, `_handed`, `_may_raise`, `_eager` answer the questions those two ask.

### Walkthrough (variant C: one run of the fitness test)

1. **Trigger:** `make check` or CI runs `pytest`, which runs
   `test_every_scratch_database_test_runs_the_coroutine_it_defines`.
2. **Scan:** it reads every `*.py` under `backend/tests` as UTF-8 and calls `unrun_coroutines` on each. A file that
   isn't UTF-8 or doesn't parse is a problem, not a skip.
3. **Per test:** `_problems` builds `_Test(tracked, _trusted(test), _raising(tracked))` and calls `_run_by(test.body, …)`.
4. **Per statement:** `_runs` takes the counted part (an expression statement, an assignment's value, a `return`
   value, the first `with` item) to `_evaluated`. It then stops if the statement's `_eager` nodes hold a `return` or
   `raise`, or refer to a raising tracked function.
5. **Per call:** `_evaluated` walks the parts in order and yields `(name, called)`. `called=True` means a started
   function, whose body `_run_by` then reads; `called=False` means one that was only handed over.
6. **Result:** every tracked `async def` not in the run set gives "`x` is defined and never run". The test asserts the
   problem list is empty and at least 101 tests were found. On failure, pytest prints the list; each entry
   names the file, the test and the problem (for example "`body` is defined and never run").

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/tests/test_scratch_tests_run.py` | new: the check and its tests | +1188 |
| `docs/tickets/WF-02c-vacuous-test-check.md` | Frame notes; criterion 8's scope (B-13) | +63 / −1 |
| `docs/tickets/README.md` | status | +1 / −1 |
| `docs/HUMAN_INBOX.md` | B-13 moved to Resolved (the block, its decisions and the mistakes-log rows came in PR #148) | +1 / −1 |

`backend/tests/test_scratch_tests_run.py::_evaluated` (D2, D3, D6)

```python
    if isinstance(expr, ast.Await):
        yield from _evaluated(expr.value, test, awaited=True)
    elif isinstance(expr, ast.Call):
        callee = expr.func
        started = isinstance(callee, ast.Name) and callee.id in test.tracked
        root = _root(callee)
        outside = isinstance(root, ast.Name) and root.id in test.trusted
        handed: list[str] = []
        parts = [*expr.args, *(keyword.value for keyword in expr.keywords)]
        for part in parts if started else [callee, *parts]:
            yield from _evaluated(part, test)
            if _may_raise(part, test):
                return
            if outside and part is not callee and (name := _handed(part, test)):
                handed.append(name)
        if isinstance(callee, ast.Name) and started and _starts(test.tracked[callee.id], awaited):
            yield callee.id, True
        for name in handed:
            yield name, False
```

- It walks a call in the order Python evaluates it. The `handed` list holds the names given to an outside callee
  until every part has been evaluated; only then is the call made.
- Without the `_may_raise` return, `_run(abort(), body)` counts `body` (round 2 F1; mutation `raising-args-ignored`).
  If `handed` names were yielded at once, `_run(url, body, abort())` would count `body` (mutation
  `handed-before-later-args`).

`backend/tests/test_scratch_tests_run.py::_runs` (the leave rule)

```python
    for statement in statements:
        match statement:
            case ast.Expr(value=value) | ast.Assign(value=value) | ast.Return(value=value):
                if value is not None:
                    yield from _evaluated(value, test)
            case ast.AnnAssign(value=value):
                if value is not None:
                    yield from _evaluated(value, test)
            case ast.With(items=[first, *_]) | ast.AsyncWith(items=[first, *_]):
                yield from _evaluated(first.context_expr, test)
        scope = list(_eager([statement]))
        if any(isinstance(node, ast.Return | ast.Raise) for node in scope):
            return
        if _refers_to(scope, test.raising):
            return
```

- Only the first `with` item counts, because later items run inside the earlier ones, which may suppress their error
  (PR #145 round 4). No block's body counts.
- If `_eager` were `_own_scope`, `def setup(value=abort())` before `_run` would not stop the reading (mutation
  `definitions-not-eager`).

`backend/tests/test_scratch_tests_run.py::_trusted` (D5)

```python
    for node in ast.walk(test):
        if isinstance(node, ast.Attribute | ast.Subscript) and isinstance(
            node.ctx, ast.Store | ast.Del
        ):
            target: ast.expr = node
            while isinstance(target, ast.Attribute | ast.Subscript):
                target = target.value
            if not (isinstance(target, ast.Name) and target.id in bound):
                return set()
    roots = {id(_root(node.func)) for node in ast.walk(test) if isinstance(node, ast.Call)}
    names = [node for node in ast.walk(test) if isinstance(node, ast.Name)]
    used_otherwise = {node.id for node in names if id(node) not in roots}
    return {node.id for node in names if id(node) in roots} - used_otherwise - bound
```

- `used_otherwise` is what refuses `setattr(runner, …)`, `alias = runner` and `runner.run = …`. In each, `runner`
  appears in a position other than a callee root. The early `return set()` handles `globals()[…] = …` and stores into
  outside objects.

`backend/tests/test_scratch_tests_run.py::_starts` (D3)

```python
    if definition.decorator_list:
        return False
    if any(isinstance(node, ast.Yield | ast.YieldFrom) for node in _own_scope(definition.body)):
        return False
    return awaited or isinstance(definition, ast.FunctionDef)
```

- `_own_scope` here does not look into nested definitions' defaults. That is why a `yield` hidden in one is
  unsupported (round 3 F1, D7).

`backend/tests/test_scratch_tests_run.py::_execute` runs each case for real: it `exec`s `_HARNESS` (a `_run` that runs
the coroutine, `running`, `suppressed`, `mark()`) plus the case source. It reports each test as `ran`, `passed` (ended
without `mark()`) or `skipped`. So each negative case shows a vacuous pass before the check is asked about it.

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| `body` defined, never passed (P6-03b) | "defined and never run" | `test_a_coroutine_that_is_never_passed_fails_naming_the_test` |
| A run in a block, lambda, comprehension, `if`/loop/`try`/`match`, conditional or boolean | not counted | `test_calls_that_may_not_run_do_not_count` |
| A `with` body, a later `with` item, after `return`/`raise`, after a compound statement with `return` | not counted; each case executed `passed` (the `raise` one `skipped`) | `test_calls_that_may_not_be_reached_do_not_count` |
| Un-awaited call, generator, a callee defined in the test, a handed sibling whose error is caught | not counted; executed `passed` | `test_calls_that_never_start_or_that_the_test_itself_receives_do_not_count` |
| A coroutine reached only through a handed one | not counted | `test_a_function_reached_only_through_a_handed_coroutine_is_not_run` |
| A sibling that may raise, run before `_run` (direct, in a block, nested, transitive, handed) | ends the reading; executed `skipped` | `test_a_statement_that_runs_a_function_that_may_raise_ends_the_reading` |
| A raising argument before, after or as a keyword; a nested runner | the call doesn't count | `test_a_call_counts_only_after_its_arguments_are_evaluated` |
| A raising default, keyword default, base, metaclass, class body, lambda default | ends the reading | `test_what_a_definition_evaluates_can_end_the_reading` |
| A callee the test changes (attribute, `setattr`, alias, `vars`, `globals`, outside object) | not trusted; each baseline `ran`, each case `passed` | `test_a_callee_the_test_changes_is_not_trusted` |
| A decorated sibling | refused, named | `test_a_decorated_function_fails_naming_it` |
| A rebound tracked name (20 forms, PR #142 R1–R3) | refused, naming the form and line | `test_rebinding_a_tracked_name_anywhere_in_the_test_fails_naming_the_binding` |
| Real positives: `_run`, `asyncio.run(body(None))`, `return _run(...)` in a called sibling, `with running(body)`, awaited, imported runner, beside raising code | run; executed `ran` | `test_coroutines_handed_to_outside_code_or_called_directly_run` |
| The scan passes by finding nothing | `tests >= 101` | `test_every_scratch_database_test_runs_the_coroutine_it_defines` |
| A file that doesn't parse | a problem | `test_a_file_that_does_not_parse_fails` |

Acceptance criteria: **8**, the rows above plus mutation m3 (a real `_run` removed fails the scan; PR evidence).
**9**, the diff commands print nothing and check-links passes (PR evidence). **10**, the check file is new (`A`);
no existing test edited (PR evidence).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings | Outcome |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` high | `3be26b3` | BLOCK | High: a called sibling's `raise` didn't end the reading; High: a replaced runner attribute was trusted | fixed `f0c7327` (D4, D5); tests first `e5b0dd7`, `5817a77` |
| 2 | same, fresh | `f0c7327` | BLOCK | High: a call counted before its arguments; High: definition-time expressions escaped | fixed `ef4d0f4` (D6); tests first `fa9c6b5` |
| 3 | same, fresh | `ef4d0f4` | BLOCK | High ×3: `yield` in a nested default; exit through a local lambda or class; `__code__` replaced | stop rule 4 (B-13); James: unsupported (D7) |
| after B-13 | same, fresh | `5393918` | MERGE | none | — |

Each confirmed finding was reproduced with Codex's proof, then written as an executed test that showed the vacuous
outcome (`passed` or `skipped`) and failed on the check's assertion before the fix. All 18 mutations were caught at
`ef4d0f4` (PR "Independent review").

## 7. Not verified, accepted risks and follow-ups

- **Unsupported by decision (D7, B-13):** `__code__` replacement; a `yield` in a nested definition's eager parts; an
  exit through code the test defines but the check doesn't read (a lambda, a class's constructor or `__call__`).
  Tracked in the ticket's criterion 8 and the docstring.
- **Accepted (D1, D4, D5):** outside code that drops what it is handed, ends the test early (`pytest.skip()`), or
  rebinds a runner by a call that doesn't name it. Tracked in the PR's follow-ups and the docstring.
- **Not checked by design:** a test that runs `body` but can't fail. Mutation probes cover that.
- Mutations were not re-run on `5393918`; only the docstring changed since `ef4d0f4`.

## 8. How to change this safely

To support a new way of running a coroutine, add an executed positive case to
`test_coroutines_handed_to_outside_code_or_called_directly_run` and an executed negative neighbour, then change
`_evaluated` or `_runs`. Run `scripts/mutation-probe.sh` with a patch that removes the new rule. If a real test is
rejected, fix the test, not the check: there is no exemption list.

## 9. Must explain, then quiz

**1. Why does the check refuse a rebound name instead of analysing it, and what does that cost?** Each round of PR
#142 found a binding form that scope analysis missed (comprehensions, `import`, `class`, merged scopes). Refusing any
second binding (`_bindings` lists every binding form in the grammar) cannot be wrong in the dangerous direction: a
missing form only lets a rebinding through, never hides a run. The cost: a legitimate test that reuses a name, such as
a parameter called `body` in a helper, must rename it. No real test does today.

**2. Why stop at the first statement that can leave, and why count only a `with`'s first item?** A statement after a
`return`, or after one that runs a raising function, may never execute. If the test still passes (an early `return`,
or `pytest.skip`'s exception), a run counted there is vacuous (`_runs`, D4). A `with`'s later items are evaluated
inside the earlier ones' contexts. `with suppress(ValueError), int("x"), _run(url, body):` swallows the error from
`int("x")`, so `_run` never runs (PR #145 round 4). The first item is evaluated before any context exists.

Quiz:

1. Why does `asyncio.run(body(None))` count while a bare `body(None)` doesn't?
2. `_run(url, body)` where `body` contains `raise`: is `body` counted, and what happens to the next statement?
3. What would break if `_trusted` dropped `used_otherwise`?
4. What would break if `_run_by` read every run function, not only called ones?
5. How would you extend the check to the `db` fixture's tests?

<details><summary>Answers</summary>

1. `body(None)` creates a coroutine without starting it (`_starts` is false for an un-awaited `async def`). As a
   direct argument of an outside callee (`asyncio`, trusted), `_handed` credits it.
2. Counted: the statement's counted part is evaluated first. Then `_runs` stops, because the statement refers to a
   raising function, so a coroutine run by a later statement would be reported as never run.
3. `setattr(runner, "run", noop)` or `alias = runner; alias.run = noop` would leave `runner` trusted, and the test's
   own replacement would be believed to run `body` (`test_a_callee_the_test_changes_is_not_trusted`; mutation
   `used-otherwise-ignored`).
4. `pytest.raises(ValueError, wrapper)` with `int("x")` before `_run(url, body)` in `wrapper` would count `body`,
   though the caught error skips it (mutation `handed-read`).
5. Change `FIXTURE` to a set and test `FIXTURE & params`. Raise the scan floor after measuring, and run the real scan:
   any rejected test gets its missing run fixed, not an exemption.

</details>
