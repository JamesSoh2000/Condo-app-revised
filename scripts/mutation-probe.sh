#!/usr/bin/env bash
# Mutation probe (CLAUDE.md lessons "prove a gate can fail" and "commit before mutation probes"):
# applies a patch that breaks the code on purpose, runs the given backend tests, and expects them to
# FAIL; then restores the patched files from git and runs the same tests again, expecting them to
# pass (the clean baseline).
#   exit 0 -> the tests failed on the mutation and pass without it (the probe proves something)
#   exit 1 -> the tests passed on the mutation (they don't catch it), or the baseline fails
#   exit 2 -> refused: the working tree is dirty, or the patch doesn't apply
# Usage: bash scripts/mutation-probe.sh <patch> <pytest args...>   (DB_PORT=... passes through)
# Example: bash scripts/mutation-probe.sh /tmp/no-claim.patch tests/invitations/test_concurrency.py
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

run() { make test DB_PORT="${DB_PORT:-5432}" PYTEST_ADDOPTS="-q $*"; }

git apply "$patch"
echo "== mutated: ${files[*]}"
if run "$@"; then
  echo "PROBE FAILED: the tests passed with the mutation applied" >&2
  exit 1
fi
restore
trap - EXIT
echo "== restored; clean baseline:"
if ! run "$@"; then
  echo "BASELINE FAILED: the tests fail without the mutation" >&2
  exit 1
fi
echo "PROBE OK: the tests fail on the mutation and pass without it"
