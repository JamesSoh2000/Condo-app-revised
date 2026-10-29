import { useInfiniteQuery } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type MaintenanceRequest = components['schemas']['MaintenanceRequestOut'];
export type MaintenanceStatus = components['schemas']['MaintenanceStatus'];
export type MaintenanceCategory = components['schemas']['MaintenanceCategory'];

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
