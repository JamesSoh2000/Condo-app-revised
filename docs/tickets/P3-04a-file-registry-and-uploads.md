# P3-04a — File registry and direct uploads (split from P3-04)

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 1 |
| Depends on | P2-03, P0-04a |
| Replaces old | M5-T05 (part of [P3-04](./P3-04-private-file-uploads.md)) |
| Status | done |

## Goal

A member uploads a file straight to the private bucket with a presigned POST whose key, size and type the
server fixed. The server then verifies the stored object and pins its version, so a `ready` file always
means the bytes the server checked.

## Why

Package and maintenance photos are private data. File bytes stay off the API host, and a client can never
choose an object key or swap the bytes of a file the server accepted
([ADR-0007](../adr/0007-private-s3-presigned-uploads.md)).

## Scope

- In:
  - **`files` table** (`app/files/models.py`):
    - `building_id` (FK buildings, RESTRICT), `uploaded_by_user_id` (FK users, RESTRICT)
    - `purpose` (`package_photo`, `maintenance_photo`, `notice_attachment`)
    - `s3_key` String(200), unique; `s3_version_id` String(1024), null until `ready`
    - `content_type` String(100), `size_bytes` BigInteger (> 0), `original_name` String(255)
    - `status` (`pending`, `ready`)
    - `attached_type` String(40), `attached_id` (both null or both set; only a `ready` file is attached).
      Nothing sets them before P3-04b's `claim_file`.
    - `created_at`, `updated_at`; `UniqueConstraint(building_id, id)` (the target of the composite FKs
      domain tables will use, ADR-0005)
    - check constraints: `status = 'ready'` exactly when `s3_version_id` is set; an attachment needs
      `ready`
  - **Purpose registry** (`app/files/purposes.py`), one rule per purpose:

    | Purpose | Content types | Max bytes | Who may upload |
    |---|---|---|---|
    | `package_photo` | image/jpeg, image/png, image/webp, image/heic | 10 MiB | security, property_management |
    | `maintenance_photo` | same images | 10 MiB | resident, property_management |
    | `notice_attachment` | application/pdf | 20 MiB | property_management |

    plus the magic number of each type (JPEG `FF D8 FF`; PNG `89 50 4E 47 0D 0A 1A 0A`; WebP `RIFF` at 0 and
    `WEBP` at 8; HEIC `ftyp` at 4 with a HEIF brand at 8; PDF `%PDF-`). P3-04b adds the `can_view` hook.
  - **Storage adapter** (`app/files/storage.py`): boto3, `endpoint_url` from `S3_ENDPOINT_URL` when set,
    presigning with `S3_PUBLIC_ENDPOINT_URL` when set (so the browser reaches the emulator), every call in
    `anyio.to_thread`. Functions: `presign_post`, `head`, `get_range` (pinned to a `VersionId`). P3-04b adds
    `presign_get`, P3-04c `delete_versions`.
  - **Endpoints** on the building router:
    - **`POST /files`** (`files_create`) `{purpose, filename, content_type, size_bytes}`:
      - the caller holds one of the purpose's upload roles (else 403 `forbidden_role`)
      - `content_type` is one the purpose allows (else 422 `file_type_not_allowed`), `size_bytes` at most its
        limit (else 422 `file_too_large`)
      - creates a `pending` row with key `b/{building_id}/{purpose}/{file_id}`
      - 201 `{file_id, upload: {url, fields}, expires_at}`: a presigned POST valid 5 minutes, whose policy is
        `content-length-range` exactly `size_bytes`..`size_bytes`, `Content-Type` exactly the declared type,
        and the key
    - **`POST /files/{file_id}/complete`** (`files_complete`), uploader only (anyone else, and another
      building's file, gets 404 `file_not_found`):
      - `head` the object; missing → 409 `upload_incomplete`
      - size equal to the declared one (else 422 `file_size_mismatch`), `Content-Type` equal to the declared
        one (else 422 `file_type_mismatch`)
      - reads the first 16 bytes **of the version `head` returned** and checks the magic number against the
        declared type (mismatch → 422 `file_type_mismatch`)
      - stores that `VersionId` and sets `ready` with a conditional update (`WHERE status = 'pending'`)
      - 200 with the file (`id, purpose, status, content_type, size_bytes, original_name, created_at`); the
        key and version are never returned
  - **CI:** an `s3` service (the same LocalStack image as compose) in the backend job. The file tests create
    a bucket of their own per run (versioned), so they need no init script and never share state.
- Out:
  - `can_view`, `download-url`, `claim_file` (P3-04b); `files.cleanup` (P3-04c)
  - malware scanning and quotas (pilot); image resizing (later); the frontend (P3-06)
  - audit events: a file is audited through the record that claims it (P5 and later), not on upload

## Interfaces

Endpoints `files_create`, `files_complete`. Table `files`. Module `app.files.storage`.

## Acceptance criteria

Numbers 1–5 are P3-04's; 9 onwards are added by framing.

1. **Given** a valid create, **then** the response is 201 with `file_id`, a presigned POST (`url`, `fields`
   including `key` and `Content-Type`) and `expires_at` about 5 minutes ahead; the DB row is `pending`, its
   `s3_key` is `b/{building_id}/{purpose}/{file_id}` and `s3_version_id` is null. A body that names a key (or
   any unknown field) is 422 `validation_error`, and no row is written.
2. **Given** `size_bytes` above the purpose limit, **then** 422 `file_too_large`; **given** a content type the
   purpose doesn't allow, **then** 422 `file_type_not_allowed`. No row is written in either case.
3. **Given** the presigned form (emulator), **then** S3 rejects an upload larger than the declared size
   (`EntityTooLarge`), one smaller than it (`EntityTooSmall`), and one with another `Content-Type` (403).
   The declared size itself is accepted.
4. **Given** complete before upload, **then** 409 `upload_incomplete`. **Given** a PNG declared but PDF bytes
   uploaded, **then** 422 `file_type_mismatch`, and the file stays `pending` with no version stored.
5. **Given** a completed file, **then** `s3_version_id` is the version `head` returned. Re-POSTing different
   bytes with the same presigned form (still valid) creates a new version; the stored version still serves the
   original bytes, and completing again returns the same file without re-pinning. (The `download-url` half of
   P3-04's criterion 5 is in P3-04b.)
9. **Happy path per role** (tenant row 1): security and the manager create `package_photo`, a resident and
   the manager `maintenance_photo`, the manager `notice_attachment`; each upload completes to `ready`.
10. **Wrong role** (row 4): a resident creating `package_photo`, security creating `maintenance_photo`, the
    council member creating `notice_attachment`: 403 `forbidden_role`, no row. `multi` (security in B,
    resident in A) creating `package_photo` in A: 403, so the role comes from A's membership.
11. **Unauthenticated, another building, pending/suspended** (rows 2, 3, 6): 401 `not_authenticated`; 404
    `building_not_found` for `b_manager`, `a_pending` and `a_suspended`, on both endpoints.
12. **Someone else's file** (row 5): `a_resident2`, and the manager, completing `a_resident1`'s file get
    404 `file_not_found`, the same body as a random id; the file stays `pending`.
13. **Another building's file** (row 7): `multi` completing its own building-B file through building A's URL
    gets 404 `file_not_found`, and the file stays `pending`.
14. **Retry and concurrency** (rows 8–10): completing a `ready` file returns 200 and the same body, with no
    S3 call. If another completion wins the conditional update first, the loser returns the winner's file and
    does not overwrite its version. (Completion is idempotent, so there is no `invalid_transition`.)
15. **Pinned check** (missed case): if a new version lands between `head` and the magic-number read, the
    read still checks the version `head` returned, and that version is the one stored.
16. **Mismatches** (missed case): an object whose size or `Content-Type` differs from the declaration (put
    outside the form) gives 422 `file_size_mismatch` / `file_type_mismatch` and stays `pending`. A filename
    with a control character, an empty one, or one over 255 characters, and `size_bytes` < 1, are 422
    `validation_error`.

## Test plan

- `backend/tests/files/test_create.py`, `test_complete.py`, `test_storage.py`, `test_schema_files.py` against
  the S3 emulator (compose locally, the `s3` service in CI), a bucket per run.
- Commands: `make test`. On the stack: create, upload with curl using the presigned form, complete.
  Real S3 is checked in D-06.

## Likely files

`backend/app/files/{models,purposes,storage,service,router,schemas}.py`, `backend/app/core/errors.py`,
`backend/app/models/registry.py`, `backend/app/main.py`, `backend/migrations/versions/<new>.py`,
`backend/pyproject.toml` (boto3, anyio, boto3 type stubs), `Makefile`, `.github/workflows/ci.yml`,
`backend/tests/files/*`.

## Must explain (learning checkpoint)

1. Why presigned **POST** instead of PUT?
2. Without `s3_version_id`, how could someone change what an accepted `file_id` serves?
3. Why check magic bytes when S3 already has a `Content-Type`?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - 1: the exact key, the null version, 201, and "a client can't send a key" (InputModel forbids extra
    fields).
  - 2: the two error codes, and no row on either.
  - 3: the policy range is exactly the declared size, so S3 also rejects a smaller upload (checked on
    LocalStack 4.14.0 before framing: `EntityTooSmall` / `EntityTooLarge`, declared size 204). P3-04 said
    `1..max`; this is tighter, never looser.
  - 4: "stays pending" now also means no version stored.
  - 5: split; this part checks the stored version against S3 directly.
  - 9–16 added: tenant rows 1–10 that apply, the version-pinned magic check (15) and the mismatch and
    filename cases (16).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Who may upload each purpose (table above): autonomous, from PRODUCT_SCOPE's roles (security logs
    packages; residents submit maintenance; the manager publishes notices; council is read-only). Recorded
    in the PR; P5/P6 can widen a rule.
  - `notice_attachment` accepts PDF only: autonomous (P3-04 names "PDF ≤ 20 MiB for notice attachments");
    reversible by adding types to the rule.
  - Policy range exactly the declared size: autonomous, tighter than P3-04 (see 3).
  - Completion is idempotent (a second call returns the stored file): autonomous; tenant row 9.
  - Error codes `file_not_found`, `file_too_large`, `file_type_not_allowed`, `file_size_mismatch`,
    `file_type_mismatch` (P3-04's), `upload_incomplete` (P3-04's): autonomous where P3-04 named none.
  - Per-run test bucket created by the tests: autonomous (the same reason as P2-07's per-run database).
- Split: from P3-04 (2026-10-18), with P3-04b and P3-04c; see P3-04's table.
