import { useMutation } from '@tanstack/react-query';
import { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { useBuildingId } from '@/app/BuildingProvider';
import { contentTypeOf, type FilePurpose } from '@/features/files/purposes';

type PresignedUpload = components['schemas']['PresignedUpload'];
type FileUploadOut = components['schemas']['FileUploadOut'];

export type UploadStatus = 'idle' | 'uploading' | 'ready' | 'error';

// A retry doesn't reuse a form this close to its expiry: the S3 POST could outlast it.
const EXPIRY_MARGIN_MS = 30_000;

/** S3 answered the form POST with an error status (an expired or refused policy). */
export class StorageError extends Error {
  constructor(readonly status: number) {
    super(`The storage service refused the upload (HTTP ${status}).`);
    this.name = 'StorageError';
  }
}

/** The connection broke during the S3 POST. */
export class UploadNetworkError extends Error {
  constructor() {
    super('The connection was lost during the upload.');
    this.name = 'UploadNetworkError';
  }
}

/**
 * POSTs `file` to S3 with the presigned form: the policy `fields` first, the file last (S3's rule). Uses
 * `XMLHttpRequest` because `fetch` reports no upload progress; it is still a `connect-src` request, which the CSP
 * allows for the S3 origin (deploy/Caddyfile), unlike a native `<form action>`.
 */
export function postToS3(
  upload: PresignedUpload,
  file: File,
  { signal, onProgress }: { signal: AbortSignal; onProgress: (fraction: number) => void },
): Promise<void> {
  return new Promise((resolve, reject) => {
    const aborted = () => (signal.reason instanceof Error ? signal.reason : new DOMException('Aborted', 'AbortError'));
    if (signal.aborted) {
      reject(aborted());
      return;
    }
    const xhr = new XMLHttpRequest();
    const abort = () => xhr.abort();
    const settle = (error?: Error) => {
      signal.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve();
    };
    xhr.open('POST', upload.url);
    xhr.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress(event.loaded / event.total);
    };
    xhr.onload = () => settle(xhr.status >= 200 && xhr.status < 300 ? undefined : new StorageError(xhr.status));
    xhr.onerror = () => settle(new UploadNetworkError());
    xhr.onabort = () => settle(aborted());
    signal.addEventListener('abort', abort, { once: true });
    const form = new FormData();
    for (const [name, value] of Object.entries(upload.fields)) form.append(name, value);
    form.append('file', file);
    xhr.send(form);
  });
}

/** One file's way through the three steps; kept between attempts so a retry skips what is still valid. */
interface Attempt {
  file: File;
  created: FileUploadOut | null;
  sent: boolean;
}

interface Run {
  attempt: Attempt;
  buildingId: string;
  signal: AbortSignal;
}

/** The user-facing sentence for a failed upload: the server's `detail` when it gave one. */
export function uploadErrorMessage(error: unknown): string {
  if (error instanceof ApiError) return error.detail ?? 'The upload failed. Try again.';
  if (error instanceof StorageError || error instanceof UploadNetworkError) return error.message;
  // `fetch` rejects with a TypeError when the network fails.
  if (error instanceof TypeError) return 'The connection was lost. Try again.';
  return 'The upload failed. Try again.';
}

/**
 * Uploads one file of `purpose` to private S3 (ADR-0007): `POST /files` signs a form, the browser POSTs the file
 * to S3, `POST /files/{id}/complete` verifies it. `retry()` reuses the form while it is valid, and starts again
 * from `POST /files` once it has expired or S3 refused it. `cancel()`, unmounting, a building switch and a purpose
 * change abort the request in flight; `onUploaded` is then never called.
 */
export function useUpload(purpose: FilePurpose, { onUploaded }: { onUploaded?: (fileId: string) => void } = {}) {
  const buildingId = useBuildingId();
  const [progress, setProgress] = useState(0);
  const attempt = useRef<Attempt | null>(null);
  const controller = useRef<AbortController | null>(null);
  const onUploadedRef = useRef(onUploaded);
  onUploadedRef.current = onUploaded;

  const mutation = useMutation({
    // Keyed by building, so a `building_not_found` marks the building denied (app/buildingDenial.ts).
    mutationKey: ['b', buildingId, 'files', 'upload'],
    mutationFn: async ({ attempt: current, buildingId: building, signal }: Run) => {
      const expired = (created: FileUploadOut) => Date.parse(created.expires_at) - Date.now() < EXPIRY_MARGIN_MS;
      if (current.created === null || expired(current.created)) {
        current.created = await api.post('/api/buildings/{building_id}/files', {
          params: { path: { building_id: building } },
          body: {
            purpose,
            filename: current.file.name,
            content_type: contentTypeOf(current.file),
            size_bytes: current.file.size,
          },
          signal,
        });
        current.sent = false;
      }
      const { file_id: fileId, upload } = current.created;
      if (!current.sent) {
        setProgress(0);
        try {
          await postToS3(upload, current.file, { signal, onProgress: setProgress });
        } catch (error) {
          // A refused form won't work next time either.
          if (error instanceof StorageError) current.created = null;
          throw error;
        }
        current.sent = true;
      }
      try {
        return await api.post('/api/buildings/{building_id}/files/{file_id}/complete', {
          params: { path: { building_id: building, file_id: fileId } },
          signal,
        });
      } catch (error) {
        // `upload_incomplete`: S3 has nothing for this form, so send the file again.
        if (error instanceof ApiError && error.status === 409) current.sent = false;
        throw error;
      }
    },
  });
  const { mutate, reset } = mutation;

  const start = useCallback(() => {
    if (attempt.current === null) return;
    controller.current?.abort();
    controller.current = new AbortController();
    mutate(
      { attempt: attempt.current, buildingId, signal: controller.current.signal },
      // Per-call callbacks run only for the latest call while this component is mounted.
      { onSuccess: (file) => onUploadedRef.current?.(file.id) },
    );
  }, [buildingId, mutate]);

  const upload = useCallback(
    (file: File) => {
      attempt.current = { file, created: null, sent: false };
      // Now, not when the S3 POST starts: the last file's 100% would show during `POST /files` (round 1, F3).
      setProgress(0);
      start();
    },
    [start],
  );

  const cancel = useCallback(() => {
    controller.current?.abort();
    controller.current = null;
    attempt.current = null;
    setProgress(0);
    reset();
  }, [reset]);

  // On unmount, a building switch and a purpose change: a file of the old building or purpose must not reach a
  // form of the new one (review round 3, R3-F1).
  useEffect(() => cancel, [buildingId, purpose, cancel]);

  let status: UploadStatus = 'idle';
  if (mutation.isPending) status = 'uploading';
  else if (mutation.isSuccess) status = 'ready';
  else if (mutation.isError) status = 'error';

  return {
    upload,
    retry: start,
    cancel,
    progress,
    status,
    error: mutation.isError ? uploadErrorMessage(mutation.error) : null,
    fileId: mutation.data?.id ?? null,
  };
}
