# <ID> — <Title>

| Field | Value |
|---|---|
| Phase / lane | P? / A (backend-platform) or B (frontend-QA-ops) |
| Risk tier | 1 / 2 / 3 ([what this means](../AI_AGENT_PLAYBOOK.md#risk-tiers)) |
| Depends on | <ticket IDs that must be merged first> |
| Replaces old | <old M-ticket IDs, if any> |
| Status | todo / framing / in progress / review / done |

## Goal

One sentence describing the observable outcome.

## Why

Two or three sentences: what this unlocks and which risk it removes. Link the ADR(s).

## Scope

- In: …
- Out (do **not** do in this ticket): …

## Interfaces

Endpoints (method, path, auth, request/response schema, error codes), tables and columns, CLI commands, env
vars. Be explicit: agents must not invent contracts.

## Acceptance criteria

Given/When/Then. Include negative, same-building and cross-building cases where data is tenant-owned.

1. **Given** … **When** … **Then** …

## Test plan

- Tests to add (file + test names). Each acceptance criterion maps to at least one test.
- Commands: `make check`; `uv run pytest tests/<area> -q`; …
- Manual check: …

## Likely files

Starting points only. The agent must still read the code before changing it.

## Must explain (learning checkpoint)

Questions the reviewer answers without notes before merging (also used by `/quiz-me`).

1. …

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
