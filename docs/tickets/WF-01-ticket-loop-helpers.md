# WF-01 — Ticket-loop helpers: preflight, PR wait and PR state

| Field | Value |
|---|---|
| Phase / lane | Workflow (off-roadmap, like P2-gate-01) / B |
| Risk tier | 1 (tooling, but its output feeds the merge gate and no human checks after the reviewers, so the playbook's Tier 1 review applies: a Claude reviewer with the security pass plus Codex) |
| Depends on | — |
| Replaces old | — |
| Status | todo |

## Goal

The agent gets a ticket's preflight state, a CI verdict bound to one PR head, and the PR facts the merge gate needs
from three read-only scripts, each with a compact result, with no change to who reviews, what is
tested or what the merge gate requires.

## Why

A token audit of eight completed runs (P6-01b … P6-03a, 2026-10-24 to 10-26, parent model `claude-opus-5-5`) found
**101 parent responses that were a coordination command directly after another one** (git state, `gh pr …`, a CI
wait, a Codex launch): about 12.6 per ticket and 21.7M of the 233.5M cumulative tokens (9%, 97.7% of all tokens being
cache reads; these figures are the drafter's own regex classification of local session transcripts, approximate and not reproducible from the repository). That is a ceiling, not a forecast: a response whose output decides the next step is still needed. The
audit measured them because each parent response re-processes a 156k–231k-token history. CI waiting itself is
already one call (`gh pr checks --watch`, 31 responses); what the runs show instead is a race: `sleep 20` or an
`until … grep -q .` loop before `--watch`, because a push's checks may not exist yet, and `--watch` that returns for
a head other than the one the agent is about to merge. A helper bound to the head SHA removes both.

The helpers must only collect facts and wait. They never decide (a failure is read by the agent), never relax a check,
and fail closed. No ADR: [ADR-0014](../adr/0014-autonomous-agent-workflow.md)'s loop and the playbook's merge gate
are unchanged, except that the merge command gets a stricter flag.

## Scope

- In:
  - `scripts/ticket-preflight.sh <ID> [--create]`, `scripts/pr-wait.sh <PR> [--sha <sha>] [--timeout <s>]` and
    `scripts/pr-state.sh <PR>` (interfaces below).
  - `scripts/check-ticket-helpers.sh` and its fixtures: the helpers' self-test against a fake `gh` that serves
    JSON captured from real GitHub responses, and a temporary git repository. Run by a new step of CI's `docs` job;
    the four scripts are added to the existing `Shellcheck the smoke scripts` step, which lives in the `prodlike` job.
  - The commands that call them: `.claude/commands/build-ticket.md` (step 1, every push-and-wait in steps 3, 4, 5 and 6, step 7 and the
    handoff in step 9) and
    `.claude/commands/implement-ticket.md` (Verify 5); the playbook's step 4 and step 7 command lines
    (additions only); one in-place edit of `CLAUDE.md`'s "Context hygiene" (no net new line).
- Out (do **not** do in this ticket):
  - Anything that writes prose or decides: the PR body, the review history, the bookkeeping commit, the handoff
    block, the inbox ([the audit's option 4](#why), a separate piece of work).
  - The Codex skill (`~/.claude/skills/codex-review/`, outside the repo) and how a review is launched or waited
    on.
  - `docs/templates/REVIEW_PROMPT.md`, `.claude/commands/review-ticket.md`, the merge gate's checkboxes and the
    stop rules (protected; this ticket changes none of their words).
  - Changing which checks are required, CI jobs or branch protection.
  - A helper for the local verification environment (PRE-8, the audit's option 2).

## Interfaces

All three: bash, `set -euo pipefail`, run from any directory of a clone, `GODEBUG=netdns=cgo` set inside (the
documented WSL workaround), repository taken from `git remote get-url origin`, `GH` env var to override the `gh`
binary (for the self-test). They write no repository file, nothing on GitHub and not the inbox, and they only
*read* branch protection (never change it, CLAUDE.md "Never"). `git fetch origin main` updates remote-tracking refs
(preflight, every run); `ticket-preflight.sh --create` also runs `git worktree add`. JSON is parsed with `python3 -I`
(standard library), not `jq`, which is not installed in the agents' environment. Output is stdout; diagnostics go to
stderr. A usage error is exit 64 in all three.

### `scripts/ticket-preflight.sh <ID> [--create]`

Reads everything from `origin/main` after `git fetch origin main` (never the checkout's `main`, which can be behind:
P5-03c, P5-05, P6-02 draft). Output, one `key: value` per line:

```text
ticket: P6-03e
file: docs/tickets/P6-03e-maintenance-cancel-and-emergency-phone.md
tier: 2
status: todo
run_state: running
depends_on: P6-03b=done
branch: p6-03e-maintenance-cancel-and-emergency-phone
worktree: ../bw-p6-03e            # relative to the repository's top level; "exists" follows the path when it does
base: <origin/main sha>
```

| Exit | Meaning |
|---|---|
| 0 | ready: not paused, ticket found, every dependency `done`, status `todo` or `in progress` |
| 10 | `Run state: paused` in `docs/HUMAN_INBOX.md` |
| 11 | a dependency is not `done` (it is printed with its status) |
| 12 | ticket not in the index, or its file is missing |
| 13 | status is `done`, `review` or `blocked` (printed) |
| 64 | usage error |
| 65 | git or parse error: no `Run state:` line in the inbox, an unreadable index row, or `origin/main` not fetchable. Never "ready" |

When several apply, all the failing facts are printed and the exit code is the first of 10, 12, 13, 11. A
dependency ID that is not in the index is exit 11 with `<ID>=missing`.

`--create` (exit 0 only): `git worktree add ../bw-<id lowercase> -b <branch> origin/main`, where `<branch>` is
`<id lowercase>-<slug>` with the slug from the ticket's file name. Refuses (exit 14) if the branch or the directory
already exists. It does not edit the ticket's status; the agent does that in the ticket's first commit.

### `scripts/pr-wait.sh <PR> [--sha <sha>] [--timeout <s>]`

Resolves the PR's head SHA, then waits until **every required check** has a completed result **on that SHA**, or the
timeout (default **540 s**, polling every 30 s; the first poll is at once). The required checks are read from the base
branch's protection (`required_status_checks.checks[]`, each a name and an `app_id`) so the list never lives in two
places; a check run counts only if **both** its name and its app match. The script reads check runs of that SHA
(`commits/<sha>/check-runs?filter=latest`, all pages), so a re-run of a job counts by its latest run. The Bash tool
caps a foreground command at 10 minutes, hence the default: on exit 2 the agent runs the script again (it
re-resolves the head, so a push in between is exit 3), or starts it with `run_in_background`. Output on stdout, and nothing else:

```text
head: a2e19e6… (PR #138, base main)
Backend tests                          success
Frontend lint, types, ratchet and build success
Docs links and explanation references  failure   log: /tmp/pr-wait-138-docs.log
Prod-like stack smoke                  success
E2E journeys                           success
result: failure
```

For a required check that finished with anything other than `success` (including `cancelled`, `skipped`,
`neutral`, `timed_out`), the script saves the failed steps' log (`gh run view --job <check run id> --log-failed`: job-scoped, so it works while
other jobs still run) to a file under `${TMPDIR:-/tmp}` and prints its path; the log itself is never printed. If the
log cannot be fetched the line says `log: unavailable` and the exit code does not change. A required check with no run on the SHA is
`missing`, never `success`.

| Exit | `result:` | Meaning |
|---|---|---|
| 0 | `success` | every required check `success` on the head |
| 1 | `failure` | a required check finished and was not `success` (reported as soon as it is known, without waiting for the others) |
| 2 | `timeout` | the timeout passed with a required check `pending` or `missing` (both listed) |
| 3 | `head-moved` | the PR's head is no longer the SHA the wait started on (a push during the wait), or `--sha` was given and the head is not that SHA |
| 4 | `error` | `gh` failed; the protection could not be read, or its required list is **empty or absent** (fail closed: the script never guesses a list, and nothing required is not "all green"); or the PR is closed unmerged |
| 64 | — | usage error |

A merged PR is allowed (its head's checks are still readable), so the script can be exercised against a real PR.
If the protection cannot be read for lack of permission (exit 4), the agent may fall back to `gh pr checks --watch`
as today, confirming the five names and the head SHA itself from `pr-state.sh`, and says so in the PR.

### `scripts/pr-state.sh <PR>`

One JSON object, only the fields the merge gate and the handoff need (`gh pr view --json` for these, plus the
compare against the base):

```json
{"number":138,"state":"OPEN","draft":false,"head":"<sha>","base":"main","base_sha":"<sha>",
 "behind_by":0,"mergeable":"MERGEABLE","merge_state":"CLEAN","title":"…","url":"…","merge_commit":null}
```

`behind_by` is the base-branch commit count not in the head (from the compare API). `merge_commit` is the merge
commit's SHA once merged, else `null`. Exit 0, or 4 on a `gh` failure. It makes no judgement: `behind_by > 0` or a
`merge_state` other than `CLEAN` is for the agent to act on, and `mergeable: UNKNOWN` (usual right after a push) is
asked again, never read as clean.

### Command changes

- `build-ticket.md` step 1: "Run `scripts/ticket-preflight.sh $ARGUMENTS --create`" replaces the separate inbox read,
  dependency check and `git worktree add` (exit 10–13 map to the existing stop and block paths). Step 2's rule to read
  the ticket from the worktree stays.
- Steps 3, 4, 5 and 6 (every "push and wait for CI"): `git push` then `scripts/pr-wait.sh <PR>`; on exit 1 the agent
  reads the log file and fixes the cause (the playbook's two-retry rule for unrelated failures is unchanged); on exit
  2 it runs the script again; exits 2, 3 and 4 are never treated as green.
- Step 7 (merge gate): `scripts/pr-wait.sh <PR> --sha <the sha the checklist was ticked against>`, then
  `scripts/pr-state.sh <PR>`, then `gh pr merge <N> --squash --delete-branch --match-head-commit <that sha>`. The
  playbook's step 7 gets the same flag on its merge command. A head that moved since the boxes were ticked makes
  `gh` refuse; the agent re-ticks the changed boxes.
- Handoff (step 9): the merge commit comes from `scripts/pr-state.sh`.
- `implement-ticket.md` Verify 5 and the playbook's step 4: "wait for CI" names `scripts/pr-wait.sh`.
- `CLAUDE.md` "Context hygiene": the `gh pr view --json` bullet names `scripts/pr-state.sh` as the way to get the
  merge-gate fields once. No line is added.

## Acceptance criteria

The self-test (`scripts/check-ticket-helpers.sh`) feeds the scripts a fake `gh` (a shell script serving fixture files
and recording each call) and, for the preflight, a temporary repository with a fake `origin`. The check-run, protection
and PR fixtures are **captured from real GitHub responses** for PR #138 (head `a2e19e6e0ac0dd555f28fc5f339fe72b568d9426`),
then edited only where a criterion needs a different conclusion; the PR shows which fields were edited.

1. **Given** a paused inbox on `origin/main` (while the checkout's own `main` says `running`), **when**
   `ticket-preflight.sh` runs, **then** it exits 10 and prints `run_state: paused`, and `--create` made no worktree.
2. **Given** a ticket whose dependency is `todo` on `origin/main` but `done` in the checkout's stale `main`, **when**
   it runs, **then** it exits 11 naming the dependency and its status; a dependency absent from the index is exit 11
   with `<ID>=missing`.
3. **Given** a ready ticket, **when** it runs with `--create`, **then** it exits 0, prints the fields above, and the
   worktree exists on a branch from `origin/main`'s commit; a second `--create` exits 14 and changes nothing. A
   ticket ID that is only a prefix of another's (`P6-03` vs `P6-03b`) matches the exact row only.
4. **Given** a `done`, a `review`, a `blocked` and a missing ticket, **then** exit 13, 13, 13 and 12; **given** an
   inbox with no `Run state:` line or an unreadable index row, **then** exit 65, never 0; **given** a paused inbox and
   an unmet dependency, **then** exit 10 with both facts printed.
5. **Given** all required checks `success` on the head, **when** `pr-wait.sh` runs, **then** exit 0, `result:
   success`, and the head SHA printed is the PR's.
6. **Given** one required check `failure` and another `pending`, **then** exit 1 at once (the pending one is not
   waited for), the failure's job-scoped log is saved to a file whose path is printed, and the log text is absent from
   stdout; **given** the log fetch fails, **then** the line says `log: unavailable` and the exit is still 1.
7. **Given** a required check that is `cancelled`, `skipped`, `neutral` or `timed_out`, **then** each is exit 1,
   never 0.
8. **Given** a required check with no run on the head (the push's checks not yet created, or a renamed job), **when**
   the timeout passes, **then** exit 2 with that check listed `missing`; and **given** zero check runs at all, also
   exit 2, never 0. (This is the `sleep 20` race.)
9. **Given** the PR's head changes during the wait, or `--sha` differs from the head, **then** exit 3 and the output
   names both SHAs; a success recorded for the old head is never reported.
10. **Given** the branch protection cannot be read, or `gh` fails, or the PR is closed unmerged, **then** exit 4 and
    no `success` line.
11. **Given** protection that reads fine but whose required list is empty, or whose `required_status_checks` is null or
    absent, while some other check run on the head is red, **then** exit 4 and no `success` line.
12. **Given** a check run whose name matches a required one but whose app is not the required `app_id`, **then** it does
    not satisfy that check (`missing`, exit 2).
13. **Given** check runs on several pages, **then** a required check on page 2 is found; **given** two runs of one job
    (a failed run, then a successful re-run), **then** the latest decides.
14. **Given** a PR, **when** `pr-state.sh` runs, **then** it prints one JSON object with exactly the keys above;
    for a PR behind its base `behind_by` is the true count, for a merged PR `merge_commit` is its SHA, and
    `mergeable: UNKNOWN` is printed as `UNKNOWN`.
15. **Given** the changed files, **then** these commands print nothing (they are the criteria's proof, pasted in the PR):
    `git diff --exit-code origin/main...HEAD -- docs/templates/REVIEW_PROMPT.md .claude/commands/review-ticket.md`;
    and `git diff origin/main...HEAD -- docs/AI_AGENT_PLAYBOOK.md` shows removed lines only in the step 4 and step 7
    command lines that gain a helper name or `--match-head-commit`, no checkbox, stop rule or protected-gate line
    changed. `git diff origin/main...HEAD -- .github/workflows/ci.yml` shows only added steps and added names in the
    shellcheck step.
16. **Given** the four mutations (the SHA comparison removed; `success` accepted for `skipped`; zero runs treated as
    green; the protection's required list ignored or its emptiness accepted), **when** the self-test runs on each,
    **then** it fails. Evidence, not a repeatable check: made by hand, pasted in the PR.

## Test plan

- `scripts/check-ticket-helpers.sh` (criteria 1–14, one function per criterion; exits non-zero on any failure and
  prints the failing criterion). Wired into `.github/workflows/ci.yml`'s `docs` job as a new step; the new scripts are
  added to the `prodlike` job's `Shellcheck the smoke scripts` step (additions only, [protected
  gates](../AI_AGENT_PLAYBOOK.md#protected-gates)). `make lint` also runs the self-test (shellcheck itself is CI-only
  where it is not installed).
- Criterion 15: the three commands above, run by the author and the reviewer.
- Criterion 16: `scripts/mutation-probe.sh` is backend-only (it applies a patch and runs pytest), so these shell
  mutations are made **by hand on a clean committed tree**, each shown failing, then restored with `git checkout` and
  the baseline shown green.
- Manual, against GitHub (read-only): `scripts/pr-wait.sh 138` on the merged P6-03b PR exits 0 with the five required
  checks and prints head `a2e19e6…`; `scripts/pr-wait.sh 138 --sha 0000000000000000000000000000000000000000` exits 3;
  `scripts/pr-state.sh 138` prints merge commit `9b428fe…`. Paste the output.
- Commands: `bash scripts/check-ticket-helpers.sh`; `shellcheck scripts/ticket-preflight.sh scripts/pr-wait.sh
  scripts/pr-state.sh scripts/check-ticket-helpers.sh` (CI); `python3 scripts/check-links.py`.
- After merge, not a criterion: the next five tickets' parent responses per ticket are counted with the audit's
  method (message-ID dedup, phase timestamps) against the baseline above, and the number is added to the inbox. The
  baseline is only in this ticket, since the audit's files lived under `/tmp`. Five tickets can show a token change
  but not that defects are unchanged; the unchanged reviewers and merge gate are what protect that.

## Likely files

`scripts/ticket-preflight.sh`, `scripts/pr-wait.sh`, `scripts/pr-state.sh`, `scripts/check-ticket-helpers.sh`;
`.claude/commands/build-ticket.md`, `.claude/commands/implement-ticket.md`; `docs/AI_AGENT_PLAYBOOK.md` (step 4, step
7 command line); `CLAUDE.md` (Context hygiene); `.github/workflows/ci.yml` (docs job: one step, shellcheck list);
`Makefile` (`lint`). Existing patterns to follow: `scripts/check-eslint-fence.sh` (a self-test with a `check()` helper
and a failure counter), `scripts/smoke.sh` (bash style, shellcheck-clean).

## Open decisions

Framing resolves each with the [decision rules](../AI_AGENT_PLAYBOOK.md#decision-rules). Defaults:

- Directory: flat `scripts/` like the existing scripts (default), not `scripts/ticket/`.
- Required checks from branch protection (default), not a list in the script. Cost: reading protection needs a
  token with repository admin, which James's `gh` login has; if the protection call is refused, fail closed (exit 4).
- Poll interval 30 s (as the runs used) and default timeout 540 s (under the Bash tool's 10-minute cap; the runs
  used 1500 s, which only fits a background command).
- A timeout (exit 2) is reported, never retried by the script; the agent decides whether to wait again.
- Whether `/draft-ticket` and `/milestone-recap` also call `pr-wait.sh` (default: yes for the "wait for CI" step of
  draft-ticket step 7; the recap is out of scope unless it has the same wait).

## Must explain (learning checkpoint)

1. Why does `pr-wait.sh` key everything to a head SHA, and what concrete mistake does that prevent that
   `gh pr checks --watch` alone does not?
2. Why are "no run" and "zero runs" failures and not successes? Which earlier `sleep 20` pattern was this replacing?
3. What does `--match-head-commit` add at the merge gate that the green wait did not already give?
4. What is deliberately not automated here (failure reading, the merge decision, the PR prose), and why does the
   saving come from fewer model responses rather than from skipping any check?
5. How does the self-test show each helper can fail, and why is that required?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / convention / default / autonomous; for consequential ones,
  also the alternatives considered and why they lost):
- Split:
