# P3-04b — File downloads and `claim_file` (split from P3-04)

| Field | Value |
|---|---|
| Phase / lane | P3 / A |
| Risk tier | 1 |
| Depends on | P3-04a |
| Replaces old | M5-T05 (part of [P3-04](./P3-04-private-file-uploads.md)) |
| Status | done |

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

Numbers 5–7 are P3-04's; 17 onwards are added by framing (P3-04a used 9–16).

5. **Given** a completed file, re-POSTing different bytes with the same presigned form (still valid), then
   downloading via `download-url`, **still returns the original bytes**: the URL names the stored
   `versionId`, and a GET on it returns the bytes that were checked at completion. (The stored-version half is
   in P3-04a.)
6. **Given** another resident in the same building (`a_resident2` on `a_resident1`'s file), or a building-B
   member (`b_manager`), **when** requesting `download-url`, **then** 404: `file_not_found` (the same body as
   a random id) for `a_resident2`, `building_not_found` for `b_manager`. The manager is not an exception: on a
   resident's unattached file it also gets 404 `file_not_found` unless a `can_view` hook grants it.
7. **Given** `claim_file` with a file from building B, an unready file, the wrong purpose, someone else's
   file, or an already-attached file, **then** each raises the documented error, and no attachment happens:
   building B's file (and a random id) → 404 `file_not_found`; the others → 422 `invalid_file`. Afterwards
   the row's `attached_type` and `attached_id` are unchanged (null, or the first claim's).
17. **Download happy path** (tenant row 1): the uploader of a `ready`, unattached file gets 200 with `url` and
    `expires_at` about 60 s ahead; the URL is valid for 60 s (`X-Amz-Expires=60`) and names the stored
    `versionId`. A GET on it (emulator) returns the bytes with `Content-Disposition` `inline` for an image and
    `attachment` for a PDF (the manager's own `notice_attachment`).
18. **`can_view`** (the ticket's hook): with a hook registered for the purpose, a file attached to a record is
    downloadable by whoever the hook grants (another resident, the manager) and 404 `file_not_found` for whom
    it refuses. The hook is called with the caller's context and the file, and only for a `ready`, attached
    file of the URL's building. A purpose with no hook grants nothing: once attached, even the uploader gets
    404. Registering a second hook for one purpose is an error.
19. **Unauthenticated, another building, pending/suspended** (rows 2, 3, 6): 401 `not_authenticated`; 404
    `building_not_found` for `b_manager`, `a_pending` and `a_suspended`.
20. **Another building's file** (row 7): `multi` requesting its own building-B file through building A's URL
    gets 404 `file_not_found`, even when building A's hook for that purpose would grant everything.
21. **Pending file**: `download-url` for a `pending` file (the uploader's own) is 404 `file_not_found`; the
    hook is not consulted.
22. **Filename in `Content-Disposition`** (sharpened): a filename with `"`, `\` or non-ASCII characters
    gives `filename="<ASCII fallback>"` with each of those replaced by `_`, plus
    `filename*=UTF-8''<percent-encoded name>` (RFC 6266 / RFC 5987); the header S3 returns contains no raw
    quote inside the quoted name and decodes back to the original name.
23. **Concurrent claims** (row 10): two `claim_file` calls on one file in two transactions: the second waits
    for the first's row lock; exactly one attaches, the other raises 422 `invalid_file`, and the stored
    attachment is the winner's.
24. **Staff claims** (missed case): for a staff purpose (every uploader role is staff: `package_photo`,
    `notice_attachment`), a caller holding one of the purpose's uploader roles may claim another staff
    member's file (the manager claims security's `package_photo`). Council (staff, but no upload role for
    it) may not, and nobody may claim someone else's `maintenance_photo` (a resident purpose): 422
    `invalid_file`. `claim_file` never commits.

## Test plan

- `backend/tests/files/test_download.py`, `test_claim.py` against the S3 emulator (as in P3-04a).
- Commands: `make test`.

## Likely files

`backend/app/files/{purposes,storage,service,router,schemas}.py`, `backend/tests/files/*`.

## Must explain (learning checkpoint)

4. Why is download authorization delegated to the owning domain (`can_view`)?

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - 5: what "the original bytes" means (the pinned `versionId` in the URL, the checked bytes returned).
  - 6: the exact codes per caller, and that staff get no implicit access to a resident's file.
  - 7: which error each case raises (404 for another building or an unknown id, 422 `invalid_file`
    otherwise) and what "no attachment happens" means on the row.
  - 17–24 added: tenant rows 1, 2, 3, 6, 7 and 10 that apply (row 4 has no role gate here: authorization is
    per file, so a refusal is the row-5 404; rows 8–9 don't apply to a GET or a helper), the four cases the
    ticket asked framing to sharpen (tenant rows, a pending file, concurrent claims, the filename), and the
    missed cases: the hook is never asked about another building's or a pending file (20, 21), attaching
    hands visibility to the domain (18), and which staff may claim (24).
- Criteria loosened (with reason; also listed in the inbox): none.
- Decisions taken (with basis: ticket / ADR / default / autonomous):
  - Hooks live in their own registry in `purposes.py` (`register_can_view`), not in `PurposeRule`, so a
    domain registers its hook from its own module: autonomous; the ticket says "registered by the owning
    domain". A duplicate registration raises, so one domain can't silently replace another's hook.
  - The hook is consulted only for a `ready`, attached file: autonomous. An unattached file has no owning
    record to ask about; a pending one has no pinned version to serve.
  - Once attached, the uploader's own access ends unless the hook grants it: the ticket's rule read
    literally ("the uploader of an unattached `ready` file").
  - "Staff for staff purposes" means: every uploader role of the purpose is staff, and the caller holds one
    of the purpose's uploader roles. Autonomous; tighter than "any staff" (council can't attach a package
    photo it could never upload).
  - Disposition by type: `inline` for the image types, `attachment` otherwise (today only PDF): the ticket.
    The ASCII fallback plus `filename*` follows RFC 6266; autonomous.
  - `download-url` answers `{url, expires_at}`; `claim_file` returns the attached `File`: autonomous.
  - Error code `invalid_file` (the ticket's); refusals of `download-url` reuse `file_not_found`.
- Split: from P3-04 (2026-10-18); see P3-04's table.
