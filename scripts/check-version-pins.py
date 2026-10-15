#!/usr/bin/env python3
"""Fail when the Python or Postgres version pins disagree across the repo (P0-06).

Dependabot updates some of these files and not others (the CI `services:` block, `.python-version`,
`requires-python`), so one merged bump can leave dev, the Docker image and CI on different versions.

Python: every pin must name the same minor as `.python-version`, and the exact pins the same patch.
Postgres: compose's `db` and CI's service must use the same major.

    python3 scripts/check-version-pins.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


def find_all(path: str, pattern: str) -> list[str]:
    found = re.findall(pattern, read(path), flags=re.MULTILINE)
    if not found:
        sys.exit(f"check-version-pins: no match for {pattern!r} in {path}; update this script")
    return found


def main() -> int:
    exact = read(".python-version").strip()
    if not re.fullmatch(r"\d+\.\d+\.\d+", exact):
        sys.exit(f"check-version-pins: .python-version {exact!r} is not an exact X.Y.Z version")
    major, minor, _ = exact.split(".")
    want_minor = f"{major}.{minor}"
    next_minor = f"{major}.{int(minor) + 1}"

    # (file, what, found, expected)
    checks = [
        (".tool-versions", "python", find_all(".tool-versions", r"^python (\S+)$"), exact),
        (
            ".github/workflows/ci.yml",
            "python-version",
            find_all(".github/workflows/ci.yml", r'python-version: "([^"]+)"'),
            exact,
        ),
        (
            "backend/Dockerfile",
            "FROM python",
            find_all("backend/Dockerfile", r"^FROM python:(\d+\.\d+)"),
            want_minor,
        ),
        (
            "backend/pyproject.toml",
            "requires-python",
            find_all("backend/pyproject.toml", r'^requires-python = "([^"]+)"'),
            f">={want_minor},<{next_minor}",
        ),
        (
            "backend/pyproject.toml",
            "ruff target-version",
            find_all("backend/pyproject.toml", r'^target-version = "([^"]+)"'),
            f"py{major}{minor}",
        ),
        (
            "backend/pyproject.toml",
            "mypy python_version",
            find_all("backend/pyproject.toml", r'^python_version = "([^"]+)"'),
            want_minor,
        ),
    ]

    compose_pg = find_all("docker-compose.yml", r"^\s*image: postgres:(\d+)")
    ci_pg = find_all(".github/workflows/ci.yml", r"^\s*image: postgres:(\d+)")
    checks.append((".github/workflows/ci.yml", "postgres major", ci_pg, compose_pg[0]))
    checks.append(("docker-compose.yml", "postgres major", compose_pg, compose_pg[0]))

    errors = [
        f"{path}: {what} is {value!r}, expected {expected!r}"
        for path, what, values, expected in checks
        for value in values
        if value != expected
    ]
    for error in errors:
        print(f"check-version-pins: {error}")
    if errors:
        print("check-version-pins: bump every pin together (docs/tickets/P0-06-runtime-and-ci-upgrades.md)")
        return 1
    print(f"check-version-pins: Python {exact} and Postgres {compose_pg[0]} agree in every pin")
    return 0


if __name__ == "__main__":
    sys.exit(main())
