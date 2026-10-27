#!/usr/bin/env bash
# Waits until every required check of a PR has finished on one head SHA (WF-01), and prints one line per check
# and a `result:`. The required checks come from the base branch's protection, so the list lives in one place.
# It only reads GitHub; a failed check's job log goes to a mktemp file whose path is printed, never the log.
# Exit: 0 success, 1 failure, 2 timeout, 3 head-moved, 4 error, 64 usage (docs/tickets/WF-01-ticket-loop-helpers.md).
# Usage: scripts/pr-wait.sh <PR> [--sha <sha>] [--timeout <s>]
set -Eeuo pipefail
export GODEBUG=netdns=cgo
gh="${GH:-gh}"

# Any unexpected failure (gh, malformed JSON, a traceback) is exit 4: exit 1 only ever means a red check.
trap 'if ((BASH_SUBSHELL > 0)); then exit 4; fi; error "unexpected failure at line $LINENO"' ERR
error() {
  echo "pr-wait: $*" >&2
  echo "result: error"
  exit 4
}
usage() {
  echo "usage: scripts/pr-wait.sh <PR> [--sha <sha>] [--timeout <s>]" >&2
  exit 64
}

pr=
sha=
timeout=540
while (($#)); do
  case $1 in
    --sha) (($# >= 2)) || usage; sha=$2; shift 2 ;;
    --timeout) (($# >= 2)) || usage; timeout=$2; shift 2 ;;
    -*) usage ;;
    *) [[ -z $pr ]] || usage; pr=$1; shift ;;
  esac
done
positive='^[1-9][0-9]*$'
[[ $pr =~ $positive && $timeout =~ $positive ]] || usage
[[ -z $sha || $sha =~ ^[0-9a-f]{40}$ ]] || usage
# The self-test shortens the 30 s poll and the 60 s wait for a pushed head; nothing else sets these.
interval=${PR_WAIT_INTERVAL:-30}
head_timeout=${PR_WAIT_HEAD_TIMEOUT:-60}
[[ $interval =~ $positive && $head_timeout =~ $positive ]] || usage

url="$(git remote get-url origin)"
[[ $url =~ github\.com[:/]([^/]+/[^/]+)$ ]] || error "origin is not a GitHub repository"
repo="${BASH_REMATCH[1]%.git}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
deadline=$((SECONDS + timeout))
checked_base=

read_pr() { # sets state, head and base_ref from the PR as GitHub reports it now
  local fields
  fields="$("$gh" pr view "$pr" --repo "$repo" --json headRefOid,state,baseRefName |
    python3 -I -c 'import json, sys; d = json.load(sys.stdin); print(d["state"], d["headRefOid"], d["baseRefName"])')"
  read -r state head base_ref <<<"$fields"
  [[ $head =~ ^[0-9a-f]{40}$ ]] || error "unexpected head in the PR response"
  [[ $state == OPEN || $state == MERGED ]] || error "PR #$pr is $state"
  # Once the protection is read, a retargeted PR would be judged by the old base's required checks.
  if [[ -n $checked_base && $base_ref != "$checked_base" ]]; then
    error "PR #$pr was retargeted from $checked_base to $base_ref during the wait; run it again"
  fi
}
moved() { # moved <sha waited on> <sha the PR has>
  printf 'head: %s (PR #%s, base %s)\nmoved: %s -> %s\nresult: head-moved\n' "$1" "$pr" "$base_ref" "$1" "$2"
  exit 3
}
pause() { # pause <at most s>: sleep, but never past the deadline
  local left=$((deadline - SECONDS))
  if ((left > $1)); then left=$1; fi
  if ((left > 0)); then sleep "$left"; fi
}

read_pr
if [[ -n $sha ]]; then
  # A push moves the PR's head a moment later: until then the head is the previous commit, with its old checks.
  head_deadline=$((SECONDS + (head_timeout < timeout ? head_timeout : timeout)))
  head_interval=$((interval < 5 ? interval : 5))
  while [[ $head != "$sha" ]]; do
    ((SECONDS < head_deadline)) || moved "$sha" "$head"
    pause "$head_interval"
    read_pr
  done
fi
sha=$head
checked_base=$base_ref

"$gh" api "repos/$repo/branches/$base_ref/protection" >"$tmp/protection"
python3 -I - "$tmp/protection" >"$tmp/required" <<'PY'
import json, sys
checks = (json.load(open(sys.argv[1])).get("required_status_checks") or {}).get("checks") or []
if not checks:
    sys.exit("pr-wait: the branch protection lists no required checks")
for c in checks:
    print(f"{c['context']}\t{c.get('app_id')}")
PY

evaluate() { # prints a verdict (success, failure or waiting), then "name<TAB>state<TAB>check run id" per check
  python3 -I - "$tmp/required" "$tmp/runs" <<'PY'
import json, sys
required = [line.split("\t") for line in open(sys.argv[1]).read().splitlines()]
text, decoder, pos, runs, pages = open(sys.argv[2]).read(), json.JSONDecoder(), 0, [], 0
while True:  # gh api --paginate prints one JSON object per page, back to back
    while pos < len(text) and text[pos].isspace():
        pos += 1
    if pos == len(text):
        break
    page, pos = decoder.raw_decode(text, pos)
    runs += page["check_runs"]
    pages += 1
if not pages:
    sys.exit("pr-wait: the check-run response is empty")
latest = {}  # per (name, app) only the newest run: a re-run supersedes the run it repeats
for r in runs:
    key = (r["name"], r["app"]["id"])
    if key not in latest or r["id"] > latest[key]["id"]:
        latest[key] = r
rows = []
for name, app in required:
    found = [r for (n, a), r in latest.items() if n == name and (app in ("None", "-1") or str(a) == app)]
    r = max(found, key=lambda r: r["id"]) if found else None
    if r is None:
        rows.append((name, "missing", ""))
    elif r["status"] != "completed":
        rows.append((name, "pending", r["id"]))
    else:
        rows.append((name, r["conclusion"] or "none", r["id"]))
states = {s for _, s, _ in rows}
print("failure" if states - {"success", "pending", "missing"} else "success" if states == {"success"} else "waiting")
for row in rows:
    print(*row, sep="\t")
PY
}
report() { # report <result>: the table from $tmp/verdict, saving each red check's job log
  local width name state id line log
  width="$(tail -n +2 "$tmp/verdict" | cut -f1 | awk '{ if (length > w) w = length } END { print w }')"
  printf 'head: %s (PR #%s, base %s)\n' "$sha" "$pr" "$base_ref"
  while IFS=$'\t' read -r name state id; do
    line="$(printf '%-*s %s' "$width" "$name" "$state")"
    if [[ $state != success && $state != pending && $state != missing ]]; then
      if log="$(mktemp "${TMPDIR:-/tmp}/pr-wait-$pr-XXXXXX.log")" &&
        "$gh" api "repos/$repo/actions/jobs/$id/logs" >"$log"; then
        line="$(printf '%-*s %-9s log: %s' "$width" "$name" "$state" "$log")"
      else
        rm -f "$log"
        line="$(printf '%-*s %-9s log: unavailable' "$width" "$name" "$state")"
      fi
    fi
    printf '%s\n' "$line"
  done < <(tail -n +2 "$tmp/verdict")
  echo "result: $1"
}

while :; do
  read_pr
  [[ $head == "$sha" ]] || moved "$sha" "$head"
  "$gh" api --paginate "repos/$repo/commits/$sha/check-runs?filter=latest&per_page=100" >"$tmp/runs"
  evaluate >"$tmp/verdict"
  case "$(head -n 1 "$tmp/verdict")" in
    failure)
      report failure
      exit 1
      ;;
    success)
      read_pr # a success recorded for a head the PR has left is not reported
      [[ $head == "$sha" ]] || moved "$sha" "$head"
      report success
      exit 0
      ;;
  esac
  if ((SECONDS >= deadline)); then
    report timeout
    exit 2
  fi
  pause "$interval"
done
