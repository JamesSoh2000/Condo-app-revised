# P3-06 — Frontend upload component

| Field | Value |
|---|---|
| Phase / lane | P3 / B |
| Risk tier | 2 |
| Depends on | P3-04, P2-06 |
| Replaces old | M5-T06 |
| Status | in progress |

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

1. **Given** a 2 MiB JPEG and a `package_photo` `FileUpload` on the dev stack (Vite `:5173`) and on the prod-like
   stack (`:8080`, CSP on), both using the emulator, **then** a `progressbar` shows the S3 upload's progress
   (`aria-valuenow` rises to 100), the status ends `ready` (`POST /files/{id}/complete` answered `ready`), and
   `onUploaded` is called exactly once with that `file_id`. Vitest proves the states with a mocked XHR; a
   Playwright transcript on both stacks goes in the PR.
2. **Given** a 15 MiB image (over the 10 MiB image limit), **then** a client-side error naming the limit is
   shown and **no request** is made (no `POST /files`, no XHR). Same for a type the purpose does not accept
   (a PDF as `package_photo`). **If** the check is bypassed (devtools), **then** the server's problem `detail`
   (422 `file_too_large`) is shown, never a generic message.
3. **Given** a network drop mid-upload (XHR `error`), **then** the status is `error` with a retry control, and
   retry completes the upload with the **same** `file_id` while the form is still valid. **Given** the form has
   expired (`expires_at` passed), **then** retry restarts from `POST /files` and `onUploaded` gets the new
   `file_id`.
4. **Given** `PrivateImage` for an accessible file, **then** it renders an `<img>` with the presigned URL and the
   required `alt`. **Given** fake timers advanced to shortly before `expires_at`, **then** it fetches a new
   download URL and swaps `src` without showing the skeleton again.
5. **Given** a file the user cannot view (`404 file_not_found`), **then** `PrivateImage` shows a neutral
   "Image unavailable" state and renders no `<img>`. **Given** an `<img>` load error (the URL stopped working
   early), **then** it fetches one new URL; a second failure shows the same unavailable state.
6. **Given** keyboard only, **then** the "Choose file" control is a `<button>` reachable by Tab; Enter opens the
   file picker, choosing a file starts the upload, and cancel/retry are buttons. Errors are in a `role="alert"`
   region; progress and `ready` are announced through `aria-live`.
7. (added) **Given** an upload in progress, **when** the user presses Cancel **or** the component unmounts,
   **then** the XHR is aborted, `complete` is never called, and `onUploaded` is not called.
8. (added) **Given** the S3 POST itself fails (a 4xx from the bucket, e.g. the policy refused the size), or
   `complete` answers 409/422, **then** the status is `error` with a readable message, and `onUploaded` is not
   called.
9. (added) **Given** a second file chosen after a finished or failed upload, **then** the old state (progress,
   error, preview) is replaced by the new file's; during an upload the chooser is disabled.

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

## Carried from P1-08

The CSP has `form-action 'self'` and allows the S3 origin only in `img-src` and `connect-src`: upload with
`fetch` (presigned POST as `FormData`), not a native `<form action="https://bucket…">`, or extend the CSP in
`deploy/Caddyfile`. Check the upload on `make prodlike`, where the CSP applies.

## Frame notes (filled by the agent in step 1)

- Criteria added or sharpened:
  - 1–6 made testable: the exact signals (`progressbar`, `aria-valuenow`, `role="alert"`, the `ready` answer of
    `complete`, `onUploaded` once), where each is proved (Vitest vs. stack transcript), and the 10 MiB image
    limit that makes the 15 MiB case fail (`backend/app/files/purposes.py::MAX_IMAGE_BYTES`).
  - 2 also covers a wrong type. 3 splits "retry" into same form (still valid) and new form (expired), as the
    Scope says. 5 adds the image load error (a URL that stopped working before `expires_at`).
  - Added 7 (cancel and unmount abort; an abandoned caller), 8 (S3 or `complete` failure), 9 (a second file).
- Criteria loosened (with reason; also listed in the inbox):
  - **Scope "Replace Base44 `UploadFile` in shared components that the demo slices will use": nothing is
    replaced here.** Since P2-06a every legacy page renders a placeholder (`src/app/routes.tsx`), so no legacy
    upload can be reached. The one shared component a demo slice uses, `NoticeAttachmentUpload.jsx` (notices,
    P6), hands its parent a public `attachment_url` that residents open directly; a private `file_id` can't
    replace that until the notices API attaches and authorizes the file. The slices adopt `FileUpload` when they
    migrate their pages (P5-03 already names it; a carry note goes to the P6 notices backlog item). The Base44
    baseline does not move.
- Decisions taken (with basis):
  - The client-side rules mirror the server registry in `src/features/files/purposes.ts`, typed by the
    generated `FilePurpose`, so a new server purpose fails `typecheck` until it is mirrored (ticket; autonomous
    on the mechanism). `accept` and `maxBytes` props default to the purpose's rule and may only narrow it.
  - Upload over `XMLHttpRequest` with `FormData`, as the ticket says; that is `connect-src`, which the CSP
    already allows for the S3 origin (P1-08 carry note). No CSP change.
  - Download-URL query keyed `['b', buildingId, 'files', fileId, 'download-url']` (CLAUDE.md rule 12), so a
    `building_not_found` marks the building denied like other building data (P3-05).
  - Prod-like check: no route renders `FileUpload` yet, so the stack transcript drives the component through
    the dev server's module graph on `:5173`, and on `:8080` runs the same upload core in the built app's page
    (CSP and CORS apply). Autonomous; no test-only route is added to the app.
- 10-case tenant table: n/a for new rows; no endpoint is added. The frontend's side of case 3/5 (a file of
  another building or record → 404) is criterion 5.
- Size estimate: ~380 non-test lines (hook ~140, `FileUpload` ~150, `PrivateImage` ~70, rules ~20). No split.
- Split: none.
