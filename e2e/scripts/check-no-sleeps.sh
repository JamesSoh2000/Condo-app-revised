#!/usr/bin/env bash
# P4-09 criterion 5: journeys wait for what they need (web-first assertions, expect.poll), never for a fixed time.
# Fails on any hard sleep under tests/ and helpers/.
set -euo pipefail
cd "$(dirname "$0")/.."
if grep -rnE 'waitForTimeout\(|\.waitFor\(\s*[0-9]|setTimeout\(' tests helpers; then
  echo "check-no-sleeps: hard sleeps found above; wait with a locator, expect(...) or expect.poll instead" >&2
  exit 1
fi
echo "check-no-sleeps: no hard sleeps"
