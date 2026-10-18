#!/usr/bin/env bash
# Checks of the prod-like stack's own wiring that scripts/smoke.sh can't see from outside (P1-08):
# - api, worker and db publish no host port and mount no source directory; the API runs one gunicorn worker
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
check "worker publishes no port and mounts no source" isolated worker

# One gunicorn worker: the master process plus exactly one worker process (the image has no `ps`). The
# pattern is split so this probe's own command line doesn't match it.
gunicorns() {
  "${compose[@]}" exec -T api python -c '
import pathlib
app = "app.main" + ":app"
print(sum(b"gunicorn" in c and app.encode() in c for c in (p.read_bytes() for p in pathlib.Path("/proc").glob("[0-9]*/cmdline"))))'
}
check "api runs one gunicorn worker (master + 1)" test "$(gunicorns)" = 2

# Criterion 9: gunicorn takes the client address from X-Forwarded-For only when Caddy sends it. Through
# Caddy, the logged client is the real peer: not Caddy (header ignored) and not a spoofed value (Caddy
# replaces it). Sent straight to api:8000 from another container, the header is ignored.
caddy_ip=10.213.208.10
marker="xff-probe-$$-$RANDOM"
curl -sS -o /dev/null -A "$marker-caddy" -H "X-Forwarded-For: 203.0.113.9" "$base/api/health"
s3_ip="$("${compose[@]}" exec -T s3 hostname -i | tr -d '\r' | awk '{print $1}')"
"${compose[@]}" exec -T s3 curl -sS -o /dev/null -A "$marker-direct" -H "X-Forwarded-For: 203.0.113.10" \
  http://api:8000/api/health
sleep 1
logs="$("${compose[@]}" logs --no-color --no-log-prefix api)"
client_of() { # the client_ip logged for the request whose User-Agent is $marker-$1
  python3 -c '
import json, sys
for line in sys.stdin:
    if line.startswith("{") and json.loads(line).get("user_agent") == sys.argv[1]:
        print(json.loads(line)["client_ip"])' "$marker-$1" <<<"$logs"
}
via_caddy="$(client_of caddy)"
direct="$(client_of direct)"
echo "      logged client via Caddy: ${via_caddy:-none}; direct from s3 ($s3_ip): ${direct:-none}"
check "a request through Caddy is logged" test -n "$via_caddy"
check "through Caddy, the client is not Caddy (forwarded header trusted)" test "$via_caddy" != "$caddy_ip"
check "through Caddy, a spoofed X-Forwarded-For is not the client" test "$via_caddy" != 203.0.113.9
check "around Caddy, X-Forwarded-For is ignored (client is the sender)" test "$direct" = "$s3_ip"

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
