# Explanation — WF-02b Lock-wait helper and vacuous-test check

> **PR:** #145 · **Source revision:** `a47a8c9`, the pre-merge PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (2) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 145 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here, and a rebase after it gives the same changes new SHAs.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check:** re-read at `a47a8c9` the diff (`git diff --stat origin/main...HEAD`, 9 files),
> `backend/tests/helpers/lock_wait.py` in full, `backend/tests/test_scratch_tests_run.py::_problems`,
> `::_run_by`, `::_called_or_passed`, `::_direct`, `::_bindings`, and the cited tests' assertions; ran
> `pytest tests/helpers/test_lock_wait.py tests/notices/test_expiry_during_fan_out_wait.py
> tests/test_scratch_tests_run.py -v` (31 passed), `test_lock_wait.py` five more times (18 passed each), and the
> lock-helper mutation probes m2, m4, m5 (regenerated for the moved lines) and m6 at `a47a8c9` (all `PROBE OK`;
> m1 and m3 ran at `4be2c2e` and touch files round 1 didn't change). `make check` ran at `4be2c2e` (exit 0); CI
> is green at `a47a8c9`. Branch is rebased on `origin/main` (`d4633ff`).
> Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C (a test-support process).

## 1. What was built and why

Two test tools that WF-02 meant to add, rebuilt after PR #142's design failed three review rounds (inbox B-11,
James chose the split):

- `backend/tests/helpers/lock_wait.py::act_blocked_on_lock` runs an action while another transaction holds a lock it
  needs, proves the action really waited on *that* lock, changes the world during the wait, and returns the action's
  result. It makes the `CLAUDE.md` lesson "don't write from a value read before a slow `await`" a one-call test.
- `backend/tests/test_scratch_tests_run.py` is a fitness test: every test that takes `scratch_database_url` must run
  the coroutine it defines (P6-03b R3 had one that never did).

The decisions that matter: the helper now opens the action's session itself, on a connection **detached from the
pool**, so "which database backend is the action's" is fixed before the action starts (§2 D1). And the check stopped
trying to understand Python's scopes: it refuses any second binding of a tracked name (§2 D3). Both replace designs
where each review round found a new hole.

## 2. Decisions

### D1. The action runs on a detached connection the helper owns

- **Problem or constraint:** to prove "the action waited on the holder", the helper must know which Postgres backend
  (server process) runs the action's statements. PR #142 inferred it from the connection pool's `checkout`/`checkin`
  events, and three rounds found three races (R1 any waiter counted, R2 overlapping calls shared a flag, R3 a
  connection the action returned was reused by another session while the probe was out). An ordinary
  `AsyncSession` gives its connection back to the pool at every commit, so a pid read once wouldn't stay the action's.
- **Chosen:** `_detached` opens a connection with `engine.connect()`, binds a session to it
  (`sessions(bind=connection)`), reads the backend's `(pid, backend_start)`, then calls `Connection.detach()`. A
  session bound to a connection keeps that one connection across commits. A detached connection is closed at the end
  instead of going back to the pool. So no other session can ever run on that backend. The holder is built the same way.
- **Alternatives rejected:** an engine of the helper's own with `NullPool` (it would copy the URL but drop the
  caller's engine options); re-checking `connection.closed` after each probe (it narrows the race but doesn't remove
  it). Both recorded in PR D1.
- **Tradeoffs and accepted limitations:** an `act` that opens its own session is not seen. Its wait doesn't count,
  and the call fails at `timeout`. PR #142's positive case "an action whose wait is in a task of its own counts" has
  no equivalent now.
- **Basis:** ticket (the interface change) and an experiment run before framing (one pid across two commits and
  `close()`; the pool's next checkout was a different backend). Mutation m4 (no `detach()`) fails 14 of 18 helper
  tests at `a47a8c9`.
- **Source:** recorded (ticket "Scope", Frame notes, PR D1).

### D2. Cleanup terminates both backends

- **Problem or constraint:** found while implementing. The first run of the failing-`change` test left the row
  locked, and `pg_stat_activity` showed the action's backend `idle in transaction`. Cancelling the action's task
  mid-statement invalidates its connection. A detached connection is then dropped without being closed, and no pool
  resets it.
- **Chosen:** `_detached`'s `finally` calls `_end`, which runs `pg_terminate_backend(pid, 5000)` on the row matching
  `(pid, backend_start)`. The two-argument form waits for the process to exit, and `_end` asserts that it did.
- **Alternatives rejected:** terminating client-side (the server ends the backend asynchronously, so the next
  statement can still meet its lock); garbage collection (what left the lock).
- **Tradeoffs and accepted limitations:** one extra query per call.
- **Basis:** test result (`test_a_failing_change_is_raised_and_leaves_no_lock_task_or_connection` failed with
  `canceling statement due to lock timeout`, then passed); mutation m5. **Source:** recorded (PR D2). Autonomous.

### D3. The vacuous-test check is narrow and fail-closed

- **Problem or constraint:** PR #142's check resolved Python scopes to decide whether a call meant the test's
  coroutine, and each round found a binding form it missed (nested bodies, merged scopes, comprehensions, `import`,
  `class`).
- **Chosen:** the functions defined directly in a test's body are *tracked*. A tracked coroutine counts as run only
  through the plainest shapes (§3). Any other binding of a tracked name anywhere in the test is a failure that names
  the form and line, so no scope ever needs resolving. An `async def` inside a block of the test also fails.
- **Alternatives rejected:** B-11 option (b), adding the missing forms (the history suggested more would turn up).
- **Tradeoffs and accepted limitations:** legal tests that run a coroutine in an `if`, loop, `try`, lambda or
  comprehension, or reuse a tracked name, are rejected. None exists (the real scan passes with no exemption list).
- **Basis:** ticket (B-11 option (a)); four hand mutations of the check, each caught (PR D3). **Source:** recorded.

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Match backends by `(pid, backend_start)` | pid only | the OS may give an ended backend's pid to a new one; no test can force that | autonomous | recorded (PR table) |
| Criterion 7's `_publish` lives in its own file | edit `backend/tests/notices/test_concurrency.py::_act` | criterion 10 forbids editing existing tests | ticket | recorded |
| R3's test holds the probe by patching `AsyncSession.scalar` for the probe statement | a timing race | deterministic interleaving (Codex's R3 proof did the same) | review finding | recorded |
| `build-ticket.md` gets a new sentence | edit inside the existing parenthesis | that changed the token `tests),`; criterion 9 allows added words only | ticket | recorded |
| Identify the backend *before* detaching | detach first | a cancel during the identity read left a detached backend nothing ended | review round 1, F1 | recorded |

**Framing changes:** criterion 5 sharpened (the detached connection and `(pid, backend_start)`); 6 gained "a wait in
the action's own session is not seen" and the R3 interleaving rebuilt; 8 written out as the narrow rule with every
binding form; 11's lock half plus the template and command lines. None loosened (ticket Frame notes, `bef4777`).

**Plan versus final code:** two deviations, both noted below the PR's Plan: cleanup terminates the backends (D2,
found while implementing), and the backend is identified before the connection is detached (round 1 F1; the plan
had detach first).

## 3. How it is implemented

### Overview

- `act_blocked_on_lock` opens two detached sessions (`_detached`): the holder's and the action's.
- `hold(holder)` takes a lock; `act(acting)` starts as a task.
- `_wait_until_blocked` polls one query in a fresh pooled session until the action's backend lists the holder's
  backend in `pg_blocking_pids`.
- `change(holder)` runs, the holder commits, and the helper returns the task's result. The `finally` blocks undo
  everything, in order.
- Separately, `test_scratch_tests_run.py` parses every test file with `ast` and applies the narrow rule.

### Walkthrough (variant C: one call, from trigger to result)

1. **Trigger.** A test calls `act_blocked_on_lock(sessions, hold=…, act=…, change=…)`, e.g.
   `backend/tests/notices/test_expiry_during_fan_out_wait.py::test_a_notice_expiring_while_its_fan_out_waits_on_a_membership_lock_is_not_published`.
2. **Two backends.** `backend/tests/helpers/lock_wait.py::_detached` runs `_THIS_BACKEND` (`SELECT pid,
   backend_start FROM pg_stat_activity WHERE pid = pg_backend_pid()`), commits, detaches, and yields the session with
   its `(pid, backend_start)`. Twice: holder, then action.
3. **Lock and start.** `hold(holder)` runs in the holder's open transaction. `act` starts as a task on the action's
   session; the deadline is `now + timeout`.
4. **Probe.** `backend/tests/helpers/lock_wait.py::_wait_until_blocked` runs `_BLOCKED_BY_HOLDER`: a self-join of `pg_stat_activity`
   where the waiting row is the action's `(pid, backend_start)` and the holding row, found through
   `pg_blocking_pids(waiting.pid)`, is the holder's `(pid, backend_start)`. `True` → go on. Otherwise: if the task
   has finished → `AssertionError(NEVER_BLOCKED)` chained from its error; past the deadline → the same, unchained;
   else wait up to 10 ms (waking early if the task ends) and probe again.
5. **Change.** `change(holder)` runs in the holder's transaction (criterion 7 sleeps on the database clock until
   the notice has expired), and `holder.commit()` releases the lock. The action proceeds and sees the change.
6. **Result.** `asyncio.wait_for(task, timeout)` returns the action's result or raises its error.
7. **Cleanup.** The inner `finally`: roll the holder back, then cancel and await the task. Leaving `_detached`
   closes the session and the connection, and `_end` terminates the backend if it still exists.
8. **Where it fails:** `AssertionError: the action was never blocked by the holder's lock` (with `__cause__` when the
   action raised first); `backend <pid> did not end within 5 s` from `_end`.

### Data model changes

None.

## 4. The code

**Files changed**

| File | Change | Lines (+/−) |
|---|---|---|
| `backend/tests/helpers/lock_wait.py` | new: the helper | +164 |
| `backend/tests/helpers/test_lock_wait.py` | new: criteria 5–6, R1–R3, round 1 | +547 |
| `backend/tests/notices/test_expiry_during_fan_out_wait.py` | new: criterion 7 | +89 |
| `backend/tests/test_scratch_tests_run.py` | new: criterion 8 | +492 |
| `.github/pull_request_template.md`, `.claude/commands/build-ticket.md`, `.claude/commands/implement-ticket.md`, `CLAUDE.md` | the helper named (added words only) | +6 / −3 (lines rewrapped or extended) |
| `docs/tickets/WF-02b-lock-wait-and-vacuous-test-checks.md` | Frame notes, status | +47 / −1 |

`backend/tests/helpers/lock_wait.py::_detached`

```python
    backend: _Backend | None = None
    try:
        async with engine.connect() as connection, sessions(bind=connection) as session:
            pid, started = (await session.execute(_THIS_BACKEND)).one()
            await session.commit()
            # Detach only now, with no `await` before `backend` is set: a cancellation up to here
            # leaves a pooled connection, which the pool resets or discards (WF-02b round 1).
            assert connection.sync_connection is not None
            connection.sync_connection.detach()
            backend = (pid, started)
            yield session, backend
    finally:
        if backend is not None:
            await _end(sessions, backend)
```

- It gives the caller a session on one backend that only the caller can ever use.
- Why: D1. The order (identify, then detach, then record) is round 1's F1 fix. Every `await` before `backend =` runs
  on a still-pooled connection, so a cancellation there is the pool's to clean up.
- Without `detach()`, a connection the action closed goes back to the pool, and the R3 test's held probe returns
  `True` for another session's wait (m4). Without `_end`, a cancelled action leaves its locks behind (m5:
  `test_a_failing_change_is_raised_and_leaves_no_lock_task_or_connection` fails).

`backend/tests/helpers/lock_wait.py::_BLOCKED_BY_HOLDER`

```python
_BLOCKED_BY_HOLDER = text(
    "SELECT EXISTS (SELECT 1 FROM pg_stat_activity AS waiting"
    " JOIN pg_stat_activity AS holding ON holding.pid = ANY(pg_blocking_pids(waiting.pid))"
    " WHERE waiting.pid = :action_pid AND waiting.backend_start = :action_start"
    " AND holding.pid = :holder_pid AND holding.backend_start = :holder_start)"
).bindparams(
    # ... the four parameters' types (Integer, DateTime(timezone=True))
)
```

- It asks Postgres whether *this* action backend is waiting on *this* holder backend, right now.
- Why: `pg_blocking_pids` reports real lock waits, so no `sleep`-based guess is needed. Pinning both sides by start
  time is the smaller decision in §2.
- If the action condition is dropped (m6: any waiter counts), 11 of 18 tests fail, including R1, R2 and R3.

`backend/tests/helpers/lock_wait.py::_wait_until_blocked`

```python
    while True:
        async with sessions() as probe:
            if await probe.scalar(_BLOCKED_BY_HOLDER, params):
                return
        # Checked after the probe, before the deadline: an error the action raised while the probe
        # was out is still the cause (WF-02b round 1).
        if task.done():
            error = None if task.cancelled() else task.exception()
            raise AssertionError(NEVER_BLOCKED) from error
        if loop.time() >= deadline:
            raise AssertionError(NEVER_BLOCKED)
        # Wakes early when the action finishes; the next turn then reports it.
        await asyncio.wait([task], timeout=_POLL_SECONDS)
```

- The polling loop. `params` are constants of the call (the two detached backends), so nothing read before an
  `await` here can go stale.
- A `True` probe is an observation that the action's own backend waited on the holder at that moment. That is
  everything the helper claims, so the task finishing afterwards changes nothing.
- The `task.done()` check comes after the probe (round 1 F2). Before the fix it sat before the probe, and an error
  raised during the last probe was lost to the deadline branch.

`backend/tests/test_scratch_tests_run.py::_called_or_passed` and `::_direct`

```python
    for statement in statements:
        match statement:
            case ast.Expr(value=value) | ast.Assign(value=value) | ast.Return(value=value):
                if value is not None:
                    yield from _direct(value)
            case ast.AnnAssign(value=value):
                if value is not None:
                    yield from _direct(value)
            case ast.With(items=items, body=body) | ast.AsyncWith(items=items, body=body):
                for item in items:
                    yield from _direct(item.context_expr)
                yield from _called_or_passed(body)


def _direct(expr: ast.expr) -> Iterator[str]:
    if isinstance(expr, ast.Await):
        yield from _direct(expr.value)
    elif isinstance(expr, ast.Call):
        for part in [expr.func, *expr.args, *(keyword.value for keyword in expr.keywords)]:
            if isinstance(part, ast.Name):
                yield part.id
            else:
                yield from _direct(part)
```

- What counts as running a coroutine: its name is the callee or a direct argument of a call, reached through only
  calls and `await`s, from a statement that always runs. `if`, loops, `try`, `match`, lambdas, comprehensions,
  conditional expressions, boolean operators and `*` arguments are not entered.
- `_run_by` follows tracked siblings transitively. `_bindings` lists every binding node in Python's `ast`, and
  `_problems` fails a tracked name bound a second time.
- Counting `if`/`for`/`try` bodies makes `test_calls_that_may_not_run_do_not_count` fail (hand mutation, PR D3).

`backend/tests/helpers/test_lock_wait.py::test_a_connection_the_action_gives_up_during_the_probe_does_not_count`
(the R3 case, rebuilt; trimmed)

```python
        async def gated_scalar(self: AsyncSession, statement: Any, *args: Any, **kw: Any) -> Any:
            if statement is lock_wait._BLOCKED_BY_HOLDER and not given_up.is_set():
                probing.set()
                await given_up.wait()
                # Run the real probe only once the unrelated session waits on the holder.
                # ...
                gated.append(await real_scalar(self, statement, *args, **kw))
                return gated[-1]
            return await real_scalar(self, statement, *args, **kw)
        # ...
        async def act(db: AsyncSession) -> str:
            # ...
            await probing.wait()
            await (await db.connection()).close()
            unrelated = asyncio.ensure_future(_in_own_session(sessions, 1))
            given_up.set()
            await changed.wait()
            return "never blocked"
        # ...
        assert gated == [False]
        assert raised.value.__cause__ is None
```

- It holds the first probe at its I/O point, has the action close its connection and an unrelated session wait on
  the holder, and only then lets the real probe run. `gated == [False]` proves the interleaving happened and was not
  credited. Under m4 the same probe returned `True` (checked by hand with a print).

## 5. Edge cases and tests

| What could go wrong | What the code does | Test that proves it |
|---|---|---|
| Another session waits on the holder; the action never does (R1) | the probe requires the action's backend | `test_an_unrelated_session_waiting_on_the_holder_does_not_count_as_the_action` |
| Two overlapping calls (R2) | each call has its own two backends | `test_two_overlapping_calls_each_watch_only_their_own_action`, `…_whose_actions_both_wait_both_pass` |
| The action gives up its connection during the probe (R3) | a detached connection never returns to the pool | `test_a_connection_the_action_gives_up_during_the_probe_does_not_count` |
| The action commits before it waits | the bound session keeps its connection | `test_an_action_that_commits_before_it_waits_is_still_seen` |
| The action blocks on a third session's lock | not the holder → `NEVER_BLOCKED` | `test_an_action_blocked_by_a_third_session_is_not_blocked_by_the_holder`, `…_fails_even_while_another_waits_on_the_holder` |
| The action waits in a session of its own | not seen → `NEVER_BLOCKED` (the documented limit) | `test_an_action_that_waits_in_a_session_of_its_own_is_not_seen` |
| The holder takes no lock / the action locks another row | `NEVER_BLOCKED`, no cause | `test_a_holder_that_takes_no_lock_blocks_nothing`, `test_an_action_on_another_row_is_never_blocked` |
| The action raises after / before / during the last probe | propagates unchanged / chained / chained | `test_a_domain_error_raised_after_the_wait_propagates_unchanged`, `test_an_error_raised_before_any_wait_is_the_cause_of_the_assertion`, `test_an_error_raised_during_the_last_probe_is_the_cause_of_the_assertion` |
| `change` raises | re-raised; no lock, task or backend left | `test_a_failing_change_is_raised_and_leaves_no_lock_task_or_connection` |
| The call is cancelled while identifying, or while polling | no backend, lock or task left | `test_a_call_cancelled_while_it_identifies_its_backend_leaves_no_connection`, `test_a_call_cancelled_while_it_waits_leaves_no_lock_task_or_connection` |
| An OS pid reused by a later backend | `backend_start` differs, so no match | **No test** (it can't be forced) |
| A coroutine never passed, used only in a never-run sibling, or bare-referenced | "defined and never run" | `test_a_coroutine_that_is_never_passed_fails_naming_the_test`, `…_used_only_inside_a_sibling_that_never_runs_fails`, `test_a_bare_reference_does_not_run_it` |
| A call that may not run (11 shapes) | not counted | `test_calls_that_may_not_run_do_not_count` |
| A tracked name bound again (20 forms, incl. R3's comprehension, `import`, `class`), as a test parameter, or a run sibling rebound | "bound again (form, line N)" | `test_rebinding_a_tracked_name_anywhere_in_the_test_fails_naming_the_binding`, `test_a_test_parameter_with_a_tracked_name_fails`, `test_a_run_sibling_that_is_rebound_fails` |
| An `async def` inside a block | "defined inside a block" | `test_a_coroutine_defined_inside_a_block_fails` |
| The runner never awaits what it's given | not detected | **No test** (out of the check's reach, as in WF-02) |

Acceptance criteria → tests:
- **5:** `test_the_action_sees_the_change_made_while_it_waited` (result 11 on the holder's committed 10).
- **6:** the R1/R2/R3, third-session, own-session, error and cleanup rows above.
- **7:** `test_a_notice_expiring_while_its_fan_out_waits_on_a_membership_lock_is_not_published[normal/urgent]`
  (`422 notice_expired`, still `draft`, no audit, notification or job). m1 makes both fail.
- **8:** `test_every_scratch_database_test_runs_the_coroutine_it_defines` (81 tests found, no problems) and the
  negative cases.
- **9–11:** the commands in the PR's evidence table (no removed words, protected files unchanged, links clean,
  `CLAUDE.md` still 162 lines).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome (fixed in commit / dismissed: why) |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` high (fresh) | `4be2c2e` | MERGE | Medium: a cancel during backend identification leaked a detached backend. Medium: an error raised during the last probe wasn't chained | both fixed in `a47a8c9` |
| 2 | Codex `gpt-6.1-sol` high (fresh) | `a47a8c9` | MERGE | none | — |

- **R1 F1:** `_detached` detached first and read the backend after. Cancelling the call during that read left
  `backend` unset, so `_end` was skipped and one backend stayed. Codex's proof slowed the identity query and
  cancelled; the backend was still there. Fix: identify while the connection is pooled, then detach (§4).
  Evidence: `test_a_call_cancelled_while_it_identifies_its_backend_leaves_no_connection` failed (`assert 2 == 1`
  backends) and now passes.
- **R1 F2:** the loop checked `task.done()` before each probe and the deadline after it. An action raising while the
  last probe was out hit the deadline branch, with `__cause__` `None` (criterion 6). Fix: check the task after the
  probe. Evidence: `test_an_error_raised_during_the_last_probe_is_the_cause_of_the_assertion` failed
  (`None is _Refused`) and now passes.
- Neighbour added before round 2: `test_a_call_cancelled_while_it_waits_leaves_no_lock_task_or_connection`. It
  already passed: cancelling in the poll loop was safe.

The earlier design's three rounds (PR #142) are in WF-02's ticket and in inbox B-11; their shapes are this PR's
R1–R3 tests.

## 7. Not verified, accepted risks and follow-ups

- **pid reuse:** the `backend_start` guard has no failing test; no test can make the OS reuse a pid.
- **A second cancellation during cleanup** (while `_end` or a rollback is awaited) is not handled or tested. Tests
  cancel at most once. Accepted (PR "Independent review", round 1 neighbours). Tracked only here.
- **The action's own sessions are invisible** (D1). Accepted; docstring and test.
- **The check rejects legal shapes** (D3). Accepted; none exist today.
- **The check can't tell whether a runner awaits what it's given** (WF-02's original limit).
- **After-merge measurement** (WF-02's): count round-1 findings of the pre-review table's shapes over the next five
  tickets. Tracked in WF-02's ticket.
- PR #142 is closed as superseded in the bookkeeping step.

## 8. How to change this safely

- **Using the helper:** pass `act` a function of the session it receives, and run every statement there. Change
  rows the holder owns, or wait on the database clock, in `change`. Copy the pattern of
  `backend/tests/notices/test_expiry_during_fan_out_wait.py::_publish`.
- **Changing the helper:** run `backend/tests/helpers/test_lock_wait.py` (and five more times for the cancellation cases)
  and the mutation patches. Any new `await` in `_detached` before `backend =` must leave the connection pooled. Any
  new state read before an `await` in `_wait_until_blocked` needs a test that changes it during the await.
- **A new way to run a coroutine in tests** (e.g. a runner called inside `try`): the check will reject it. Either
  write the call as a plain statement, or extend `_called_or_passed` with a negative case in
  `test_calls_that_may_not_run_do_not_count` showing what stays excluded.

## 9. Must explain, then quiz

**1. Why does `act_blocked_on_lock` wait for the backend to appear in `pg_blocking_pids` instead of sleeping, and
how does it guard against a test that never waited?** A sleep guesses that the action has reached its lock by
some time; on a slow machine it hasn't, and the test checks nothing. `pg_blocking_pids` is Postgres's own record
of who waits on whom, so `backend/tests/helpers/lock_wait.py::_wait_until_blocked` continues only once the wait is real. If the action
finishes, or the deadline passes, without that observation, the call raises `NEVER_BLOCKED` (chained from the
action's error, if any). So a test whose action never waited can't pass.

**2. Why did inferring the action's backend from pool events keep failing, and why does passing the session in
remove the race rather than narrow it?** Pool events describe the pool, not the action. A connection moves between
users at every checkin and checkout, so a recorded pid could belong to someone else by the time the probe asked
about it (R3), and context flags shared between calls blurred whose checkout it was (R2). Now the helper creates
the action's connection, detaches it (`backend/tests/helpers/lock_wait.py::_detached`) and hands its session over. That backend can never
serve another session, so there is no moment at which the attribution can become wrong. A re-check after each
`await` (B-11 option (b)) would only have made the window smaller.

**3. Why does the vacuous-test check refuse a rebound name instead of analysing it, and what does that cost?**
Analysing means resolving Python scopes. Every review round found a binding form the analysis missed, and each miss
let a test that never ran its coroutine pass. Refusing needs only a complete list of binding *nodes*
(`backend/tests/test_scratch_tests_run.py::_bindings`), which is finite and easy to check. A missed form there would let a
rebinding through, but couldn't make a never-run coroutine count as run. The cost: legitimate tests that reuse a
name, or run a coroutine conditionally, are rejected and must be rewritten. Today there are none.

**Quiz**

1. A test's `act` calls a service that opens its own `AsyncSession` from the app's session factory. What does
   `act_blocked_on_lock` report, and why?
2. Why does `_detached` call `session.commit()` after reading the backend, before `detach()`?
3. What would break if `_end` were removed? Which test catches it?
4. What would break if `_wait_until_blocked` checked `task.done()` only before the probe, as it first did?
5. How would you extend the check to allow `try: _run(url, body)` while keeping it fail-closed?

<details><summary>Answers</summary>

1. `AssertionError(NEVER_BLOCKED)` at `timeout`: the probe only asks about the backend of the session the helper
   passed in, and the service's wait is on a different backend (`test_an_action_that_waits_in_a_session_of_its_own_is_not_seen`).
2. So that every `await` before `detach()` happens on a pooled connection with no open transaction. A cancellation
   there leaves the pool to reset or discard the connection, and once `backend` is set, `_end` covers the rest
   (round 1 F1).
3. A cancelled action leaves its connection invalidated and unclosed, and its backend stays idle in transaction
   holding its locks. `test_a_failing_change_is_raised_and_leaves_no_lock_task_or_connection` fails (m5).
4. An error the action raised while the last probe was out would reach the deadline branch unchained
   (`test_an_error_raised_during_the_last_probe_is_the_cause_of_the_assertion`).
5. Not by counting the whole `try` body: a statement before the call can raise, and a handler can swallow it, so
   the call never runs and the test passes. A fail-closed extension counts a call in a `try` body only when it is
   the body's first statement, or when the `try` has no `except` handlers (`try`/`finally`, where an error fails the
   test). Add those as positive cases, and keep the current `try`/`except` case in
   `test_calls_that_may_not_run_do_not_count` as a negative one.

</details>
