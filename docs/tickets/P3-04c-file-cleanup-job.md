# P3-04c — File cleanup job (split from P3-04)

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 1 |
| Depends on | P3-04b, P3-01b |
| Replaces old | M5-T11 (cleanup part) (part of [P3-04](./P3-04-private-file-uploads.md)) |
| Status | in progress |

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

Number 8 is P3-04's; 25 onwards are added by framing (P3-04a used 9–16, P3-04b 17–24).

8. **Given** `files.cleanup` with old pending and unattached files, **then** the rows and objects are deleted.
   Attached files are untouched. Sharpened: "old" is measured from the row's `created_at` against
   `clock.now()`, strictly older: a `pending` file created more than 24 h ago and a `ready`, unattached file
   created more than 7 days ago are deleted (every S3 version of the key, then the row); a `ready` file with
   an attachment is kept whatever its age, row and every version.
25. **Age boundaries**: a `pending` file created exactly 24 h ago (and 23 h 59 m ago) is kept, 24 h + 1 s ago
    deleted; a `ready`, unattached file created exactly 7 days ago is kept, 7 days + 1 s ago deleted; a
    `ready`, unattached file 2 days old (older than the pending limit) is kept.
26. **Every version** (`storage.delete_versions(key)`): a key holding two versions and a delete marker has
    nothing left under it afterwards (no version, no delete marker). Another key that starts with the same
    characters (`<key>-other`) keeps its objects. A key with nothing stored (a `pending` file never uploaded)
    is not an error: its row is deleted.
27. **A failed S3 delete keeps its row** (missed case): when deleting one file's versions fails, that row is
    kept and the run goes on: the other eligible files of the same run are deleted and the job succeeds. The
    failure is logged with the file's id and the error type only. The next run deletes it.
28. **A file claimed while the job runs is not deleted** (tenant row 10, concurrency): (a) a `claim_file`
    holding the row (uncommitted) when the job runs: the job skips it, and the file is attached with its object
    once the claim commits; (b) a `claim_file` on a file the job holds waits, then gets 404 `file_not_found`,
    so no record is ever attached to a deleted object; (c) the same for `complete_file` on an old `pending`
    file the job deleted under it: 404 `file_not_found`, not a 500 (missed case: the conditional update matched
    no row and the refresh failed).
29. **Bounded run** (missed case): one run handles at most `CLEANUP_BATCH` (500) files and starts no new S3
    delete after `CLEANUP_BUDGET` (30 s), well inside `HANDLER_TIMEOUT` (50 s); what's left is deleted by the
    next run. Oldest first.
30. **Every building**: the job is not tenant-scoped; eligible files of building A and building B are both
    deleted in one run, and the rows it deletes are exactly the eligible ones.
31. **In the worker** (carried from P3-01b): `app.files.jobs` is in `HANDLER_MODULES`, `files.cleanup` in
    `RECURRING_KINDS` (scheduled daily, key `files.cleanup:<UTC date>`), with no sensitive keys. The handler
    uses `ctx.db` and never commits: run through `Worker.run_once`, its row deletions commit with the job's
    `succeeded`, and roll back if the handler fails after them.
32. **Index**: a partial index on `files (created_at) WHERE attached_id IS NULL` serves the job's query (every
    candidate is unattached); `alembic check` is clean and the migration downgrades.

## Test plan

- `backend/tests/files/test_cleanup.py` against the S3 emulator (`test_storage.py` for `delete_versions`;
  `test_claim.py`/`test_complete.py` for 28b–c).
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
  - 8: what "old" means (`created_at` vs `clock.now()`, strictly older) and what "deleted" covers.
  - 25–28: the four cases the ticket asked framing to sharpen (boundaries, a failed S3 delete, a concurrent
    claim, every version), plus missed cases: a never-uploaded `pending` row, a sibling key with the same
    prefix, and `complete_file` racing the job (28c).
  - 29 (bounded run), 30 (every building), 31 (worker wiring and the job's transaction), 32 (the index).
  - Tenant table (`docs/ENGINEERING_PRACTICES.md` §7): no endpoint is added, so rows 1–9 don't apply; row 10
    (concurrency) is 28. The job crosses buildings by design (30); it deletes, never reads, file contents.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Age from `created_at`, not `updated_at` or the time it became `ready`: autonomous. ADR-0007 says
    "`ready` but unattached after 7 days" without a clock; `created_at` never changes and a file becomes
    `ready` minutes after creation (the form expires in 5 min), so the two differ by at most the time a
    client waits to call `complete`.
  - Rows are locked `FOR UPDATE SKIP LOCKED` with the eligibility conditions in the same statement, before any
    S3 call: autonomous. A claim in flight holds the row, so the job skips it (28a); a claim arriving later
    waits for the job and finds the row gone (28b). The alternative, a committed `deleting` status first,
    needs a schema change and a commit inside a handler (rule 5).
  - The row is deleted only after its S3 delete succeeded, file by file, in the job's transaction: ticket
    ("S3 versions, then rows"). If the job itself fails after some S3 deletes (a database error, the 50 s
    timeout), their rows roll back and point at nothing until the next run deletes them; 29's budget keeps
    the timeout out of reach. Limitation recorded in the PR.
  - No follow-up job when a run leaves work (29): autonomous. A continuation would re-run every 30 s while S3
    is down; a day's delay costs only storage.
