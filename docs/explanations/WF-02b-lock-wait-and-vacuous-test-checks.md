# Explanation — WF-02b Lock-wait helper

> **PR:** #145 · **Source revision:** `e3675f1`, the pre-merge PR head this explanation was checked against.
> **Reviewed:** the final review round (split round 2, Codex, MERGE with no findings) reviewed this commit.
> **Merge commit:** not known when written; after the merge, `gh pr view 145 --json mergeCommit` gives it.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and
> the squash merge are not described here.
> This is a snapshot: before the merge it is edited to match the PR head; once merged, write a new
> explanation for later changes and do not update this one. Lasting decisions live in ADRs.
> **Reality check** (2026-10-28, after the split and the split review's fix `5701992`): `git diff --stat
> origin/main...HEAD` (12 files); `git diff a47a8c9 HEAD -- backend .github .claude CLAUDE.md` shows the removed check,
> the `CLAUDE.md` sentence (§2, last table row) and the shielded `_end` with its test (§4, §6), and §4's excerpts were
> re-read against the file; ran `pytest tests/helpers/test_lock_wait.py tests/notices/test_expiry_during_fan_out_wait.py
> -q` eight times (22 passed each). Mutation probes m2, m4, m5 (regenerated for the shield) and m6 at `5701992`: all
> `PROBE OK`; m1 ran at `4be2c2e` against unchanged code; m3 belonged to the check and moved with it.
> `make check` exit 0 at `5701992`'s tree. The branch has `origin/main` (`9024ea1`) merged in rather than rebased (§6).
> Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).
> Form: full. Tier: 2. Walkthrough variant: C (a test-support process).

## 1. What was built and why

One of the test tools WF-02 meant to add, rebuilt after PR #142's design failed three review rounds (inbox B-11,
James chose the split):

- `backend/tests/helpers/lock_wait.py::act_blocked_on_lock` runs an action while another transaction holds a lock it
  needs, proves the action really waited on *that* lock, changes the world during the wait, and returns the action's
  result. It makes the `CLAUDE.md` lesson "don't write from a value read before a slow `await`" a one-call test.
- WF-02's second tool, a fitness test that every test taking `scratch_database_url` runs the coroutine it defines,
  was built here too, but review rounds 3 and 4 each found a never-run call it counted. It moved to WF-02c (inbox
  B-12, James chose option (a)), and this PR no longer contains it (§6).

The decision that matters: the helper now opens the action's session itself, on a connection **detached from the
pool**, so "which database backend is the action's" is fixed before the action starts (§2 D1). It replaces a design
where each review round found a new race.

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
- **Tradeoffs and accepted limitations:** one extra query per call. `_end` runs shielded from a cancellation of the
  caller (split review F1, §6); a second cancellation during it is not handled (§7).
- **Basis:** test result (`test_a_failing_change_is_raised_and_leaves_no_lock_task_or_connection` failed with
  `canceling statement due to lock timeout`, then passed); mutation m5. **Source:** recorded (PR D2). Autonomous.

| Decision | Alternative rejected | Why | Basis | Source |
|---|---|---|---|---|
| Match backends by `(pid, backend_start)` | pid only | the OS may give an ended backend's pid to a new one; no test can force that | autonomous | recorded (PR table) |
| Criterion 7's `_publish` lives in its own file | edit `backend/tests/notices/test_concurrency.py::_act` | criterion 10 forbids editing existing tests | ticket | recorded |
| R3's test holds the probe by patching `AsyncSession.scalar` for the probe statement | a timing race | deterministic interleaving (Codex's R3 proof did the same) | review finding | recorded |
| `build-ticket.md` gets a new sentence | edit inside the existing parenthesis | that changed the token `tests),`; criterion 9 allows added words only | ticket | recorded |
| Identify the backend *before* detaching | detach first | a cancel during the identity read left a detached backend nothing ended | review round 1, F1 | recorded |
| Promote "a check made before an `await` is stale after it" to `CLAUDE.md`, for test helpers, appended to the lock lesson in place | a follow-up for the next ticket | round 1's F2 was the third occurrence (WF-02 R3 F1, WF-02a R3 F1), and the ticket says to promote it if it recurs; appended in place, so criterion 11's line count holds | ticket ("Carried from WF-02a") | recorded |

**Framing changes:** criterion 5 sharpened (the detached connection and `(pid, backend_start)`); 6 gained "a wait in
the action's own session is not seen" and the R3 interleaving rebuilt; 8 moved to WF-02c after review round 4; 11's
lock half plus the template and command lines. None loosened (ticket Frame notes, `bef4777`).

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
| `.github/pull_request_template.md`, `.claude/commands/build-ticket.md`, `.claude/commands/implement-ticket.md`, `CLAUDE.md` | the helper named (added words only) | +6 / −3 (lines rewrapped or extended) |
| `docs/tickets/WF-02b-lock-wait-and-vacuous-test-checks.md` | Frame notes, status, criterion 8 marked as moved | +62 / −10 |
| `docs/tickets/WF-02c-vacuous-test-check.md`, `docs/tickets/WF-02-known-failure-test-kit.md`, `docs/tickets/README.md` | the check's new ticket, the split table, the index row | +79 / −3 |

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
            # Shielded: a cancellation of the caller here would leave the backend holding the
            # action's locks, so finish ending it, then let the cancellation through (WF-02b
            # review of the split diff). A second cancellation is not handled.
            ending = asyncio.ensure_future(_end(sessions, backend))
            try:
                await asyncio.shield(ending)
            except asyncio.CancelledError:
                await asyncio.shield(ending)
                raise
```

- It gives the caller a session on one backend that only the caller can ever use.
- Why: D1. The order (identify, then detach, then record) is round 1's F1 fix. Every `await` before `backend =` runs
  on a still-pooled connection, so a cancellation there is the pool's to clean up.
- Without `detach()`, a connection the action closed goes back to the pool, and the R3 test's held probe returns
  `True` for another session's wait (m4). Without `_end`, a cancelled action leaves its locks behind (m5:
  `test_a_failing_change_is_raised_and_leaves_no_lock_task_or_connection` fails).
- The shield is the split review's F1 fix: one cancellation of the caller during `_end`'s query used to abort it, and
  the action's backend stayed `idle in transaction` with its row lock. Now `_end` finishes first. Without the shield,
  `test_a_call_cancelled_while_it_ends_a_backend_still_ends_it[action]` fails (`assert 2 == 1` backends).

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
| The call is cancelled once while `_end` ends a backend (after `change` failed) | `_end` finishes, then the cancellation propagates | `test_a_call_cancelled_while_it_ends_a_backend_still_ends_it[action/holder]` |
| An OS pid reused by a later backend | `backend_start` differs, so no match | **No test** (it can't be forced) |

Acceptance criteria → tests:
- **5:** `test_the_action_sees_the_change_made_while_it_waited` (result 11 on the holder's committed 10).
- **6:** the R1/R2/R3, third-session, own-session, error and cleanup rows above.
- **7:** `test_a_notice_expiring_while_its_fan_out_waits_on_a_membership_lock_is_not_published[normal/urgent]`
  (`422 notice_expired`, still `draft`, no audit, notification or job). m1 makes both fail.
- **8:** moved to WF-02c; nothing here.
- **9–11:** the commands in the PR's evidence table (no removed words, protected files unchanged, links clean,
  `CLAUDE.md` still 162 lines).

## 6. Review log

| Round | Reviewer | Commit reviewed | Verdict | Findings (severity: one line) | Outcome (fixed in commit / dismissed: why) |
|---|---|---|---|---|---|
| 1 | Codex `gpt-6.1-sol` high (fresh) | `4be2c2e` | MERGE | Medium: a cancel during backend identification leaked a detached backend. Medium: an error raised during the last probe wasn't chained | both fixed in `a47a8c9` |
| 2 | Codex `gpt-6.1-sol` high (fresh) | `a47a8c9` | MERGE | none | — |
| 3 | Codex `gpt-6.1-sol` high (fresh) | `91d3a87` | BLOCK | High: the check counted a runner call inside a `with` body (`pytest.raises` swallowing an earlier error) or after a sibling's `return` | not fixed here: stop rule 4, inbox B-12 |
| 4 | Codex `gpt-6.1-sol` high (fresh; James asked for a fix and one more round) | `084499b` (rebased, not pushed: R3's fix) | BLOCK | High: a later `with` item counted after `suppress`. High: a call after a compound statement containing `return` counted. Medium: this explanation still showed the old traversal | the check moved to WF-02c (B-12, option (a)), with both Highs as its sharpened criterion; the Medium is resolved by the cut |
| split 1 | Codex `gpt-6.1-sol` high (fresh; a new count for the split diff) | `c5c1f30` | MERGE | Medium: one cancellation of the caller during `_end`'s query (after `change` failed) left the action's backend alive, holding its row lock | fixed in `5701992` |
| split 2 | Codex `gpt-6.1-sol` high (fresh) | `e3675f1` | MERGE | none (the F1 fix verified; full backend run 3034 passed; its 7 confirmation proofs passed, then deleted) | — |

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

- **R3, R4 and the split:** both rounds found nothing in the lock helper, criterion 7 or the docs. Each found a new
  way for the vacuous-test check to count a call that never runs, the pattern PR #142 showed for its scope analysis.
  James chose to move the check to WF-02c (B-12, option (a)); R3's fix and the stricter rule R4 points to are written
  into WF-02c's criterion 8. A force-push of the rebased branch was refused by the session's permission check, so the
  split is built on the pushed head `91d3a87` with `origin/main` merged in.

- **Split 1 F1:** Codex's proof held the termination query and cancelled the call once: one backend left
  (`assert 2 == 1`) and the next update timed out on the lock. Fix: `_end` runs in a task awaited through
  `asyncio.shield`, and on cancellation the helper awaits it again before re-raising (§4). Evidence:
  `test_a_call_cancelled_while_it_ends_a_backend_still_ends_it[action]` failed 3 of 3 runs without the shield and
  passes; `[holder]` is the neighbour (the holder's connection closes cleanly, so it passed before too). The first
  version of that test could hang under mutation m6 (it raised before releasing its gate, leaving the held query
  waiting forever; found when the m6 probe hung): it now releases the gate in a `finally` and waits 30 s, longer than
  the helper's 5 s.

The earlier design's three rounds (PR #142) are in WF-02's ticket and in inbox B-11; their shapes are this PR's
R1–R3 tests.

## 7. Not verified, accepted risks and follow-ups

- **pid reuse:** the `backend_start` guard has no failing test; no test can make the OS reuse a pid.
- **A second cancellation during cleanup** (while `_end` or a rollback is awaited) is not handled or tested: a first
  one during `_end` is (split review F1). Tests cancel at most once. Accepted (PR "Independent review"). Tracked only
  here.
- **The action's own sessions are invisible** (D1). Accepted; docstring and test.
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

**Quiz**

1. A test's `act` calls a service that opens its own `AsyncSession` from the app's session factory. What does
   `act_blocked_on_lock` report, and why?
2. Why does `_detached` call `session.commit()` after reading the backend, before `detach()`?
3. What would break if `_end` were removed? Which test catches it?
4. What would break if `_wait_until_blocked` checked `task.done()` only before the probe, as it first did?
5. Why does `_BLOCKED_BY_HOLDER` match each backend by `backend_start` as well as by pid?

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
5. Postgres backends are OS processes, and the OS can give an ended backend's pid to a new one. Matching the start
   time too means a later backend with the same pid is never taken for the action or the holder. No test can force
   pid reuse, so this guard is untested (§7).

</details>
