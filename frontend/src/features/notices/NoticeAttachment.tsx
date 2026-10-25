import { useRef, useState } from 'react';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';

/**
 * A notice's attachment that isn't an image (a PDF; P6-02b criterion 6, D5). Images are shown inline instead (R1 F1). The download URL is asked at each click, never cached or put in
 * the page: it is short-lived and its path holds the S3 key, and `files_download_url` decides through the notice
 * whether the caller may have it (ADR-0007). S3 serves a PDF with `Content-Disposition: attachment`
 * (`app/files/service.py::content_disposition`), so going to the URL downloads it and the page stays.
 */
export function NoticeAttachment({ fileId, pdf }: { fileId: string; pdf: boolean }) {
  const buildingId = useBuildingId();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  // Set before the request, so a second click in the same tick opens nothing.
  const opening = useRef(false);

  const open = async () => {
    if (opening.current) return;
    opening.current = true;
    setBusy(true);
    setFailure(null);
    try {
      const { url } = await api.get('/api/buildings/{building_id}/files/{file_id}/download-url', {
        params: { path: { building_id: buildingId, file_id: fileId } },
      });
      window.location.assign(url);
    } catch (error) {
      const notFound = error instanceof ApiError && error.status === 404;
      setFailure(notFound ? 'The attachment is not available.' : (rateLimitMessage(error) ?? 'Could not open the attachment, try again.'));
    } finally {
      opening.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="mt-3">
      <button
        type="button"
        disabled={busy}
        onClick={() => void open()}
        className="min-h-11 rounded border px-4 text-sm disabled:opacity-50"
      >
        {pdf ? 'Download attachment (PDF)' : 'Download attachment'}
      </button>
      {failure && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {failure}
        </p>
      )}
    </div>
  );
}
