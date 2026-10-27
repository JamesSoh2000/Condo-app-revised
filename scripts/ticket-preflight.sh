#!/usr/bin/env bash
# Preflight for one ticket (WF-01): the inbox's run state, the ticket's index row and its dependencies, all read
# from origin/main after fetching it (never the checkout's main, which can be behind: P5-03c, P5-05). With
# --create, and only when the ticket is ready, it adds the ticket's worktree and branch. It writes nothing else.
# Output is one `key: value` per line; the exit codes are in docs/tickets/WF-01-ticket-loop-helpers.md.
# Usage: scripts/ticket-preflight.sh <ID> [--create]
set -Eeuo pipefail
export GODEBUG=netdns=cgo

# Any unexpected failure (git, a missing file on origin/main, a Python traceback) is exit 65, never "ready".
trap 'if ((BASH_SUBSHELL > 0)); then exit 65; fi; echo "ticket-preflight: unexpected failure at line $LINENO" >&2; exit 65' ERR
usage() {
  echo "usage: scripts/ticket-preflight.sh <ID> [--create]" >&2
  exit 64
}

id=
create=0
for arg in "$@"; do
  case "$arg" in
    --create) create=1 ;;
    -*) usage ;;
    *) [[ -z $id ]] || usage; id=$arg ;;
  esac
done
[[ $id =~ ^[A-Z][A-Z0-9]*-[A-Za-z0-9-]+$ ]] || usage

top="$(git rev-parse --show-toplevel)"
cd "$top"
if ! git fetch -q origin +refs/heads/main:refs/remotes/origin/main; then
  echo "ticket-preflight: origin/main is not fetchable" >&2
  exit 65
fi
base="$(git rev-parse --verify 'refs/remotes/origin/main^{commit}')"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
git show "$base:docs/HUMAN_INBOX.md" >"$tmp/inbox"
git show "$base:docs/tickets/README.md" >"$tmp/index"
git ls-tree -r --name-only "$base" -- docs/tickets/ >"$tmp/files"

rc=0
facts="$(python3 -I - "$id" "$tmp/inbox" "$tmp/index" "$tmp/files" <<'PY'
import re, sys

tid, inbox, index, files = sys.argv[1], *(open(p).read() for p in sys.argv[2:])
files = set(files.splitlines())
ID = r"[A-Z][A-Z0-9]*-[A-Za-z0-9-]+"
ROW = re.compile(r"^\|\s*\[([^\]]+)\]\(([^)]*)\)\s*\|")
STATUSES = {"todo", "in progress", "review", "done", "blocked"}


class Unreadable(Exception):
    pass


rows = {}
for line in index.splitlines():
    if m := ROW.match(line):
        rows.setdefault(m.group(1), []).append(line.strip())


def row(t):
    """The index row of ticket t as a dict, None if it is not listed; Unreadable if it does not parse."""
    if t not in rows:
        return None
    if len(rows[t]) > 1:
        raise Unreadable(f"{t} is listed {len(rows[t])} times")
    line = rows[t][0]
    cells = [c.strip() for c in line.split("|")]
    if len(cells) != 9 or cells[0] or cells[8]:
        raise Unreadable(f"{t}: the row does not have the seven cells")
    link = re.fullmatch(r"\./(" + re.escape(t) + r"-([a-z0-9-]+))\.md", ROW.match(line).group(2))
    deps = [] if cells[5] == "—" else [d.strip() for d in cells[5].split(",")]
    if not link or not re.fullmatch(r"\d", cells[4]) or cells[6] not in STATUSES:
        raise Unreadable(f"{t}: unreadable link, tier or status")
    if not all(re.fullmatch(ID, d) for d in deps):
        raise Unreadable(f"{t}: a dependency is not a ticket ID")
    return {"file": f"docs/tickets/{link.group(1)}.md", "slug": link.group(2), "tier": cells[4],
            "deps": deps, "status": cells[6]}


out, codes, errors = [f"ticket: {tid}"], set(), []
# The whole value of the line, bold or not: "running-paused" or "running2" is not "running".
states = re.findall(r"^\s*(?:\*\*)?Run state:[ \t]*(.*?)[ \t]*(?:\*\*)?[ \t]*$", inbox, re.M)
run_state = states[0] if len(set(states)) == 1 and states[0] in {"running", "paused"} else "unreadable"
try:
    t = row(tid)
except Unreadable as e:
    errors.append(str(e))
    t = None
if t is None:
    out.append("file: missing" if not errors else "file: unreadable")
    codes.add(12)
else:
    out.append(f"file: {t['file']}" + ("" if t["file"] in files else " (missing)"))
    if t["file"] not in files:
        codes.add(12)
    out += [f"tier: {t['tier']}", f"status: {t['status']}"]
    if t["status"] in {"done", "review", "blocked"}:
        codes.add(13)
out.append(f"run_state: {run_state}")
if run_state == "paused":
    codes.add(10)
elif run_state != "running":
    errors.append("no single Run state line of running or paused in docs/HUMAN_INBOX.md")
if t is not None:
    deps = []
    for d in t["deps"]:
        try:
            dep = row(d)
        except Unreadable as e:
            errors.append(str(e))
            dep = {"status": "unreadable"}
        deps.append(f"{d}={dep['status'] if dep else 'missing'}")
        if not dep or dep["status"] != "done":
            codes.add(11)
    out += [f"depends_on: {', '.join(deps) or '—'}", f"branch: {tid.lower()}-{t['slug']}"]
print("\n".join(out))
for e in errors:
    print(f"ticket-preflight: {e}", file=sys.stderr)
# Paused stops whatever else is wrong; otherwise an unreadable fact is never "ready".
if 10 in codes and run_state == "paused":
    sys.exit(10)
if errors:
    sys.exit(65)
sys.exit(next((c for c in (12, 13, 11) if c in codes), 0))
PY
)" || rc=$?
case $rc in 0 | 10 | 11 | 12 | 13 | 65) ;; *) rc=65 ;; esac

worktree="../bw-${id,,}"
printf '%s\n' "$facts"
if ((rc == 0 && create)); then
  branch="$(sed -n 's/^branch: //p' <<<"$facts")"
  if git show-ref --verify --quiet "refs/heads/$branch" || [[ -e $worktree ]]; then
    printf 'worktree: %s%s\nbase: %s\n' "$worktree" "$([[ -e $worktree ]] && echo ' exists')" "$base"
    echo "ticket-preflight: --create refused: the branch $branch or $worktree already exists" >&2
    exit 14
  fi
  git worktree add -q -b "$branch" "$worktree" "$base" >&2
  printf 'worktree: %s created\nbase: %s\n' "$worktree" "$base"
  exit 0
fi
printf 'worktree: %s%s\nbase: %s\n' "$worktree" "$([[ -e $worktree ]] && echo ' exists')" "$base"
exit "$rc"
