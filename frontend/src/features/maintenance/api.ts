import { useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type MaintenanceRequest = components['schemas']['MaintenanceRequestOut'];
export type MaintenanceStatus = components['schemas']['MaintenanceStatus'];
export type MaintenanceCategory = components['schemas']['MaintenanceCategory'];
export type MaintenanceComment = components['schemas']['MaintenanceCommentOut'];
export type MaintenanceStatusEvent = components['schemas']['MaintenanceStatusEventOut'];

/** Requests per page (P6-04a); sent, so the page size is the ticket's and not the server's default. */
export const PAGE_SIZE = 25;

/** Every maintenance key of a building starts here, so a maintenance mutation's one invalidation covers them (P6-04b–d). */
export const maintenanceKey = (buildingId: string) => ['b', buildingId, 'maintenance'] as const;
export const maintenanceListKey = (buildingId: string, status: MaintenanceStatus | null) =>
  [...maintenanceKey(buildingId), 'list', status] as const;

/**
 * The requests the caller may see, newest first, one page at a time; only those with `status` when given (P6-04d's
 * filter). `visible_maintenance` on the server decides what is the caller's, so the browser shows every item it gets.
 * Stale at once, so asked on every mount and on focus: a manager's change shows when the resident comes back. Lists
 * don't poll (ADR-0012).
 */
export function useMaintenanceRequests(buildingId: string, status: MaintenanceStatus | null = null) {
  return useInfiniteQuery({
    queryKey: maintenanceListKey(buildingId, status),
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/maintenance-requests', {
        params: {
          path: { building_id: buildingId },
          query: { limit: PAGE_SIZE, ...(status !== null && { status }), ...(pageParam !== null && { cursor: pageParam }) },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

/**
 * One request's queries, keyed by whether the caller reads as staff here (security or property management): staff see
 * other residents' requests, the requester's name and internal comments, so a staff answer is never shown once `/me`
 * says the caller is not (criterion 2a; review round 1 F1).
 */
export const maintenanceRequestKey = (buildingId: string, requestId: string, staff: boolean) =>
  [...maintenanceKey(buildingId), 'request', requestId, staff ? 'staff' : 'member'] as const;

/**
 * One request (P6-04c). Stale at once and dropped when the view closes (`gcTime: 0`), so reopening it never shows an
 * old status while a manager acts (criterion 6).
 */
export function useMaintenanceRequest(buildingId: string, requestId: string, staff: boolean, enabled: boolean) {
  return useQuery({
    queryKey: maintenanceRequestKey(buildingId, requestId, staff),
    staleTime: 0,
    gcTime: 0,
    enabled,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/maintenance-requests/{request_id}', {
        params: { path: { building_id: buildingId, request_id: requestId } },
        signal,
      }),
  });
}

/** A request's comments the caller may see, oldest first, a page at a time; `gcTime: 0` drops them when the view closes. */
export function useMaintenanceComments(buildingId: string, requestId: string, staff: boolean, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...maintenanceRequestKey(buildingId, requestId, staff), 'comments'],
    staleTime: 0,
    gcTime: 0,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/maintenance-requests/{request_id}/comments', {
        params: {
          path: { building_id: buildingId, request_id: requestId },
          query: { limit: PAGE_SIZE, ...(pageParam !== null && { cursor: pageParam }) },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

/** A request's status changes (start, hold, resume, resolve, reopen), oldest first, a page at a time. */
export function useMaintenanceStatusEvents(buildingId: string, requestId: string, staff: boolean, enabled: boolean) {
  return useInfiniteQuery({
    queryKey: [...maintenanceRequestKey(buildingId, requestId, staff), 'events'],
    staleTime: 0,
    gcTime: 0,
    enabled,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/maintenance-requests/{request_id}/status-events', {
        params: {
          path: { building_id: buildingId, request_id: requestId },
          query: { limit: PAGE_SIZE, ...(pageParam !== null && { cursor: pageParam }) },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

export type NewMaintenanceRequest = components['schemas']['MaintenanceRequestCreate'];

/**
 * After any maintenance write: every maintenance query of the building is cancelled, then asked again however the
 * write ended (an answer lost on the way may have been applied; a 409 means someone else changed the list). Cancelled
 * first, so a list request already on its way is not reused (the CLAUDE.md lesson).
 */
function refresh(queryClient: QueryClient, buildingId: string) {
  const filters = { queryKey: maintenanceKey(buildingId) };
  void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
}

/** File a request (P6-04b). `key` is the form's `Idempotency-Key`, the same for every retry of one form. */
export function useCreateMaintenance(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...maintenanceKey(buildingId), 'create'],
    mutationFn: ({ key, body }: { key: string; body: NewMaintenanceRequest }) =>
      api.post('/api/buildings/{building_id}/maintenance-requests', {
        params: { path: { building_id: buildingId }, header: { 'idempotency-key': key } },
        body,
      }),
    onSettled: () => refresh(queryClient, buildingId),
  });
}
