#!/usr/bin/env bash
# Prints, as one JSON object, the PR facts the merge gate and the handoff read (WF-01): head, base, how far the
# head is behind the base, mergeability and the merge commit. It reads GitHub only and judges nothing:
# `mergeable: UNKNOWN` (usual right after a push) is printed as is, to be asked again.
# Exit: 0, 4 on a gh or parse failure, 64 usage.
# Usage: scripts/pr-state.sh <PR>
set -Eeuo pipefail
export GODEBUG=netdns=cgo
gh="${GH:-gh}"

trap 'if ((BASH_SUBSHELL > 0)); then exit 4; fi; echo "pr-state: unexpected failure at line $LINENO" >&2; exit 4' ERR
if (($# != 1)) || [[ ! $1 =~ ^[1-9][0-9]*$ ]]; then
  echo "usage: scripts/pr-state.sh <PR>" >&2
  exit 64
fi
pr=$1

url="$(git remote get-url origin)"
if [[ ! $url =~ github\.com[:/]([^/]+/[^/]+)$ ]]; then
  echo "pr-state: origin is not a GitHub repository" >&2
  exit 4
fi
repo="${BASH_REMATCH[1]%.git}"
# Responses go through files: a compare response (every commit with its files) outgrows a command argument.
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$gh" pr view "$pr" --repo "$repo" \
  --json number,state,isDraft,headRefOid,baseRefName,mergeable,mergeStateStatus,title,url,mergeCommit >"$tmp/view"
refs="$(python3 -I -c 'import json, sys; d = json.load(open(sys.argv[1])); print(d["baseRefName"], d["headRefOid"])' "$tmp/view")"
"$gh" api "repos/$repo/compare/${refs% *}...${refs#* }" >"$tmp/compare"
python3 -I - "$tmp/view" "$tmp/compare" <<'PY'
import json, sys
v, c = json.load(open(sys.argv[1])), json.load(open(sys.argv[2]))
print(json.dumps({
    "number": v["number"], "state": v["state"], "draft": v["isDraft"], "head": v["headRefOid"],
    "base": v["baseRefName"], "base_sha": c["base_commit"]["sha"], "behind_by": c["behind_by"],
    "mergeable": v["mergeable"], "merge_state": v["mergeStateStatus"], "title": v["title"], "url": v["url"],
    "merge_commit": (v.get("mergeCommit") or {}).get("oid"),
}, separators=(",", ":"), ensure_ascii=False))
PY
