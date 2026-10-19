import { useQuery, type Query } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { useBuildingId } from '@/app/BuildingProvider';

type DownloadUrl = components['schemas']['FileDownloadOut'];

// A URL is replaced this long before it stops working, so a loading image never gets a dead one.
const REFRESH_MARGIN_MS = 10_000;

/** How long the cached URL stays usable, less the margin; never negative. */
function usableFor(query: Query<DownloadUrl, Error>): number {
  const { data } = query.state;
  return data ? Math.max(0, Date.parse(data.expires_at) - Date.now() - REFRESH_MARGIN_MS) : 0;
}

export interface PrivateImageProps {
  fileId: string;
  /** Required: the image's text alternative. */
  alt: string;
  className?: string;
}

/**
 * Shows a private file through a short-lived download URL (ADR-0007). The URL is cached until shortly before it
 * expires, then fetched again in the background, so the image never blinks. A file the user may not see (404)
 * shows a neutral "unavailable" box, never a broken image.
 */
export function PrivateImage(props: PrivateImageProps) {
  // Keyed, so the one-retry state below starts fresh for each file.
  return <PrivateImageFor key={props.fileId} {...props} />;
}

function PrivateImageFor({ fileId, alt, className = '' }: PrivateImageProps) {
  const buildingId = useBuildingId();
  const query = useQuery({
    queryKey: ['b', buildingId, 'files', fileId, 'download-url'],
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/files/{file_id}/download-url', {
        params: { path: { building_id: buildingId, file_id: fileId } },
        signal,
      }),
    staleTime: usableFor,
    // At least a second apart, so a URL already inside the margin can't make it spin.
    refetchInterval: (query) => (query.state.data ? Math.max(1_000, usableFor(query)) : false),
  });
  // After an <img> load error (the URL stopped working early), one new URL is tried; a second error is final.
  const [retried, setRetried] = useState(false);
  const [broken, setBroken] = useState(false);

  const box = `flex items-center justify-center rounded bg-slate-100 text-sm text-slate-600 ${className}`;
  const notFound = query.error instanceof ApiError && query.error.status === 404;
  if (notFound || broken) return <div className={box}>Image unavailable</div>;
  if (query.data) {
    return (
      <img
        src={query.data.url}
        alt={alt}
        className={className}
        onLoad={() => setRetried(false)}
        onError={() => {
          if (retried) {
            setBroken(true);
            return;
          }
          setRetried(true);
          void query.refetch();
        }}
      />
    );
  }
  if (query.isError) {
    return (
      <div className={`${box} gap-2`}>
        <span>Couldn&apos;t load the image.</span>
        <button type="button" onClick={() => void query.refetch()} className="rounded border bg-white px-2 py-0.5 text-xs">
          Retry
        </button>
      </div>
    );
  }
  return (
    <div role="status" className={`${box} animate-pulse`}>
      <span className="sr-only">Loading image</span>
    </div>
  );
}
