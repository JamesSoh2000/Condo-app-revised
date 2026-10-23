import { useInfiniteQuery } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type Package = components['schemas']['PackageOut'];

/**
 * The carriers the desk picks from (P5-03b D2): the waiting list's filter, and P5-03c's quick-pick. The API matches
 * `?carrier=` against the whole carrier, any case.
 */
export const CARRIERS = ['Amazon', 'Canada Post', 'DHL', 'FedEx', 'Purolator', 'UPS'] as const;

export interface WaitingFilters {
  unitId: string | null;
  carrier: string | null;
}

/** Every packages key of a building starts here, so a package mutation's one invalidation covers them (P5-03c/d). */
export const packagesKey = (buildingId: string) => ['b', buildingId, 'packages'] as const;
export const waitingListKey = (buildingId: string, filters: WaitingFilters) => [...packagesKey(buildingId), 'waiting', filters] as const;

/**
 * The packages waiting at the desk (`status=received`) that match `filters`, newest first, one page at a time. Each
 * combination is its own query, dropped as soon as nothing shows it (`gcTime: 0`), so going back to one starts from
 * its first page rather than fetching all its cached pages again; the unit choice lives in `useUnitPicker`, so there
 * is no single place to remove it before a change, as `Members` does. Stale at once, so it is asked on every mount
 * and on focus; lists don't poll (ADR-0012).
 */
export function useWaitingPackages(buildingId: string, filters: WaitingFilters) {
  return useInfiniteQuery({
    queryKey: waitingListKey(buildingId, filters),
    staleTime: 0,
    gcTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/packages', {
        params: {
          path: { building_id: buildingId },
          query: {
            status: 'received',
            ...(filters.unitId && { unit_id: filters.unitId }),
            ...(filters.carrier && { carrier: filters.carrier }),
            ...(pageParam !== null && { cursor: pageParam }),
          },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}
