import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type Notice = components['schemas']['NoticeOut'];

/** Every notices key of a building starts here, so a read's one invalidation covers the feed and the summary. */
export const noticesKey = (buildingId: string) => ['b', buildingId, 'notices'] as const;
export const noticeFeedKey = (buildingId: string) => [...noticesKey(buildingId), 'feed'] as const;

/**
 * The building's live notices (`live=true`: published and not expired, by the database clock, for every role; P6-02a
 * D2), in the API's order, one page at a time. `visible_notices` on the server decides what the caller sees. Stale at
 * once, so asked on every mount and on focus; lists don't poll (ADR-0012), and the page asks it again when the polled
 * summary changes (criterion 5). Not asked until `enabled`.
 */
export function useNoticeFeed(buildingId: string, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: noticeFeedKey(buildingId),
    staleTime: 0,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/notices', {
        params: { path: { building_id: buildingId }, query: { live: true, ...(pageParam !== null && { cursor: pageParam }) } },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

/**
 * The caller's unread count for the nav badge, polled as `usePackageSummary` (ADR-0012): every 30 s while the tab is
 * visible, never in a hidden tab, again whenever it becomes visible and on each mount. Under the notices key, so a read
 * asks it again too.
 */
export function useNoticeSummary(buildingId: string) {
  return useQuery({
    queryKey: [...noticesKey(buildingId), 'summary'],
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/notices/summary', { params: { path: { building_id: buildingId } }, signal }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  });
}

/**
 * Mark one notice read (P6-02a D4). Every notices query is cancelled, then asked again however it ends, as the packages
 * mutations: a lost answer may have been applied, and a 404 means the notice left the feed.
 */
export function useMarkNoticeRead(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...noticesKey(buildingId), 'read'],
    mutationFn: (noticeId: string) =>
      api.post('/api/buildings/{building_id}/notices/{notice_id}/read', {
        params: { path: { building_id: buildingId, notice_id: noticeId } },
      }),
    onSettled: () => {
      const filters = { queryKey: noticesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
  });
}
