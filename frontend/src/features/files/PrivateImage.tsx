import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';

import { api } from '@/api/client';
import { ApiError } from '@/api/errors';
import type { components } from '@/api/schema';
import { useBuildingId } from '@/app/BuildingProvider';

type DownloadUrl = components['schemas']['FileDownloadOut'];

// A URL is replaced this long before it stops working, so a loading image never gets a dead one.
const REFRESH_MARGIN_MS = 10_000;

/** When the cached URL should be replaced (its expiry less the margin), as a timestamp; null without one. */
function refreshAt(query: { state: { data?: DownloadUrl } }): number | null {
  const { data } = query.state;
  return data ? Date.parse(data.expires_at) - REFRESH_MARGIN_MS : null;
}

/** A 404: the user may not see this file (or it is gone). The same answer next time, so never asked again. */
function isNotFound(error: unknown): boolean {
  return error instanceof ApiError && error.status === 404;
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
  // After an <img> load error (the URL stopped working early), one new URL is tried; a second error is final.
  // `failedAnswer` is the answer whose image failed (its `dataUpdateCount`): only a newer one is shown again.
  const [failedAnswer, setFailedAnswer] = useState<number | null>(null);
  const [broken, setBroken] = useState(false);
  const queryClient = useQueryClient();
  const queryKey = ['b', buildingId, 'files', fileId, 'download-url'];
  const query = useQuery({
    queryKey,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/files/{file_id}/download-url', {
        params: { path: { building_id: buildingId, file_id: fileId } },
        signal,
      }),
    // Nothing more to fetch once the image is given up on (review round 2, F2).
    enabled: !broken,
    // A new data object for every answer, so an answer identical to the last one still re-renders: the recovery
    // check reads `dataUpdateCount`, which the hook doesn't subscribe to (review round 3, R3-F2).
    structuralSharing: false,
    // React Query measures staleTime from `dataUpdatedAt`, not from now (review round 1, F4).
    staleTime: (query) => {
      const at = refreshAt(query);
      return at === null ? 0 : Math.max(0, at - query.state.dataUpdatedAt);
    },
    // A margin before expiry, at least a second apart. Never after a failed request (a 404, or a 5xx whose
    // retries ran out): the loaded image works until its URL expires, and Retry, focus or an image error ask
    // again (review round 1, F2; round 2, F2). After a 404 not even on focus.
    refetchInterval: (query) => {
      const at = refreshAt(query);
      return at === null || query.state.status === 'error' ? false : Math.max(1_000, at - Date.now());
    },
    refetchOnWindowFocus: (query) => !isNotFound(query.state.error),
  });

  // How many successful answers the query has had; the hook's result doesn't expose it.
  const answers = queryClient.getQueryState(queryKey)?.dataUpdateCount ?? 0;
  const box = `flex items-center justify-center rounded bg-slate-100 text-sm text-slate-600 ${className}`;
  if (isNotFound(query.error) || broken) return <div className={box}>Image unavailable</div>;
  // The failed URL is known to be broken: until a newer answer, show the loading or error state (round 1, F1).
  // The <img> leaves the page meanwhile, so the next one is a new element that loads even the same URL again
  // (review round 2, F1).
  const waiting = failedAnswer !== null && answers <= failedAnswer;
  if (query.data && !waiting) {
    return (
      <img
        src={query.data.url}
        alt={alt}
        className={className}
        onLoad={() => setFailedAnswer(null)}
        onError={() => {
          if (failedAnswer !== null) {
            setBroken(true);
            return;
          }
          setFailedAnswer(answers);
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
