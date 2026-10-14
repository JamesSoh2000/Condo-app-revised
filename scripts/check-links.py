#!/usr/bin/env python3
"""Check that relative markdown links resolve.

Scans every Markdown file tracked by git (or new and not ignored), except docs/archive/,
which is kept for history and is not maintained. For each `[text](target)` outside code spans
and fenced code blocks, it checks that the target exists and, for `file.md#anchor`, that the
anchor matches a heading in that file (GitHub slug rules).

Usage: python3 scripts/check-links.py
Exit code: 0 if every link resolves, 1 otherwise. Standard library only.
"""

from __future__ import annotations

import re
import subprocess
import sys
from functools import cache
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SKIP_PREFIXES = ("docs/archive/",)

LINK = re.compile(r"\[([^\]]*)\]\(([^)\s]+)(?:\s+\"[^\"]*\")?\)")
FENCE = re.compile(r"^\s*(```|~~~)")
CODE_SPAN = re.compile(r"(`+)(?:(?!\1).)+?\1")
HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")


def markdown_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "--cached", "--others", "--exclude-standard", "--", "*.md"],
        cwd=REPO,
        capture_output=True,
        text=True,
        check=True,
    ).stdout
    return [REPO / p for p in out.splitlines() if not p.startswith(SKIP_PREFIXES) and (REPO / p).exists()]


def prose_lines(path: Path) -> list[tuple[int, str]]:
    """Return (line number, text) for lines outside fenced code, with code spans blanked out."""
    lines, in_fence = [], False
    for n, line in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if FENCE.match(line):
            in_fence = not in_fence
            continue
        if not in_fence:
            lines.append((n, CODE_SPAN.sub("", line)))
    return lines


def slug(heading: str) -> str:
    text = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", heading)  # links keep their text
    text = text.replace("`", "").replace("*", "").lower()
    text = re.sub(r"[^\w\- ]", "", text)
    return text.replace(" ", "-")


@cache
def anchors(path: Path) -> set[str]:
    seen: dict[str, int] = {}
    result = set()
    for _, line in prose_lines(path):
        m = HEADING.match(line)
        if not m:
            continue
        base = slug(m.group(1))
        count = seen.get(base, 0)
        seen[base] = count + 1
        result.add(base if count == 0 else f"{base}-{count}")
    return result


def check(path: Path) -> list[str]:
    problems = []
    rel = path.relative_to(REPO)
    for n, line in prose_lines(path):
        for m in LINK.finditer(line):
            target = m.group(2)
            if target.startswith(("http://", "https://", "mailto:")):
                continue
            file_part, _, anchor = target.partition("#")
            dest = path if not file_part else (path.parent / file_part).resolve()
            if not dest.exists():
                problems.append(f"{rel}:{n}: {target} → file not found")
            elif not dest.is_relative_to(REPO):
                problems.append(f"{rel}:{n}: {target} → points outside the repo")
            elif anchor and dest.suffix == ".md" and anchor not in anchors(dest):
                problems.append(f"{rel}:{n}: {target} → no heading with anchor #{anchor}")
    return problems


def main() -> int:
    files = markdown_files()
    problems = [p for f in files for p in check(f)]
    for p in problems:
        print(p)
    print(f"check-links: {len(files)} files, {len(problems)} broken link(s)", file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
