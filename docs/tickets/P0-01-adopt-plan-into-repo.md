# P0-01 — Adopt the new plan into the repo

| Field | Value |
|---|---|
| Phase / lane | P0 / A |
| Risk tier | 3 |
| Depends on | — |
| Replaces old | M0-T01, M0-T07, M0-T08 (process parts) |
| Status | todo |

## Goal

The repository's `docs/` becomes the single source of truth, with the old planning docs archived and agent
context (`CLAUDE.md`, project commands) in place.

## Why

Three diverging copies of the docs exist, and the repo copy is stale. Agents and teammates working inside the
repo must see the current rules ([00_REVIEW.md H2](../REVIEW-2026-10.md#h2--documentation-duplication-and-drift-high)).

**This ticket goes first, before any other P0 ticket.** `/frame-ticket`, `/implement-ticket` and the other
commands read `docs/tickets/` and `CLAUDE.md`, which only exist after this PR merges. It is Tier 3 and about
an hour of work; do it without the loop (there are no commands yet), and have the other dev review it.

## Scope

- In:
  - Copy `Claude_Plan/` into `building-website/docs/` using the mapping below, and fix relative links.
  - Move the current `building-website/docs/*` into `docs/archive/2026-10-legacy/`, with a `README.md` saying
    "superseded on 2026-10-13 by docs/README.md; kept for history".
  - Add `CLAUDE.md` at the repo root (from `templates/CLAUDE.md`).
  - Add `.claude/commands/*.md` (from `templates/claude-commands/`).
  - Create `docs/explanations/` and `docs/recaps/` with `.gitkeep`, and `docs/AGENT_MISTAKES_LOG.md` from the
    template.
  - Update the root `README.md` "Current State" section and the docs links.
  - Add `scripts/check-links.py` and `scripts/check-explanation-refs.py` (spec below), and a `docs` CI job
    that runs both.
- Out:
  - Deleting anything outside the repo (`Recent_Plan/`, `Plan/`, `Process/`). The humans decide, and should
    at least mark them superseded.
  - Code changes.

## Interfaces

| From `Claude_Plan/` | To `building-website/` |
|---|---|
| `README.md` | `docs/README.md` (drop the old→new mapping section, which moves to `docs/archive/…/README.md`) |
| `00_REVIEW.md` | `docs/REVIEW-2026-10.md` |
| `01_PRODUCT_SCOPE.md` … `07_PILOT_READINESS.md` | `docs/PRODUCT_SCOPE.md`, `docs/ARCHITECTURE.md`, `docs/ROADMAP.md`, `docs/ENGINEERING_PRACTICES.md`, `docs/AI_AGENT_PLAYBOOK.md`, `docs/LEARNING_PATH.md`, `docs/PILOT_READINESS.md` |
| `adr/`, `tickets/`, `templates/` | `docs/adr/`, `docs/tickets/`, `docs/templates/` |
| `templates/CLAUDE.md` | `CLAUDE.md` |
| `templates/AGENTS.md` | `AGENTS.md` (pointer to `CLAUDE.md` for Codex) |
| `templates/claude-commands/*.md` (except README) | `.claude/commands/*.md` |
| `templates/AGENT_MISTAKES_LOG.md` | `docs/AGENT_MISTAKES_LOG.md` (template stays too) |

Links that point outside the repo (for example `../../Plan/EC2-…`) become plain text with the note
"(outside repo)".

**`scripts/check-explanation-refs.py`** (standard library only):
- Input: explanation files changed in this PR, from
  `git diff --name-only --diff-filter=AM origin/main...HEAD -- 'docs/explanations/*.md'`. With no changed
  files it exits 0. It never checks older explanations: they are snapshots, and their references are
  expected to drift as the code moves on.
- For each reference in backticks of the form `path::anchor`: fail if `path` (relative to the repo root)
  doesn't exist, or if `anchor` doesn't appear in the file as literal text.
- For each backticked bare `path` that looks like a repo path (contains `/` and a file extension): fail if it
  doesn't exist.
- Fail on bare `path:NN` line references, with a message pointing to the `path::symbol` rule in
  `docs/templates/EXPLANATION.md`.
- Output: one line per problem, `explanation-file: reference → reason`; exit 1 if there is any.

## Acceptance criteria

1. **Given** the repo after this PR, **when** the link checker runs, **then** every relative markdown link in
   `docs/`, `CLAUDE.md` and `README.md` resolves.
2. **Given** a new Claude Code session in the repo, **when** you type `/frame-ticket P0-02`, **then** the
   command loads and reads `docs/tickets/P0-02-*.md`.
3. **Given** `CLAUDE.md`, **then** it has ≤ 150 lines, and every path it mentions exists or is marked "added in
   <ticket>".
4. **Given** `docs/archive/2026-10-legacy/`, **then** it contains all previous docs and a superseded note.
   Nothing outside the archive references them as current.
5. **Given** a branch that adds `docs/explanations/X.md` containing `` `backend/app/main.py::lifespan` ``
   (exists) and `` `backend/app/main.py::no_such_symbol` `` (doesn't), **when** `check-explanation-refs.py`
   runs, **then** it reports only the second reference and exits 1. **Given** a branch that changes no
   explanation file, **then** it exits 0 even if an older explanation's references no longer resolve.
6. **Given** `.claude/commands/`, **then** it contains `draft-ticket`, `frame-ticket`, `implement-ticket`,
   `review-ticket`, `explain-ticket`, `quiz-me` and `milestone-recap`.

## Test plan

- Link check: a small script (`scripts/check-links.py`, committed) that parses `[text](path)` links in `*.md`
  and verifies the targets exist. Run it in the `docs` CI job.
- Reference check: `scripts/check-explanation-refs.py` with a small fixture, or the manual branch test from
  criterion 5 (paste the output in the PR). Run it in the `docs` CI job after the link check.
- `wc -l CLAUDE.md`
- Manual: try `/frame-ticket P0-02` in Claude Code.

## Likely files

`docs/**`, `CLAUDE.md`, `.claude/commands/*`, `README.md`, `scripts/check-links.py`,
`scripts/check-explanation-refs.py`, `.github/workflows/*.yml` (`docs` job).

## Must explain (learning checkpoint)

1. Why is "one fact, one place" worth enforcing, and where does each kind of fact live now?
2. What is the difference between an ADR, a ticket and an explanation?
3. Why does `CLAUDE.md` link out instead of containing all the rules?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
