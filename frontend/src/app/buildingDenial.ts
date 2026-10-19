import type { QueryClient, QueryKey } from '@tanstack/react-query';

import { ApiError } from '@/api/errors';

/**
 * When the tab lost access to a building, as a timestamp (inbox B-5). A query entry, not component state, so it
 * outlives the shell (the catch-all route unmounts it) and goes with the building's other queries on a switch,
 * `reset()`, another user or a 401. `useBuildingDenied()` reads it.
 */
export const deniedKey = (buildingId: string) => ['b', buildingId, 'denied'] as const;

/**
 * Marks a building denied when one of its requests says so: `building_not_found` (the tenancy 404, ADR-0004)
 * from a query or a mutation keyed `['b', id, …]`, or any 404 from the building itself. Another 404 code
 * (`notification_not_found`) is about one record, not the building.
 *
 * Called from the client's own cache `onError` (queryClient.ts), not from a component: it then hears answers
 * that arrive while the shell is unmounted, and a mutation's denial before its `onSettled` waits for refetches
 * (review round 4, Codex R4-F1, R4-F2).
 */
export function recordBuildingDenial(queryClient: QueryClient, key: QueryKey | undefined, error: unknown): void {
  if (key?.[0] !== 'b' || typeof key[1] !== 'string') return;
  if (!(error instanceof ApiError) || error.status !== 404) return;
  if (error.code !== 'building_not_found' && key[2] !== 'building') return;
  // Built with no garbage collection: nothing observes this entry, and a default 5-minute gcTime would end the
  // denial on its own.
  queryClient.getQueryCache().build(queryClient, { queryKey: deniedKey(key[1]), gcTime: Infinity }).setData(Date.now());
}
