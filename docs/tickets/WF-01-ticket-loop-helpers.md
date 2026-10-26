# WF-01 — Ticket-loop helpers: preflight, PR wait and PR state

| Field | Value |
|---|---|
| Phase / lane | Workflow (off-roadmap, like P2-gate-01) / B |
| Risk tier | 2 (tooling, but its output feeds the merge gate) |
| Depends on | — |
| Replaces old | — |
| Status | todo |

## Goal

The agent gets a ticket's preflight state, a CI verdict bound to one PR head, and the PR facts the merge gate needs
from three read-only scripts, each in one command with a compact result, with no change to who reviews, what is
tested or what the merge gate requires.

## Why

A token audit of eight completed runs (P6-01b … P6-03a, 2026-10-24 to 10-26, parent model `claude-opus-5-5`) found
**101 parent responses that were a coordination command directly after another one** (git state, `gh pr …`, a CI
wait, a Codex launch): about 12.6 per ticket and 21.7M of the 233.5M cumulative tokens (9%, 97.7% of all tokens being
cache reads). That is a ceiling, not a forecast: a response whose output decides the next step is still needed. The
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
  - `scripts/check-ticket-helpers.sh`: the helpers' self-test against a fake `gh` and a temporary git repository,
    run by CI's `docs` job and linted by its shellcheck step.
  - The commands that call them: `.claude/commands/build-ticket.md` (steps 1, 3, 4, 7 and the handoff) and
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
binary (for the self-test). They never write to the repository, GitHub, or the inbox, except `ticket-preflight.sh
--create`, which only runs `git fetch` and `git worktree add`. Output is stdout; diagnostics go to stderr.

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
worktree: ../bw-p6-03e            # "exists" is printed after the path when it already does
base: <origin/main sha>
```

| Exit | Meaning |
|---|---|
| 0 | ready: not paused, ticket found, every dependency `done`, status `todo` or `in progress` |
| 10 | `Run state: paused` in `docs/HUMAN_INBOX.md` |
| 11 | a dependency is not `done` (it is printed with its status) |
| 12 | ticket not in the index, or its file is missing |
| 13 | status is `done`, `review` or `blocked` (printed) |
| 2 | usage or git error |

`--create` (exit 0 only): `git worktree add ../bw-<id lowercase> -b <branch> origin/main`, where `<branch>` is
`<id lowercase>-<slug>` with the slug from the ticket's file name. Refuses (exit 14) if the branch or the directory
already exists. It does not edit the ticket's status; the agent does that in the ticket's first commit.

### `scripts/pr-wait.sh <PR> [--sha <sha>] [--timeout <s>]`

Resolves the PR's head SHA, then waits until **every required check** has a completed result **on that SHA**, or the
timeout (default 1500 s, polling every 30 s; the first poll is at once). The required checks are read from the base
branch's protection (`required_status_checks.contexts`) so the list never lives in two places; the script reads
check runs of that SHA (`commits/<sha>/check-runs`, all pages). Output on stdout, and nothing else:

```text
head: 9b428fe… (PR #138, base main)
Backend tests                          success
Frontend lint, types, ratchet and build success
Docs links and explanation references  failure   log: /tmp/pr-wait-138-docs.log
Prod-like stack smoke                  success
E2E journeys                           success
result: failure
```

For a required check that finished with anything other than `success` (including `cancelled`, `skipped`,
`neutral`, `timed_out`), the script saves the failed steps' log (`gh run view <id> --log-failed`) to a file under
`${TMPDIR:-/tmp}` and prints its path; the log itself is never printed. A required check with no run on the SHA is
`missing`, never `success`.

| Exit | `result:` | Meaning |
|---|---|---|
| 0 | `success` | every required check `success` on the head |
| 1 | `failure` | a required check finished and was not `success` (reported as soon as it is known, without waiting for the others) |
| 2 | `timeout` | the timeout passed with a required check `pending` or `missing` (both listed) |
| 3 | `head-moved` | the PR's head is no longer the SHA the wait started on (a push during the wait), or `--sha` was given and the head is not that SHA |
| 4 | `error` | `gh` failed, the protection could not be read (fail closed: the script does not guess a list), or the PR is closed unmerged |

A merged PR is allowed (its head's checks are still readable), so the script can be exercised against a real PR.

### `scripts/pr-state.sh <PR>`

One JSON object, only the fields the merge gate and the handoff need (`gh pr view --json` for these, plus the
compare against the base):

```json
{"number":138,"state":"OPEN","draft":false,"head":"<sha>","base":"main","base_sha":"<sha>",
 "behind_by":0,"mergeable":"MERGEABLE","merge_state":"CLEAN","title":"…","url":"…","merge_commit":null}
```

`behind_by` is the base-branch commit count not in the head (from the compare API). `merge_commit` is the merge
commit's SHA once merged, else `null`. Exit 0, or 4 on a `gh` failure. It makes no judgement: `behind_by > 0` or a
`merge_state` other than `CLEAN` is for the agent to act on.

### Command changes

- `build-ticket.md` step 1: "Run `scripts/ticket-preflight.sh $ARGUMENTS --create`" replaces the separate inbox read,
  dependency check and `git worktree add` (exit 10–13 map to the existing stop and block paths). Step 2's rule to read
  the ticket from the worktree stays.
- Steps 3, 4, 5 and 6 (every "push and wait for CI"): `git push` then `scripts/pr-wait.sh <PR>`; on exit 1 the agent
  reads the log file and fixes the cause (the playbook's two-retry rule for unrelated failures is unchanged); exits 2
  and 3 are never treated as green.
- Step 7 (merge gate): `scripts/pr-wait.sh <PR> --sha <the sha the checklist was ticked against>`, then
  `scripts/pr-state.sh <PR>`, then `gh pr merge <N> --squash --delete-branch --match-head-commit <that sha>`. The
  playbook's step 7 gets the same flag on its merge command. A head that moved since the boxes were ticked makes
  `gh` refuse; the agent re-ticks the changed boxes.
- Handoff (step 9): the merge commit comes from `scripts/pr-state.sh`.
- `implement-ticket.md` Verify 5 and the playbook's step 4: "wait for CI" names `scripts/pr-wait.sh`.
- `CLAUDE.md` "Context hygiene": the `gh pr view --json` bullet names `scripts/pr-state.sh` as the way to get the
  merge-gate fields once. No line is added.

## Acceptance criteria

The self-test (`scripts/check-ticket-helpers.sh`) feeds the scripts a fake `gh` (a shell script reading fixture JSON
from a directory, recording each call) and, for the preflight, a temporary repository with a fake `origin`.

1. **Given** a paused inbox on `origin/main` (while the checkout's own `main` says `running`), **when**
   `ticket-preflight.sh` runs, **then** it exits 10 and prints `run_state: paused`, and `--create` made no worktree.
2. **Given** a ticket whose dependency is `todo` on `origin/main` but `done` in the checkout's stale `main`, **when**
   it runs, **then** it exits 11 naming the dependency and its status.
3. **Given** a ready ticket, **when** it runs with `--create`, **then** it exits 0, prints the fields above, and the
   worktree exists on a branch from `origin/main`'s commit; a second `--create` exits 14 and changes nothing. A
   ticket ID that is only a prefix of another's (`P6-03` vs `P6-03b`) matches the exact row only.
4. **Given** a done, a missing and a blocked ticket, **then** exit 13, 12 and 13.
5. **Given** all required checks `success` on the head, **when** `pr-wait.sh` runs, **then** exit 0, `result:
   success`, and the head SHA printed is the PR's.
6. **Given** one required check `failure` and another `pending`, **then** exit 1 at once (the pending one is not
   waited for), the failure's log is saved to a file whose path is printed, and the log text is absent from stdout.
7. **Given** a required check that is `cancelled`, `skipped`, `neutral` or `timed_out`, **then** each is exit 1,
   never 0.
8. **Given** a required check with no run on the head (the push's checks not yet created, or a renamed job), **when**
   the timeout passes, **then** exit 2 with that check listed `missing`; and **given** zero check runs at all, also
   exit 2, never 0. (This is the `sleep 20` race.)
9. **Given** the PR's head changes during the wait, or `--sha` differs from the head, **then** exit 3 and the output
   names both SHAs; a success recorded for the old head is never reported.
10. **Given** the branch protection cannot be read, or `gh` fails, or the PR is closed unmerged, **then** exit 4 and
    no `success` line.
11. **Given** check runs on several pages, **then** a required check on page 2 is found.
12. **Given** a PR, **when** `pr-state.sh` runs, **then** it prints one JSON object with exactly the keys above;
    for a PR behind its base `behind_by` is the true count, and for a merged PR `merge_commit` is its SHA.
13. **Given** the changed command files, **then** `git diff --stat` shows `REVIEW_PROMPT.md`, `review-ticket.md`,
    the merge gate's checkboxes and the stop rules untouched, and the playbook's step 7 differs from `main` only by
    the added flag and helper names.
14. **Given** each helper with one of its checks deliberately broken (the SHA comparison removed; `success` accepted
    for `skipped`; zero runs treated as green; the protection list ignored), **when** the self-test runs, **then** it
    fails. Done once by hand and pasted in the PR as the mutation evidence (CLAUDE.md "prove a gate can fail").

## Test plan

- `scripts/check-ticket-helpers.sh` (criteria 1–12, in one file, one function per criterion; exit non-zero on any
  failure and print the failing criterion). Wired into `.github/workflows/ci.yml`'s `docs` job as a new step, and the
  new scripts added to its shellcheck step's list (additions only, [protected
  gates](../AI_AGENT_PLAYBOOK.md#protected-gates)). Also `make lint` runs it (a line in the existing `lint` target).
- Criterion 13: reviewer-checked from the diff; the PR's evidence table shows `git diff --stat main...HEAD`.
- Criterion 14: `scripts/mutation-probe.sh` is the existing tool for source mutations; the four mutations are made
  with it or by hand on a clean tree, each shown failing, then restored with the baseline green.
- Manual, against GitHub (read-only): `scripts/pr-wait.sh 138` on the merged P6-03b PR exits 0 with the five required
  checks; `scripts/pr-wait.sh 138 --sha 0000000000000000000000000000000000000000` exits 3;
  `scripts/pr-state.sh 138` prints the merge commit. Paste the output.
- Commands: `bash scripts/check-ticket-helpers.sh`; `shellcheck scripts/ticket-preflight.sh scripts/pr-wait.sh
  scripts/pr-state.sh scripts/check-ticket-helpers.sh`; `make check` (docs links: `python3 scripts/check-links.py`).
- After merge, not a criterion: the next five tickets' parent responses per ticket are counted with the audit's
  method (message-ID dedup, phase timestamps) against the baseline above, and the number is added to the inbox. The
  baseline is only in this ticket, since the audit's files lived under `/tmp`.

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
- Poll interval 30 s and default timeout 1500 s, as the runs used (`--interval 30`, `timeout 1500`).
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
