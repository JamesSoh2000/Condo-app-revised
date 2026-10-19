# ADR-0007: Private S3 with presigned POST uploads and a server-owned file registry

- Status: Accepted
- Date: 2026-10-13

## Context

Package photos, maintenance photos, and later documents and statements are private. Uploads should not
stream through the small API host. Clients must not be able to attach arbitrary object keys, read other
users' files, upload unlimited sizes, or replace bytes after acceptance.

## Decision

- **One private bucket per environment:**
  - Block Public Access
  - versioning enabled
  - SSE-S3 encryption
  - CORS allowing only the app origin
  - a lifecycle rule expiring non-current versions after 30 days
- **`files` table** owned by the server: building, uploader, `purpose`, `s3_key`, `s3_version_id`,
  `content_type`, `size_bytes`, `original_name`, `status` (pending/ready).
- **Flow:**
  1. `POST /api/buildings/{b}/files` validates purpose, type and size limits, creates a `pending` row with
     the server-generated key `b/{building_id}/{purpose}/{file_id}`, and returns a **presigned POST** (5 min)
     whose policy enforces `content-length-range` and `Content-Type`.
  2. The browser uploads directly to S3.
  3. `POST /files/{id}/complete` does a `HEAD` (size, type, `VersionId`) and checks the magic bytes with a
     ranged GET of the first bytes. It then marks the row `ready` and stores the `VersionId`.
  4. Domain endpoints accept `*_file_id`. The service checks the file is in the same building (composite FK),
     `ready`, the right purpose, uploaded by the caller (or staff), and not already attached.
  5. Downloads: `GET /files/{id}/download-url` authorizes through the **owning record's** visibility and
     returns a 60 s presigned GET pinned to the stored `VersionId`.
- **Cleanup:** a nightly job deletes files still `pending` after 24 h, and `ready` but unattached after 7 days
  (how: through a committed `deleting` status, [ADR-0018](./0018-file-deletion-state.md)).
- **Local development** uses an S3-compatible emulator chosen in P0-04 (see "Local emulator" below).
  The adapter only changes `endpoint_url`.
- **Limits** (default; revisit at pilot): images (JPEG/PNG/WebP/HEIC) ≤ 10 MiB; PDF ≤ 20 MiB.

## Local emulator (P0-04a, 2026-10-15)

`localstack/localstack:4.14.0` with `SERVICES=s3`, port 4566 (`docker-compose.yml`, service `s3`).
`docker/s3-init/create-bucket.sh` creates the bucket on every start with versioning, a public access
block, and CORS for `http://localhost:5173` and `http://localhost:8080`. The API uses
`S3_ENDPOINT_URL=http://s3:4566`; presigned URLs use `S3_PUBLIC_ENDPOINT_URL=http://localhost:4566`; both
must be unset in production (the settings validator rejects them). `make s3-smoke` checks what this ADR relies on.

Measured with the same presigned POST (a 1 KiB `content-length-range` and an exact `Content-Type`):

| Candidate | Size limit | Content-Type | VersionId | CORS by origin | Result |
|---|---|---|---|---|---|
| MinIO | — | — | — | — | images no longer pullable (Docker Hub, Quay) |
| moto 5.1.4 / 5.2.4.dev0 | not enforced | not enforced | yes | yes | rejected: can't test the policy |
| SeaweedFS (latest) | upload failed | — | — | — | rejected |
| RustFS (latest) | 400 `EntityTooLarge` | 400 `InvalidPolicyDocument` | yes | yes | works; errors differ from AWS |
| **LocalStack 4.4.0 / 4.14.0** | 400 `EntityTooLarge` | 403 `AccessDenied` | yes | yes | **chosen**: errors match AWS |

LocalStack 4.14.0 is the last tag checked that runs without an account token; it stays pinned. Its state is
in memory, so local uploads are gone after `make down`. Revisit if the pin needs a security fix or LocalStack
drops the free image (RustFS is the fallback).

## Consequences

- The API never handles file bytes.
- Re-using an upload URL cannot change what an accepted `file_id` serves, because the version is pinned.
- Authorization lives with domain records. A file is only as visible as its package or request.
- **Malware scanning and quotas** are not in the demo (pilot checklist).

## Alternatives considered

- **Proxy uploads through the API:** simple, but uses API memory and bandwidth on a small host.
- **Presigned PUT:** cannot enforce a maximum size by policy.
- **Public bucket + unguessable keys:** security by obscurity. Rejected.

## Revisit when

There is a pilot (scanning, quotas, retention per purpose), large documents (multipart), or image thumbnails
(a worker job).
