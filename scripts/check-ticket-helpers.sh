#!/usr/bin/env bash
# Self-test for the ticket-loop helpers (WF-01): scripts/ticket-preflight.sh, scripts/pr-wait.sh and
# scripts/pr-state.sh. The PR helpers run against a fake `gh` (scripts/fixtures/ticket-helpers/fake-gh) that
# serves JSON captured from GitHub for PR #138 (head a2e19e6); each criterion edits a copy with `jedit`, so the
# edited fields are visible below. The preflight runs in a temporary clone with a temporary bare `origin`.
# Nothing here touches the network or this repository. One function per acceptance criterion of
# docs/tickets/WF-01-ticket-loop-helpers.md.
# Usage: bash scripts/check-ticket-helpers.sh   (from anywhere in the repo; needs git and python3)
set -uo pipefail

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
fixtures="$root/scripts/fixtures/ticket-helpers"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
export GH="$fixtures/fake-gh"
# The helpers must not read the developer's git identity or config.
export GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_NOSYSTEM=1
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@example.com GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@example.com
old=a2e19e6e0ac0dd555f28fc5f339fe72b568d9426
new=c0ffee00c0ffee00c0ffee00c0ffee00c0ffee00
failures=0
label=
rc=0

ok() { printf 'ok    %s\n' "$1"; }
fail() {
  printf 'FAIL  %s (exit %s)\n' "$1" "$rc"
  sed 's/^/      out| /' "$work/out"
  sed 's/^/      err| /' "$work/err" | head -5
  failures=$((failures + 1))
}
# want <description> <test command...>: one assertion about the last `run`.
want() {
  local what=$1
  shift
  if "$@"; then ok "$label: $what"; else fail "$label: $what"; fi
}
code() { [[ $rc == "$1" ]]; }
has() { grep -qF -- "$1" "$work/out"; }
lacks() { ! grep -qF -- "$1" "$work/out"; }
# run <dir> <command...>: run in <dir>, stdout to $work/out, stderr to $work/err, exit code in $rc.
run() {
  local dir=$1
  shift
  rc=0
  (cd "$dir" && "$@") >"$work/out" 2>"$work/err" || rc=$?
}
# jedit <src> <dst> <python>: copy a JSON file, applying statements to `d`; run(name) is that check run.
jedit() {
  python3 -I - "$1" "$2" "$3" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
def run(name):
    return next(r for r in d["check_runs"] if r["name"] == name)
exec(sys.argv[3])
json.dump(d, open(sys.argv[2], "w"))
PY
}

# ---- PR helpers: a scenario is a fresh fake-gh directory and a clone whose origin is the real repository.
repo="$work/repo"
git init -q "$repo"
git -C "$repo" remote add origin git@github.com:JamesSoh2000/Condo-app-revised.git
scenario() {
  export FAKE_GH_DIR="$work/gh-$1"
  mkdir -p "$FAKE_GH_DIR"
  cp "$fixtures/protection.json" "$FAKE_GH_DIR/protection.json"
  cp "$fixtures/pr-view-138.json" "$FAKE_GH_DIR/pr.json"
  cp "$fixtures/check-runs-a2e19e6.json" "$FAKE_GH_DIR/runs-$old.json"
  cp "$fixtures/compare-138.json" "$FAKE_GH_DIR/compare.json"
  g="$FAKE_GH_DIR"
}
wait_pr() { run "$repo" bash "$root/scripts/pr-wait.sh" "$@"; }
open_pr() { # open_pr <dst> <head sha>: the captured PR, reopened at another head
  jedit "$fixtures/pr-view-138.json" "$1" "d['state']='OPEN'; d['mergeCommit']=None; d['headRefOid']='$2'"
}

c5() {
  label="5 all green"
  scenario c5
  wait_pr 138
  want "exit 0" code 0
  want "result success" has "result: success"
  want "head is the PR's" has "head: $old (PR #138, base main)"
  want "five required checks listed" test "$(grep -E '[[:space:]]success$' "$work/out" | grep -cv '^result:')" = 5
  open_pr "$g/pr.json" "$old"
  wait_pr 138 --sha "$old"
  want "open PR with matching --sha: exit 0" code 0
}

c6() {
  label="6 failure beside pending"
  scenario c6
  jedit "$g/runs-$old.json" "$g/runs-$old.json" \
    "run('Backend tests')['conclusion']='failure'; r=run('E2E journeys'); r['status']='in_progress'; r['conclusion']=None"
  printf 'SECRET-LOG-LINE pytest failed\n' >"$g/log-121909163678.json"
  local start=$SECONDS
  wait_pr 138
  want "exit 1" code 1
  want "result failure" has "result: failure"
  want "at once, the pending one not waited for" test $((SECONDS - start)) -lt 5
  want "pending one listed" grep -qE '^E2E journeys +pending$' "$work/out"
  local path
  path="$(sed -nE 's/^Backend tests +failure +log: (.*)$/\1/p' "$work/out")"
  want "log path printed" test -n "$path"
  want "log saved to that file" grep -qF SECRET-LOG-LINE "${path:-/nonexistent}"
  want "log file mode 0600" test "$(stat -c %a "${path:-/nonexistent}" 2>/dev/null)" = 600
  want "log text absent from stdout" lacks SECRET-LOG-LINE
  rm -f "${path:-/nonexistent}"
  rm "$g/log-121909163678.json"
  touch "$g/log-121909163678.fail"
  wait_pr 138
  want "log fetch fails: exit still 1" code 1
  want "log: unavailable" grep -qE '^Backend tests +failure +log: unavailable$' "$work/out"
}

c7() {
  local conclusion
  for conclusion in cancelled skipped neutral timed_out action_required stale; do
    label="7 $conclusion"
    scenario "c7-$conclusion"
    jedit "$g/runs-$old.json" "$g/runs-$old.json" "run('Docs links and explanation references')['conclusion']='$conclusion'"
    printf 'log\n' >"$g/log-121909163639.json"
    wait_pr 138
    want "exit 1, never 0" code 1
    want "no result success" lacks "result: success"
  done
}

c8() {
  label="8 renamed job"
  scenario c8
  jedit "$g/runs-$old.json" "$g/runs-$old.json" "run('Prod-like stack smoke')['name']='Prod-like smoke'"
  PR_WAIT_INTERVAL=1 wait_pr 138 --timeout 2
  want "exit 2" code 2
  want "listed missing" grep -qE '^Prod-like stack smoke +missing$' "$work/out"
  want "result timeout" has "result: timeout"
  label="8 zero runs"
  printf '{"total_count":0,"check_runs":[]}' >"$g/runs-$old.json"
  PR_WAIT_INTERVAL=1 wait_pr 138 --timeout 2
  want "exit 2, never 0" code 2
  want "all five missing" test "$(grep -cE ' missing$' "$work/out")" = 5
  label="8a queued and in progress"
  cp "$fixtures/check-runs-a2e19e6.json" "$g/runs-$old.json"
  jedit "$g/runs-$old.json" "$g/runs-$old.json" \
    "r=run('Backend tests'); r['status']='queued'; r['conclusion']=None; r=run('E2E journeys'); r['status']='in_progress'; r['conclusion']=None"
  PR_WAIT_INTERVAL=1 wait_pr 138 --timeout 2
  want "exit 2" code 2
  want "listed pending" test "$(grep -cE ' pending$' "$work/out")" = 2
}

c9() {
  label="9 head moves during the wait"
  scenario c9
  open_pr "$g/pr.1.json" "$old"
  open_pr "$g/pr.3.json" "$new"
  jedit "$g/runs-$old.json" "$g/runs-$old.json" "r=run('E2E journeys'); r['status']='in_progress'; r['conclusion']=None"
  cp "$fixtures/check-runs-a2e19e6.json" "$g/runs-$new.json"
  PR_WAIT_INTERVAL=1 wait_pr 138
  want "exit 3" code 3
  want "names both SHAs" has "moved: $old -> $new"
  want "result head-moved" has "result: head-moved"
  want "no result success" lacks "result: success"
  label="9 --sha differs from the head"
  scenario c9b
  PR_WAIT_HEAD_TIMEOUT=1 wait_pr 138 --sha "$new"
  want "exit 3" code 3
  want "names both SHAs" has "moved: $new -> $old"
  want "old head's green never reported" lacks "result: success"
}

c10() {
  label="10 protection unreadable"
  scenario c10
  rm "$g/protection.json"
  touch "$g/protection.fail"
  wait_pr 138
  want "exit 4" code 4
  want "no success line" lacks "success"
  label="10 gh fails on the PR"
  scenario c10b
  rm "$g/pr.json"
  touch "$g/pr.fail"
  wait_pr 138
  want "exit 4" code 4
  want "no success line" lacks "success"
  label="10 PR closed unmerged"
  scenario c10c
  jedit "$fixtures/pr-view-138.json" "$g/pr.json" "d['state']='CLOSED'; d['mergeCommit']=None"
  wait_pr 138
  want "exit 4" code 4
  want "no success line" lacks "success"
}

c11() {
  local edit
  for edit in "d['required_status_checks']['checks']=[]; d['required_status_checks']['contexts']=[]" \
    "d['required_status_checks']=None" "del d['required_status_checks']"; do
    label="11 required list: $edit"
    scenario c11
    jedit "$g/protection.json" "$g/protection.json" "$edit"
    jedit "$g/runs-$old.json" "$g/runs-$old.json" "d['check_runs'].append(dict(run('Backend tests'), id=1, name='Other', conclusion='failure'))"
    wait_pr 138
    want "exit 4" code 4
    want "no success line" lacks "success"
  done
}

c12() {
  label="12 name matches, app does not"
  scenario c12
  jedit "$g/protection.json" "$g/protection.json" "d['required_status_checks']['checks'][0]['app_id']=99999"
  PR_WAIT_INTERVAL=1 wait_pr 138 --timeout 2
  want "exit 2" code 2
  want "listed missing" grep -qE '^Backend tests +missing$' "$work/out"
  local any
  for any in None -1; do
    label="12 app_id $any is any source"
    scenario "c12-$any"
    jedit "$g/protection.json" "$g/protection.json" "d['required_status_checks']['checks'][0]['app_id']=$any"
    jedit "$g/runs-$old.json" "$g/runs-$old.json" "run('Backend tests')['app']['id']=4242"
    wait_pr 138
    want "exit 0" code 0
  done
}

c13() {
  label="13 two pages, concatenated"
  scenario c13
  python3 -I - "$g/runs-$old.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
runs = d["check_runs"]
page = lambda rs: json.dumps({"total_count": len(runs), "check_runs": rs})
open(sys.argv[1], "w").write(page(runs[:3]) + page(runs[3:]))
PY
  want "fixture puts E2E on page 2" python3 -I -c "import sys; t=open(sys.argv[1]).read(); assert t.index('E2E journeys') > t.index('}{')" "$g/runs-$old.json"
  wait_pr 138
  want "exit 0" code 0
  local order
  for order in rerun-last rerun-first; do
    label="13 failed run then re-run ($order)"
    scenario "c13-$order"
    jedit "$g/runs-$old.json" "$g/runs-$old.json" "
f = dict(run('Backend tests'), id=run('Backend tests')['id'] - 1, conclusion='failure')
d['check_runs'].insert(0 if '$order' == 'rerun-last' else len(d['check_runs']), f)"
    wait_pr 138
    want "the re-run (highest id) decides: exit 0" code 0
    label="13 success then failed re-run ($order)"
    scenario "c13b-$order"
    jedit "$g/runs-$old.json" "$g/runs-$old.json" "
f = dict(run('Backend tests'), id=run('Backend tests')['id'] + 1, conclusion='failure')
d['check_runs'].insert(0 if '$order' == 'rerun-last' else len(d['check_runs']), f)"
    printf 'log\n' >"$g/log-$((121909163678 + 1)).json"
    wait_pr 138
    want "the highest id decides: exit 1" code 1
  done
}

c14() {
  label="14 merged PR"
  scenario c14
  run "$repo" bash "$root/scripts/pr-state.sh" 138
  want "exit 0" code 0
  want "exact keys, merge commit, UNKNOWN kept" python3 -I -c "
import json, sys
d = json.loads(open(sys.argv[1]).read())
assert set(d) == {'number','state','draft','head','base','base_sha','behind_by','mergeable','merge_state','title','url','merge_commit'}, set(d)
assert d['merge_commit'] == '9b428fefb1d4c8f64e2db6a25b2ccf5024892dd0', d
assert d['mergeable'] == 'UNKNOWN' and d['merge_state'] == 'UNKNOWN', d
assert d['head'] == '$old' and d['number'] == 138 and d['draft'] is False and d['state'] == 'MERGED', d
assert d['base_sha'] == 'bed1f4b39ae199237ad1d2db2b54820886fc502b' and d['behind_by'] == 2, d
" "$work/out"
  want "one line of output" test "$(wc -l <"$work/out")" = 1
  label="14 open PR behind its base"
  scenario c14b
  jedit "$fixtures/pr-view-138.json" "$g/pr.json" \
    "d.update(state='OPEN', mergeCommit=None, mergeable='MERGEABLE', mergeStateStatus='BEHIND')"
  jedit "$fixtures/compare-138.json" "$g/compare.json" "d['behind_by']=7"
  run "$repo" bash "$root/scripts/pr-state.sh" 138
  want "behind_by is the compare's count, merge_commit null" python3 -I -c "
import json, sys
d = json.loads(open(sys.argv[1]).read())
assert d['behind_by'] == 7 and d['merge_commit'] is None and d['merge_state'] == 'BEHIND', d
" "$work/out"
  want "compare asked for base...head" grep -qF "compare/main...$old" "$g/calls"
  label="14 gh failure"
  rm "$g/compare.json"
  touch "$g/compare.fail"
  run "$repo" bash "$root/scripts/pr-state.sh" 138
  want "exit 4" code 4
  want "no JSON printed" test ! -s "$work/out"
}

c15() {
  label="15 --sha new, head still old at first"
  scenario c15
  open_pr "$g/pr.1.json" "$old"
  open_pr "$g/pr.3.json" "$new"
  cp "$fixtures/check-runs-a2e19e6.json" "$g/runs-$new.json"
  PR_WAIT_INTERVAL=1 wait_pr 138 --sha "$new"
  want "exit 0 for the new head" code 0
  want "reports the new head" has "head: $new"
  want "the old head's checks never read" bash -c "! grep -qF 'commits/$old/' '$g/calls'"
  label="15 head never becomes --sha"
  scenario c15b
  open_pr "$g/pr.json" "$old"
  local start=$SECONDS
  PR_WAIT_INTERVAL=1 PR_WAIT_HEAD_TIMEOUT=2 wait_pr 138 --sha "$new"
  want "exit 3" code 3
  want "no success for the old SHA" lacks "result: success"
  want "gives up after the head timeout" test $((SECONDS - start)) -lt 10
  label="15 head moves between the last poll and the final re-read"
  scenario c15c
  open_pr "$g/pr.1.json" "$old"
  open_pr "$g/pr.3.json" "$new"
  wait_pr 138 --sha "$old"
  want "exit 3" code 3
  want "names both SHAs" has "moved: $old -> $new"
  want "no result success" lacks "result: success"
}

c16() {
  label="16 malformed check-run response"
  scenario c16
  printf '{"check_runs": [' >"$g/runs-$old.json"
  wait_pr 138
  want "exit 4" code 4
  label="16 malformed PR response"
  scenario c16b
  printf 'not json' >"$g/pr.json"
  wait_pr 138
  want "exit 4" code 4
  label="16 gh crash mid-wait"
  scenario c16c
  jedit "$g/runs-$old.json" "$g/runs-$old.json" "r=run('E2E journeys'); r['status']='in_progress'; r['conclusion']=None"
  mv "$g/runs-$old.json" "$g/runs-$old.1.json"
  touch "$g/runs-$old.2.fail"
  PR_WAIT_INTERVAL=1 wait_pr 138
  want "exit 4, never 1 or 0" code 4
  label="16 malformed compare"
  scenario c16d
  printf '[]' >"$g/compare.json"
  run "$repo" bash "$root/scripts/pr-state.sh" 138
  want "pr-state exit 4" code 4
  label="16 --timeout 1 with a pending check"
  scenario c16e
  jedit "$g/runs-$old.json" "$g/runs-$old.json" "r=run('E2E journeys'); r['status']='in_progress'; r['conclusion']=None"
  local start=$SECONDS
  wait_pr 138 --timeout 1
  want "exit 2" code 2
  want "within a few seconds (the 30 s poll is cut to the deadline)" test $((SECONDS - start)) -lt 5
  label="16 usage"
  local args
  for args in "" "138 --bogus" "abc" "138 --timeout" "138 --timeout x" "138 --timeout 0" "138 --sha" "138 139"; do
    # shellcheck disable=SC2086
    wait_pr $args
    want "pr-wait '$args' exit 64" code 64
  done
  for args in "" "138 --bogus" "138 139" "x"; do
    # shellcheck disable=SC2086
    run "$repo" bash "$root/scripts/pr-state.sh" $args
    want "pr-state '$args' exit 64" code 64
  done
}

# ---- Preflight: a bare origin, a seed clone that pushes to it, and the clone the script runs in.
index_md() { # index_md <row>...: an index whose rows are "ID|deps|status[|tier]"
  printf '# Tickets\n\n| ID | Title | Lane | Tier | Depends on | Status | Learned |\n|---|---|---|---|---|---|---|\n'
  local row id deps status tier
  for row in "$@"; do
    IFS='|' read -r id deps status tier <<<"$row"
    printf '| [%s](./%s-%s.md) | Title of %s | B | %s | %s | %s | — |\n' \
      "$id" "$id" "$(slug "$id")" "$id" "${tier:-2}" "$deps" "$status"
  done
}
slug() { case "$1" in P6-03e) echo maintenance-cancel-and-emergency-phone ;; *) echo "${1,,}-work" ;; esac; }
# publish <state> <row>...: push an inbox with that run state, the index and every ticket file to origin.
publish() {
  local state=$1 row id
  shift
  rm -rf "$seed/docs"
  mkdir -p "$seed/docs/tickets"
  printf '# Human Inbox\n\n**Run state: %s**\n' "$state" >"$seed/docs/HUMAN_INBOX.md"
  [[ $state == none ]] && printf '# Human Inbox\n\nNo state line.\n' >"$seed/docs/HUMAN_INBOX.md"
  index_md "$@" >"$seed/docs/tickets/README.md"
  for row in "$@"; do
    id="${row%%|*}"
    printf '# %s\n' "$id" >"$seed/docs/tickets/$id-$(slug "$id").md"
  done
  git -C "$seed" add -A && git -C "$seed" commit -qm "publish $state" && git -C "$seed" push -q origin HEAD:main
}
world() { # world <name>: a fresh origin, seed and clone under $work/<name>; the clone tracks main
  base_dir="$work/$1"
  mkdir -p "$base_dir"
  git init -q --bare -b main "$base_dir/origin.git"
  git clone -q "$base_dir/origin.git" "$base_dir/seed" 2>/dev/null
  seed="$base_dir/seed"
  git -C "$seed" symbolic-ref HEAD refs/heads/main
}
clone() { git clone -q "$base_dir/origin.git" "$base_dir/clone"; clone_dir="$base_dir/clone"; }
preflight() { run "$clone_dir" bash "$root/scripts/ticket-preflight.sh" "$@"; }

c1() {
  label="1 paused on origin/main, running in the checkout"
  world c1
  publish running "P6-03e|—|todo"
  clone
  publish paused "P6-03e|—|todo"
  want "checkout's main says running" bash -c "git -C '$clone_dir' show main:docs/HUMAN_INBOX.md | grep -q 'Run state: running'"
  preflight P6-03e --create
  want "exit 10" code 10
  want "run_state: paused" has "run_state: paused"
  want "no worktree made" test ! -e "$base_dir/bw-p6-03e"
  want "no branch made" bash -c "! git -C '$clone_dir' show-ref --verify --quiet refs/heads/p6-03e-maintenance-cancel-and-emergency-phone"
}

c2() {
  label="2 dependency todo on origin/main, done in the stale checkout"
  world c2
  publish running "P6-03b|—|done" "P6-03e|P6-03b|todo"
  clone
  publish running "P6-03b|—|todo" "P6-03e|P6-03b|todo"
  preflight P6-03e --create
  want "exit 11" code 11
  want "names the dependency and its status" has "depends_on: P6-03b=todo"
  want "no worktree made" test ! -e "$base_dir/bw-p6-03e"
  label="2 dependency not in the index"
  publish running "P6-03e|P6-03b, P9-99|todo" "P6-03b|—|done"
  preflight P6-03e
  want "exit 11" code 11
  want "<ID>=missing" has "depends_on: P6-03b=done, P9-99=missing"
}

c3() {
  label="3 ready, --create"
  world c3
  publish running "P6-03|—|todo|3" "P6-03b|P6-03|done|1" "P6-03e|P6-03b|todo"
  clone
  publish running "P6-03|—|todo|3" "P6-03b|P6-03|done|1" "P6-03e|P6-03b|in progress"
  local base
  base="$(git -C "$seed" rev-parse HEAD)"
  preflight P6-03e --create
  want "exit 0" code 0
  want "ticket" has "ticket: P6-03e"
  want "file" has "file: docs/tickets/P6-03e-maintenance-cancel-and-emergency-phone.md"
  want "tier" has "tier: 2"
  want "status" has "status: in progress"
  want "run_state" has "run_state: running"
  want "depends_on" has "depends_on: P6-03b=done"
  want "branch" has "branch: p6-03e-maintenance-cancel-and-emergency-phone"
  want "worktree" grep -qE '^worktree: \.\./bw-p6-03e( |$)' "$work/out"
  want "base is origin/main" has "base: $base"
  want "keys in order" test "$(cut -d: -f1 "$work/out" | tr '\n' ' ')" = "ticket file tier status run_state depends_on branch worktree base "
  want "worktree on origin/main's commit" test "$(git -C "$base_dir/bw-p6-03e" rev-parse HEAD 2>/dev/null)" = "$base"
  want "worktree on the branch" test "$(git -C "$base_dir/bw-p6-03e" branch --show-current 2>/dev/null)" = p6-03e-maintenance-cancel-and-emergency-phone
  label="3 second --create"
  local before
  before="$(git -C "$clone_dir" for-each-ref; git -C "$clone_dir" worktree list --porcelain)"
  preflight P6-03e --create
  want "exit 14" code 14
  want "nothing changed" test "$(git -C "$clone_dir" for-each-ref; git -C "$clone_dir" worktree list --porcelain)" = "$before"
  label="3 directory exists without the branch"
  mkdir "$base_dir/bw-p6-03"
  preflight P6-03 --create
  want "exit 14" code 14
  want "no branch made" bash -c "! git -C '$clone_dir' show-ref --verify --quiet refs/heads/p6-03-p6-03-work"
  label="3 a prefix of another ID"
  preflight P6-03
  want "exit 0" code 0
  want "the exact row's tier" has "tier: 3"
  want "the exact row's file" has "file: docs/tickets/P6-03-p6-03-work.md"
  want "worktree marked exists" has "worktree: ../bw-p6-03 exists"
  preflight P6-0
  want "a shorter prefix is not found: exit 12" code 12
}

c4() {
  world c4
  publish running "P1-01|—|done" "P1-02|—|review" "P1-03|—|blocked" "P1-04|—|todo" "P1-05|P1-04|todo"
  clone
  local id want_rc
  for id in P1-01:13 P1-02:13 P1-03:13 P1-09:12; do
    want_rc="${id#*:}"
    id="${id%:*}"
    label="4 $id"
    preflight "$id" --create
    want "exit $want_rc" code "$want_rc"
    want "no worktree made" test ! -e "$base_dir/bw-${id,,}"
  done
  label="4 file missing"
  git -C "$seed" rm -q docs/tickets/P1-04-p1-04-work.md && git -C "$seed" commit -qm rm && git -C "$seed" push -q origin HEAD:main
  preflight P1-04
  want "exit 12" code 12
  label="4 no Run state line"
  publish none "P1-04|—|todo"
  preflight P1-04
  want "exit 65, never 0" code 65
  local bad
  for bad in "P1-04|—|wip" "P1-04|—|todo|x" "P1-04|P1 04|todo" "P1-05|P1-04|todo" ; do
    label="4 unreadable row: $bad"
    if [[ $bad == "P1-05|P1-04|todo" ]]; then
      publish running "$bad"
      printf '| [P1-04](./P1-04-p1-04-work.md) | short row | B | 2 | — |\n' >>"$seed/docs/tickets/README.md"
      git -C "$seed" commit -qam short && git -C "$seed" push -q origin HEAD:main
      preflight P1-05
    else
      publish running "$bad"
      preflight P1-04
    fi
    want "exit 65, never 0" code 65
  done
  label="4 unreadable row: link to another file"
  publish running "P1-04|—|todo"
  sed -i 's#(./P1-04-p1-04-work.md)#(./other.md)#' "$seed/docs/tickets/README.md"
  git -C "$seed" commit -qam link && git -C "$seed" push -q origin HEAD:main
  preflight P1-04
  want "exit 65" code 65
  label="4 listed twice"
  publish running "P1-04|—|todo" "P1-04|—|done"
  preflight P1-04
  want "exit 65" code 65
  label="4 unknown run state"
  publish stopped "P1-04|—|todo"
  preflight P1-04
  want "exit 65" code 65
  label="4 paused and an unmet dependency"
  publish paused "P1-04|—|todo" "P1-05|P1-04|todo"
  preflight P1-05 --create
  want "exit 10" code 10
  want "paused printed" has "run_state: paused"
  want "dependency printed" has "depends_on: P1-04=todo"
  label="4 paused, done and an unmet dependency"
  publish paused "P1-04|—|todo" "P1-05|P1-04|done"
  preflight P1-05
  want "exit 10" code 10
  want "status printed" has "status: done"
  label="4 done and an unmet dependency"
  publish running "P1-04|—|todo" "P1-05|P1-04|done"
  preflight P1-05
  want "exit 13 before 11" code 13
  want "dependency printed" has "depends_on: P1-04=todo"
}

c16_preflight() {
  label="16 preflight: origin/main not fetchable"
  world c16p
  publish running "P1-04|—|todo"
  clone
  git -C "$clone_dir" remote set-url origin "$base_dir/nowhere.git"
  preflight P1-04
  want "exit 65" code 65
  label="16 preflight: index missing on origin/main"
  git -C "$clone_dir" remote set-url origin "$base_dir/origin.git"
  git -C "$seed" rm -q docs/tickets/README.md && git -C "$seed" commit -qm rm && git -C "$seed" push -q origin HEAD:main
  preflight P1-04
  want "exit 65, never 0 or 1" code 65
  label="16 preflight usage"
  local args
  for args in "" "P1-04 --bogus" "P1-04 P1-05" "p1 04" "--create"; do
    # shellcheck disable=SC2086
    preflight $args
    want "'$args' exit 64" code 64
  done
}

c1
c2
c3
c4
c5
c6
c7
c8
c9
c10
c11
c12
c13
c14
c15
c16
c16_preflight

if ((failures)); then
  echo "check-ticket-helpers: $failures failure(s)"
  exit 1
fi
echo "check-ticket-helpers: all passed"
