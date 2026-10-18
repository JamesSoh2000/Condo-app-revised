# P3-04b — File downloads and `claim_file` (split from P3-04)

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 1 |
| Depends on | P3-04a |
| Replaces old | M5-T05 (part of [P3-04](./P3-04-private-file-uploads.md)) |
| Status | todo |

## Goal

Domain code attaches a verified file to its record by `file_id`, and a download is authorized through the
record that owns the file.

## Why

A file is only as visible as its package or request ([ADR-0007](../adr/0007-private-s3-presigned-uploads.md));
`claim_file` makes it impossible to attach another user's or another building's file.

## Scope

- In:
  - **`can_view(ctx, file, db)` hook** in the purpose registry (`app/files/purposes.py`), registered by the
    owning domain; a purpose with no hook registered grants nothing beyond the uploader rule below.
  - **Storage:** `presign_get(key, version_id, disposition)`.
  - **`GET /files/{id}/download-url`** (`files_download_url`):
    - allowed if the caller is the uploader of an unattached `ready` file, **or** the purpose's `can_view`
      grants it; otherwise 404 `file_not_found`
    - returns a 60 s presigned GET pinned to `VersionId`, with `ResponseContentDisposition` (inline for
      images, attachment for PDF; the filename encoded safely)
  - **Helper `claim_file(db, ctx, file_id, purpose, attached_type, attached_id)`** (never commits):
    - the file must be same building, `ready`, the matching purpose, uploaded by `ctx.user_id` (or the caller
      is staff for staff purposes), and unattached
    - it marks the file attached with a conditional update
    - otherwise it raises 422 `invalid_file`; a file from another building gives 404
- Out: the table, uploads and completion (P3-04a); `files.cleanup` (P3-04c); the frontend (P3-06).

## Interfaces

Endpoint `files_download_url`. Helper `claim_file`. Registry hook `can_view`.

## Acceptance criteria

Numbers are P3-04's.

5. **Given** a completed file, re-POSTing different bytes with the same presigned form (if still valid),
   then downloading via `download-url`, **still returns the original bytes**. (The stored-version half is in
   P3-04a.)
6. **Given** another resident in the same building, or a building-B member, **when** requesting
   `download-url`, **then** 404.
7. **Given** `claim_file` with a file from building B, an unready file, the wrong purpose, someone else's
   file, or an already-attached file, **then** each raises the documented error, and no attachment happens.

- To sharpen while framing P3-04b: the tenant rows for `download-url`, a pending file's `download-url`
  (404), two concurrent claims (one winner), and the `Content-Disposition` of a filename with quotes or
  non-ASCII characters.

## Test plan

- `backend/tests/files/test_download.py`, `test_claim.py` against the S3 emulator (as in P3-04a).
- Commands: `make test`.

## Likely files

`backend/app/files/{purposes,storage,service,router,schemas}.py`, `backend/tests/files/*`.

## Must explain (learning checkpoint)

4. Why is download authorization delegated to the owning domain (`can_view`)?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
- Criteria loosened (with reason; also listed in the inbox):
- Decisions taken (with basis: ticket / ADR / default / autonomous):
- Split: from P3-04 (2026-10-18); see P3-04's table.
