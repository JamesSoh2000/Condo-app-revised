#!/usr/bin/env bash
# Checks of the prod-like stack's own wiring that scripts/smoke.sh can't see from outside (P1-08):
# - api, worker and db publish no host port and mount no source directory; the API runs one gunicorn worker
# - the API trusts forwarded headers from Caddy only
# - TRUSTED_ORIGINS and the build metadata
# - email (P3-02): `email-test` reaches Mailpit through the image's worker; with Mailpit stopped the job
#   is retried, and delivered once Mailpit is back. Stops and starts the stack's Mailpit.
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

# P3-02 criteria 7, 1 and 2.
mailpit=http://localhost:8025
run_id="$$-$RANDOM"
wait_for() { # <seconds> <command...>: retry the command every second until it succeeds or time runs out
  local deadline=$((SECONDS + $1))
  shift
  until "$@"; do
    [ "$SECONDS" -ge "$deadline" ] && return 1
    sleep 1
  done
}
queue_test_email() { # <recipient> → the job id `email-test` printed
  "${compose[@]}" exec -T api python -m app.cli email-test --to "$1" | awk '/^queued email job /{print $4}'
}
job_is() { # <job id> <regex for "status attempts">
  local state
  state="$("${compose[@]}" exec -T api python -c '
import asyncio, sys
from uuid import UUID
from app.core.database import AsyncSessionLocal
from app.jobs.models import Job
async def main():
    async with AsyncSessionLocal() as db:
        job = await db.get(Job, UUID(sys.argv[1]))
        print(job.status.value, job.attempts)
asyncio.run(main())' "$1" | tr -d '\r')"
  echo "      job $1: $state"
  [[ "$state" =~ ^$2$ ]]
}
delivered() { # <recipient>: Mailpit holds exactly one message to it, with both parts and the From header
  python3 - "$mailpit" "$1" <<'PY'
import json, sys, urllib.request
base, to = sys.argv[1], sys.argv[2]
listing = json.load(urllib.request.urlopen(f"{base}/api/v1/messages?limit=500", timeout=5))
found = [m for m in listing["messages"] if any(r["Address"] == to for r in m["To"])]
if len(found) != 1:
    sys.exit(1)
message = json.load(urllib.request.urlopen(f"{base}/api/v1/message/{found[0]['ID']}", timeout=5))
sender = message["From"]
sys.exit(0 if (sender["Name"], sender["Address"]) == ("Building Management", "no-reply@example.com")
         and "test email" in message["Text"] and "test email" in message["HTML"] else 1)
PY
}
mailpit_ready() { curl -fsS -o /dev/null "$mailpit/readyz"; }

to_up="smoke-$run_id@example.test"
job_up="$(queue_test_email "$to_up")"
check "email-test queues a job" test -n "$job_up"
check "the image's worker delivers it to Mailpit: one message, text + HTML, From header" \
  wait_for 30 delivered "$to_up"
check "the delivered job succeeded on attempt 1" job_is "$job_up" "succeeded 1"

"${compose[@]}" stop mailpit
to_down="smoke-down-$run_id@example.test"
job_down="$(queue_test_email "$to_down")"
check "with Mailpit stopped, the job is retried (queued again after attempt 1)" \
  wait_for 30 job_is "$job_down" "queued 1"
"${compose[@]}" start mailpit
check "Mailpit is back" wait_for 60 mailpit_ready
check "after Mailpit restarts, the retried job is delivered" wait_for 60 delivered "$to_down"
check "the retried job succeeded on a later attempt" job_is "$job_down" "succeeded [2-8]"

if [ "$failures" -gt 0 ]; then
  echo "prodlike-checks: $failures check(s) failed"
  exit 1
fi
echo "prodlike-checks: all checks passed"
