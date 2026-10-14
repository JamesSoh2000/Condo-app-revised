#!/usr/bin/env python3
"""Check code references in explanation files added or changed on this branch.

Explanations (docs/explanations/*.md) are snapshots, so only the ones changed relative to the base
branch are checked; older ones are expected to drift as the code moves on. For each changed file:

- `path::anchor` in backticks: `path` (from the repo root) must exist and contain `anchor` as literal text.
- `path` in backticks that looks like a repo path (contains "/" and a file extension): it must exist.
- `path:NN` line references are rejected: use `path::symbol` (see docs/templates/EXPLANATION.md).

Usage: python3 scripts/check-explanation-refs.py [FILE ...]
  With no FILE, the files come from `git diff --name-only --diff-filter=AM <base>...HEAD`, where <base> is
  $BASE_REF or origin/main.
Output: one line per problem, `explanation-file: reference → reason`. Exit 1 if there is any.
Standard library only.
"""

from __future__ import annotations

import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
EXPLANATIONS = "docs/explanations/*.md"
RULE = "use `path::symbol` instead (docs/templates/EXPLANATION.md, 'How to reference code')"

FENCE = re.compile(r"^\s*(```|~~~)")
CODE_SPAN = re.compile(r"(`+)(.+?)\1")
PATH = r"[\w.\-]+(?:/[\w.\-]+)*"
REPO_PATH = re.compile(rf"^{PATH}/{PATH}\.[A-Za-z]\w*$")
SYMBOL_REF = re.compile(rf"^({PATH})::(.+)$")
LINE_REF = re.compile(rf"(?<![\w./:])({PATH}\.[A-Za-z]\w*:\d+(?:-\d+)?)\b(?!:)")


def changed_explanations() -> list[str]:
    base = os.environ.get("BASE_REF", "origin/main")
    out = subprocess.run(
        ["git", "diff", "--name-only", "--diff-filter=AM", f"{base}...HEAD", "--", EXPLANATIONS],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return out.splitlines()


def check_span(span: str) -> str | None:
    """Return the reason a backticked reference is broken, or None if it is fine or not a reference."""
    if m := SYMBOL_REF.match(span):
        path, anchor = m.groups()
        target = REPO / path
        if not target.is_file():
            return f"file {path} not found"
        if anchor not in target.read_text(encoding="utf-8", errors="replace"):
            return f"anchor {anchor!r} not found in {path}"
        return None
    if LINE_REF.fullmatch(span):
        return f"line-number reference; {RULE}"
    if REPO_PATH.match(span) and not (REPO / span).exists():
        return f"path {span} not found"
    return None


def check(rel: str) -> list[str]:
    problems = []
    in_fence = False
    for line in (REPO / rel).read_text(encoding="utf-8").splitlines():
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if in_fence:
            continue
        for m in CODE_SPAN.finditer(line):
            span = m.group(2).strip()
            if reason := check_span(span):
                problems.append(f"{rel}: {span} → {reason}")
        prose = CODE_SPAN.sub("", line)
        for m in LINE_REF.finditer(prose):
            if "/" in m.group(1):  # bare prose like `config.py:12` needs a slash to count as a repo path
                problems.append(f"{rel}: {m.group(1)} → line-number reference; {RULE}")
    return problems


def main(argv: list[str]) -> int:
    files = argv or changed_explanations()
    problems = [p for f in files for p in check(f)]
    for p in problems:
        print(p)
    print(f"check-explanation-refs: {len(files)} file(s), {len(problems)} problem(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
