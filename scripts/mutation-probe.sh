#!/usr/bin/env bash
# Mutation probe (CLAUDE.md lessons "prove a gate can fail" and "commit before mutation probes"):
# applies a patch that breaks the code on purpose, runs the given backend tests, and expects them to
# FAIL; then restores the patched files from git and runs the same tests again, expecting them to
# pass (the clean baseline).
#   exit 0 -> a test failed on the mutation and the tests pass without it (the probe proves something)
#   exit 1 -> no test failed on the mutation (they passed, or pytest errored before any test failed), or the
#             baseline fails
#   exit 2 -> refused: the working tree is dirty, or the patch doesn't apply
# Usage: bash scripts/mutation-probe.sh <patch> <pytest args...>   (DB_PORT=... passes through)
# Example: bash scripts/mutation-probe.sh /tmp/no-claim.patch tests/invitations/test_concurrency.py -k "a or b"
# Each run's full output goes to a log file; only pytest's summary lines and the log's path are printed.
set -euo pipefail

if [[ $# -lt 2 ]]; then
  echo "usage: $0 <patch> <pytest args...>" >&2
  exit 2
fi
patch="$(realpath "$1")"
shift
repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$repo_root"

# Refuse a dirty tree: restoring with `git checkout` would also throw away uncommitted work.
if [[ -n "$(git status --porcelain)" ]]; then
  echo "refused: the working tree is dirty; commit first (git status --porcelain is not empty)" >&2
  exit 2
fi
if ! git apply --check "$patch"; then
  echo "refused: $patch does not apply" >&2
  exit 2
fi

mapfile -t files < <(git apply --numstat "$patch" | cut -f3)
restore() { git checkout -- "${files[@]}"; }
trap restore EXIT

logs="$(mktemp -d "${TMPDIR:-/tmp}/mutation-probe.XXXXXX")"
# run <name> <pytest args...>: make test with the args kept one by one (shlex.join, so `-k "a or b"` stays one
# argument), output to $logs/<name>.log, its summary lines printed.
run() {
  local name=$1 opts rc=0
  shift
  opts="$(python3 -I -c 'import shlex, sys; print(shlex.join(["-q", *sys.argv[1:]]))' "$@")" || return
  make test DB_PORT="${DB_PORT:-5432}" PYTEST_ADDOPTS="$opts" >"$logs/$name.log" 2>&1 || rc=$?
  grep -E '^(FAILED|ERROR)|[0-9]+ (passed|failed|errors?|deselected)|no tests ran|^(make|db-guard|usage)' \
    "$logs/$name.log" | tail -n 15
  echo "   (exit $rc; full output: $logs/$name.log)"
  return "$rc"
}

git apply "$patch"
echo "== mutated: ${files[*]}"
if run mutated "$@"; then
  echo "PROBE FAILED: the tests passed with the mutation applied" >&2
  exit 1
fi
# A usage or collection error also fails the run; only a failed test shows the tests catch the mutation.
if ! grep -qE '[0-9]+ failed' "$logs/mutated.log"; then
  echo "PROBE FAILED: no test failed on the mutation (pytest errored first; see the log)" >&2
  exit 1
fi
restore
trap - EXIT
echo "== restored; clean baseline:"
if ! run baseline "$@"; then
  echo "BASELINE FAILED: the tests fail without the mutation" >&2
  exit 1
fi
echo "PROBE OK: the tests fail on the mutation and pass without it"
