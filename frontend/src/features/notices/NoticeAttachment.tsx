import { useRef, useState } from 'react';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import { useBuildingId } from '@/app/BuildingProvider';
import { rateLimitMessage } from '@/features/auth/formErrors';

/**
 * A notice's PDF attachment (P6-02b criterion 6, D5). The download URL is asked at each click, never cached or put in
 * the page: it is short-lived and its path holds the S3 key, and `files_download_url` decides through the notice
 * whether the caller may have it (ADR-0007). The tab is opened blank in the click itself, as a popup blocker would
 * refuse one opened after the request; a failure closes it again.
 */
export function NoticeAttachment({ fileId }: { fileId: string }) {
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
    const tab = window.open('', '_blank');
    try {
      const { url } = await api.get('/api/buildings/{building_id}/files/{file_id}/download-url', {
        params: { path: { building_id: buildingId, file_id: fileId } },
      });
      if (tab) {
        // The file's page gets no handle on this one.
        tab.opener = null;
        tab.location.href = url;
      } else window.location.assign(url);
    } catch (error) {
      tab?.close();
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
        Download attachment (PDF)
      </button>
      {failure && (
        <p role="alert" className="mt-1 text-sm text-red-700">
          {failure}
        </p>
      )}
    </div>
  );
}
