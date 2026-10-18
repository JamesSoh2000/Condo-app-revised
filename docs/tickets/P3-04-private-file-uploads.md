# P3-04 — Private file uploads (split)

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 1 |
| Depends on | P2-03, P0-04 |
| Replaces old | M5-T05, M5-T11 (cleanup part) |
| Status | split into [P3-04a](./P3-04a-file-registry-and-uploads.md), [P3-04b](./P3-04b-file-downloads-and-claim.md), [P3-04c](./P3-04c-file-cleanup-job.md) |

Split while framing (2026-10-18). "P3-04" in other tickets' text means all three parts; the
[ticket index](./README.md) lists which part each dependent actually needs (P5-01 and P3-06 need P3-04b:
`claim_file` and `download-url`).

| Part | Scope | Acceptance criteria (original numbers) |
|---|---|---|
| [P3-04a](./P3-04a-file-registry-and-uploads.md) | `files` table, purpose registry (types, sizes, uploader roles), storage adapter (`presign_post`, `head`, `get_range`), `POST /files`, `POST /files/{id}/complete`, the `s3` service in CI | 1–4, 5 (the version is stored and pinned), plus new 9–16 |
| [P3-04b](./P3-04b-file-downloads-and-claim.md) | `can_view` hook, `presign_get`, `GET /files/{id}/download-url`, `claim_file` | 5 (download returns the original bytes), 6, 7 |
| [P3-04c](./P3-04c-file-cleanup-job.md) | `delete_versions`, recurring `files.cleanup` | 8 |

## Why split

- Size: the estimate for the whole ticket was ~600 non-test lines (model and migration ~100, registry and
  magic numbers ~70, storage adapter ~100, create and complete ~130, download and `claim_file` ~110, schemas
  and router ~60, CI ~20, cleanup ~60), over ~400.
- Dependency: `files.cleanup` is a recurring job, and the scheduler that runs recurring jobs is P3-01b
  (P3-01 was split the same day; P3-01b is `todo`). P3-04c waits for it; nothing else here does.
- Order: uploads first (P3-06 can build its form against them), then downloads and `claim_file`, which the
  first domain (P5-01 packages) needs, then cleanup.
- No criterion was dropped or loosened: criteria 1–4 and the first half of 5 are in P3-04a (sharpened), the
  rest of 5 and 6–7 in P3-04b, 8 in P3-04c. "Must explain" questions 1–3 are answered by P3-04a's
  explanation, 4 by P3-04b's.

## Original ticket (for reference)

### Goal

Users upload files directly to private S3 with server-controlled keys and size and type limits. The server
verifies and pins each upload. Domain code attaches files by `file_id`, and downloads are authorized through
the owning record.

### Why

Package and maintenance photos are private data. This design keeps file bytes off the API host and makes it
impossible to reference another user's or another building's file
([ADR-0007](../adr/0007-private-s3-presigned-uploads.md)).

### Scope

- In:
  - **`files` table:**
    - `building_id`, `uploaded_by_user_id`
    - `purpose` enum (`package_photo`, `maintenance_photo`, `notice_attachment`)
    - `s3_key` (unique), `s3_version_id`
    - `content_type`, `size_bytes`, `original_name` String(255)
    - `status` (pending, ready)
    - `attached_type`, `attached_id` (nullable)
    - `UniqueConstraint(building_id, id)`
  - **Purpose registry** (`app/files/purposes.py`): allowed MIME types and max bytes per purpose
    (images ≤ 10 MiB; PDF ≤ 20 MiB for notice attachments), plus a `can_view(ctx, file, db)` hook that the
    owning domain registers.
  - **Storage adapter** (`app/files/storage.py`): boto3 client with optional `endpoint_url`, wrapped with
    `anyio.to_thread`. Functions: `presign_post`, `head`, `get_range`, `presign_get(version_id)` and
    `delete_versions`. Presigning uses `S3_PUBLIC_ENDPOINT_URL` locally, so the browser can reach the
    emulator.
  - **Endpoints** (building router):
    - **`POST /files`** `{purpose, filename, content_type, size_bytes}`:
      - validates against the purpose registry
      - creates a `pending` row with key `b/{building_id}/{purpose}/{file_id}`
      - returns `{file_id, upload: {url, fields}, expires_at}`; the POST policy has
        `content-length-range` 1..max and an exact `Content-Type`
    - **`POST /files/{id}/complete`** (uploader only):
      - `head` the object (missing → 409 `upload_incomplete`)
      - checks size ≤ max and equal to the declared size, and the content type
      - reads the first 16 bytes and checks the magic number against the declared type (mismatch → 422
        `file_type_mismatch`)
      - stores `s3_version_id` and sets `ready`
    - **`GET /files/{id}/download-url`:**
      - allowed if the caller is the uploader of an unattached file, **or** the purpose's `can_view` grants it
      - otherwise 404
      - returns a 60 s presigned GET pinned to `VersionId`, with `ResponseContentDisposition` (inline for
        images, attachment for PDF)
  - **Helper `claim_file(db, ctx, file_id, purpose, attached_type, attached_id)`:**
    - the file must be same building, `ready`, the matching purpose, uploaded by `ctx.user_id` (or the caller
      is staff for staff purposes), and unattached
    - it marks the file attached
    - otherwise it raises 422 `invalid_file`; a file from another building gives 404
  - **Recurring job `files.cleanup`:** delete `pending` older than 24 h and unattached `ready` older than
    7 days (S3 versions, then rows).
- Out:
  - malware scanning and quotas (pilot)
  - image resizing (later)
  - the frontend (P3-06)

### Interfaces

Endpoints `files_create`, `files_complete`, `files_download_url`. Helper `claim_file`.

### Acceptance criteria

1. **Given** a valid create, **then** the response has a presigned POST, and the DB row is `pending` with a
   server-generated key containing the building ID.
2. **Given** `size_bytes` above the purpose limit, or a disallowed type, **then** 422 at create.
3. **Given** an upload larger than the declared policy range (emulator), **then** S3 rejects it.
4. **Given** complete before upload, **then** 409 `upload_incomplete`. Given a PNG declared but PDF bytes
   uploaded, **then** 422 `file_type_mismatch`, and the file stays `pending`.
5. **Given** a completed file, **then** `s3_version_id` is stored. Re-POSTing different bytes with the same
   presigned form (if still valid), then downloading via `download-url`, **still returns the original bytes**.
6. **Given** another resident in the same building, or a building-B member, **when** requesting
   `download-url`, **then** 404.
7. **Given** `claim_file` with a file from building B, an unready file, the wrong purpose, someone else's
   file, or an already-attached file, **then** each raises the documented error, and no attachment happens.
8. **Given** `files.cleanup` with old pending and unattached files, **then** the rows and objects are deleted.
   Attached files are untouched.

### Test plan

- Integration tests against the S3 emulator in compose and CI (add an `s3` service to CI): `tests/files/*`.
- Commands: `make test`. Manual on the local stack: upload via curl using the presigned form against the S3
  emulator. Real S3 is checked in D-06.

### Likely files

`backend/app/files/{models,purposes,storage,service,router,schemas}.py`,
`backend/migrations/versions/<new>.py`, `backend/app/core/config.py`, `.github/workflows/<ci>.yml`,
`backend/tests/files/*`.

### Must explain (learning checkpoint)

1. Why presigned **POST** instead of PUT?
2. Without `s3_version_id`, how could someone change what an accepted `file_id` serves?
3. Why check magic bytes when S3 already has a `Content-Type`?
4. Why is download authorization delegated to the owning domain (`can_view`)?

### Frame notes (filled by the agent in step 1)

- See each part's own Frame notes.
- Split: into P3-04a, P3-04b and P3-04c (2026-10-18; the table at the top of this file).
