import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type JoinRequest = components['schemas']['OnboardingRequestManagerOut'];
export type Decision = { kind: 'approve'; id: string } | { kind: 'deny'; id: string; reason: string };

/** Every key of the managers' join requests starts here, so one invalidation covers the list and its pages. */
const requestsKey = (buildingId: string) => ['b', buildingId, 'onboarding-requests'] as const;

/**
 * The building's pending join requests, newest first, one page at a time (`next_cursor`). Never polled, and
 * stale at once, so a visible tab asks again on focus and after a decision (ADR-0012).
 */
export function usePendingRequests(buildingId: string) {
  return useInfiniteQuery({
    queryKey: [...requestsKey(buildingId), 'pending'],
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/onboarding-requests', {
        params: { path: { building_id: buildingId }, query: pageParam === null ? {} : { cursor: pageParam } },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

/**
 * Approve or deny one request. The list is asked for again after every outcome, here and not in the caller: a
 * 409 means a colleague changed it, and the answer may come after the dialog or the page is gone (D3).
 */
export function useDecide(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...requestsKey(buildingId), 'decide'],
    mutationFn: (decision: Decision) => {
      const path = { building_id: buildingId, request_id: decision.id };
      return decision.kind === 'approve'
        ? api.post('/api/buildings/{building_id}/onboarding-requests/{request_id}/approve', { params: { path } })
        : api.post('/api/buildings/{building_id}/onboarding-requests/{request_id}/deny', {
            params: { path },
            body: { reason: decision.reason },
          });
    },
    // Not returned: `mutateAsync` would wait for the refetch, and a slow list would hold back the dialog's answer
    // (review round 1, Codex F1).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: requestsKey(buildingId) });
    },
  });
}
