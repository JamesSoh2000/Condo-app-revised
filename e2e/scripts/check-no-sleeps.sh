#!/usr/bin/env bash
# P4-09 criterion 5: journeys wait for what they need (web-first assertions, expect.poll), never for a fixed time.
# Fails on any hard sleep under tests/ and helpers/. Each file is read whole, so a call split across lines or
# spaced before its parenthesis is caught too (review rounds 1 F4 and 2 R2-3).
set -euo pipefail
cd "$(dirname "$0")/.."
if find tests helpers -name '*.ts' -print0 | xargs -0 perl -0777 -ne '
  while (/\b(?:waitForTimeout|setTimeout)\s*\(|\.waitFor\s*\(\s*[0-9]/g) {
    my $line = 1 + (substr($_, 0, $-[0]) =~ tr/\n//);
    (my $match = $&) =~ s/\s+/ /g;
    print "$ARGV:$line: $match\n";
    $found = 1;
  }
  END { exit($found ? 0 : 1) }'; then
  echo "check-no-sleeps: hard sleeps found above; wait with a locator, expect(...) or expect.poll instead" >&2
  exit 1
fi
echo "check-no-sleeps: no hard sleeps"
