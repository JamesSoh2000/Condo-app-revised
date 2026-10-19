# P3-04c — File cleanup job (split from P3-04)

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 1 |
| Depends on | P3-04b, P3-01b |
| Replaces old | M5-T11 (cleanup part) (part of [P3-04](./P3-04-private-file-uploads.md)) |
| Status | done |

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

Number 8 is P3-04's; 25 onwards are added by framing (P3-04a used 9–16, P3-04b 17–24); 33–35 and the
changes to 8, 27–29, 31, 32 by review round 1 ([ADR-0018](../adr/0018-file-deletion-state.md)).

8. **Given** `files.cleanup` with old pending and unattached files, **then** the rows and objects are deleted.
   Attached files are untouched. Sharpened: "old" is measured from the row's `created_at` against
   `clock.now()`, strictly older: a `pending` file created more than 24 h ago and a `ready`, unattached file
   created more than 7 days ago are deleted: `files.cleanup` marks them `deleting`, and the `files.purge` it
   enqueues deletes every S3 version of the key, then the row. A `ready` file with an attachment is kept
   whatever its age, row and every version.
25. **Age boundaries**: a `pending` file created exactly 24 h ago (and 23 h 59 m ago) is kept, 24 h + 1 s ago
    deleted; a `ready`, unattached file created exactly 7 days ago is kept, 7 days + 1 s ago deleted; a
    `ready`, unattached file 2 days old (older than the pending limit) is kept.
26. **Every version** (`storage.delete_versions(key)`): a key holding two versions and a delete marker has
    nothing left under it afterwards (no version, no delete marker). Another key that starts with the same
    characters (`<key>-other`) keeps its objects. A key with nothing stored (a `pending` file never uploaded)
    is not an error: its row is deleted.
27. **A failed S3 delete keeps its row** (missed case): when deleting one file's versions fails, that row is
    kept, still `deleting`, and the purge goes on: the other files of the same purge are deleted and the job
    succeeds. The failure is logged with the file's id and the error type only. The next day's cleanup
    enqueues a purge for it, which deletes it. A partial failure (some versions deleted, the pinned one among
    them) leaves the row `deleting` too: never claimable or downloadable.
28. **A file claimed while the job runs is not deleted** (tenant row 10, concurrency): (a) a `claim_file`
    holding the row (uncommitted) when the job runs: the job skips it, and the file is attached with its object
    once the claim commits; (b) a `claim_file` on a file the cleanup holds waits, then gets 404
    `file_not_found` (the file is `deleting`), so no record is ever attached to a file being deleted; (c)
    `complete_file` on an old `pending` file the cleanup took meanwhile gets 404 `file_not_found`, never a
    409 or 500, at every point: before its HEAD, between HEAD and the ranged GET (the version is gone), after
    its checks (the conditional update matches no row), and when a purge deleted the object but left the row.
29. **Bounded run** (missed case): one cleanup marks at most `CLEANUP_BATCH` (500) files and one purge
    deletes at most as many, oldest first; a purge starts no new S3 delete after `CLEANUP_BUDGET` (30 s), well
    inside `HANDLER_TIMEOUT` (50 s). What's left stays `deleting` for the next day's purge.
30. **Every building**: the job is not tenant-scoped; eligible files of building A and building B are both
    deleted in one run, and the rows it deletes are exactly the eligible ones.
31. **In the worker** (carried from P3-01b): `app.files.jobs` is in `HANDLER_MODULES`, `files.cleanup` in
    `RECURRING_KINDS` (scheduled daily, key `files.cleanup:<UTC date>`); `files.purge` is not recurring (the
    cleanup enqueues it, key `files.purge:<cleanup job id>`). Neither has sensitive keys. The handlers use
    `ctx.db` and never commit: run through `Worker.run_once`, the cleanup's marks and its purge job commit
    with the job's `succeeded` and roll back if it fails; the purge runs next and deletes.
32. **Migration**: a partial index on `files (created_at) WHERE attached_id IS NULL` serves the cleanup's
    query (every candidate is unattached); `status` accepts `deleting` (the column widened to 8 characters,
    `ck_files_file_status`), and a `deleting` row may keep its version or have none
    (`ck_files_version_iff_ready`) but can't be attached. `alembic check` is clean; the downgrade turns
    `deleting` rows back into `ready` (with a version) or `pending` (without), and upgrading again works.
33. **The cleanup only marks** (review round 1): `files.cleanup` deletes no object; it marks the eligible rows
    `deleting` and, if any row is `deleting` (new or left by an earlier purge), enqueues one `files.purge`;
    with none, it enqueues nothing.
34. **A `deleting` file is gone** (review round 1): `claim_file`, `download-url` and `complete` answer 404
    `file_not_found` for it, without asking S3; the API never reports the status `deleting`.
35. **A purge that dies mid-delete harms nothing** (review round 1): when the worker's timeout cancels a purge
    while its S3 call still runs in its thread, the purge rolls back, the row stays `deleting`, a claim gets
    404, and the next purge deletes the row.

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
  - Review round 1 (Codex): the first design deleted objects while only a row lock protected the file; a
    timed-out or partly failed delete left a claimable file without its object. Criteria 8, 27–29, 31 and 32
    were rewritten for the committed `deleting` state and 33–35 added; each keeps or tightens what it
    required.
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Age from `created_at`, not `updated_at` or the time it became `ready`: autonomous. ADR-0007 says
    "`ready` but unattached after 7 days" without a clock; `created_at` never changes and a file becomes
    `ready` minutes after creation (the form expires in 5 min), so the two differ by at most the time a
    client waits to call `complete`.
  - Rows are locked `FOR UPDATE SKIP LOCKED` with the eligibility conditions in the same statement:
    autonomous. A claim in flight holds the row, so the cleanup skips it (28a); a claim arriving later waits
    and finds the file `deleting` (28b).
  - Superseded in review round 1 by [ADR-0018](../adr/0018-file-deletion-state.md): first a committed
    `deleting` status (by `files.cleanup`), then the S3 deletes and the row delete (by `files.purge`, a job the
    cleanup enqueues, so no handler commits). The first design deleted objects under a row lock alone and
    accepted that a failed job left rows pointing at nothing; the review showed that state is claimable.
  - No follow-up purge when a purge leaves work (29): autonomous. A continuation would re-run every 30 s while
    S3 is down; a day's delay costs only storage, and the files stay `deleting` meanwhile.
