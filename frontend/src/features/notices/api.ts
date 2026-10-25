import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef } from 'react';

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

/** One notice (`notices_get`), for `/notices/<id>` (P6-02b). Under the notices key, so a read asks it again. */
export function useNotice(buildingId: string, noticeId: string, enabled: boolean) {
  return useQuery({
    queryKey: [...noticesKey(buildingId), 'one', noticeId],
    staleTime: 0,
    enabled,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/notices/{notice_id}', {
        params: { path: { building_id: buildingId, notice_id: noticeId } },
        signal,
      }),
  });
}

/** How many unread urgent notices the banner lists by name (P6-02b D2); it links the rest to the feed. */
export const BANNER_ROWS = 3;
export const urgentNoticesKey = (buildingId: string) => [...noticesKey(buildingId), 'urgent'] as const;

/**
 * The caller's newest unread urgent live notices, for the banner (P6-02b D2). Asked only while `enabled` (the summary
 * counts some), and again when that count changes (D4); it doesn't poll on its own (ADR-0012).
 */
export function useUrgentNotices(buildingId: string, enabled: boolean) {
  return useQuery({
    queryKey: urgentNoticesKey(buildingId),
    staleTime: 0,
    enabled,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/notices', {
        params: {
          path: { building_id: buildingId },
          query: { live: true, priority: 'urgent', unread: true, limit: BANNER_ROWS },
        },
        signal,
      }),
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

/**
 * `useMarkNoticeRead` for a button: one request per press. The guard is set before the request, so a second press in the
 * same tick, before `isPending` renders, sends nothing (P6-02a criterion 3).
 */
export function useMarkReadOnce(buildingId: string) {
  const read = useMarkNoticeRead(buildingId);
  const sending = useRef(false);
  const markRead = (noticeId: string, onError?: (error: unknown) => void) => {
    if (sending.current) return;
    sending.current = true;
    read.mutate(noticeId, {
      onError,
      onSettled: () => {
        sending.current = false;
      },
    });
  };
  return { read, markRead };
}

/** The manager's three lists (P6-02c D3); "expired" isn't a status but a published notice past its `expires_at` (D4). */
export type ManagedStatus = 'draft' | 'published' | 'archived';
export const MANAGED_PAGE = 25;

/**
 * One of the manager's lists, by `status`, in the API's order, 25 a page. Under the notices key, so an action's
 * invalidation asks every list, the feed, the summary and the banner again. Stale at once, as the feed.
 */
export function useManagedNotices(buildingId: string, status: ManagedStatus) {
  return useInfiniteQuery({
    queryKey: [...noticesKey(buildingId), 'manage', status],
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/notices', {
        params: {
          path: { building_id: buildingId },
          query: { status, limit: MANAGED_PAGE, ...(pageParam !== null && { cursor: pageParam }) },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

export type NoticeAction = 'publish' | 'archive';

/**
 * Publish or archive one notice (`POST …/publish`, `…/archive`; never `PATCH status`). However it ends, every notices
 * query is cancelled, then asked again, as `useMarkNoticeRead`: a 409 means another tab or manager moved it first.
 */
export function useNoticeAction(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...noticesKey(buildingId), 'action'],
    mutationFn: ({ id, action }: { id: string; action: NoticeAction }) => {
      const params = { path: { building_id: buildingId, notice_id: id } };
      return action === 'publish'
        ? api.post('/api/buildings/{building_id}/notices/{notice_id}/publish', { params })
        : api.post('/api/buildings/{building_id}/notices/{notice_id}/archive', { params });
    },
    onSettled: () => {
      const filters = { queryKey: noticesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
  });
}

export type NoticeCreate = components['schemas']['NoticeCreate'];
export type NoticeUpdate = components['schemas']['NoticeUpdate'];

/**
 * Write a new draft (`notices_create`) or change a draft's fields (`notices_update`, only the fields sent; P6-02d).
 * However it ends, every notices query is cancelled, then asked again, as `useNoticeAction`: the drafts list shows the
 * new draft, and a lost answer may have been applied.
 */
export function useSaveNotice(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...noticesKey(buildingId), 'save'],
    mutationFn: (save: { id: null; body: NoticeCreate } | { id: string; body: NoticeUpdate }) =>
      save.id === null
        ? api.post('/api/buildings/{building_id}/notices', { params: { path: { building_id: buildingId } }, body: save.body })
        : api.patch('/api/buildings/{building_id}/notices/{notice_id}', {
            params: { path: { building_id: buildingId, notice_id: save.id } },
            body: save.body,
          }),
    onSettled: () => {
      const filters = { queryKey: noticesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
  });
}
