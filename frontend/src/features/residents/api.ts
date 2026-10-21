import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type JoinRequest = components['schemas']['OnboardingRequestManagerOut'];
export type Decision = { kind: 'approve'; id: string } | { kind: 'deny'; id: string; reason: string };

/** Every key of the managers' join requests starts here, so one invalidation covers the list and its pages. */
const requestsKey = (buildingId: string) => ['b', buildingId, 'onboarding-requests'] as const;
const summaryKey = (buildingId: string) => [...requestsKey(buildingId), 'summary'] as const;

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
 * How many requests the pending list shows, for the nav's badge (P4-08d). Polled like the notification summary: every
 * 30 s in a visible tab, never in a hidden one, and again whenever the tab becomes visible (ADR-0012). Under
 * `requestsKey`, so a decision's invalidation asks for it again too. Asked again each time the badge mounts: the nav
 * item comes back after a council member views as Management again, with a count that may be from before (review
 * round 1, Codex F2).
 */
export function usePendingSummary(buildingId: string) {
  return useQuery({
    queryKey: summaryKey(buildingId),
    refetchOnMount: 'always',
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/onboarding-requests/summary', {
        params: { path: { building_id: buildingId } },
        signal,
      }),
    refetchInterval: 30_000,
    refetchIntervalInBackground: false,
    refetchOnWindowFocus: 'always',
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
    // (review round 1, Codex F1). The summary is cancelled first: a first fetch still out has no data yet, so the
    // invalidation would wait for it instead of asking again, and it may have counted before the decision (P4-08d
    // review round 1, Codex F1).
    onSettled: () => {
      void queryClient
        .cancelQueries({ queryKey: summaryKey(buildingId) })
        .then(() => queryClient.invalidateQueries({ queryKey: requestsKey(buildingId) }));
    },
  });
}

export type Member = components['schemas']['MemberOut'];
export type MemberRole = components['schemas']['Role'];
export type MemberStatus = components['schemas']['MembershipStatus'];
export interface MemberFilters {
  role: MemberRole | null;
  status: MemberStatus | null;
  /** Trimmed; empty for none. */
  search: string;
}
export type MemberActionKind = 'suspend' | 'reactivate' | 'deactivate';
export type MemberAction = { kind: 'reactivate'; id: string } | { kind: 'suspend' | 'deactivate'; id: string; reason: string };

/** Every key of the members list starts here, so one invalidation covers every filter combination and its pages. */
const membersKey = (buildingId: string) => ['b', buildingId, 'members'] as const;
export const membersListKey = (buildingId: string, filters: MemberFilters) => [...membersKey(buildingId), 'list', filters] as const;

/**
 * The building's members matching `filters`, newest first, one page at a time. Each combination is its own query;
 * `Members` removes a cached one before going back to it, so every filter change starts from its first page (review
 * round 1, Codex F1). Stale at once, as the pending requests (ADR-0012).
 */
export function useMembers(buildingId: string, filters: MemberFilters) {
  return useInfiniteQuery({
    queryKey: membersListKey(buildingId, filters),
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/members', {
        params: {
          path: { building_id: buildingId },
          query: {
            ...(filters.role && { role: filters.role }),
            ...(filters.status && { status: filters.status }),
            ...(filters.search && { search: filters.search }),
            ...(pageParam !== null && { cursor: pageParam }),
          },
        },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

/**
 * Suspend, reactivate or move out one member. The list is asked for again after every outcome, from here, as
 * `useDecide`: the answer may come after the dialog or the page is gone.
 */
export function useMemberAction(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...membersKey(buildingId), 'action'],
    mutationFn: (action: MemberAction) => {
      const path = { building_id: buildingId, membership_id: action.id };
      if (action.kind === 'reactivate') {
        return api.post('/api/buildings/{building_id}/members/{membership_id}/reactivate', { params: { path } });
      }
      const body = { reason: action.reason };
      return action.kind === 'suspend'
        ? api.post('/api/buildings/{building_id}/members/{membership_id}/suspend', { params: { path }, body })
        : api.post('/api/buildings/{building_id}/members/{membership_id}/deactivate', { params: { path }, body });
    },
    // Not returned, so `mutateAsync` doesn't wait for the refetch (P4-08b round 1, Codex F1).
    onSettled: () => {
      void queryClient.invalidateQueries({ queryKey: membersKey(buildingId) });
    },
  });
}
