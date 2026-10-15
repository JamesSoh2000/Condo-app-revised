#!/usr/bin/env python3
"""Fail when the Python, Postgres or uv version pins disagree across the repo (P0-06).

Dependabot updates some of these files and not others (the CI `services:` block, `.python-version`,
`requires-python`), so one merged bump can leave dev, the Docker image and CI on different versions.

Python: every pin must name the same minor as `.python-version`, and the exact pins the same patch.
Postgres: compose's `db` and CI's service must use the same major.
uv: the Dockerfile's uv image and CI's setup-uv `version` must be the same release.

    python3 scripts/check-version-pins.py
"""

import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
CI = ".github/workflows/ci.yml"


def read(path: str) -> str:
    return (ROOT / path).read_text(encoding="utf-8")


# A YAML/TOML scalar, quoted or not: `key: 3.14.8`, `key: "3.14.8"`, `key = '3.14'`.
VALUE = r"""["']?([^"'\s#]+)["']?"""
# `image: postgres:18`, quoted or with a registry prefix; captures the major.
POSTGRES_IMAGE = r"""^\s*image:\s*["']?(?:docker\.io/)?(?:library/)?postgres:(\d+)"""


def find_all(path: str, pattern: str, count: int | None = None) -> list[str]:
    """Every match of `pattern` in `path`; exactly `count` of them when given."""
    found = re.findall(pattern, read(path), flags=re.MULTILINE)
    if not found:
        sys.exit(f"check-version-pins: no match for {pattern!r} in {path}; update this script")
    if count is not None and len(found) != count:
        sys.exit(
            f"check-version-pins: {len(found)} match(es) for {pattern!r} in {path},"
            f" expected {count} (one per step); update this script or the file"
        )
    return found


def count_uses(action: str) -> int:
    pattern = rf"^\s*(?:-\s*)?uses: {re.escape(action)}@"
    return len(re.findall(pattern, read(CI), flags=re.MULTILINE))


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
            CI,
            "python-version",
            find_all(CI, rf"^\s*python-version:\s*{VALUE}", count_uses("actions/setup-python")),
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
            find_all("backend/pyproject.toml", rf"^requires-python\s*=\s*{VALUE}"),
            f">={want_minor},<{next_minor}",
        ),
        (
            "backend/pyproject.toml",
            "ruff target-version",
            find_all("backend/pyproject.toml", rf"^target-version\s*=\s*{VALUE}"),
            f"py{major}{minor}",
        ),
        (
            "backend/pyproject.toml",
            "mypy python_version",
            find_all("backend/pyproject.toml", rf"^python_version\s*=\s*{VALUE}"),
            want_minor,
        ),
        (
            "Makefile",
            "s3-smoke --python",
            find_all("Makefile", r"uv run --python (\S+) scripts/s3-smoke\.py"),
            want_minor,
        ),
        (
            "scripts/s3-smoke.py",
            "requires-python",
            find_all("scripts/s3-smoke.py", rf"^# requires-python\s*=\s*{VALUE}"),
            f">={want_minor}",
        ),
    ]

    docker_uv = find_all("backend/Dockerfile", r"ghcr\.io/astral-sh/uv:(\S+)")
    ci_uv = find_all(CI, rf"^\s*version:\s*{VALUE}", count_uses("astral-sh/setup-uv"))
    checks.append((CI, "setup-uv version", ci_uv, docker_uv[0]))
    checks.append(("backend/Dockerfile", "uv image", docker_uv, docker_uv[0]))

    compose_pg = find_all("docker-compose.yml", POSTGRES_IMAGE)
    ci_pg = find_all(CI, POSTGRES_IMAGE)
    checks.append((CI, "postgres major", ci_pg, compose_pg[0]))
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
        print("check-version-pins: bump every pin together (docs/tickets/P0-06-*.md)")
        return 1
    print(
        f"check-version-pins: Python {exact}, Postgres {compose_pg[0]} and uv {docker_uv[0]}"
        " agree in every pin"
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
