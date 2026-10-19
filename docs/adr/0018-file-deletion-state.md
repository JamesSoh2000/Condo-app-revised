# ADR-0018: Files are deleted through a committed `deleting` status

- Status: Accepted
- Date: 2026-10-19
- Deciders: agent (autonomous) in P3-04c, after review round 1
- Amends: [ADR-0007](./0007-private-s3-presigned-uploads.md) "Cleanup" (how, not what)

## Context

ADR-0007 has a nightly job delete abandoned uploads: `pending` after 24 h, `ready` but unattached after 7
days. Deleting means S3 calls (every version of the key) and a row delete. S3 calls can't be rolled back with
a database transaction, and a job handler never commits (CLAUDE.md rule 5): its writes commit with the job.

P3-04c's first design locked the rows (`FOR UPDATE SKIP LOCKED`), deleted the objects, then the rows, all in
the job's transaction. Review round 1 showed two ways that leaves a `ready`, unattached file whose object is
gone, which any claim can then attach to a record:

- the worker's timeout cancels the handler while boto3 still runs in its thread: the transaction rolls back,
  the lock is released, a claim succeeds, and the thread then deletes the object;
- S3 deletes some versions of a key (the pinned one among them) and refuses others: the row is kept, `ready`.

## Decision

- `files` gets a third status, `deleting`. A `deleting` file is never served, claimed or completed: those
  paths answer 404 `file_not_found`, and the API never reports the status.
- `files.cleanup` (daily) deletes nothing. It marks the eligible rows `deleting` and enqueues `files.purge`,
  both in its own transaction, so the purge exists only if the marks committed.
- `files.purge` deletes each `deleting` file's S3 versions, then its row. If it fails at any point, the row
  stays `deleting`; the next day's cleanup enqueues another purge while any row is `deleting`.

## Consequences

- Nothing a failed purge leaves behind can reach a user: the worst case is a `deleting` row and some of its
  versions, deleted by a later purge.
- Deletion takes two jobs instead of one; the purge normally runs right after the cleanup.
- Every query that serves files must keep filtering on `ready` (they already do); `claim_file`'s
  "does it exist" check excludes `deleting`.
- A future "delete this file now" (a record deleted, retention per purpose) should mark the file `deleting`
  and enqueue a purge, rather than calling S3 itself.

## Alternatives considered

- Keep the lock-only design and accept the window: rejected, the review reproduced both failures with tests.
- Bound each S3 call below the remaining timeout: narrows the first failure, doesn't fix the partial delete,
  and a thread that has started a request can't be stopped.
- A `deleting_at` column instead of a status: every serving query would need a second filter; the status
  check they already have covers it.
