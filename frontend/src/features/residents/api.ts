import { keepPreviousData, useInfiniteQuery, useMutation, useQuery, useQueryClient, type QueryClient, type QueryKey } from '@tanstack/react-query';

import { api } from '@/api/client';
import type { components } from '@/api/schema';

export type JoinRequest = components['schemas']['OnboardingRequestManagerOut'];

/**
 * Ask for `filters`' queries again after a mutation, whatever its outcome; every residents mutation refreshes through
 * here (P4-08i criterion 1, `refresh.test.ts`). Cancelled first: a first load still out has no data, so an
 * invalidation alone would wait for it instead of asking again, and it read before the mutation (P4-08d R1, PR #110
 * R1 F1). Not returned: `mutateAsync` would wait for the refetch (P4-08b R1, Codex F1).
 */
function refresh(queryClient: QueryClient, filters: { queryKey: QueryKey; exact?: boolean }): void {
  void queryClient.cancelQueries(filters).then(() => queryClient.invalidateQueries(filters));
}
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
    // The summary and the list: a first fetch of either may have counted before the decision.
    onSettled: () => refresh(queryClient, { queryKey: requestsKey(buildingId) }),
  });
}

export type Member = components['schemas']['MemberOut'];
export type MemberRole = components['schemas']['Role'];
export type MemberStatus = components['schemas']['MembershipStatus'];
/** In `Role`'s declaration order: the roles dialog's checkboxes and its request follow it. */
export const ROLE_LABELS: Record<MemberRole, string> = {
  resident: 'Resident',
  security: 'Security',
  property_management: 'Property manager',
  council: 'Council',
};
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
    onSettled: () => refresh(queryClient, { queryKey: membersKey(buildingId) }),
  });
}

export type Relationship = components['schemas']['OccupancyRelationship'];
export interface RolesChange {
  id: string;
  add: MemberRole[];
  remove: MemberRole[];
  /** The member is the caller: `/me` is asked for again (criterion 6). */
  self: boolean;
}
export interface Transfer {
  id: string;
  unit_id: string;
  relationship: Relationship;
  self: boolean;
}

/**
 * After a roles change or a transfer, whatever the outcome: the list, and `/me` when the member is the caller (their
 * roles or unit there; `BuildingProvider` then asks for the building, which the nav and the guards read). From the
 * mutation, as `useMemberAction`: the answer may come after the dialog or the page is gone. A failure too: a lost
 * answer may follow a committed change.
 */
function useMemberChange<T extends { self: boolean }>(buildingId: string, kind: string, mutationFn: (variables: T) => Promise<Member>) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...membersKey(buildingId), kind],
    mutationFn,
    onSettled: (_data, _error, variables) => {
      refresh(queryClient, { queryKey: membersKey(buildingId) });
      if (variables.self) refresh(queryClient, { queryKey: ['me'], exact: true });
    },
  });
}

export function useRolesChange(buildingId: string) {
  return useMemberChange(buildingId, 'roles', ({ id, add, remove }: RolesChange) =>
    api.post('/api/buildings/{building_id}/members/{membership_id}/roles', {
      params: { path: { building_id: buildingId, membership_id: id } },
      body: { add, remove },
    }),
  );
}

export function useTransfer(buildingId: string) {
  return useMemberChange(buildingId, 'transfer', ({ id, unit_id, relationship }: Transfer) =>
    api.post('/api/buildings/{building_id}/members/{membership_id}/transfer', {
      params: { path: { building_id: buildingId, membership_id: id } },
      body: { unit_id, relationship },
    }),
  );
}

/**
 * The first page of the building's active units whose label starts with `search` (empty: any), for the transfer.
 * The previous answer stays shown while the next one loads, as the join form's. Not asked while `enabled` is false.
 */
export function useUnitOptions(buildingId: string, search: string, enabled: boolean) {
  return useQuery({
    queryKey: ['b', buildingId, 'units', { active: true, search }],
    // Stale at once, as the members list: a reopened dialog or an earlier search asks again, so a unit deactivated or
    // added meanwhile isn't served from the 30 s cache (review round 1, Codex F2; the CLAUDE.md lesson).
    staleTime: 0,
    enabled,
    queryFn: ({ signal }) =>
      api.get('/api/buildings/{building_id}/units', {
        params: { path: { building_id: buildingId }, query: { active: true, ...(search && { search }) } },
        signal,
      }),
    placeholderData: keepPreviousData,
  });
}

export type Invitation = components['schemas']['InvitationOut'];
/** The invitations the tab lists: those resend and revoke can act on (P4-08i D1). */
export type ListedStatus = 'pending' | 'expired';
export interface InvitationCreate {
  email: string;
  roles: MemberRole[];
  /** A pre-approved resident's unit and how they relate to it: both or neither. */
  unit_id?: string;
  relationship?: Relationship;
}
export interface InvitationAction {
  kind: 'resend' | 'revoke';
  id: string;
}

/** Every key of the building's invitations starts here, so one invalidation covers both lists and their pages. */
const invitationsKey = (buildingId: string) => ['b', buildingId, 'invitations'] as const;
export const invitationsListKey = (buildingId: string, status: ListedStatus) => [...invitationsKey(buildingId), status] as const;

/**
 * The building's invitations of `status`, newest first, one page at a time (P4-08g, P4-08i). Stale at once, as the
 * pending requests: coming back to the tab or the window asks again (ADR-0012).
 */
export function useInvitations(buildingId: string, status: ListedStatus) {
  return useInfiniteQuery({
    queryKey: invitationsListKey(buildingId, status),
    staleTime: 0,
    initialPageParam: null as string | null,
    queryFn: ({ pageParam, signal }) =>
      api.get('/api/buildings/{building_id}/invitations', {
        params: { path: { building_id: buildingId }, query: { status, ...(pageParam !== null && { cursor: pageParam }) } },
        signal,
      }),
    getNextPageParam: (page) => page.next_cursor,
  });
}

/**
 * Invite one email. The list is asked for again after every outcome, from here, as `useMemberAction`: a 409
 * `invitation_pending` means one is listed now, and the answer may come after the page is gone.
 */
export function useInvite(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...invitationsKey(buildingId), 'create'],
    mutationFn: (body: InvitationCreate) =>
      api.post('/api/buildings/{building_id}/invitations', { params: { path: { building_id: buildingId } }, body }),
    onSettled: () => refresh(queryClient, { queryKey: invitationsKey(buildingId) }),
  });
}

/**
 * Resend (a new link and 7-day expiry; the invitation, not null) or revoke (null) one invitation (P4-08i). Both lists
 * are asked for again after every outcome: a resent expired one moves to Pending.
 */
export function useInvitationAction(buildingId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    // Keyed by building, so a `building_not_found` here marks the building denied (app/buildingDenial.ts).
    mutationKey: [...invitationsKey(buildingId), 'action'],
    mutationFn: async ({ kind, id }: InvitationAction): Promise<Invitation | null> => {
      const params = { path: { building_id: buildingId, invitation_id: id } };
      if (kind === 'resend') return api.post('/api/buildings/{building_id}/invitations/{invitation_id}/resend', { params });
      await api.post('/api/buildings/{building_id}/invitations/{invitation_id}/revoke', { params });
      return null;
    },
    onSettled: () => refresh(queryClient, { queryKey: invitationsKey(buildingId) }),
  });
}
