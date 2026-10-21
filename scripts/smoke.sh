#!/usr/bin/env bash
# Smoke test for a running stack: the prod-like stack locally and in CI (P1-08), staging after every
# deploy (D-03). Checks what the built artifacts behind Caddy must get right: the deployed SHA, the SPA and
# its deep links, asset caching, the /api route and the security headers.
#
#   scripts/smoke.sh http://localhost:8080 "$(git rev-parse HEAD)"
#
# Runs every check, prints ok/FAIL for each, and exits 1 if any failed. Needs curl and python3.
set -euo pipefail

if [ $# -ne 2 ]; then
  echo "usage: $0 <base_url> <git_sha>" >&2
  exit 2
fi
base="${1%/}"
sha="$2"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
failures=0

check() { # <description> <command...>: runs the command, records ok/FAIL
  local what="$1"
  shift
  if "$@"; then
    echo "ok    $what"
  else
    echo "FAIL  $what"
    failures=$((failures + 1))
  fi
}

fetch() { # <name> <path>: saves <name>.status, <name>.headers (lowercase names) and <name>.body
  local status
  status="$(curl -sS --max-time 10 -o "$tmp/$1.body" -D "$tmp/$1.raw" -w '%{http_code}' "$base$2")" ||
    status=000
  echo "$status" >"$tmp/$1.status"
  tr -d '\r' <"$tmp/$1.raw" 2>/dev/null |
    awk 'BEGIN { FS = OFS = ":" } NF > 1 { $1 = tolower($1) } { print }' >"$tmp/$1.headers" || :
}

status_is() { [ "$(cat "$tmp/$1.status")" = "$2" ]; }
header() { grep -m1 "^$2: " "$tmp/$1.headers" | cut -d' ' -f2-; }
header_has() { header "$1" "$2" | grep -qiF -- "$3"; }
header_lacks() { ! header_has "$@"; }
header_once() { [ "$(grep -c "^$2: " "$tmp/$1.headers")" = 1 ]; }
is_spa() { grep -q '<div id="root">' "$tmp/$1.body"; }
not_spa() { ! is_spa "$1"; }
json_field_is() { python3 -c 'import json, sys; sys.exit(json.load(open(sys.argv[1])).get(sys.argv[2]) != sys.argv[3])' "$tmp/$1.body" "$2" "$3" 2>/dev/null; }

# The deployed API is the image built from this commit.
fetch version /api/version
check "/api/version is 200" status_is version 200
check "/api/version reports git_sha $sha" json_field_is version git_sha "$sha"

# The SPA, and a deep link that only the try_files fallback can serve.
fetch root /
check "/ is 200 HTML" status_is root 200
check "/ is the SPA's index.html" is_spa root
check "/ has Cache-Control: no-cache" header_has root cache-control no-cache
fetch deep /packages
check "/packages (deep link) is 200" status_is deep 200
check "/packages serves index.html" cmp -s "$tmp/root.body" "$tmp/deep.body"
check "/packages has Cache-Control: no-cache" header_has deep cache-control no-cache

# A hashed asset that index.html references is cached for a year; a missing one is a plain 404.
asset="$(grep -oE '/assets/[^"]+\.js' "$tmp/root.body" | head -n1 || :)"
check "index.html references a hashed /assets/*.js" test -n "$asset"
fetch asset "${asset:-/assets/none.js}"
check "$asset is 200" status_is asset 200
check "$asset is immutable for a year" header_has asset cache-control "public, max-age=31536000, immutable"
fetch missing /assets/smoke-missing-0000.js
check "a missing asset is 404" status_is missing 404
check "a missing asset is not index.html" not_spa missing
check "a missing asset is not cached as immutable" header_lacks missing cache-control immutable

# /api/* belongs to the API even when the route doesn't exist.
fetch apimiss /api/smoke-does-not-exist
check "/api/smoke-does-not-exist is the API's 404" status_is apimiss 404
check "/api/smoke-does-not-exist is problem+json" header_has apimiss content-type application/problem+json
fetch apibare /api
check "/api (no slash) is the API's, not the SPA" header_has apibare content-type application/problem+json
fetch apifoo /apifoo
check "/apifoo is an SPA route" is_spa apifoo

# Security headers, on the SPA and on an API response.
for page in root version missing; do
  check "$page: X-Content-Type-Options nosniff" header_has "$page" x-content-type-options nosniff
  check "$page: Referrer-Policy" header_has "$page" referrer-policy strict-origin-when-cross-origin
  check "$page: Permissions-Policy" header_has "$page" permissions-policy "camera=(self)"
  check "$page: CSP frame-ancestors 'none'" header_has "$page" content-security-policy "frame-ancestors 'none'"
  check "$page: Strict-Transport-Security" header_has "$page" strict-transport-security "max-age=31536000"
done

# Pages whose URL can carry a token: no Referer to other origins (P4-07a); the rest keep the default above.
fetch loginpage /login
fetch resetpage /reset-password/smoke-token
fetch invitepage /invite/smoke-token
for page in loginpage resetpage invitepage; do
  check "$page is an SPA route" is_spa "$page"
  check "$page: Referrer-Policy same-origin" header_has "$page" referrer-policy same-origin
  check "$page: a single Referrer-Policy" header_once "$page" referrer-policy
done

if [ "$failures" -gt 0 ]; then
  echo "smoke: $failures check(s) failed against $base"
  exit 1
fi
echo "smoke: all checks passed against $base ($sha)"
