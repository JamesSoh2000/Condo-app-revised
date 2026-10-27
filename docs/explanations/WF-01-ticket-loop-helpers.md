# Explanation — WF-01 Ticket-loop helpers: preflight, PR wait and PR state

> **PR:** #141 · **Source revision:** `3657cac` (pre-merge), the PR head this explanation was written from and
> checked against. **Reviewed:** the final review round (3, Codex `gpt-6.1-sol` high) reviewed this commit and
> said `MERGE`.
> **Merge commit:** not known when written; after the merge, `scripts/pr-state.sh 141` gives it as `merge_commit`.
> Built and merged autonomously ([ADR-0014](../adr/0014-autonomous-agent-workflow.md)); no human reviewed it
> before merge. This describes the PR's changes at the source revision. Commits after it (bookkeeping) and the
> squash merge are not described here. This is a snapshot: before the merge it is edited to match the PR head;
> once merged, write a new explanation for later changes and do not update this one.
> **Reality check:** re-read at `3657cac`: `git diff --stat origin/main...HEAD`, then the whole of
> `scripts/pr-wait.sh`, `scripts/ticket-preflight.sh` and `scripts/pr-state.sh`, the list of self-test labels in
> `scripts/check-ticket-helpers.sh` and the assertions of each test cited below, the command and playbook diffs,
> the ticket's criteria and Frame notes, and the PR body (decisions D1–D4, three review rounds). Ran
> `bash scripts/check-ticket-helpers.sh` at `3657cac`: **all passed, 200 assertions**; `make check DB_PORT=55432`
> at `65e9f3f` (exit 0; backend 3012, frontend 1333; the rounds after it changed only `scripts/`); CI green at
> `3657cac` (read with `scripts/pr-wait.sh 141 --sha 3657cac…`, exit 0). The live GitHub runs quoted in §5 are
> from the PR body, run at `65e9f3f`. Differences from the plan: see §2.
> Written by the implementing session after that check ([ADR-0017](../adr/0017-implementer-writes-the-explanation.md)).

## 1. What was built and why

Three read-only shell scripts replace coordination steps the ticket loop used to do with several separate
commands. `scripts/ticket-preflight.sh` reads the inbox's run state, the ticket's index row and its dependencies
from `origin/main`, and with `--create` makes the worktree. `scripts/pr-wait.sh` waits for **every required
check on one head SHA** and prints a one-line-per-check verdict. `scripts/pr-state.sh` prints the merge-gate
facts as one JSON object. The ticket's reason: an audit counted about 12.6 parent responses per ticket that
were a coordination command directly after another one, and a race (`sleep 20` before `gh pr checks --watch`,
and `--watch` answering for a head other than the one being merged). The two decisions that matter most: the
required checks come from the branch protection, matched by name and app (D1), and the green verdict is bound
to one SHA and one base (D2, D4). The merge command now also passes `--match-head-commit`.

## 2. Decisions

#### D1. Required checks come from the branch protection, matched by name and app
- **Problem:** the verdict must not trust a list that can drift from what GitHub enforces, and a check with the
  right name from the wrong app must not count.
- **Chosen:** `scripts/pr-wait.sh` reads `required_status_checks.checks[]` from `branches/<base>/protection`;
  each entry is matched by `context` and `app_id`, and an `app_id` of null or -1 is matched by name alone. An
  empty or absent list is exit 4.
- **Alternatives rejected:** a list in the script (two places to update when a job is renamed, which the
  playbook's step 7 already warns about); `gh pr checks --required` (in gh 2.45 it reports per check without
  the app and without binding to a SHA). Source: PR decision D1.
- **Tradeoffs:** reading the protection needs a repository-admin token. Without it the script exits 4, and the
  ticket's fallback applies (`gh pr checks --watch`, confirming the names and head with `pr-state.sh`).
- **Basis:** the ticket's default. Evidence: mutations M5 and M6 (PR body) make the self-test fail.

#### D2. The verdict is bound to one SHA at three points
- **Problem:** right after a push the PR still shows the previous head, with its green checks; and a wait can
  end on one head while the merge happens on another.
- **Chosen:** with `--sha`, wait up to 60 s for the PR head to become that SHA. Then re-read the head on every
  poll (exit 3 if it moved) and once more just before printing `success`. The merge passes
  `--match-head-commit <sha>`, so `gh` refuses if the head moved after the wait.
- **Alternatives rejected:** polling `commits/<sha>/check-runs` without checking the PR head (green for a SHA
  the PR has left would read as success). Source: PR decision D2.
- **Tradeoffs:** a push between the final re-read and the merge is caught by `--match-head-commit`, not by the
  script.

#### D3. `pr-state.sh` reads the responses from files (found by the manual run)
- **Problem:** the real compare response for #138 is larger than one command argument may be;
  `python3 -c … "$compare"` failed with `Argument list too long` (exit 4). The trimmed fixture had hidden it.
- **Chosen:** both `gh` responses go to a `mktemp -d` directory and Python reads the files.
- **Alternatives rejected:** gh's built-in `--jq` (the ticket says Python, and the fake `gh` would have to
  emulate jq). Source: PR decision D3.

#### D4. A PR retargeted during the wait is exit 4 (review round 1, F2)
- **Problem:** the protection is read once, for the base at the start. A PR retargeted to a branch with
  stricter checks could print `success` under the old list.
- **Chosen:** once the protection is read, `scripts/pr-wait.sh::read_pr` compares every later base with
  `checked_base` and exits 4 ("retargeted … run it again"). A retarget before the protection is read (during
  the `--sha` head wait) is fine: the new base's protection is the one read.
- **Alternatives rejected:** reloading the protection and re-evaluating (more code for a rare event); exit 3
  (`head-moved` would misname it). Source: PR decision D4.

| Smaller decision | Chosen | Basis |
|---|---|---|
| Location | flat `scripts/` | ticket default |
| Timing | 30 s poll, 540 s timeout (under the Bash tool's 10-minute cap), no retry in the script | ticket default |
| Self-test speed | `PR_WAIT_INTERVAL` override, like `PR_WAIT_HEAD_TIMEOUT` | autonomous (PR) |
| Head-wait poll | every 5 s, or the poll interval if smaller | autonomous (PR) |
| `/draft-ticket` step 7 | names `pr-wait.sh` | ticket default |
| Fetch | explicit refspec `+refs/heads/main:refs/remotes/origin/main` | autonomous (PR) |
| Worktree base | the fetched SHA, printed as `base:` | autonomous (PR) |
| Run state | the whole line value must be `running` or `paused` | review round 2 |

**Plan versus final code:** the plan's files and interfaces hold. Added during review: executable modes,
base binding (D4), the empty-response check and the strict run-state parse (§6). None is a deliberate
deviation.

## 3. How it is implemented

Variant C (a process). The callers are the commands, not users.

**Preflight** (`/build-ticket` step 1). `scripts/ticket-preflight.sh` validates the ID's shape and fetches
`main` into `refs/remotes/origin/main`. It writes the inbox, the index and the list of ticket files at that
commit to a temporary directory. Then one Python block parses them: the run state, the ticket's row through
`row()` (seven cells, a digit tier, one of five statuses, IDs as dependencies, a `./<ID>-<slug>.md` link),
and each dependency's row. It prints `key: value` lines and picks the exit code: paused (10) wins, then any
unreadable fact (65), then 12, 13, 11. Bash appends `worktree:` and `base:`. Only on exit 0 with `--create` it
refuses (14) if the branch or `../bw-<id>` exists, else runs `git worktree add -b <branch> ../bw-<id> <base>`.

**Wait** (steps 3–7). `scripts/pr-wait.sh`:
1. `read_pr`: state, head and base from `gh pr view`. `CLOSED` is exit 4.
2. With `--sha`: poll until the head equals it, or exit 3 after 60 s.
3. Read the protection, once, for that base; record `checked_base`.
4. Loop: `read_pr` (exit 3 if the head moved, 4 if the base did), fetch all check-run pages for the SHA,
   `evaluate`. A red check → `report failure`, exit 1, at once. All green → `read_pr` once more, then
   `report success`, exit 0. Past the deadline → `report timeout`, exit 2. Else sleep, never past the deadline.

**State** (step 7 and the handoff). `scripts/pr-state.sh` runs `gh pr view` for ten fields and
`compare/<base>...<head>` for `behind_by` and the base tip, and prints one JSON object. It judges nothing.

Every script runs under `set -Eeuo pipefail` with an ERR trap. Any unexpected failure becomes the script's
error code (65, 4, 4), so a crash can never read as "ready" or as a red check (exit 1).

## 4. The code

| File | Change |
|---|---|
| `scripts/ticket-preflight.sh` | new (145 lines) |
| `scripts/pr-wait.sh` | new (174 lines) |
| `scripts/pr-state.sh` | new (40 lines) |
| `scripts/check-ticket-helpers.sh`, `scripts/fixtures/ticket-helpers/*` | self-test, fake `gh`, captured JSON (tests) |
| `.claude/commands/build-ticket.md`, `implement-ticket.md`, `draft-ticket.md` | call the helpers |
| `docs/AI_AGENT_PLAYBOOK.md`, `CLAUDE.md` | step 4 wait, step 7 `--match-head-commit`; Context hygiene |
| `.github/workflows/ci.yml`, `Makefile` | the self-test step and `make lint`; shellcheck list |

`scripts/pr-wait.sh::read_pr`: the head and base, read fresh each time. The base check is review round 1's fix.

```bash
read_pr() { # sets state, head and base_ref from the PR as GitHub reports it now
  local fields
  fields="$("$gh" pr view "$pr" --repo "$repo" --json headRefOid,state,baseRefName |
    python3 -I -c 'import json, sys; d = json.load(sys.stdin); print(d["state"], d["headRefOid"], d["baseRefName"])')"
  read -r state head base_ref <<<"$fields"
  [[ $head =~ ^[0-9a-f]{40}$ ]] || error "unexpected head in the PR response"
  [[ $state == OPEN || $state == MERGED ]] || error "PR #$pr is $state"
  # Once the protection is read, a retargeted PR would be judged by the old base's required checks.
  if [[ -n $checked_base && $base_ref != "$checked_base" ]]; then
    error "PR #$pr was retargeted from $checked_base to $base_ref during the wait; run it again"
  fi
}
```
Without it a retarget goes unnoticed (round 1's proof exited 0). Without the head regex, a malformed response
could leave `head` empty and the comparisons meaningless.

`scripts/pr-wait.sh::evaluate`: the verdict. Pages are decoded back to back, the newest run per
(name, app) is kept, and every required entry becomes `missing`, `pending` or its conclusion.

```python
while True:  # gh api --paginate prints one JSON object per page, back to back
    while pos < len(text) and text[pos].isspace():
        pos += 1
    if pos == len(text):
        break
    page, pos = decoder.raw_decode(text, pos)
    runs += page["check_runs"]
    pages += 1
if not pages:
    sys.exit("pr-wait: the check-run response is empty")
latest = {}  # per (name, app) only the newest run: a re-run supersedes the run it repeats
for r in runs:
    key = (r["name"], r["app"]["id"])
    if key not in latest or r["id"] > latest[key]["id"]:
        latest[key] = r
rows = []
for name, app in required:
    found = [r for (n, a), r in latest.items() if n == name and (app in ("None", "-1") or str(a) == app)]
    r = max(found, key=lambda r: r["id"]) if found else None
    if r is None:
        rows.append((name, "missing", ""))
    elif r["status"] != "completed":
        rows.append((name, "pending", r["id"]))
    else:
        rows.append((name, r["conclusion"] or "none", r["id"]))
states = {s for _, s, _ in rows}
print("failure" if states - {"success", "pending", "missing"} else "success" if states == {"success"} else "waiting")
```
"Success" requires every row to be `success`. Any other conclusion (`skipped`, `neutral`, `cancelled`…) is a
failure, and `missing` is never green. That is why zero runs is a timeout, not a pass. Without the `pages`
check an empty body looked like "no checks yet" (round 1, F3).

`scripts/pr-wait.sh::moved` and the main loop: the SHA binding (D2).

```bash
while :; do
  read_pr
  [[ $head == "$sha" ]] || moved "$sha" "$head"
  "$gh" api --paginate "repos/$repo/commits/$sha/check-runs?filter=latest&per_page=100" >"$tmp/runs"
  evaluate >"$tmp/verdict"
  case "$(head -n 1 "$tmp/verdict")" in
    failure)
      report failure
      exit 1
      ;;
    success)
      read_pr # a success recorded for a head the PR has left is not reported
      [[ $head == "$sha" ]] || moved "$sha" "$head"
      report success
      exit 0
      ;;
  esac
```

`scripts/ticket-preflight.sh::Run state`: the strict parse from review round 2, and the precedence.

```python
# The whole value of the line, bold or not: "running-paused" or "running2" is not "running".
states = re.findall(r"^\s*(?:\*\*)?Run state:[ \t]*(.*?)[ \t]*(?:\*\*)?[ \t]*$", inbox, re.M)
run_state = states[0] if len(set(states)) == 1 and states[0] in {"running", "paused"} else "unreadable"
# ...
# Paused stops whatever else is wrong; otherwise an unreadable fact is never "ready".
if 10 in codes and run_state == "paused":
    sys.exit(10)
if errors:
    sys.exit(65)
sys.exit(next((c for c in (12, 13, 11) if c in codes), 0))
```

`scripts/pr-wait.sh::report`: a red check's job log goes to a `mktemp` file (mode 0600, unpredictable name).
Only the path is printed, never the log. If the fetch fails the line says `log: unavailable` and the exit
code stays 1.

## 5. Edge cases and tests

All in `scripts/check-ticket-helpers.sh` (run at `3657cac`, 200 assertions passed). The PR helpers run
against `scripts/fixtures/ticket-helpers/fake-gh`, which serves the JSON captured for PR #138. Each test
edits a copy with `jedit`, so the changed fields are visible in the test. The preflight tests run in a
temporary clone of a temporary bare origin.

| Case | Test (label) |
|---|---|
| paused on `origin/main`, running in the stale checkout → 10, no worktree | `1 paused on origin/main, running in the checkout` |
| dependency `done` locally but `todo` on origin → 11; absent → `=missing` | `2 dependency todo on origin/main, done in the stale checkout`, `2 dependency not in the index` |
| ready → 0, worktree at `base:`; second `--create` → 14, nothing changed; `P6-03` vs `P6-03b` | `3 ready, --create`, `3 second --create`, `3 a prefix of another ID` |
| done/review/blocked → 13, missing → 12, unreadable rows, malformed run states → 65 | `4 $id`, `4 unreadable row: $bad`, `4 run state '$state'` |
| all green → 0 | `5 all green` |
| red beside pending → 1 at once, log in a 0600 file, not on stdout; fetch fails → `unavailable` | `6 failure beside pending` |
| `cancelled`, `skipped`, `neutral`, `timed_out`, `action_required`, `stale` → 1 | `7 $conclusion` |
| renamed job, zero runs, queued → 2 | `8 renamed job`, `8 zero runs`, `8a queued and in progress` |
| head moves, `--sha` differs, base retargeted → 3 / 3 / 4 | `9 head moves during the wait`, `9 --sha differs from the head`, `9 base retargeted during the wait`, `9 base retargeted before the final re-read` |
| protection unreadable, gh fails, PR closed; empty or absent required list → 4 | `10 protection unreadable`, `10 gh fails on the PR`, `10 PR closed unmerged`, `11 required list: $edit` |
| wrong app → missing; app_id null/-1 → any source | `12 name matches, app does not`, `12 app_id $any is any source` |
| two concatenated pages; re-run ordering, both list orders | `13 two pages, concatenated`, `13 failed run then re-run ($order)`, `13 success then failed re-run ($order)` |
| exact keys, `behind_by`, merge commit, `UNKNOWN`; a full-size compare | `14 merged PR`, `14 open PR behind its base`, `14 a full-size compare response` |
| head still old after a push; never becomes `--sha`; moves before the final re-read | `15 --sha new, head still old at first`, `15 head never becomes --sha`, `15 head moves between the last poll and the final re-read` |
| malformed or empty responses, a gh crash mid-wait → 4 / 65; usage → 64; run directly | `16 malformed check-run response`, `16 empty $key response`, `16 gh crash mid-wait`, `16 usage`, `16 $script runs directly`, `16 preflight: origin/main not fetchable` |

Criteria 17 (diff constraints) and 18 (seven hand mutations, each failing the self-test) are command output
in the PR body, not repeatable tests. Live, read-only, from the PR body at `65e9f3f`:
`scripts/pr-wait.sh 138` → exit 0 with the five checks, `--sha 0000…` → exit 3,
`scripts/pr-state.sh 138` → merge commit `9b428fe…`. The job-log endpoint fetched a real failed job (323 KB,
mode 600).

## 6. Review log

All rounds were run by Codex `gpt-6.1-sol` at high effort. James asked for Codex only, with no Claude reviewer,
for this session.

- **Round 1 (`65e9f3f`), CHANGES.** F1 High: the helpers were `100644`, so running them directly (as the
  commands do) failed with exit 126; the self-test called them through `bash` and hid it. Fixed with
  `chmod +x` plus `16 $script runs directly`. F2 Medium: the retarget gap, fixed as D4. F3 Low: an empty
  check-run body led to exit 2; now at least one page is required, with tests for every response that can be
  empty. All three were confirmed by running Codex's proofs and fixed in `7e2c749`.
- **Round 2 (`7e2c749`), CHANGES.** F1 Medium: `Run state: running-paused` was parsed as `running`, and
  `--create` exited 0 and made a worktree. Fixed in `3657cac` with the whole-value parse and six malformed
  values tested. Every other parsed value was checked for the same prefix match.
- **Round 3 (`3657cac`), MERGE.** No findings. Codex re-ran its own six mutations, which were rejected.

One bug was found outside review: D3 (`Argument list too long`), from the manual run against GitHub.

## 7. Not verified, accepted risks and follow-ups

- **No end-to-end run on a red PR head.** Every merged PR's last head was green. The log endpoint and file
  handling were run on a real failed job of run 40172899217 instead. The first red PR after the merge is the
  real test.
- **Fixtures, not GitHub.** Pagination, re-runs, apps and timing are proven against a fake `gh`. Real
  pagination only appears beyond 100 check runs, and the repository has five.
- **A red check is reported without a final head re-read.** If the head moves between the poll's `read_pr`
  and the report, exit 1 names the old head. This errs toward "not green", so the agent reads a log and
  re-runs; it never merges on it.
- **The base name is put in the protection URL unencoded.** Fine for `main`; a base containing `/` is untested.
- **Admin token needed** for the protection read (D1). Without it: exit 4 and the documented fallback.
- **Follow-up (tracked in the ticket's Test plan; the inbox line is added in the bookkeeping commit):** count
  parent responses per ticket over the next five tickets against the 12.6 baseline.

## 8. How to change this safely

- Run `bash scripts/check-ticket-helpers.sh` (also in `make lint` and CI's `docs` job). A new exit path needs a
  test that makes it happen, and a mutation that removes it should fail the self-test.
- A new fixture should be captured from a real response and then edited inside the test with `jedit`, so the
  edit is visible.
- Never print a job log or a full response to stdout, and keep every response in a file, not an argument (D3).
- Changing what counts as green is changing a gate. It may only get stricter (playbook "Protected gates").

## 9. Must explain, then quiz

1. **Why key everything to a head SHA?** `gh pr checks --watch` reports whatever the PR's checks are when you
   ask. Right after a push the PR still shows the previous commit and its green checks, so a watch can return
   green for code you are not merging. `pr-wait.sh` waits until the head *is* the pushed SHA, reads that SHA's
   check runs, and re-checks the head before saying `success` (D2).
2. **Why are "no run" and "zero runs" not successes?** A required check with no run means CI hasn't created it
   yet (the push race) or the job was renamed. "Nothing failed" is not "everything passed". The old pattern was
   `sleep 20` (or an `until … grep -q .` loop) before `--watch`, because the push's checks might not exist yet.
   Now `missing` keeps the wait going until the timeout (exit 2).
3. **What does `--match-head-commit` add?** The wait proves the checks were green on SHA X. The merge flag
   makes GitHub refuse unless the head is still X at merge time, which closes the gap between the wait and the
   merge.
4. **What is deliberately not automated?** Reading a failure (the agent reads the saved log), the merge
   decision (the boxes are still ticked from evidence), the PR prose, the reviews. The saving comes from fewer
   responses (one wait call instead of a sleep, a poll and a watch), not from skipping any check. The required
   list, the reviewers and the gate are unchanged.
5. **How does the self-test show each helper can fail?** Every exit code has a test that triggers it, and the
   seven hand mutations (removing the SHA check, the head wait, the empty-list check…) each make the self-test
   fail. A check that has never failed may be passing vacuously (CLAUDE.md "Lessons learned").

**Quiz**
1. What breaks if `read_pr` is not called again in the `success` branch?
2. A required check shows `skipped` because a path filter skipped the job. What does `pr-wait.sh` print and exit, and why is that deliberate?
3. How would you extend `pr-wait.sh` to also require a passing review status (a commit status, not a check run)?
4. Why does the preflight read `origin/main` rather than the checkout's `main`, and which test fails if it doesn't?
5. Why is exit 1 never used for an unexpected failure?

<details><summary>Answers</summary>

1. A push that lands after the last poll would be missed: the script would print `success` for a head the PR
   has left. Test `15 head moves between the last poll and the final re-read` fails (mutation M1).
2. `failure` with a log path (or `log: unavailable`), exit 1. Only `success` is green, so a skipped required
   check never passes silently. If a skip is legitimate, the protection's list is what should change.
3. Also read `commits/<sha>/status` (the combined status), and match the protection's `contexts` entries that
   no check run satisfies. Keep "missing is not success", and add fixture tests and a mutation for it.
4. The checkout's `main` can be behind (P5-03c, P5-05). `1 paused on origin/main, running in the checkout` and
   the stale-dependency test in 2 fail (mutation M7: 27 failing assertions).
5. Exit 1 means "a required check finished red", and the agent reacts by reading a log. A crash reported as 1
   would send it to read a log that doesn't exist. The ERR trap maps any unexpected failure to 4 (65 for the
   preflight).

</details>
