# P2-07 — Test infrastructure hardening

| Field | Value |
|---|---|
| Phase / lane | P2 / B |
| Risk tier | 3 |
| Depends on | P2-03 |
| Replaces old | — |
| Status | todo |

Follow-ups of [P1-05](./P1-05-test-world-and-isolation-helpers.md) (PR #50) and
[P2-03](./P2-03-tenant-context-guards-fitness.md) (PR #59) that P2-03 did not take in scope. Re-frame before
starting.

## Goal

Concurrent test runs can't break each other, test code is type-checked, and the P2-03 fitness checks lose the
blind spots review round 2 found.

## Scope

- In:
  - **Per-run test database.** `condo_test` is one per server: two concurrent full suites (worktrees,
    reviewers) drop each other's schema. Give the session test database a per-run name (Makefile, CI,
    `backend/tests/conftest.py`), keeping the `_test` guard and dropping it afterwards (P1-05 follow-up).
  - **`mypy tests/` in `make check` and CI.** 123 errors in 13 files on 2026-10-17; fix them, then add the
    path (tightens a gate) (P1-05 follow-up).
  - **Fitness walk over every `APIRoute`.** `backend/tests/test_architecture.py` checks 1 and 2 walk only `/api`
    routes; an unguarded `APIRoute` at `/admin/export` passes. Report non-`/api` `APIRoute`s too (docs routes
    excepted) (P2-03 review round 2, L1).
  - **Commit grep.** Also match lower-case SQL `commit` (`re.IGNORECASE` for the SQL form) and `AUTOCOMMIT`
    (P2-03 review round 2, L2).
  - **Docs routes in production.** `/api/docs` and `/api/openapi.json` are served without a session and are
    exempt from the fitness checks. Decide whether staging/production serve them (settings flag) (P2-03 review
    round 2 residual).
- Out: anything that changes app behaviour beyond the docs-route flag.

## Acceptance criteria

1. Two `make test` runs started at the same time on one server both pass.
2. `make check` runs mypy on `tests/` and passes.
3. A meta-test: an unguarded `APIRoute` outside `/api` fails a fitness check.
4. A meta-test: `text("commit")` and `isolation_level="AUTOCOMMIT"` in a non-service file fail fitness test 4.
5. The docs-route decision is recorded and tested.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split:
