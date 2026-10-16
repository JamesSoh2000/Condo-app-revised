#!/usr/bin/env bash
# Checks of the prod-like stack's own wiring that scripts/smoke.sh can't see from outside (P1-08):
# - api and db publish no host port and mount no source directory; the API runs one gunicorn worker
# - the API trusts forwarded headers from Caddy only
# - TRUSTED_ORIGINS and the build metadata
# Run against a running stack (`make prodlike`), from the repo root. Exits 1 if any check failed.
set -euo pipefail

compose=(docker compose -f compose.prodlike.yml)
base="${1:-http://localhost:8080}"
failures=0

check() { # <description> <command...>
  local what="$1"
  shift
  if "$@"; then
    echo "ok    $what"
  else
    echo "FAIL  $what"
    failures=$((failures + 1))
  fi
}

# Criterion 4: no published port, no bind mount, on api and db.
config="$("${compose[@]}" config --format json)"
isolated() {
  python3 -c '
import json, sys
service = json.loads(sys.argv[1])["services"][sys.argv[2]]
binds = [v for v in service.get("volumes", []) if v.get("type") == "bind"]
sys.exit(1 if service.get("ports") or binds else 0)' "$config" "$1"
}
check "api publishes no port and mounts no source" isolated api
check "db publishes no port and mounts no source" isolated db

# One gunicorn worker: the master process plus exactly one worker process (the image has no `ps`). The
# pattern is split so this probe's own command line doesn't match it.
gunicorns() {
  "${compose[@]}" exec -T api python -c '
import pathlib
app = "app.main" + ":app"
print(sum(b"gunicorn" in c and app.encode() in c for c in (p.read_bytes() for p in pathlib.Path("/proc").glob("[0-9]*/cmdline"))))'
}
check "api runs one gunicorn worker (master + 1)" test "$(gunicorns)" = 2

# Criterion 9: a spoofed X-Forwarded-For through Caddy, and one sent to the API directly from another
# container, must not become the client address in the server's access log.
marker="xff-probe-$$-$RANDOM"
curl -sS -o /dev/null -H "X-Forwarded-For: 203.0.113.9" "$base/api/health?$marker-caddy"
"${compose[@]}" exec -T s3 curl -sS -o /dev/null -H "X-Forwarded-For: 203.0.113.10" \
  "http://api:8000/api/health?$marker-direct"
sleep 1
logs="$("${compose[@]}" logs --no-color api)"
logged() { grep -F "$marker-$1" <<<"$logs" | grep -q "$2"; }
not_logged() { ! logged "$@"; }
check "Caddy's request is in the access log" logged caddy "GET /api/health"
check "a spoofed X-Forwarded-For via Caddy is not the client" not_logged caddy 203.0.113.9
check "X-Forwarded-For sent around Caddy is not trusted" logged direct "GET /api/health"
check "X-Forwarded-For sent around Caddy is not the client" not_logged direct 203.0.113.10

# Criterion 11.
setting() { "${compose[@]}" exec -T api python -c "from app.core.config import settings; print(settings.$1)"; }
check "TRUSTED_ORIGINS contains http://localhost:8080" grep -qF "'http://localhost:8080'" <<<"$(setting trusted_origins)"
check "image_tag is not 'local'" test "$(setting image_tag)" != local
check "build_time is not 'local'" test "$(setting build_time)" != local

if [ "$failures" -gt 0 ]; then
  echo "prodlike-checks: $failures check(s) failed"
  exit 1
fi
echo "prodlike-checks: all checks passed"
