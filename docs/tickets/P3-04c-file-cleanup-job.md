# P3-04c — File cleanup job (split from P3-04)

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 1 |
| Depends on | P3-04b, P3-01b |
| Replaces old | M5-T11 (cleanup part) (part of [P3-04](./P3-04-private-file-uploads.md)) |
| Status | todo |

## Goal

Abandoned uploads don't pile up: old `pending` files and old unattached `ready` files are deleted, their S3
versions first.

## Why

Without it, every abandoned upload stays in the private bucket forever
([ADR-0007](../adr/0007-private-s3-presigned-uploads.md) "Cleanup").

## Scope

- In:
  - **Storage:** `delete_versions(key)` (every version of the key, then nothing is left under it).
  - **Recurring job `files.cleanup`** (scheduled by P3-01b's scheduler): delete `pending` older than 24 h
    and unattached `ready` older than 7 days (S3 versions, then rows). An index for the query if it needs one.
- Out: retention per purpose (pilot); the 30-day lifecycle rule on non-current versions (D-01, Terraform).

## Interfaces

Job kind `files.cleanup`. Storage `delete_versions`.

## Acceptance criteria

Number is P3-04's.

8. **Given** `files.cleanup` with old pending and unattached files, **then** the rows and objects are deleted.
   Attached files are untouched.

- To sharpen while framing P3-04c: the exact age boundaries (23 h 59 m kept), a row whose S3 delete fails
  (kept, retried next run), a file claimed while the job runs (not deleted), and every version deleted, not
  only the latest.

## Test plan

- `backend/tests/files/test_cleanup.py` against the S3 emulator.
- Commands: `make test`.

## Likely files

`backend/app/files/{storage,jobs}.py` (or `service.py`), the scheduler's registration, `backend/tests/files/*`.

## Carried from P3-01b

- Register the handler module in `backend/app/jobs/worker.py::HANDLER_MODULES` and the kind in
  `RECURRING_KINDS` (one daily job, key `"files.cleanup:<UTC date>"`); update
  `backend/tests/jobs/test_scheduler.py::test_the_recurring_kinds_are_the_three_cleanups_every_60_seconds`.
- Handlers use `ctx.db`, never commit, and finish within `HANDLER_TIMEOUT` (50 s). See
  `docs/explanations/P3-01b-scheduler-cleanup-and-cli.md` §8.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: from P3-04 (2026-10-18); see P3-04's table.
