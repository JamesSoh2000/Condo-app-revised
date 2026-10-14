# P3-06 — Frontend upload component

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 2 |
| Depends on | P3-04, P2-06 |
| Replaces old | M5-T06 |
| Status | todo |

## Goal

A reusable upload component and a `PrivateImage` component let any slice upload a photo or document to
private S3 with progress, retry and validation, and display it securely.

## Why

Packages (P5) and maintenance (P6) both need photos. Building this once removes Base44 `UploadFile` usage and
keeps the security rules in one place.

## Scope

- In:
  - **`src/features/files/useUpload.ts`:**
    - `create` (`POST /files`), then the browser POST to S3 with `FormData(fields + file)` via
      `XMLHttpRequest` (for upload progress), then `complete`
    - returns `{upload(file), progress, status, error, cancel}`
    - retry restarts from `create` when the presigned form has expired
  - **`FileUpload.tsx`:**
    - props `purpose`, `accept`, `maxBytes`, `onUploaded(fileId)`, `capture?`
    - client-side type and size checks (mirroring the server registry, which the server still enforces)
    - drag-and-drop plus a button, image preview, progress bar, cancel and retry
    - `capture="environment"` for package photos on mobile
  - **`PrivateImage.tsx`:**
    - `fileId` → `GET /files/{id}/download-url`, cached until shortly before expiry, then re-fetched
    - alt text required
    - a loading skeleton, and an error state with retry
  - Replace Base44 `UploadFile` in shared components that the demo slices will use. Leave others behind the
    hidden routes.
  - **The S3 emulator CORS** must allow the app origins (`http://localhost:5173` and `:8080`). P0-04 and
    P1-08 set it; verify it here. The real bucket's CORS comes in D-01 and is checked in D-06.
- Out:
  - multi-file galleries
  - image compression (later; could use a canvas resize before upload)

## Interfaces

Consumes `files_create`, `files_complete` and `files_download_url`. Exports `FileUpload`, `PrivateImage` and
`useUpload`.

## Acceptance criteria

1. **Given** a 2 MiB JPEG on the dev stack and on the prod-like stack (both using the emulator), **then** the
   upload shows progress, ends `ready`, and `onUploaded` receives the `file_id`.
2. **Given** a 15 MiB image, **then** a client-side error is shown before any request. If the check is
   bypassed (devtools), **then** the server error `detail` is shown.
3. **Given** a network drop mid-upload, **then** retry completes the upload.
4. **Given** `PrivateImage` for an accessible file, **then** it renders. After URL expiry (fake timers), it
   refetches transparently.
5. **Given** a file the user cannot view, **then** `PrivateImage` shows a neutral "unavailable" state with no
   broken image.
6. **Given** keyboard only, **then** a file can be chosen and the upload started. Errors are announced.

## Test plan

- Vitest with mocked XHR and fetch for `useUpload` states.
- Manual on the local stack with a desktop browser and devtools device mode (record in the PR). A real phone
  against real S3 is checked in D-06.
- Commands: `npm run test`, `npm run typecheck`.

## Likely files

`frontend/src/features/files/**`, legacy upload usages in `frontend/src/components/*`,
`frontend/base44-baseline.txt`.

## Must explain (learning checkpoint)

1. Why does the browser talk to S3 directly, and what does the server still control?
2. Why use XHR instead of `fetch` here?
3. Why do client-side size checks not replace server enforcement?

## Frame notes (filled by the human in step 1)

- Design prediction:
- Extra cases added:
