import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type Package = components['schemas']['PackageOut'];
export type NewPackage = components['schemas']['PackageCreate'];

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

/**
 * Who currently lives in `unitId` with an active membership: the log form's recipients (P5-03c). Stale at once, so a
 * unit chosen again asks again; not asked until a unit is chosen.
 */
export function useUnitOccupants(buildingId: string, unitId: string | null) {
  return useQuery({
    queryKey: ['b', buildingId, 'units', unitId, 'occupants'],
    staleTime: 0,
    enabled: unitId !== null,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/units/{unit_id}/occupants', {
        params: { path: { building_id: buildingId, unit_id: unitId ?? '' } },
        signal,
      }),
  });
}

/**
 * Log a package under `key`, the form's `Idempotency-Key` (P5-03c D1): the caller sends the same key for every retry
 * of one form, so a retry after a lost answer replays the first package instead of logging a second. Every packages
 * query is asked again however it ends, since an attempt that failed in the browser may have been logged; cancelled
 * first, as the residents `refresh`, so a fetch already out can't answer from before the package.
 */
export function useLogPackage(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...packagesKey(buildingId), 'create'],
    mutationFn: ({ key, body }: { key: string; body: NewPackage }) =>
      api.post('/api/buildings/{building_id}/packages', {
        params: { path: { building_id: buildingId }, header: { 'idempotency-key': key } },
        body,
      }),
    onSettled: () => {
      const filters = { queryKey: packagesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
  });
}

export type PickupBody = components['schemas']['PackagePickup'];
export type PackageAction = { kind: 'pickup'; id: string; body: PickupBody } | { kind: 'return'; id: string; reason: string };

/**
 * Hand a waiting package out, or send it back (P5-03d). As `useLogPackage`, every packages query (the waiting list,
 * and the summary when a page reads it) is cancelled, then asked again however it ends: an answer lost on the way may
 * have been applied, and a 409 means another desk changed the list.
 */
export function usePackageAction(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...packagesKey(buildingId), 'action'],
    mutationFn: (action: PackageAction) => {
      const path = { building_id: buildingId, package_id: action.id };
      return action.kind === 'pickup'
        ? api.post('/api/buildings/{building_id}/packages/{package_id}/pickup', { params: { path }, body: action.body })
        : api.post('/api/buildings/{building_id}/packages/{package_id}/return', { params: { path }, body: { reason: action.reason } });
    },
    onSettled: () => {
      const filters = { queryKey: packagesKey(buildingId) };
      void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
    },
  });
}
