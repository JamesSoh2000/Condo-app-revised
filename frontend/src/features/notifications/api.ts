import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api/client';
import { useBuildingId } from '@/app/BuildingProvider';

/** Every notification key starts here, so one invalidation covers the summary and the list. */
const notificationsKey = (buildingId: string) => ['b', buildingId, 'notifications'] as const;

/**
 * The unread count for the badge. Polled every 30 s while the tab is visible, never in a hidden tab, and asked
 * again whenever the tab is focused or visible again, even if the last answer is under 30 s old (ADR-0012;
 * review round 1, Codex F2: the client's default staleTime skipped it after a short hide).
 */
export function useNotificationSummary() {
  const buildingId = useBuildingId();
  return useQuery({
    queryKey: [...notificationsKey(buildingId), 'summary'],
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/notifications/summary', {
        params: { path: { building_id: buildingId } },
        signal,
      }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
  });
}

/**
 * The notifications, newest first, one page at a time (`next_cursor`). Only requested while `enabled` (the panel
 * is open), asked again each time it opens, and never polled: lists refetch on focus and after mutations
 * (ADR-0012).
 */
export function useNotifications({ enabled }: { enabled: boolean }) {
  const buildingId = useBuildingId();
  return useInfiniteQuery({
    queryKey: [...notificationsKey(buildingId), 'list'],
    enabled,
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/notifications', {
        params: { path: { building_id: buildingId }, query: pageParam === null ? {} : { cursor: pageParam } },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

/**
 * After a mark-read, success or not, the summary and the list are asked for again instead of edited here: the
 * server's count also includes what other tabs and new notifications changed meanwhile.
 */
function useInvalidateNotifications() {
  const buildingId = useBuildingId();
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: notificationsKey(buildingId) });
}

export function useMarkRead() {
  const buildingId = useBuildingId();
  const onSettled = useInvalidateNotifications();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (BuildingProvider).
    mutationKey: [...notificationsKey(buildingId), 'read'],
    mutationFn: (notificationId: string) =>
      api.post('/api/buildings/{building_id}/notifications/{notification_id}/read', {
        params: { path: { building_id: buildingId, notification_id: notificationId } },
      }),
    onSettled,
  });
}

export function useMarkAllRead() {
  const buildingId = useBuildingId();
  const onSettled = useInvalidateNotifications();
  return useMutation({
    mutationKey: [...notificationsKey(buildingId), 'read-all'],
    mutationFn: () =>
      api.post('/api/buildings/{building_id}/notifications/read-all', {
        params: { path: { building_id: buildingId } },
      }),
    onSettled,
  });
}

// The API's own rule (backend app/notifications/service.py `_APP_PATH`): one leading slash, not followed by
// another slash or a backslash, and no whitespace or control characters.
// eslint-disable-next-line no-control-regex
const APP_PATH = /^\/(?![/\\])[^\s\x00-\x1f\x7f]*$/;

/** Whether `link` is a path inside the app, safe to navigate to. The API already refuses anything else. */
export function isAppPath(link: string | null): link is string {
  return link !== null && APP_PATH.test(link);
}
