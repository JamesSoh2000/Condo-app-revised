#!/usr/bin/env bash
# Base44 ratchet (ADR-0011): counts `base44.` and `@base44/` references under frontend/src and compares
# the count with frontend/base44-baseline.txt.
#   higher than the baseline -> exit 1 (new Base44 usage is not allowed)
#   lower                    -> exit 0, with a reminder to lower the baseline in the same PR
# Usage: bash scripts/base44-count.sh   (from anywhere in the repo)
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
src_dir="$repo_root/frontend/src"
baseline_file="$repo_root/frontend/base44-baseline.txt"

if [[ ! -d $src_dir ]]; then
  echo "::error::$src_dir not found; the ratchet has nothing to count." >&2
  exit 1
fi

# -R follows symlinks, so references can't hide behind one.
count="$( (grep -RhoE 'base44\.|@base44/' "$src_dir" || true) | wc -l | tr -d ' ')"
baseline="$(tr -d '[:space:]' < "$baseline_file")"
# No leading zeros: bash arithmetic would read 08 or 0999 as (invalid) octal and skip both checks.
if [[ ! $baseline =~ ^(0|[1-9][0-9]*)$ ]]; then
  echo "::error::frontend/base44-baseline.txt must hold one plain number, got '$baseline'." >&2
  exit 1
fi

echo "Base44 references under frontend/src: $count (baseline: $baseline)"

if (( count > baseline )); then
  echo "::error::Base44 references went up from $baseline to $count. New code must use src/api, not Base44 (ADR-0011)." >&2
  echo "Where they are: grep -RnE 'base44\\.|@base44/' frontend/src" >&2
  exit 1
fi

if (( count < baseline )); then
  echo "Base44 references went down. Lower the ratchet in this PR: echo $count > frontend/base44-baseline.txt"
fi
